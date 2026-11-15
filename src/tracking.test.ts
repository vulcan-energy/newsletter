import { afterEach, expect, it, vi } from "vitest";
import { handleTrackingRequest, setTrackingConsent } from "./tracking.js";
import { fakeDatabase } from "./testing/database.js";
import { hashEmail } from "./subscribers.js";
import { eraseSubscriber } from "./admin.js";
import { FakeProvider } from "./testing/provider.js";
const campaign = "11111111-1111-4111-8111-111111111111";
const token = "22222222-2222-4222-8222-222222222222";
const now = "2026-11-03T12:00:00.000Z";
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  return fakeDatabase({
    newsletter_subscribers: [
      {
        id: "person",
        email: "person@example.com",
        status: "subscribed",
        updated_at: "2026-10-01T00:00:00.000Z",
        tracking_token: token,
        tracking_consent_source: "explicit checkbox v1",
        tracking_granted_at: "2026-10-01T00:00:00.000Z",
        tracking_revoked_at: null,
      },
    ],
    newsletter_campaigns: [
      {
        id: campaign,
        status: "sent",
        provider_broadcast_id: "broadcast",
        tracking_started_at: "2026-11-01T00:00:00.000Z",
        sent_at: "2026-11-01T00:00:00.000Z",
        tracking_links: ["https://example.com/article?edition=1&part=2"],
      },
    ],
  });
}
const request = (action = "0", value = token, method = "GET", headers = {}) =>
  new Request(
    `https://example.com/tracking/${campaign}/${action}?token=${value}`,
    { method, headers },
  );
