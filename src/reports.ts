import type { SupabaseClient } from "@supabase/supabase-js";
import { allRows } from "./reconcile.js";
import { checked } from "./subscribers.js";
import type {
  CampaignStats,
  ErasedStats,
  NewsletterCampaign,
  NewsletterEvent,
  NewsletterSubscriber,
  StoredStats,
} from "./types.js";
import { NewsletterError } from "./errors.js";
export function isErasedStats(stats: StoredStats | null | undefined): stats is ErasedStats {
  return !!stats && "kind" in stats && stats.kind === "erased";
}
export function mergeStats(live: CampaignStats, erased?: CampaignStats): CampaignStats {
  if (!erased) return live;
  const totals = { ...live };
  for (const field of [
    "delivered",
    "unique_opens",
    "opens",
    "unique_clicks",
    "clicks",
    "bounces",
    "complaints",
    "unsubscribes",
  ] as const)
    totals[field] += erased[field];
  const links = new Map(live.links.map((link) => [link.url, { ...link }]));
  for (const link of erased.links) {
    const previous = links.get(link.url);
    links.set(link.url, {
      url: link.url,
      clicks: (previous?.clicks ?? 0) + link.clicks,
      unique_clicks: (previous?.unique_clicks ?? 0) + link.unique_clicks,
    });
  }
  return { ...totals, links: [...links.values()] };
}
export function reportTotals(
  campaign: NewsletterCampaign,
  events: NewsletterEvent[],
  campaigns: NewsletterCampaign[],
): CampaignStats {
  if (campaign.stats && !isErasedStats(campaign.stats)) return campaign.stats;
  const own = events.filter((e) => e.campaign_id === campaign.id);
  const key = (e: NewsletterEvent) => e.subscriber_id ?? e.provider_event_id ?? e.id;
  const typed = (type: NewsletterEvent["type"]) => own.filter((e) => e.type === type);
  const unique = (rows: NewsletterEvent[]) => new Set(rows.map(key)).size;
  const bounced = new Set(typed("bounced").map(key));
  const clicks = typed("clicked").filter((e) => {
    try {
      return new URL(e.url ?? "").hostname !== "unsubscribe.resend.com";
    } catch {
      return false;
    }
  });
  const next = campaigns
    .filter(
      (c) => c.status === "sent" && c.sent_at && campaign.sent_at && c.sent_at > campaign.sent_at,
    )
    .map((c) => c.sent_at!)
    .sort()[0];
  const unsubscribes =
    campaign.source === "external"
      ? typed("unsubscribed")
      : events.filter(
          (e) =>
            !e.campaign_id &&
            e.type === "unsubscribed" &&
            campaign.sent_at &&
            e.occurred_at >= campaign.sent_at &&
            (!next || e.occurred_at < next),
        );
  return mergeStats(
    {
      emails_sent: campaign.recipient_count ?? 0,
      delivered: unique(typed("delivered").filter((e) => !bounced.has(key(e)))),
      unique_opens: unique(typed("opened")),
      opens: typed("opened").length,
      unique_clicks: unique(clicks),
      clicks: clicks.length,
      bounces: bounced.size,
      complaints: unique(typed("complained")),
      unsubscribes: unique(unsubscribes),
      unsubscribes_approximate: campaign.source !== "external",
      links: [...new Set(clicks.map((e) => e.url!))].map((url) => ({
        url,
        clicks: clicks.filter((e) => e.url === url).length,
        unique_clicks: unique(clicks.filter((e) => e.url === url)),
      })),
    },
    isErasedStats(campaign.stats) ? campaign.stats.totals : undefined,
  );
}
export function eventsForSubscriber(db: SupabaseClient, id: string): Promise<NewsletterEvent[]> {
  return allRows(db, "newsletter_events", (q) => q.eq("subscriber_id", id));
}
type PersonReport = Pick<NewsletterSubscriber, "id" | "email" | "status"> & {
  opens: number;
  clicks: number;
  events: NewsletterEvent[];
};
export type CampaignReport = CampaignStats & { people?: PersonReport[] };
export async function campaignStats(
  db: SupabaseClient,
  id: string,
  people = false,
): Promise<CampaignReport> {
  const campaign: NewsletterCampaign | null = checked(
    await db.from("newsletter_campaigns").select("*").eq("id", id).maybeSingle(),
  );
  if (!campaign) throw new NewsletterError("Campaign not found");
  const snapshot = campaign.stats && !isErasedStats(campaign.stats);
  if (snapshot && !people) return campaign.stats as CampaignStats;
  const events = await allRows(db, "newsletter_events", (q) => q.eq("campaign_id", id));
  const next: NewsletterCampaign | null = campaign.sent_at
    ? checked(
        await db
          .from("newsletter_campaigns")
          .select("id,sent_at,status")
          .eq("status", "sent")
          .gt("sent_at", campaign.sent_at)
          .order("sent_at")
          .limit(1)
          .maybeSingle(),
      )
    : null;
  const optouts =
    !snapshot && campaign.source === "provider" && campaign.sent_at
      ? await allRows(db, "newsletter_events", (q) => {
          const window = q
            .is("campaign_id", null)
            .eq("type", "unsubscribed")
            .gte("occurred_at", campaign.sent_at!);
          return next?.sent_at ? window.lt("occurred_at", next.sent_at) : window;
        })
      : [];
  const totals = reportTotals(campaign, [...events, ...optouts], next ? [next] : []);
  if (!people) return totals;
  const ids = [...new Set(events.flatMap((e) => (e.subscriber_id ? [e.subscriber_id] : [])))];
  const subscribers: NewsletterSubscriber[] = [];
  for (let i = 0; i < ids.length; i += 100)
    subscribers.push(
      ...(await allRows(db, "newsletter_subscribers", (q) => q.in("id", ids.slice(i, i + 100)))),
    );
  return {
    ...totals,
    people: subscribers.map((s) => {
      const own = events.filter((e) => e.subscriber_id === s.id);
      return {
        id: s.id,
        email: s.email,
        status: s.status,
        opens: own.filter((e) => e.type === "opened").length,
        clicks: own.filter((e) => e.type === "clicked" && e.url).length,
        events: own,
      };
    }),
  };
}
export async function retainEvents(
  db: SupabaseClient,
  now = new Date(),
): Promise<{ deleted_before: string }> {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 24);
  const before = cutoff.toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    const expired = await allRows(db, "newsletter_events", (q) => q.lt("occurred_at", before));
    const campaigns = await allRows(db, "newsletter_campaigns");
    let changed = false;
    for (const campaign of campaigns) {
      if (campaign.stats && !isErasedStats(campaign.stats)) continue;
      if (
        !expired.some((e) => e.campaign_id === campaign.id) &&
        !reportTotals({ ...campaign, stats: null }, expired, campaigns).unsubscribes
      )
        continue;
      const totals = await campaignStats(db, campaign.id);
      let query = db.from("newsletter_campaigns").update({ stats: totals }).eq("id", campaign.id);
      query =
        campaign.stats == null
          ? query.is("stats", null)
          : query.eq("stats", JSON.stringify(campaign.stats));
      if (!checked(await query.select("id").maybeSingle())) {
        changed = true;
        break;
      }
    }
    if (changed) continue;
    for (let start = 0; start < expired.length; start += 500)
      checked(
        await db
          .from("newsletter_events")
          .delete()
          .in(
            "id",
            expired.slice(start, start + 500).map((e) => e.id),
          ),
      );
    return { deleted_before: before };
  }
  throw new NewsletterError("Campaign totals changed concurrently; retry retention");
}
