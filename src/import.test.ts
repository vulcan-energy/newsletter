import { expect, it, vi, afterEach } from "vitest";
import { importSubscriber, hashEmail } from "./subscribers.js";
afterEach(() => vi.useRealTimers());
import { fakeDatabase } from "./testing/database.js";
it("reruns never restore consent and external suppression reaches a pre-import signup", async () => {
  const db = fakeDatabase();
  const input = {
    email: " PERSON@EXAMPLE.COM ",
    status: "subscribed" as const,
    tags: ["one"],
    consent_source: "external",
    status_changed_at: "2026-01-01T00:00:00Z",
  };
  const first = await importSubscriber(db.client, input);
  await importSubscriber(db.client, {
    ...input,
    status: "unsubscribed",
    status_changed_at: "2026-02-01T00:00:00Z",
  });
  const last = await importSubscriber(db.client, input);
  expect(last?.id).toBe(first?.id);
  expect(last?.status).toBe("unsubscribed");
  expect(db.rows.newsletter_subscribers).toHaveLength(1);
});
it("erasure prevents import and a newer explicit resubscribe survives old suppression", async () => {
  const db = fakeDatabase({
    newsletter_erasures: [{ email_sha256: hashEmail("erased@example.com") }],
  });
  expect(
    await importSubscriber(db.client, {
      email: "erased@example.com",
      status: "subscribed",
      consent_source: "external",
      tags: [],
    }),
  ).toBeNull();
  db.rows.newsletter_subscribers = [
    {
      id: "a",
      email: "person@example.com",
      status: "subscribed",
      tags: [],
      resubscribed_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    },
  ];
  expect(
    (
      await importSubscriber(db.client, {
        email: "person@example.com",
        status: "unsubscribed",
        status_changed_at: "2026-02-01T00:00:00Z",
        consent_source: "external",
        tags: [],
      })
    )?.status,
  ).toBe("subscribed");
});

it("advances the optimistic version even when two writes share a millisecond", async () => {
  vi.useFakeTimers();
  const db = fakeDatabase();
  const input = {
    email: "clock@example.com",
    status: "subscribed" as const,
    consent_source: "external",
    tags: [],
  };
  const first = await importSubscriber(db.client, input);
  const second = await importSubscriber(db.client, input);
  expect(Date.parse(second.updated_at)).toBeGreaterThan(
    Date.parse(first.updated_at),
  );
});
