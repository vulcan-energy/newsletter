import { expect, it, vi } from "vitest";
import { createNewsletter } from "./sending.js";
import { newsletterHandler, tokenRole } from "./http.js";
import { fakeDatabase } from "./testing/database.js";
import { FakeProvider } from "./testing/provider.js";
import { sha256 } from "./subscribers.js";
const ordinary = "o".repeat(43),
  sender = "s".repeat(43),
  agent = "a".repeat(43);
const html = '<p>Example Address</p><a href="{{unsubscribe_url}}">Leave</a>';
import { httpFixture } from "./testing/http.js";
const png = (rest = Buffer.from("fake image")) =>
  Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), rest]).toString("base64");
it.each([null, "wrong", agent])("rejects absent, wrong and unrelated tokens", async (token) => {
  const { request, db } = await httpFixture();
  const response = await request("campaigns", "GET", undefined, token);
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    ok: false,
    code: "unauthorized",
    next_action: expect.any(String),
  });
  expect(db.rows.newsletter_campaigns).toEqual([]);
});
it("does not grant send access when the two configured hashes match", () =>
  expect(tokenRole(`Bearer ${ordinary}`, sha256(ordinary), sha256(ordinary))).toBe("ordinary"));
it.each(["campaigns/id/send", "campaigns/id/stats?people=1"])(
  "ordinary token cannot reach %s",
  async (path) => {
    const { request } = await httpFixture();
    expect(
      (
        await request(
          path,
          path.endsWith("send") ? "POST" : "GET",
          path.endsWith("send") ? {} : undefined,
        )
      ).status,
    ).toBe(403);
  },
);
it.each(["subscribers", "resubscribe", "erase", "import", "clear-erasure"])(
  "neither token exposes administration: %s",
  async (path) => {
    const { request } = await httpFixture();
    for (const token of [ordinary, sender])
      expect((await request(path, "POST", {}, token)).status).toBe(404);
  },
);
it("validates draft dry-run without any write, and records a test only for the configured inbox", async () => {
  const { request, db, provider } = await httpFixture();
  const data = { slug: "issue", subject: "Issue", html, is_public: false };
  expect((await request("campaigns?dry_run=1", "POST", data)).status).toBe(200);
  expect(db.rows.newsletter_campaigns).toHaveLength(0);
  expect(
    (await request("campaigns?dry_run=1", "POST", { ...data, html: "no unsubscribe" })).status,
  ).toBe(422);
  const created = await (await request("campaigns", "POST", data)).json();
  const id = created.data.id;
  const send = vi.spyOn(provider, "sendTest");
  expect((await request(`campaigns/${id}/test`, "POST", { to: "other@example.com" })).status).toBe(
    400,
  );
  expect(send).not.toHaveBeenCalled();
  expect((await request(`campaigns/${id}/test`, "POST", {})).status).toBe(200);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ to: "owner@example.com", subject: "[TEST] Issue" }),
  );
  expect(db.rows.newsletter_campaigns[0].subject).toBe("Issue");
  expect(db.rows.newsletter_campaigns[0].last_test_sha256).toBe(sha256(html));
  const state = await (await request(`campaigns/${id}`)).json();
  expect(state.data.actions.send).toHaveProperty("blockers");
  await request("campaigns", "POST", { ...data, id, html: html + " edit" });
  expect(db.rows.newsletter_campaigns[0].last_test_sha256).toBeNull();
});
it("a test racing an edit cannot certify the edited HTML", async () => {
  const { request, db, provider } = await httpFixture();
  const created = await (
    await request("campaigns", "POST", { slug: "issue", subject: "Issue", html })
  ).json();
  vi.spyOn(provider, "sendTest").mockImplementation(async () => {
    db.rows.newsletter_campaigns[0].updated_at = "2099-01-01";
    db.rows.newsletter_campaigns[0].html_sha256 = "edited";
  });
  expect((await request(`campaigns/${created.data.id}/test`, "POST", {})).status).toBe(409);
  expect(db.rows.newsletter_campaigns[0].last_test_sha256).toBeNull();
});
it("bounds JSON bodies and image uploads", async () => {
  const { request } = await httpFixture();
  expect(
    (
      await request("assets", "POST", {
        filename: "bad.html",
        mime: "text/html",
        base64: Buffer.from("<script>").toString("base64"),
      })
    ).status,
  ).toBe(400);
  expect((await request("campaigns", "POST", { html: "x".repeat(7_100_000) })).status).toBe(413);
});
it("send token records api-token and provider errors have stable safe envelopes", async () => {
  const { request, db, provider } = await httpFixture();
  const created = await (
    await request("campaigns", "POST", { slug: "issue", subject: "Issue", html })
  ).json();
  const id = created.data.id;
  await request(`campaigns/${id}/test`, "POST", {});
  const broadcast = vi.spyOn(provider, "createBroadcast");
  vi.spyOn(provider, "sendBroadcast").mockRejectedValue(new Error("secret email should not leak"));
  const response = await request(
    `campaigns/${id}/send`,
    "POST",
    { expected_recipient_count: 0, review_sha256: created.data.review_sha256 },
    sender,
  );
  expect(response.status).toBe(409);
  expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ subject: "Issue" }));
  const body = await response.json();
  expect(body.code).toBe("send_unknown");
  expect(JSON.stringify(body)).not.toContain("secret email");
  expect(db.rows.newsletter_campaigns[0]).toMatchObject({
    status: "send_unknown",
    sent_by: "api-token",
  });
});
it("stores a valid bounded image and returns its public asset URL", async () => {
  const { request, db } = await httpFixture();
  const upload = vi.fn(async () => ({ data: { path: "asset" }, error: null }));
  Object.assign(db.client, {
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe("newsletter-assets");
        return {
          upload,
          getPublicUrl: (key: string) => ({
            data: { publicUrl: `https://assets.example.com/${key}` },
          }),
        };
      },
    },
  });
  const response = await request("assets", "POST", {
    mime: "image/png",
    base64: png(),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).data.url).toMatch(/^https:\/\/assets.example.com\//);
  expect(upload).toHaveBeenCalledWith(expect.any(String), expect.any(Buffer), {
    contentType: "image/png",
    upsert: false,
  });
  expect(
    (
      await request("assets", "POST", {
        mime: "image/png",
        base64: png(Buffer.alloc(5 * 1024 * 1024 - 8)),
      })
    ).status,
  ).toBe(200);
  upload.mockResolvedValueOnce({ data: null, error: { message: "secret" } } as any);
  const failed = await request("assets", "POST", {
    mime: "image/png",
    base64: png(),
  });
  expect(failed.status).toBe(409);
  expect(await failed.text()).not.toContain("secret");
});
it("reports a sending hold and gives the send token no way to override it", async () => {
  const { request, db, provider } = await httpFixture();
  const created = await (
    await request("campaigns", "POST", { slug: "issue", subject: "Issue", html })
  ).json();
  const id = created.data.id;
  await request(`campaigns/${id}/test`, "POST", {});
  db.rows.newsletter_campaigns.push({ id: "previous", slug: "previous", status: "sent", source: "provider", sent_at: "2026-01-01T00:00:00Z", recipient_count: 40, stats: null });
  for (const type of ["bounced", "bounced", "bounced", "complained"])
    db.rows.newsletter_events.push({ id: `${type}-${db.rows.newsletter_events.length}`, campaign_id: "previous", subscriber_id: `p${db.rows.newsletter_events.length}`, type, occurred_at: "2026-01-02T00:00:00Z", provider_event_id: `e${db.rows.newsletter_events.length}` });
  const state = await (await request(`campaigns/${id}`, "GET", undefined, sender)).json();
  expect(state.data.actions.send).toMatchObject({
    allowed: false,
    blockers: ["The last send had 3 bounces (7.50%), above the 5.00% limit."],
    warnings: ["The last send had 1 complaint (2.50%), above the 0.08% warning level."],
  });
  const broadcast = vi.spyOn(provider, "createBroadcast");
  const confirmation = { expected_recipient_count: 0, review_sha256: created.data.review_sha256 };
  const held = await request(`campaigns/${id}/send`, "POST", confirmation, sender);
  expect(held.status).toBe(409);
  expect((await held.json()).code).toBe("operation_failed");
  // The token API schema has no override field at all.
  const smuggled = await request(
    `campaigns/${id}/send`,
    "POST",
    { ...confirmation, override_limits: true },
    sender,
  );
  expect(smuggled.status).toBe(400);
  expect(broadcast).not.toHaveBeenCalled();
  expect(db.rows.newsletter_campaigns[0].status).toBe("draft");
});
it("uploads only PNG, JPEG, GIF and WebP whose bytes match the declared type", async () => {
  const { request, db } = await httpFixture();
  const upload = vi.fn(async () => ({ data: { path: "asset" }, error: null }));
  Object.assign(db.client, {
    storage: {
      from: () => ({
        upload,
        getPublicUrl: (key: string) => ({ data: { publicUrl: `https://assets.example.com/${key}` } }),
      }),
    },
  });
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
  expect((await request("assets", "POST", { mime: "image/svg+xml", base64: svg.toString("base64") })).status).toBe(400);
  const disguised = await request("assets", "POST", {
    mime: "image/png",
    base64: Buffer.from("<html><script>x</script></html>").toString("base64"),
  });
  expect(disguised.status).toBe(409);
  expect((await disguised.json()).message).toBe("Image bytes do not match image/png");
  const gif = Buffer.from("GIF89a....").toString("base64");
  expect((await request("assets", "POST", { mime: "image/gif", base64: gif })).status).toBe(200);
  expect(upload).toHaveBeenCalledTimes(1);
});
it("tells the caller why a draft or request was refused, without exposing unexpected errors", async () => {
  const { request } = await httpFixture();
  const draft = { slug: "issue", subject: "Issue", html, is_public: false };
  const missingFooter = await request("campaigns?dry_run=1", "POST", {
    ...draft,
    html: '<a href="{{unsubscribe_url}}">Leave</a>',
  });
  expect(missingFooter.status).toBe(422);
  expect(await missingFooter.json()).toMatchObject({
    code: "operation_failed",
    message: "Footer address required",
  });
  const badSlug = await request("campaigns", "POST", { ...draft, slug: "Bad Slug" });
  expect(badSlug.status).toBe(400);
  expect((await badSlug.json()).message).toMatch(/^Input does not match the schema: slug /);
});
it("status shows an unresolved send elsewhere as a blocker, and a malformed id plainly", async () => {
  const { request, db } = await httpFixture();
  const created = await (await request("campaigns", "POST", { slug: "issue", subject: "Issue", html })).json();
  await request(`campaigns/${created.data.id}/test`, "POST", {});
  db.rows.newsletter_campaigns.push({ id: "stuck", slug: "stuck", status: "send_unknown", source: "provider", provider_broadcast_id: "b", updated_at: new Date().toISOString() });
  const state = await (await request(`campaigns/${created.data.id}`, "GET", undefined, sender)).json();
  expect(state.data.actions.send.allowed).toBe(false);
  expect(state.data.actions.send.blockers).toContain(
    "Another send is in progress or has an unknown outcome; resolve it first",
  );
  const bad = await request("campaigns/bad$id", "GET");
  expect(bad.status).toBe(400);
  expect((await bad.json()).message).toBe("Invalid campaign ID");
});
it("serves the API wherever the host mounts it", async () => {
  const { core } = await httpFixture();
  const handler = newsletterHandler(core, { basePath: "/newsletter-api" });
  const get = (path: string) =>
    handler(new Request(`https://example.com${path}`, { headers: { authorization: `Bearer ${ordinary}` } }));
  expect((await get("/newsletter-api/campaigns")).status).toBe(200);
  expect((await get("/api/newsletter/v1/campaigns")).status).toBe(404);
});
