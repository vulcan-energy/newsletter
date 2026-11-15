import { expect, it } from "vitest";
import { sendingHealth } from "./health.js";
import { fakeDatabase } from "./testing/database.js";

const sent = (id: string, sent_at: string, recipients: number, source = "provider") => ({
  id,
  slug: id,
  status: "sent",
  source,
  sent_at,
  recipient_count: recipients,
  stats: null,
});
const events = (campaign: string, type: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${campaign}-${type}-${i}`,
    campaign_id: campaign,
    subscriber_id: `${campaign}-${type}-person-${i}`,
    type,
    occurred_at: "2026-10-02T00:00:00Z",
    provider_event_id: `${campaign}-${type}-${i}`,
  }));
const health = (campaigns: object[], rows: object[]) =>
  sendingHealth(
    fakeDatabase({ newsletter_campaigns: campaigns, newsletter_events: rows } as any).client,
  );

it("is clear before anything has been sent", async () => {
  expect(await health([], [])).toMatchObject({ campaign_id: null, blockers: [], warnings: [] });
});

it("blocks after a send whose bounces or complaints passed the limits", async () => {
  const result = await health(
    [sent("old", "2026-09-01T00:00:00Z", 100), sent("last", "2026-10-01T00:00:00Z", 200)],
    [...events("last", "bounced", 11), ...events("last", "complained", 2), ...events("old", "complained", 9)],
  );
  expect(result).toMatchObject({ campaign_id: "last", emails_sent: 200, bounces: 11, complaints: 2 });
  expect(result.blockers).toEqual([
    "The last send had 11 bounces (5.50%), above the 5.00% limit.",
    "The last send had 2 complaints (1.00%), above the 0.30% limit.",
  ]);
});

it("only warns on a single complaint or a moderate bounce rate", async () => {
  const result = await health(
    [sent("last", "2026-10-01T00:00:00Z", 284), sent("imported", "2026-10-05T00:00:00Z", 10, "external")],
    [...events("last", "bounced", 8), ...events("last", "complained", 1)],
  );
  expect(result.campaign_id).toBe("last");
  expect(result.blockers).toEqual([]);
  expect(result.warnings).toEqual([
    "The last send had 8 bounces (2.82%), above the 2.50% warning level.",
    "The last send had 1 complaint (0.35%), above the 0.08% warning level.",
  ]);
});
