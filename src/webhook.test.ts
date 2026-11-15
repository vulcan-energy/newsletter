import { expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createResendProvider } from "./providers/resend.js";
import { webhookHandler } from "./webhook.js";
import { fakeDatabase } from "./testing/database.js";
const secret =
  "whsec_" + Buffer.from("fake-signature-key-for-tests").toString("base64");
function signed(name: string, id = "delivery-1") {
  const raw = readFileSync(
    new URL(`../fixtures/${name}.json`, import.meta.url),
    "utf8",
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${id}.${timestamp}.${raw}`)
    .digest("base64");
  const headers = new Headers({
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  });
  return {
    raw,
    headers,
    request: () =>
      new Request("https://example.com/webhook", {
        method: "POST",
        body: raw,
        headers,
      }),
  };
}
function setup(status = "subscribed") {
  const db = fakeDatabase({
    newsletter_subscribers: [
      {
        id: "person",
        email: "subscriber@example.com",
        status,
        provider_contact_id: "provider-person",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    newsletter_campaigns: [
      {
        id: "campaign",
        provider_broadcast_id: "00000000-0000-4000-8000-000000000015",
      },
      {
        id: "click-campaign",
        provider_broadcast_id: "00000000-0000-4000-8000-000000000004",
      },
    ],
  });
  const provider = createResendProvider("fake", secret);
  provider.setUnsubscribed = vi.fn(async () => {});
  return {
    db,
    provider,
    handle: webhookHandler({
      supabase: db.client,
      provider,
      newsletterDomain: "news.example.com",
    }),
  };
}
it("signature verifies the original bytes and normalisation removes identifying transport fields", () => {
  const event = signed("email-clicked-broadcast");
  const provider = createResendProvider("fake", secret);
  const normalized = provider.parseWebhook(event.raw, event.headers);
  expect(normalized[0].url).toBe("https://example.com/docs");
  expect(JSON.stringify(normalized)).not.toMatch(
    /ipAddress|userAgent|headers|REDACTED/,
  );
  expect(() =>
    provider.parseWebhook(JSON.stringify(JSON.parse(event.raw)), event.headers),
  ).toThrow();
});
it("bad signature stores nothing and returns 401", async () => {
  const { handle, db } = setup();
  expect(
    (
      await handle(
        new Request("https://example.com", { method: "POST", body: "{}" }),
      )
    ).status,
  ).toBe(401);
  expect(db.rows.newsletter_events).toHaveLength(0);
});
it("duplicate bounce cleans once and records one event", async () => {
  const { handle, db } = setup();
  const input = signed("email-bounced-broadcast");
  expect((await handle(input.request())).status).toBe(200);
  expect((await handle(input.request())).status).toBe(200);
  expect(db.rows.newsletter_subscribers[0].status).toBe("cleaned");
  expect(db.rows.newsletter_events).toHaveLength(1);
});
it("a provider failure returns 500; retry completes suppression and records the event", async () => {
  const { handle, db, provider } = setup();
  vi.mocked(provider.setUnsubscribed).mockRejectedValueOnce(
    new Error("private recipient details"),
  );
  const event = signed("email-bounced-broadcast");
  expect((await handle(event.request())).status).toBe(500);
  expect(db.rows.newsletter_events).toHaveLength(0);
  expect(db.rows.newsletter_subscribers[0].status).toBe("cleaned");
  expect((await handle(event.request())).status).toBe(200);
  expect(db.rows.newsletter_subscribers[0].status).toBe("cleaned");
});
it("transaction rollback between status and insert permits a complete retry", async () => {
  const { handle, db } = setup();
  db.failEventInsert = true;
  const event = signed("contact-updated-unsubscribe");
  expect((await handle(event.request())).status).toBe(500);
  expect(db.rows.newsletter_subscribers[0].status).toBe("subscribed");
  db.failEventInsert = false;
  expect((await handle(event.request())).status).toBe(200);
  expect(db.rows.newsletter_events).toHaveLength(1);
});
it("transactional delivery is ignored, but newsletter-domain permanent bounce is retained", async () => {
  const { handle, db } = setup();
  expect(
    (await handle(signed("email-delivered-transactional").request())).status,
  ).toBe(200);
  expect(db.rows.newsletter_events).toHaveLength(0);
  expect(
    (await handle(signed("email-bounced-transactional").request())).status,
  ).toBe(200);
  expect(db.rows.newsletter_events[0].campaign_id).toBeNull();
});
it("own contact update leaves cleaned alone; late delivery does not restore status", async () => {
  const { handle, db } = setup("cleaned");
  await handle(signed("contact-updated-api-patch").request());
  expect(db.rows.newsletter_events).toHaveLength(0);
  await handle(signed("email-delivered-broadcast", "late").request());
  expect(db.rows.newsletter_subscribers[0].status).toBe("cleaned");
});
it("unknown addresses retain anonymous known-broadcast events", async () => {
  const { handle, db } = setup();
  db.rows.newsletter_subscribers = [];
  await handle(signed("email-clicked-broadcast").request());
  expect(db.rows.newsletter_events[0].subscriber_id).toBeNull();
});
it("a contact unsubscribe records exactly one transition without a campaign", async () => {
  const { handle, db } = setup();
  const event = signed("contact-updated-unsubscribe");
  await handle(event.request());
  await handle(event.request());
  expect(db.rows.newsletter_subscribers[0].status).toBe("unsubscribed");
  expect(db.rows.newsletter_events).toHaveLength(1);
  expect(db.rows.newsletter_events[0].campaign_id).toBeNull();
});
it("errors do not log payloads or addresses", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { handle, provider } = setup();
    vi.mocked(provider.setUnsubscribed).mockRejectedValue(
      new Error("subscriber@example.com"),
    );
    await handle(signed("email-bounced-broadcast").request());
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it("newsletter-domain complaint without a broadcast suppresses the known contact", async () => {
  const { handle, db } = setup();
  db.rows.newsletter_subscribers[0].email = "complained@resend.dev";
  expect(
    (await handle(signed("email-complained-transactional").request())).status,
  ).toBe(200);
  expect(db.rows.newsletter_subscribers[0].status).toBe("unsubscribed");
  expect(db.rows.newsletter_events[0].campaign_id).toBeNull();
});
it("an unknown broadcast and a different-domain transactional bounce are ignored", async () => {
  const { db, provider, handle } = setup();
  db.rows.newsletter_campaigns = [];
  await handle(signed("email-delivered-broadcast").request());
  expect(db.rows.newsletter_events).toHaveLength(0);
  const other = webhookHandler({
    supabase: db.client,
    provider,
    newsletterDomain: "different.example.com",
  });
  await other(signed("email-bounced-transactional").request());
  expect(db.rows.newsletter_events).toHaveLength(0);
});

it("erased addresses cannot recreate raw event history on late delivery or replay", async () => {
  const { handle, db, provider } = setup();
  const { hashEmail } = await import("./subscribers.js");
  db.rows.newsletter_erasures.push({
    email_sha256: hashEmail("subscriber@example.com"),
  });
  db.rows.newsletter_subscribers.splice(0);
  const input = signed("email-bounced-broadcast");
  expect((await handle(input.request())).status).toBe(200);
  expect((await handle(input.request())).status).toBe(200);
  expect(db.rows.newsletter_events).toHaveLength(0);
  expect(provider.setUnsubscribed).not.toHaveBeenCalled();
});
it("ignores native engagement for own-tracked campaigns while keeping delivery", async () => {
  const { handle, db } = setup();
  db.rows.newsletter_campaigns.forEach(
    (c) => (c.tracking_started_at = "2026-01-01T00:00:00Z"),
  );
  await handle(signed("email-clicked-broadcast").request());
  expect(db.rows.newsletter_events).toHaveLength(0);
  await handle(signed("email-delivered-broadcast").request());
  expect(db.rows.newsletter_events).toHaveLength(1);
});
it("host can disable delayed native engagement from pre-switch campaigns too", async () => {
  const { db, provider } = setup();
  const handle = webhookHandler({
    supabase: db.client,
    provider,
    newsletterDomain: "news.example.com",
    ignoreEngagement: true,
  });
  await handle(signed("email-clicked-broadcast").request());
  expect(db.rows.newsletter_events).toHaveLength(0);
});
it("an opt-out from before an explicit resubscribe does not undo it when delivered late", async () => {
  const { handle, db, provider } = setup();
  db.rows.newsletter_subscribers[0].resubscribed_at = "2026-11-10T00:00:00Z";
  // The fixture's opt-out happened on 2026-11-02, before the resubscribe.
  expect((await handle(signed("contact-updated-unsubscribe").request())).status).toBe(200);
  expect(db.rows.newsletter_subscribers[0].status).toBe("subscribed");
  expect(provider.setUnsubscribed).not.toHaveBeenCalled();
  db.rows.newsletter_subscribers[0].resubscribed_at = "2026-11-01T00:00:00Z";
  await handle(signed("contact-updated-unsubscribe", "delivery-2").request());
  expect(db.rows.newsletter_subscribers[0].status).toBe("unsubscribed");
});
it("reports webhook failures to onError so they are not invisible", async () => {
  const { db, provider } = setup();
  const onError = vi.fn();
  const handle = webhookHandler({ supabase: db.client, provider, newsletterDomain: "news.example.com", onError });
  provider.setUnsubscribed = vi.fn(async () => {
    throw new Error("provider down");
  });
  expect((await handle(signed("email-bounced-broadcast").request())).status).toBe(500);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "provider down" }));
});
