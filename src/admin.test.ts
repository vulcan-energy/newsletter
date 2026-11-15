import { expect, it, vi } from "vitest";
import { eraseSubscriber, resubscribeSubscriber, clearErasure, editSubscriber } from "./admin.js";
import { addSubscriber, importSubscriber, hashEmail } from "./subscribers.js";
import { campaignStats } from "./reports.js";
import { fakeDatabase } from "./testing/database.js";
import { FakeProvider } from "./testing/provider.js";
async function setup(status = "subscribed") {
  const db = fakeDatabase({
    newsletter_subscribers: [
      {
        id: "person",
        email: "person@example.com",
        status,
        tags: ["old"],
        consent_source: "test",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    newsletter_campaigns: [
      {
        id: "campaign",
        stats: null,
        recipient_count: 1,
        source: "provider",
        sent_at: "2026-01-01",
      },
    ],
    newsletter_events: [1, 2].map((n) => ({
      id: String(n),
      campaign_id: "campaign",
      subscriber_id: "person",
      type: "opened",
      occurred_at: "2026-01-01",
    })),
  });
  const provider = new FakeProvider();
  await provider.createContact({
    email: "person@example.com",
    unsubscribed: status !== "subscribed",
  });
  return { db, provider };
}
it("erase preserves anonymous totals, deletes the provider contact, and cannot be undone by signup or import", async () => {
  const { db, provider } = await setup();
  const before = await campaignStats(db.client, "campaign");
  await eraseSubscriber(db.client, provider, "person@example.com");
  expect(db.rows.newsletter_subscribers).toHaveLength(0);
  expect(provider.contacts.size).toBe(0);
  expect(db.rows.newsletter_erasures).toEqual([
    expect.objectContaining({ email_sha256: hashEmail("person@example.com") }),
  ]);
  expect(db.rows.newsletter_events.every((e) => e.subscriber_id === null)).toBe(true);
  expect(await campaignStats(db.client, "campaign")).toEqual(before);
  expect(
    await addSubscriber(db.client, { email: "person@example.com", consent_source: "again" }),
  ).toBeNull();
  expect(
    await importSubscriber(db.client, {
      email: "person@example.com",
      status: "subscribed",
      tags: [],
      consent_source: "import",
    }),
  ).toBeNull();
  await clearErasure(db.client, " PERSON@example.com ");
  expect(
    await addSubscriber(db.client, {
      email: "person@example.com",
      consent_source: "fresh consent",
    }),
  ).not.toBeNull();
});
it("an erase provider failure leaves a tombstone and local suppression, and is retryable", async () => {
  const { db, provider } = await setup();
  const remove = vi.spyOn(provider, "deleteContact").mockRejectedValueOnce(new Error("offline"));
  await expect(eraseSubscriber(db.client, provider, "person@example.com")).rejects.toThrow();
  expect(db.rows.newsletter_subscribers[0].status).toBe("unsubscribed");
  expect(db.rows.newsletter_erasures).toHaveLength(1);
  await eraseSubscriber(db.client, provider, "person@example.com");
  expect(remove).toHaveBeenCalledTimes(2);
  expect(db.rows.newsletter_subscribers).toHaveLength(0);
});
it("a signup racing erasure is skipped at the atomic insertion boundary", async () => {
  const db = fakeDatabase();
  db.beforeSubscriberInsert = () =>
    db.rows.newsletter_erasures.push({ email_sha256: hashEmail("person@example.com") });
  expect(
    await addSubscriber(db.client, { email: "person@example.com", consent_source: "form" }),
  ).toBeNull();
  expect(db.rows.newsletter_subscribers).toHaveLength(0);
});
it("resubscribe requires a reason, refuses cleaned and erased addresses, and records explicit consent", async () => {
  const { db, provider } = await setup("unsubscribed");
  await expect(resubscribeSubscriber(db.client, provider, "person", " ")).rejects.toThrow();
  await resubscribeSubscriber(db.client, provider, "person", "Confirmed request received today");
  expect(db.rows.newsletter_subscribers[0]).toMatchObject({
    status: "subscribed",
    consent_source: "Confirmed request received today",
    resubscribed_at: expect.any(String),
  });
  expect((await provider.findContact("person@example.com"))?.unsubscribed).toBe(false);
  db.rows.newsletter_subscribers[0].status = "cleaned";
  await expect(resubscribeSubscriber(db.client, provider, "person", "reason")).rejects.toThrow(
    "cleaned",
  );
  db.rows.newsletter_subscribers[0].status = "unsubscribed";
  db.rows.newsletter_erasures.push({ email_sha256: hashEmail("person@example.com") });
  await expect(resubscribeSubscriber(db.client, provider, "person", "reason")).rejects.toThrow(
    "erasure",
  );
});
it("profile edits cannot change consent and replace tags without resubscribing", async () => {
  const { db } = await setup("unsubscribed");
  await editSubscriber(db.client, "person", { first_name: "Example", tags: ["new"] });
  expect(db.rows.newsletter_subscribers[0]).toMatchObject({
    status: "unsubscribed",
    tags: ["new"],
  });
  await expect(editSubscriber(db.client, "person", { status: "subscribed" })).rejects.toThrow();
});
it("an already-running signup sync cannot recreate an erased provider contact", async () => {
  const { db, provider } = await setup();
  const audience = await provider.ensureAudience("all");
  const row = structuredClone(db.rows.newsletter_subscribers[0]);
  const create = provider.createContact.bind(provider);
  vi.spyOn(provider, "createContact").mockImplementationOnce(async (input) => {
    await eraseSubscriber(db.client, provider, input.email);
    return create(input);
  });
  const { syncSubscriber } = await import("./subscribers.js");
  await syncSubscriber(db.client, provider, audience, row);
  expect(db.rows.newsletter_subscribers).toHaveLength(0);
  expect(provider.contacts.size).toBe(0);
});
it("failed erasure totals write keeps the profile and events until a successful retry", async () => {
  const { db, provider } = await setup();
  db.failTable = "newsletter_campaigns";
  await expect(eraseSubscriber(db.client, provider, "person@example.com")).rejects.toThrow();
  expect(db.rows.newsletter_subscribers).toHaveLength(1);
  expect(db.rows.newsletter_events.every((e) => e.subscriber_id === "person")).toBe(true);
  db.failTable = null;
  await eraseSubscriber(db.client, provider, "person@example.com");
  expect(db.rows.newsletter_subscribers).toHaveLength(0);
});
it("failed resubscribe persistence suppresses the provider again", async () => {
  const { db, provider } = await setup("unsubscribed");
  vi.spyOn(db.client, "rpc").mockResolvedValueOnce({
    data: null,
    error: { message: "offline" },
  } as any);
  await expect(
    resubscribeSubscriber(db.client, provider, "person", "Fresh consent"),
  ).rejects.toThrow();
  expect((await provider.findContact("person@example.com"))?.unsubscribed).toBe(true);
  expect(db.rows.newsletter_subscribers[0].status).toBe("unsubscribed");
});

it("erasing one recipient preserves their anonymous totals while another recipient's later activity stays live", async () => {
  const { db, provider } = await setup();
  db.rows.newsletter_subscribers.push({
    id: "other",
    email: "other@example.com",
    status: "subscribed",
    tags: [],
    updated_at: "2026-01-01T00:00:00Z",
  });
  const before = await campaignStats(db.client, "campaign");
  await eraseSubscriber(db.client, provider, "person@example.com");
  expect(await campaignStats(db.client, "campaign")).toEqual(before);
  await db.client.from("newsletter_events").insert({
    id: "later",
    provider_event_id: "later",
    campaign_id: "campaign",
    subscriber_id: "other",
    type: "clicked",
    url: "https://example.com/article",
    occurred_at: "2026-01-02",
  });
  expect(await campaignStats(db.client, "campaign")).toMatchObject({
    unique_opens: 1,
    opens: 2,
    unique_clicks: 1,
    clicks: 1,
  });
  expect(db.rows.newsletter_events).toHaveLength(1);
  await eraseSubscriber(db.client, provider, "person@example.com");
  expect(await campaignStats(db.client, "campaign")).toMatchObject({
    unique_opens: 1,
    opens: 2,
    unique_clicks: 1,
    clicks: 1,
  });
});

it("concurrent erasures preserve both recipients once and retain no raw erased history", async () => {
  const { db, provider } = await setup();
  db.rows.newsletter_subscribers.push({
    id: "other",
    email: "other@example.com",
    status: "subscribed",
    tags: [],
    updated_at: "2026-01-01T00:00:00Z",
  });
  db.rows.newsletter_events.push({
    id: "other-open",
    campaign_id: "campaign",
    subscriber_id: "other",
    type: "opened",
    occurred_at: "2026-01-01",
  });
  const before = await campaignStats(db.client, "campaign");
  await Promise.all([
    eraseSubscriber(db.client, provider, "person@example.com"),
    eraseSubscriber(db.client, provider, "other@example.com"),
  ]);
  expect(await campaignStats(db.client, "campaign")).toEqual(before);
  expect(db.rows.newsletter_events).toHaveLength(0);
  expect(db.rows.newsletter_subscribers).toHaveLength(0);
});

it("a changed event set is reread before erasure and contributes exactly once", async () => {
  const { db, provider } = await setup();
  db.beforeFinishErasure = () => {
    db.beforeFinishErasure = undefined;
    db.rows.newsletter_events.push({
      id: "racing",
      campaign_id: "campaign",
      subscriber_id: "person",
      type: "clicked",
      url: "https://example.com/article",
      occurred_at: "2026-01-02",
    });
  };
  await eraseSubscriber(db.client, provider, "person@example.com");
  expect(await campaignStats(db.client, "campaign")).toMatchObject({
    unique_opens: 1,
    opens: 2,
    clicks: 1,
    unique_clicks: 1,
  });
  expect(db.rows.newsletter_events).toHaveLength(0);
});

it("failed finalization validates every campaign before changing any totals or raw history", async () => {
  const { db } = await setup();
  db.rows.newsletter_erasures.push({ email_sha256: hashEmail("person@example.com") });
  db.rows.newsletter_campaigns.push({ id: "second", stats: { delivered: 99 } });
  const before = structuredClone(db.rows);
  const result = await db.client.rpc("newsletter_finish_erasure", {
    p_email: "person@example.com",
    p_hash: hashEmail("person@example.com"),
    p_subscriber_id: "person",
    p_event_ids: ["1", "2"],
    p_campaign_updates: [
      { id: "campaign", expected_stats: null, stats: { kind: "erased", totals: {} } },
      { id: "second", expected_stats: null, stats: { kind: "erased", totals: {} } },
    ],
  });
  expect(result.data).toBe(false);
  expect(db.rows).toEqual(before);
});

it("erasure never changes authoritative imported totals", async () => {
  const { db, provider } = await setup();
  const stats = { delivered: 900, unique_opens: 300, links: [] };
  db.rows.newsletter_campaigns[0].stats = stats;
  db.rows.newsletter_campaigns[0].source = "external";
  await eraseSubscriber(db.client, provider, "person@example.com");
  expect(db.rows.newsletter_campaigns[0].stats).toEqual(stats);
  expect(db.rows.newsletter_events).toHaveLength(0);
});

it("erased and live recipients sharing a link retain separate unique counts", async () => {
  const { db, provider } = await setup();
  db.rows.newsletter_subscribers.push({
    id: "other",
    email: "other@example.com",
    status: "subscribed",
    tags: [],
    updated_at: "2026-01-01T00:00:00Z",
  });
  db.rows.newsletter_events.push(
    ...[
      ["delivered", "person"],
      ["bounced", "person"],
      ["clicked", "person"],
      ["clicked", "person"],
      ["delivered", "other"],
      ["clicked", "other"],
    ].map(([type, subscriber_id], index) => ({
      id: `extra-${index}`,
      campaign_id: "campaign",
      subscriber_id,
      type,
      url: type === "clicked" ? "https://example.com/article" : null,
      occurred_at: "2026-01-01",
    })),
  );
  const before = await campaignStats(db.client, "campaign");
  await eraseSubscriber(db.client, provider, "person@example.com");
  expect(await campaignStats(db.client, "campaign")).toEqual(before);
  expect(before).toMatchObject({
    delivered: 1,
    bounces: 1,
    clicks: 3,
    unique_clicks: 2,
    links: [{ url: "https://example.com/article", clicks: 3, unique_clicks: 2 }],
  });
});

it("a finalization storage error retains the profile and raw history for retry without double counting", async () => {
  const { db, provider } = await setup();
  const before = await campaignStats(db.client, "campaign");
  db.beforeFinishErasure = () => {
    db.beforeFinishErasure = undefined;
    db.failTable = "newsletter_campaigns";
  };
  await expect(eraseSubscriber(db.client, provider, "person@example.com")).rejects.toThrow();
  expect(db.rows.newsletter_campaigns[0].stats).toBeNull();
  expect(db.rows.newsletter_subscribers).toHaveLength(1);
  expect(db.rows.newsletter_events).toHaveLength(2);
  db.failTable = null;
  await eraseSubscriber(db.client, provider, "person@example.com");
  expect(await campaignStats(db.client, "campaign")).toEqual(before);
});
it("erases any address signup accepted, even ones a strict email check would refuse", async () => {
  const db = fakeDatabase();
  const provider = new FakeProvider();
  for (const email of ["jo@bücher.example", "first&last@example.com", "a..b@example.com"]) {
    expect(await addSubscriber(db.client, { email, consent_source: "form" })).toBeTruthy();
    await eraseSubscriber(db.client, provider, email);
    expect(db.rows.newsletter_subscribers.find((r) => r.email === email)).toBeUndefined();
    expect(db.rows.newsletter_erasures.map((r) => r.email_sha256)).toContain(hashEmail(email));
    await clearErasure(db.client, email);
  }
  await expect(eraseSubscriber(db.client, provider, "not an address")).rejects.toThrow();
});
