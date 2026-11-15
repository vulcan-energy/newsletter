import type { SupabaseClient } from "@supabase/supabase-js";
import { allRows } from "./reconcile.js";
import { campaignStats } from "./reports.js";

// A broadcast can't be paused, so a bad send holds the next one until an owner reviews it.
// Bounces include temporary ones, so this is stricter than hard bounces alone.
export type SendingLimits = {
  bounceRate: number;
  complaintRate: number;
  // Fewer events than this only warn, so one stray complaint on a small list never blocks.
  minimumEvents: number;
};
export const defaultSendingLimits: SendingLimits = {
  bounceRate: 0.05,
  complaintRate: 0.003,
  minimumEvents: 2,
};
const warningRates = { bounceRate: 0.025, complaintRate: 0.0008 };
export type SendingHealth = {
  campaign_id: string | null;
  emails_sent: number;
  bounces: number;
  complaints: number;
  blockers: string[];
  warnings: string[];
};

export async function sendingHealth(
  db: SupabaseClient,
  limits: SendingLimits = defaultSendingLimits,
): Promise<SendingHealth> {
  const sent = await allRows(db, "newsletter_campaigns", (q) =>
    q.eq("status", "sent").eq("source", "provider"),
  );
  const last = sent
    .filter((c) => c.sent_at)
    .sort((a, b) => b.sent_at!.localeCompare(a.sent_at!))[0];
  const health: SendingHealth = {
    campaign_id: last?.id ?? null,
    emails_sent: 0,
    bounces: 0,
    complaints: 0,
    blockers: [],
    warnings: [],
  };
  if (!last) return health;
  const stats = await campaignStats(db, last.id);
  Object.assign(health, {
    emails_sent: stats.emails_sent,
    bounces: stats.bounces,
    complaints: stats.complaints,
  });
  const percent = (rate: number) => `${(rate * 100).toFixed(2)}%`;
  for (const [count, noun, limit] of [
    [stats.bounces, "bounce", "bounceRate"],
    [stats.complaints, "complaint", "complaintRate"],
  ] as const) {
    const rate = stats.emails_sent ? count / stats.emails_sent : 0;
    const said = `The last send had ${count} ${noun}${count === 1 ? "" : "s"} (${percent(rate)}), above the`;
    if (count >= limits.minimumEvents && rate > limits[limit])
      health.blockers.push(`${said} ${percent(limits[limit])} limit.`);
    else if (count && rate > warningRates[limit])
      health.warnings.push(`${said} ${percent(warningRates[limit])} warning level.`);
  }
  return health;
}
