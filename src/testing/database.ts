import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
// In-memory query fake; real constraints and transactions are verified by the owner rehearsal.
export function fakeDatabase(
  seed: Record<string, any[]> = {},
  settings: { uuidIds?: boolean } = {},
) {
  const rows: Record<string, any[]> & {
    newsletter_subscribers: any[];
    newsletter_campaigns: any[];
    newsletter_events: any[];
    newsletter_erasures: any[];
  } = {
    newsletter_subscribers: [],
    newsletter_campaigns: [],
    newsletter_events: [],
    newsletter_erasures: [],
    ...structuredClone(seed),
  };
  function applySubscriber(row: any, patch: any, insert = false) {
    const old = { ...row };
    Object.assign(row, patch);
    const now = state.databaseNow?.() ?? new Date().toISOString();
    if (insert) {
      Object.assign(
        row,
        row.status === "subscribed" && row.tracking_consent_source?.trim()
          ? {
              tracking_token: randomUUID(),
              tracking_granted_at: now,
              tracking_revoked_at: null,
            }
          : {
              tracking_token: null,
              tracking_consent_source: null,
              tracking_granted_at: null,
              tracking_revoked_at: null,
            },
      );
    } else {
      if (row.status !== "subscribed" || row.tracking_token == null) {
        row.tracking_token = null;
        row.tracking_consent_source = old.tracking_consent_source ?? null;
        row.tracking_granted_at = old.tracking_granted_at ?? null;
        if (old.tracking_token) row.tracking_revoked_at = now;
      } else if (row.tracking_token !== old.tracking_token) {
        row.tracking_granted_at = now;
        row.tracking_revoked_at = null;
      }
      if (
        row.tracking_token !== old.tracking_token ||
        row.status !== old.status
      )
        row.updated_at = new Date(
          Math.max(
            Date.now(),
            Date.parse(row.updated_at),
            Date.parse(old.updated_at) + 1,
          ),
        ).toISOString();
    }
  }
  let seq = 0;
  const state = {
    databaseNow: undefined as (() => string) | undefined,
    beforeSubscriberInsert: undefined as (() => void) | undefined,
    beforeFinishErasure: undefined as (() => void) | undefined,
    beforeCampaignUpdate: undefined as (() => void) | undefined,
    reads: [] as { table: string; filters: string[]; rows: number }[],
    failEventInsert: false,
    failTable: null as string | null,
    failNext: null as { table: string; op: string } | null,
  };
  const client = {
    async rpc(name: string, args: any) {
      if (name === "newsletter_insert_subscriber") {
        state.beforeSubscriberInsert?.();
        if (
          rows.newsletter_erasures.some((r) => r.email_sha256 === args.p_hash)
        )
          return { data: null, error: null };
        return client
          .from("newsletter_subscribers")
          .insert(args.p_row)
          .select()
          .single();
      }
      if (name === "newsletter_begin_erasure") {
        const row = rows.newsletter_subscribers.find(
          (r) => r.email === args.p_email,
        );
        if ((row?.updated_at ?? null) !== args.p_expected_updated_at)
          return { data: false, error: null };
        if (
          !rows.newsletter_erasures.some((r) => r.email_sha256 === args.p_hash)
        )
          rows.newsletter_erasures.push({ email_sha256: args.p_hash });
        if (row)
          applySubscriber(row, {
            status: args.p_status,
            updated_at: new Date().toISOString(),
          });
        return { data: true, error: null };
      }
      if (name === "newsletter_finish_erasure") {
        state.beforeFinishErasure?.();
        if (
          !rows.newsletter_erasures.some((r) => r.email_sha256 === args.p_hash)
        )
          return { data: null, error: { message: "Erasure has not started" } };
        const row = rows.newsletter_subscribers.find(
          (r) => r.email === args.p_email,
        );
        if (!row) return { data: true, error: null };
        if (row.id !== args.p_subscriber_id)
          return { data: false, error: null };
        const eventIds = rows.newsletter_events
          .filter((e) => e.subscriber_id === row.id)
          .map((e) => e.id)
          .sort();
        if (
          JSON.stringify(eventIds) !==
          JSON.stringify([...args.p_event_ids].sort())
        )
          return { data: false, error: null };
        for (const change of args.p_campaign_updates) {
          const campaign = rows.newsletter_campaigns.find(
            (c) => c.id === change.id,
          );
          if (
            !campaign ||
            JSON.stringify(campaign.stats ?? null) !==
              JSON.stringify(change.expected_stats)
          )
            return { data: false, error: null };
        }
        if (state.failTable === "newsletter_campaigns")
          return { data: null, error: { message: "fake storage failure" } };
        for (const change of args.p_campaign_updates)
          rows.newsletter_campaigns.find((c) => c.id === change.id).stats =
            structuredClone(change.stats);
        for (let i = rows.newsletter_events.length - 1; i >= 0; i--)
          if (rows.newsletter_events[i].subscriber_id === row.id)
            rows.newsletter_events.splice(i, 1);
        rows.newsletter_subscribers.splice(
          rows.newsletter_subscribers.indexOf(row),
          1,
        );
        return { data: true, error: null };
      }
      if (name === "newsletter_resubscribe") {
        const row = rows.newsletter_subscribers.find(
          (r) =>
            r.id === args.p_id &&
            r.updated_at === args.p_expected_updated_at &&
            r.status !== "cleaned",
        );
        if (
          !row ||
          rows.newsletter_erasures.some((r) => r.email_sha256 === args.p_hash)
        )
          return { data: null, error: null };
        applySubscriber(row, {
          status: "subscribed",
          consent_source: args.p_reason,
          resubscribed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return { data: structuredClone(row), error: null };
      }
      if (name !== "newsletter_record_event")
        throw new Error("Unexpected fake RPC");
      const row = rows.newsletter_subscribers.find(
        (r) => r.id === args.p_subscriber_id,
      );
      if (
        args.p_subscriber_id &&
        (!row || row.updated_at !== args.p_expected_updated_at)
      )
        return { data: false, error: null };
      if (
        rows.newsletter_events.some(
          (e) => e.provider_event_id === args.p_event.provider_event_id,
        )
      )
        return { data: true, error: null };
      if (args.p_contact_unsubscribed && (!row || row.status !== "subscribed"))
        return { data: true, error: null };
      if (state.failEventInsert)
        return {
          data: null,
          error: { message: "insert failure; transaction rolled back" },
        };
      if (row && row.status !== args.p_status)
        applySubscriber(row, {
          status: args.p_status,
          status_changed_at: args.p_event.occurred_at,
          updated_at: new Date().toISOString(),
        });
      rows.newsletter_events.push({
        id: `event-${++seq}`,
        ...args.p_event,
        subscriber_id: args.p_subscriber_id,
      });
      return { data: true, error: null };
    },
    from(table: string) {
      const tableRows = (rows[table] ??= []);
      let filters: ((r: any) => boolean)[] = [];
      const filterNames: string[] = [];
      let op = "select";
      let value: any;
      let options: any;
      let one = false;
      let start = 0,
        end = Infinity;
      let sortKey: string | undefined;
      const query: any = {
        select() {
          return query;
        },
        eq(k: string, v: any) {
          filterNames.push(k);
          filters.push((r) =>
            k === "stats" && typeof v === "string"
              ? JSON.stringify(r[k]) === v
              : r[k] === v,
          );
          return query;
        },
        in(k: string, values: any[]) {
          filterNames.push(k);
          filters.push((r) => values.includes(r[k]));
          return query;
        },
        lt(k: string, v: any) {
          filterNames.push(k);
          filters.push((r) => r[k] < v);
          return query;
        },
        gt(k: string, v: any) {
          filterNames.push(k);
          filters.push((r) => r[k] > v);
          return query;
        },
        gte(k: string, v: any) {
          filterNames.push(k);
          filters.push((r) => r[k] >= v);
          return query;
        },
        returns() {
          return query;
        },
        overrideTypes() {
          return query;
        },
        delete() {
          op = "delete";
          return query;
        },
        is(k: string, v: any) {
          filterNames.push(k);
          filters.push((r) => (r[k] ?? null) === v);
          return query;
        },
        limit(n: number) {
          end = n - 1;
          return query;
        },
        range(a: number, b: number) {
          start = a;
          end = b;
          return query;
        },
        order(k: string) {
          sortKey = k;
          return query;
        },
        insert(v: any) {
          op = "insert";
          value = v;
          return query;
        },
        update(v: any) {
          op = "update";
          value = v;
          return query;
        },
        upsert(v: any, o: any) {
          op = "upsert";
          value = v;
          options = o;
          return query;
        },
        maybeSingle() {
          one = true;
          return query;
        },
        single() {
          one = true;
          return query;
        },
        then(resolve: any, reject: any) {
          return Promise.resolve()
            .then(() => {
              if (state.failNext?.table === table && state.failNext.op === op) {
                state.failNext = null;
                return { data: null, error: { message: "one failure" } };
              }
              if (state.failTable === table)
                return {
                  data: null,
                  error: { message: "fake storage failure" },
                };
              if (table === "newsletter_campaigns" && op === "update")
                state.beforeCampaignUpdate?.();
              const matches = tableRows.filter((r) =>
                filters.every((f) => f(r)),
              );
              if (sortKey)
                matches.sort((a, b) =>
                  String(a[sortKey!]).localeCompare(String(b[sortKey!])),
                );
              let result = matches.slice(start, end + 1);
              if (op === "insert" || op === "upsert") {
                result = [];
                for (const item of Array.isArray(value) ? value : [value]) {
                  const key =
                    options?.onConflict ??
                    (table === "newsletter_subscribers" ? "email" : "id");
                  const existing = tableRows.find(
                    (r) => r[key] === item[key] && item[key] != null,
                  );
                  if (existing) {
                    if (op === "insert")
                      return { data: null, error: { code: "23505" } };
                    if (!options?.ignoreDuplicates) {
                      if (table === "newsletter_subscribers")
                        applySubscriber(existing, item);
                      else Object.assign(existing, item);
                    }
                    result.push(existing);
                  } else {
                    const row = {
                      id: settings.uuidIds ? randomUUID() : `id-${++seq}`,
                      updated_at: new Date().toISOString(),
                      ...item,
                    };
                    if (table === "newsletter_subscribers")
                      applySubscriber(row, {}, true);
                    tableRows.push(row);
                    result.push(row);
                  }
                }
              } else if (op === "delete") {
                for (const row of matches) {
                  if (table === "newsletter_subscribers")
                    for (const event of rows.newsletter_events)
                      if (event.subscriber_id === row.id)
                        event.subscriber_id = null;
                  tableRows.splice(tableRows.indexOf(row), 1);
                }
              } else if (op === "update") {
                if (
                  table === "newsletter_campaigns" &&
                  matches.some(
                    (r) =>
                      r.provider_broadcast_id &&
                      r.tracking_started_at &&
                      [
                        "tracking_links",
                        "tracking_started_at",
                        "provider_broadcast_id",
                      ].some(
                        (k) =>
                          k in value &&
                          JSON.stringify(value[k]) !== JSON.stringify(r[k]),
                      ),
                  )
                )
                  return {
                    data: null,
                    error: {
                      message: "Broadcast tracking links are immutable",
                    },
                  };
                for (const r of matches) {
                  if (table === "newsletter_subscribers")
                    applySubscriber(r, value);
                  else {
                    const next = { ...r, ...value };
                    if (
                      table === "newsletter_campaigns" &&
                      !r.provider_broadcast_id &&
                      !next.provider_broadcast_id &&
                      next.status === "sending" &&
                      next.tracking_started_at
                    )
                      next.tracking_started_at =
                        state.databaseNow?.() ?? new Date().toISOString();
                    Object.assign(r, next);
                  }
                }
              }
              if (op === "select")
                state.reads.push({
                  table,
                  filters: [...filterNames],
                  rows: result.length,
                });
              return {
                data: structuredClone(one ? (result[0] ?? null) : result),
                error: null,
              };
            })
            .then(resolve, reject);
        },
      };
      return query;
    },
  };
  return Object.assign(state, {
    client: client as unknown as SupabaseClient,
    rows,
  });
}
