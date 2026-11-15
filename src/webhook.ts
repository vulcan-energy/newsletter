import type { SupabaseClient } from "@supabase/supabase-js";
import type { WebhookProvider, NormalizedEvent } from "./provider.js";
import { nextStatus, type StatusInput } from "./rules.js";
import { checked, hashEmail } from "./subscribers.js";
import type { NewsletterSubscriber } from "./types.js";
import { NewsletterError } from "./errors.js";

export function webhookHandler(config: {
  supabase: SupabaseClient;
  provider: WebhookProvider;
  newsletterDomain: string;
  ignoreEngagement?: boolean;
  onError?: (error: unknown) => void;
}) {
  const { supabase: db, provider } = config;
  return async (request: Request): Promise<Response> => {
    let events: NormalizedEvent[];
    try {
      events = provider.parseWebhook(await request.text(), request.headers);
    } catch {
      return Response.json(
        { ok: false, code: "invalid_webhook" },
        { status: 401 },
      );
    }
    try {
      for (const event of events) {
        const campaign = event.broadcastId
          ? checked(
              await db
                .from("newsletter_campaigns")
                .select("id,tracking_started_at")
                .eq("provider_broadcast_id", event.broadcastId)
                .maybeSingle(),
            )
          : null;
        if (
          (config.ignoreEngagement || campaign?.tracking_started_at) &&
          ["opened", "clicked"].includes(event.type)
        )
          continue;
        const contact = event.type === "contact_unsubscribed";
        const domainSuppression =
          !event.broadcastId &&
          event.fromDomain === config.newsletterDomain &&
          (event.type === "complained" ||
            (event.type === "bounced" && event.permanent));
        if (!campaign && !contact && !domainSuppression) continue;
        if (
          checked(
            await db
              .from("newsletter_events")
              .select("id")
              .eq("provider_event_id", event.id)
              .maybeSingle(),
          )
        )
          continue;
        let recorded = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          let row: NewsletterSubscriber | null = checked(
            await db
              .from("newsletter_subscribers")
              .select("*")
              .eq("email", event.email)
              .maybeSingle(),
          );
          if (
            checked(
              await db
                .from("newsletter_erasures")
                .select("email_sha256")
                .eq("email_sha256", hashEmail(event.email))
                .maybeSingle(),
            )
          ) {
            recorded = true;
            break;
          }
          if (contact && (!row || row.status !== "subscribed")) {
            recorded = true;
            break;
          }
          const input: StatusInput = {
            type:
              event.type === "bounced"
                ? event.permanent
                  ? "permanent_bounce"
                  : "temporary_bounce"
                : event.type,
            at: event.occurredAt,
          };
          const status = row ? nextStatus(row, input) : null;
          if (row && !contact && status !== row.status) {
            const saved = checked(
              await db
                .from("newsletter_subscribers")
                .update({
                  status,
                  status_changed_at: event.occurredAt,
                  updated_at: new Date(
                    Math.max(Date.now(), Date.parse(row.updated_at) + 1),
                  ).toISOString(),
                })
                .eq("id", row.id)
                .eq("updated_at", row.updated_at)
                .eq("status", row.status)
                .select()
                .maybeSingle(),
            );
            if (!saved) continue;
            row = saved;
          }
          // A verified contact opt-out already proves provider suppression.
          if (row && status !== "subscribed" && !contact) {
            const id =
              row.provider_contact_id ??
              (await provider.findContact(row.email))?.id;
            if (!id) throw new NewsletterError("Suppressed contact missing at provider");
            await provider.setUnsubscribed(id);
          }
          recorded = checked(
            await db.rpc("newsletter_record_event", {
              p_subscriber_id: row?.id ?? null,
              p_expected_updated_at: row?.updated_at ?? null,
              p_status: status,
              p_contact_unsubscribed: contact,
              p_event: {
                campaign_id: campaign?.id ?? null,
                type: contact ? "unsubscribed" : event.type,
                url: event.url ?? null,
                occurred_at: event.occurredAt,
                provider_event_id: event.id,
              },
            }),
          );
          if (recorded) break;
        }
        if (!recorded) throw new NewsletterError("Concurrent subscriber update");
      }
      return Response.json({ ok: true });
    } catch (error) {
      config.onError?.(error);
      return Response.json(
        { ok: false, code: "webhook_retry" },
        { status: 500 },
      );
    }
  };
}
