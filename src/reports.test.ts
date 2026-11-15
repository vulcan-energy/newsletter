import { expect, it } from "vitest";
import { campaignStats, retainEvents } from "./reports.js";
import { fakeDatabase } from "./testing/database.js";
function setup() {
  return fakeDatabase({
    newsletter_campaigns: [
      {
        id: "campaign",
        recipient_count: 3,
        stats: null,
        source: "provider",
        sent_at: "2020-01-01",
      },
    ],
    newsletter_events: [
      {
        id: "1",
        campaign_id: "campaign",
        subscriber_id: "a",
        type: "delivered",
        occurred_at: "2020-01-01",
      },
      {
        id: "2",
        campaign_id: "campaign",
        subscriber_id: "a",
        type: "bounced",
        occurred_at: "2020-01-01",
      },
      {
        id: "3",
        campaign_id: "campaign",
        subscriber_id: "b",
        type: "delivered",
        occurred_at: "2020-01-01",
      },
      {
        id: "4",
        campaign_id: "campaign",
        subscriber_id: "b",
        type: "opened",
        occurred_at: "2020-01-01",
      },
      {
        id: "5",
        campaign_id: "campaign",
        subscriber_id: "b",
        type: "opened",
        occurred_at: "2020-01-01",
      },
      {
        id: "6",
        campaign_id: "campaign",
        subscriber_id: "b",
        type: "clicked",
        url: "https://example.com/read",
        occurred_at: "2020-01-01",
      },
      {
        id: "7",
        campaign_id: "campaign",
        subscriber_id: "b",
        type: "clicked",
        url: "https://unsubscribe.resend.com/token",
        occurred_at: "2020-01-01",
      },
      {
        id: "8",
        campaign_id: null,
        subscriber_id: "b",
        type: "unsubscribed",
        occurred_at: "2020-01-02",
      },
    ],
  });
}
it("excludes bounced delivery and unsubscribe clicks; counts unique people and approximate opt-outs", async () => {
  const { client } = setup();
  const stats = await campaignStats(client, "campaign");
  expect(stats).toMatchObject({
    delivered: 1,
    unique_opens: 1,
    opens: 2,
    unique_clicks: 1,
    clicks: 1,
    bounces: 1,
    unsubscribes: 1,
    unsubscribes_approximate: true,
  });
  expect(stats.links).toHaveLength(1);
});
it("snapshots all events before deleting expired events; reports stay equal", async () => {
  const db = setup();
  const before = await campaignStats(db.client, "campaign");
  await retainEvents(db.client, new Date("2026-11-01"));
  expect(db.rows.newsletter_events).toHaveLength(0);
  expect(await campaignStats(db.client, "campaign")).toEqual(before);
});
it("failed totals write deletes nothing and imported stats are immutable", async () => {
  const db = setup();
  db.failNext = { table: "newsletter_campaigns", op: "update" };
  await expect(retainEvents(db.client, new Date("2026-11-01"))).rejects.toThrow();
  expect(db.rows.newsletter_events).toHaveLength(8);
  db.rows.newsletter_campaigns[0].stats = { delivered: 99, links: [] };
  db.rows.newsletter_campaigns[0].source = "external";
  await retainEvents(db.client, new Date("2026-11-01"));
  expect(db.rows.newsletter_campaigns[0].stats).toEqual({ delivered: 99, links: [] });
});
it("preserves approximate opt-outs even when no campaign-specific event survived", async () => {
  const db = setup();
  db.rows.newsletter_events.splice(0, 7);
  const before = await campaignStats(db.client, "campaign");
  expect(before.unsubscribes).toBe(1);
  await retainEvents(db.client, new Date("2026-11-01"));
  expect(await campaignStats(db.client, "campaign")).toEqual(before);
});

it("campaign reports fetch only their own events and bounded unattributed opt-outs", async () => {
  const db = setup();
  db.rows.newsletter_campaigns.push({
    id: "later",
    status: "sent",
    sent_at: "2020-02-01",
    stats: null,
  });
  db.rows.newsletter_events.push({
    id: "unrelated",
    campaign_id: "later",
    type: "opened",
    subscriber_id: "x",
    occurred_at: "2020-02-01",
  });
  const result = await campaignStats(db.client, "campaign", true);
  expect(result.unsubscribes).toBe(1);
  const reads = db.reads.filter((read) => read.table === "newsletter_events");
  expect(reads).toHaveLength(2);
  expect(reads.every((read) => read.filters.includes("campaign_id"))).toBe(true);
  expect(reads[1].filters.filter((filter) => filter === "occurred_at")).toHaveLength(2);
  expect(reads.reduce((sum, read) => sum + read.rows, 0)).toBe(8);
});

it("retention includes erased contributions and leaves imported snapshots untouched", async () => {
  const db = setup();
  const { eraseSubscriber } = await import("./admin.js");
  const { FakeProvider } = await import("./testing/provider.js");
  db.rows.newsletter_subscribers.push({
    id: "b",
    email: "b@example.com",
    status: "subscribed",
    updated_at: "2020-01-01",
    tags: [],
  });
  const before = await campaignStats(db.client, "campaign");
  await eraseSubscriber(db.client, new FakeProvider(), "b@example.com");
  expect(await campaignStats(db.client, "campaign")).toEqual(before);
  await retainEvents(db.client, new Date("2026-11-01"));
  expect(await campaignStats(db.client, "campaign")).toEqual(before);
  expect(db.rows.newsletter_events).toHaveLength(0);
  expect(db.rows.newsletter_campaigns[0].stats.kind).toBeUndefined();
});

it("retention losing every stats compare-and-swap deletes no events", async () => {
  const db = setup();
  const initial = await campaignStats(db.client, "campaign");
  let changes = 0;
  db.beforeCampaignUpdate = () => {
    db.rows.newsletter_campaigns[0].stats = {
      kind: "erased",
      totals: { ...initial, opens: ++changes },
    };
  };
  await expect(retainEvents(db.client, new Date("2026-11-01"))).rejects.toThrow("concurrently");
  expect(db.rows.newsletter_events).toHaveLength(8);
  expect(changes).toBe(3);
});