afterEach(() => vi.useRealTimers());
it("records consented clicks and opens with canonical destinations and privacy response headers", async () => {
  const db = setup();
  const click = await handleTrackingRequest(db.client, request());
  expect(click.status).toBe(302);
  expect(click.headers.get("location")).toBe(
    "https://example.com/article?edition=1&part=2",
  );
  expect(click.headers.get("referrer-policy")).toBe("no-referrer");
  expect(click.headers.get("cache-control")).toBe("no-store");
  const open = await handleTrackingRequest(db.client, request("open"));
  expect(open.status).toBe(200);
  expect(open.headers.get("content-type")).toBe("image/gif");
  expect(db.rows.newsletter_events).toEqual([
    expect.objectContaining({
      campaign_id: campaign,
      subscriber_id: "person",
      type: "clicked",
      url: "https://example.com/article?edition=1&part=2",
    }),
    expect.objectContaining({
      campaign_id: campaign,
      subscriber_id: "person",
      type: "opened",
      url: null,
    }),
  ]);
  expect(JSON.stringify(db.rows.newsletter_events)).not.toContain(token);
});
it.each(["none", "", "invalid", "33333333-3333-4333-8333-333333333333"])(
  "anonymous or invalid token %s follows the same link without activity",
  async (value) => {
    const db = setup();
    expect(
      (await handleTrackingRequest(db.client, request("0", value))).status,
    ).toBe(302);
    expect(
      (await handleTrackingRequest(db.client, request("open", value))).status,
    ).toBe(200);
    expect(db.rows.newsletter_events).toHaveLength(0);
  },
);
it("withdrawal and re-consent never reactivate old mail, including a queued broadcast using a fresh token", async () => {
  const db = setup();
  const revoked = await setTrackingConsent(db.client, "person", null);
  expect(revoked).toMatchObject({
    tracking_token: null,
    tracking_consent_source: "explicit checkbox v1",
    tracking_revoked_at: now,
  });
  expect(Date.parse(revoked.updated_at)).toBeGreaterThan(
    Date.parse("2026-10-01"),
  );
  await handleTrackingRequest(db.client, request());
  const renewed = await setTrackingConsent(
    db.client,
    "person",
    "explicit checkbox v2",
  );
  expect(renewed.tracking_token).not.toBe(token);
  expect(renewed.tracking_token).toMatch(/^[0-9a-f-]{36}$/);
  expect(renewed.tracking_revoked_at).toBeNull();
  await handleTrackingRequest(db.client, request());
  await handleTrackingRequest(db.client, request("0", renewed.tracking_token!));
  expect(db.rows.newsletter_events).toHaveLength(0);
  db.rows.newsletter_campaigns[0].tracking_started_at =
    "2026-11-04T00:00:00.000Z";
  vi.setSystemTime("2026-11-05T00:00:00Z");
  await handleTrackingRequest(db.client, request("0", renewed.tracking_token!));
  expect(db.rows.newsletter_events).toHaveLength(1);
});
it("requires grant proof, current subscription and no erasure tombstone", async () => {
  const db = setup();
  await expect(setTrackingConsent(db.client, "person", "  ")).rejects.toThrow();
  db.rows.newsletter_subscribers[0].status = "unsubscribed";
  await expect(
    setTrackingConsent(db.client, "person", "proof"),
  ).rejects.toThrow();
  db.rows.newsletter_subscribers[0].status = "subscribed";
  db.rows.newsletter_erasures.push({
    email_sha256: hashEmail("person@example.com"),
  });
  await expect(
    setTrackingConsent(db.client, "person", "proof"),
  ).rejects.toThrow();
  await handleTrackingRequest(db.client, request());
  expect(db.rows.newsletter_events).toHaveLength(0);
});
it("HEAD, expired issues, unsent drafts and suppressed subscribers never collect activity", async () => {
  const db = setup();
  expect(
    (await handleTrackingRequest(db.client, request("0", token, "HEAD")))
      .status,
  ).toBe(302);
  const head = await handleTrackingRequest(
    db.client,
    request("open", token, "HEAD"),
  );
  expect(await head.text()).toBe("");
  db.rows.newsletter_campaigns[0].tracking_started_at =
    "2024-11-03T12:00:00.000Z";
  await handleTrackingRequest(db.client, request());
  db.rows.newsletter_campaigns[0].tracking_started_at = "2026-11-01T00:00:00Z";
  db.rows.newsletter_campaigns[0].status = "draft";
  await handleTrackingRequest(db.client, request());
  db.rows.newsletter_campaigns[0].status = "sent";
  db.rows.newsletter_subscribers[0].status = "unsubscribed";
  await handleTrackingRequest(db.client, request());
  expect(db.rows.newsletter_events).toHaveLength(0);
});
it.each(["sending", "send_unknown"])(
  "accepts early activity for %s with a persisted broadcast id",
  async (status) => {
    const db = setup();
    db.rows.newsletter_campaigns[0].status = status;
    await handleTrackingRequest(db.client, request());
    expect(db.rows.newsletter_events).toHaveLength(1);
    db.rows.newsletter_events.length = 0;
    db.rows.newsletter_campaigns[0].provider_broadcast_id = null;
    await handleTrackingRequest(db.client, request());
    expect(db.rows.newsletter_events).toHaveLength(0);
  },
);
it("a consent change between lookup and event insertion fails closed", async () => {
  const db = setup();
  const original = db.client.rpc.bind(db.client);
  vi.spyOn(db.client, "rpc").mockImplementationOnce(async (...args: any[]) => {
    await setTrackingConsent(db.client, "person", null);
    return original(args[0], args[1]);
  });
  expect((await handleTrackingRequest(db.client, request())).status).toBe(302);
  expect(db.rows.newsletter_events).toHaveLength(0);
});
it("preferences GET only confirms; same-origin POST revokes that exact token and stale POST cannot revoke a fresh grant", async () => {
  const db = setup();
  const form = await handleTrackingRequest(db.client, request("preferences"));
  expect(await form.text()).toContain('method="post"');
  expect(db.rows.newsletter_subscribers[0].tracking_token).toBe(token);
  expect(
    (
      await handleTrackingRequest(
        db.client,
        request("preferences", token, "POST", {
          origin: "https://evil.example",
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await handleTrackingRequest(
        db.client,
        request("preferences", token, "POST", {
          origin: "https://example.com",
        }),
      )
    ).status,
  ).toBe(200);
  const renewed = await setTrackingConsent(db.client, "person", "fresh proof");
  await handleTrackingRequest(db.client, request("preferences", token, "POST"));
  expect(db.rows.newsletter_subscribers[0].tracking_token).toBe(
    renewed.tracking_token,
  );
  expect(db.rows.newsletter_events).toHaveLength(0);
});
it("failed collection does not break the destination, but failed withdrawal never claims success", async () => {
  const db = setup();
  db.failEventInsert = true;
  expect((await handleTrackingRequest(db.client, request())).status).toBe(302);
  db.failNext = { table: "newsletter_subscribers", op: "update" };
  expect(
    (
      await handleTrackingRequest(
        db.client,
        request("preferences", token, "POST"),
      )
    ).status,
  ).toBe(503);
  expect(db.rows.newsletter_subscribers[0].tracking_token).toBe(token);
});
it("rejects unsafe stored destinations, invalid routes, duplicate token parameters and write methods on collectors", async () => {
  const db = setup();
  for (const url of [
    "javascript:alert(1)",
    "https://user:pass@example.com",
    "//evil.example",
    "https://example.com/\r\nX:yes",
  ]) {
    db.rows.newsletter_campaigns[0].tracking_links[0] = url;
    expect((await handleTrackingRequest(db.client, request())).status).toBe(
      404,
    );
  }
  expect((await handleTrackingRequest(db.client, request("1"))).status).toBe(
    404,
  );
  expect(
    (await handleTrackingRequest(db.client, request("0", token, "POST")))
      .status,
  ).toBe(405);
  expect(
    (
      await handleTrackingRequest(
        db.client,
        new Request(request().url + "&token=none"),
      )
    ).status,
  ).toBe(400);
  expect(db.rows.newsletter_events).toHaveLength(0);
});
it("the insertion boundary grants only explicit tracking proof and suppression cannot revive a token", async () => {
  const db = setup();
  const create = async (email: string, tracking_consent_source?: string) =>
    db.client.rpc("newsletter_insert_subscriber", {
      p_hash: hashEmail(email),
      p_row: {
        email,
        status: "subscribed",
        tags: [],
        consent_source: "newsletter form",
        tracking_consent_source,
        updated_at: now,
      },
    });
  await create("plain@example.com");
  await create("consented@example.com", "separate tracking checkbox v1");
  expect(db.rows.newsletter_subscribers[1].tracking_token).toBeNull();
  const consented = db.rows.newsletter_subscribers[2];
  expect(consented.tracking_token).toMatch(/^[0-9a-f-]{36}$/);
  await db.client
    .from("newsletter_subscribers")
    .update({ status: "unsubscribed", updated_at: consented.updated_at })
    .eq("id", consented.id);
  expect(consented.tracking_token).toBeNull();
  expect(Date.parse(consented.updated_at)).toBeGreaterThan(Date.parse(now));
  await db.client.rpc("newsletter_resubscribe", {
    p_id: consented.id,
    p_hash: hashEmail(consented.email),
    p_expected_updated_at: consented.updated_at,
    p_reason: "newsletter resubscribe only",
  });
  expect(consented.status).toBe("subscribed");
  expect(consented.tracking_token).toBeNull();
});
it("persisted broadcast destinations cannot change while aggregate reports remain editable", async () => {
  const db = setup();
  const changed = await db.client
    .from("newsletter_campaigns")
    .update({ tracking_links: ["https://evil.example"] })
    .eq("id", campaign);
  expect(changed.error).not.toBeNull();
  expect(db.rows.newsletter_campaigns[0].tracking_links).toEqual([
    "https://example.com/article?edition=1&part=2",
  ]);
  const report = await db.client
    .from("newsletter_campaigns")
    .update({ stats: { delivered: 1 } })
    .eq("id", campaign);
  expect(report.error).toBeNull();
});
it("a post-cutoff grant in the same millisecond cannot enable a queued old broadcast", async () => {
  const db = setup();
  db.rows.newsletter_subscribers[0].tracking_granted_at =
    "2026-11-01T00:00:00.000001+00:00";
  await handleTrackingRequest(db.client, request());
  expect(db.rows.newsletter_events).toHaveLength(0);
  db.rows.newsletter_subscribers[0].tracking_granted_at =
    "2026-11-01T00:00:00.000000+00:00";
  await handleTrackingRequest(db.client, request());
  expect(db.rows.newsletter_events).toHaveLength(1);
});
it("cannot clear a persisted broadcast id to bypass immutable tracking destinations", async () => {
  const db = setup();
  const result = await db.client
    .from("newsletter_campaigns")
    .update({ provider_broadcast_id: null })
    .eq("id", campaign);
  expect(result.error).not.toBeNull();
  expect(db.rows.newsletter_campaigns[0].provider_broadcast_id).toBe(
    "broadcast",
  );
});

it("erasure between token lookup and insertion cannot recreate recipient history", async () => {
  const db = setup();
  const original = db.client.rpc.bind(db.client);
  vi.spyOn(db.client, "rpc").mockImplementationOnce(async (...args: any[]) => {
    await eraseSubscriber(db.client, new FakeProvider(), "person@example.com");
    return original(args[0], args[1]);
  });
  expect((await handleTrackingRequest(db.client, request())).status).toBe(302);
  expect(db.rows.newsletter_subscribers).toHaveLength(0);
  expect(db.rows.newsletter_events).toHaveLength(0);
  expect(db.rows.newsletter_erasures).toHaveLength(1);
});

it("coalesces concurrent and repeated activity per person, link and minute", async () => {
  const db = setup();
  db.rows.newsletter_campaigns[0].tracking_links.push(
    "https://example.com/second",
  );
  await Promise.all(
    Array.from({ length: 20 }, () =>
      handleTrackingRequest(db.client, request()),
    ),
  );
  expect(db.rows.newsletter_events).toHaveLength(1);
  await handleTrackingRequest(db.client, request("1"));
  await handleTrackingRequest(db.client, request("open"));
  expect(db.rows.newsletter_events).toHaveLength(3);
  vi.setSystemTime("2026-11-03T12:01:00.000Z");
  await handleTrackingRequest(db.client, request());
  expect(db.rows.newsletter_events).toHaveLength(4);
});
it("draft links redirect only while still in the draft, and for at most 72 hours after its last test or edit", async () => {
  const db = setup();
  const draft = db.rows.newsletter_campaigns[0];
  Object.assign(draft, {
    status: "draft",
    provider_broadcast_id: null,
    tracking_started_at: null,
    sent_at: null,
    html: '<a href="https://example.com/article?edition=1&amp;part=2">Read</a>',
    updated_at: "2026-11-03T11:00:00.000Z",
  });
  expect((await handleTrackingRequest(db.client, request("0", "none"))).status).toBe(302);
  // An edit removed the link, but the tested links were left behind.
  draft.html = '<a href="https://example.com/other">Other</a>';
  expect((await handleTrackingRequest(db.client, request("0", "none"))).status).toBe(404);
  draft.html = '<a href="https://example.com/article?edition=1&amp;part=2">Read</a>';
  vi.setSystemTime("2026-11-06T12:00:00.000Z");
  expect((await handleTrackingRequest(db.client, request("0", "none"))).status).toBe(404);
});
it("a failed campaign's test links stop redirecting like a draft's", async () => {
  const db = setup();
  Object.assign(db.rows.newsletter_campaigns[0], {
    status: "failed",
    provider_broadcast_id: null,
    tracking_started_at: null,
    sent_at: null,
    html: '<a href="https://example.com/article?edition=1&amp;part=2">Read</a>',
    updated_at: "2020-01-01T00:00:00.000Z",
  });
  expect((await handleTrackingRequest(db.client, request("0", "none"))).status).toBe(404);
});
