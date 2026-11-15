import { expect, it } from "vitest";
import { addSubscriber, syncSubscriber, hashEmail } from "./subscribers.js";
import { fakeDatabase } from "./testing/database.js";
import { FakeProvider } from "./testing/provider.js";
for (const status of ["subscribed", "unsubscribed", "cleaned"] as const)
  it(`signup preserves ${status} and pushes suppression`, async () => {
    const db = fakeDatabase({
      newsletter_subscribers: [
        {
          id: "person",
          email: "person@example.com",
          status,
          tags: ["old"],
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const provider = new FakeProvider();
    const audience = await provider.ensureAudience("everyone");
    const row = await addSubscriber(db.client, {
      email: "person@example.com",
      consent_source: "form",
      tags: ["new"],
    });
    expect(row.status).toBe(status);
    expect(row.tags).toEqual(["old", "new"]);
    await syncSubscriber(db.client, provider, audience, row);
    expect((await provider.findContact(row.email))?.unsubscribed).toBe(
      status !== "subscribed",
    );
  });
it("erased signup stores nothing and new signup preserves a provider opt-out", async () => {
  const db = fakeDatabase({
    newsletter_erasures: [{ email_sha256: hashEmail("erased@example.com") }],
  });
  expect(
    await addSubscriber(db.client, {
      email: "erased@example.com",
      consent_source: "form",
    }),
  ).toBeNull();
  const provider = new FakeProvider();
  const audience = await provider.ensureAudience("everyone");
  await provider.createContact({
    email: "person@example.com",
    unsubscribed: true,
  });
  const row = await addSubscriber(db.client, {
    email: "person@example.com",
    consent_source: "form",
  });
  await syncSubscriber(db.client, provider, audience, row);
  expect((await provider.findContact(row.email))?.unsubscribed).toBe(true);
  expect(row.consent_ip).toBeUndefined();
});
