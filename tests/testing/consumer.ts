import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { sha256, type EmailProvider, type NewsletterConfig } from "@vulcan-energy/newsletter";
import { createHost } from "./host.js";

const unexpected = (): never => {
  throw new Error("Unexpected storage, provider or network call");
};
let verified = 0;
const provider: EmailProvider = {
  async *listContacts() {
    unexpected();
  },
  assertTrackingDisabled: unexpected,
  setTrackingToken: unexpected,
  findContact: unexpected,
  createContact: unexpected,
  deleteContact: unexpected,
  setUnsubscribed: unexpected,
  resubscribe: unexpected,
  ensureAudience: unexpected,
  addToAudience: unexpected,
  removeFromAudience: unexpected,
  createBroadcast: unexpected,
  sendBroadcast: unexpected,
  getBroadcastState: unexpected,
  sendTest: unexpected,
  parseWebhook(body, headers) {
    assert.equal(body, "synthetic payload");
    if (headers.get("x-fake-signature") !== "valid")
      throw new Error("Invalid signature");
    verified++;
    return [];
  },
};
const ordinary = "a".repeat(43);
const config: NewsletterConfig & { newsletterDomain: string } = {
  supabase: createClient("https://database.invalid", "fake-key", {
    global: { fetch: unexpected },
  }),
  provider,
  audienceId: "test-audience",
  from: "Newsletter <sender@example.com>",
  replyTo: "reply@example.com",
  newsletterDomain: "example.com",
  footerAddress: "Example Company, 1 Example Street",
  publicPageUrl: (slug) => `https://example.com/newsletter/${slug}`,
  testRecipient: "owner@example.com",
  tokenHash: sha256(ordinary),
  sendTokenHash: sha256("b".repeat(43)),
  fetch: unexpected,
};
const host = createHost(config);
const request = (path: string, body?: unknown, token = ordinary) =>
  new Request(`https://example.com${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
const draft = {
  slug: "first-issue",
  subject: "First issue",
  html: `<p>${config.footerAddress}</p><a href="{{unsubscribe_url}}">Unsubscribe</a>`,
};
const valid = await host(
  request("/api/newsletter/v1/campaigns?dry_run=1", draft),
);
assert.equal(valid.status, 200);
assert.equal((await valid.json()).data.dry_run, true);
assert.equal(
  (
    await host(
      request("/api/newsletter/v1/campaigns?dry_run=1", {
        ...draft,
        html: "Missing footer and link",
      }),
    )
  ).status,
  422,
);
assert.equal(
  (
    await host(
      request("/api/newsletter/v1/campaigns?dry_run=1", draft, "wrong"),
    )
  ).status,
  401,
);
assert.equal(
  (await host(request("/api/newsletter/v1/campaigns/example/send"))).status,
  403,
);
assert.equal(
  (await host(request("/api/newsletter/v1/subscribers"))).status,
  404,
);
assert.equal(
  (await host(new Request("https://example.com/unmounted"))).status,
  404,
);
for (const [signature, status] of [
  ["invalid", 401],
  ["valid", 200],
] as const) {
  const result = await host(
    new Request("https://example.com/api/webhooks/newsletter", {
      method: "POST",
      body: "synthetic payload",
      headers: { "x-fake-signature": signature },
    }),
  );
  assert.equal(result.status, status);
}
assert.equal(verified, 1);
// The public example must mount the same normalized base path as delivery rendering.
const trackingHost = createHost({
  ...config,
  trackingBaseUrl: "https://example.com/api/newsletter/tracking/",
});
assert.equal(
  (
    await trackingHost(
      new Request(
        "https://example.com/api/newsletter/tracking/00000000-0000-4000-8000-000000000001/open",
        { method: "PUT" },
      ),
    )
  ).status,
  405,
);
