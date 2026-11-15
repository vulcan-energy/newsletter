import { expect, it, vi, afterEach } from "vitest";
import { createResendProvider } from "./resend.js";
import { readFileSync } from "node:fs";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("looks up before create and preserves an existing opt-out; raw creates really reset it", async () => {
  const contact = JSON.parse(
    readFileSync(
      new URL(
        "../../fixtures/contact-updated-unsubscribe.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).data;
  let posts = 0;
  const fake = vi.fn(async (url, init) => {
    if (init.method === "POST") {
      posts++;
      contact.unsubscribed = JSON.parse(init.body).unsubscribed ?? false;
    }
    return Response.json(contact);
  });
  vi.stubGlobal("fetch", fake);
  const provider = createResendProvider("fake");
  expect(
    await provider.createContact({ email: contact.email, unsubscribed: false }),
  ).toBe(contact.id);
  expect(contact.unsubscribed).toBe(true);
  expect(posts).toBe(0);
  await fake("https://api.resend.com/contacts", {
    method: "POST",
    body: JSON.stringify({ email: contact.email }),
  });
  expect(contact.unsubscribed).toBe(false);
});
it("new contact explicitly carries its suppression, and lookup errors abort", async () => {
  vi.useFakeTimers();
  const fake = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ name: "not_found", message: "missing" }, { status: 404 }),
    )
    .mockResolvedValueOnce(Response.json({ id: "new" }));
  vi.stubGlobal("fetch", fake);
  const provider = createResendProvider("fake");
  const result = provider.createContact({
    email: "new@example.com",
    unsubscribed: true,
  });
  await vi.runAllTimersAsync();
  expect(await result).toBe("new");
  expect(JSON.parse(fake.mock.calls[1][1].body).unsubscribed).toBe(true);
  fake.mockResolvedValueOnce(
    Response.json(
      { name: "restricted_api_key", message: "private" },
      { status: 401 },
    ),
  );
  const failed = expect(
    provider.findContact("new@example.com"),
  ).rejects.toThrow("Provider request failed");
  await vi.runAllTimersAsync();
  await failed;
});
it("paginates contacts and segments and spaces concurrent requests by 200ms", async () => {
  vi.useFakeTimers();
  const times: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      times.push(Date.now());
      const u = new URL(url);
      const after = u.searchParams.get("after");
      return Response.json({
        has_more: !after,
        data: [
          u.pathname === "/segments"
            ? { id: after ? "s2" : "s1", name: after ? "tag:chosen" : "other" }
            : {
                id: after ? "c2" : "c1",
                email: "test@example.com",
                unsubscribed: true,
              },
        ],
      });
    }),
  );
  const provider = createResendProvider("fake");
  const contacts = (async () => {
    const rows = [];
    for await (const c of provider.listContacts("a")) rows.push(c);
    return rows;
  })();
  const audience = provider.ensureAudience("tag:chosen");
  await vi.runAllTimersAsync();
  expect(await audience).toBe("s2");
  expect(await contacts).toHaveLength(2);
  expect(times.slice(1).every((t, i) => t - times[i] >= 200)).toBe(true);
});

it("escapes email path characters for the pre-create lookup", async () => {
  const fake = vi.fn(async (url: string) => {
    expect(new URL(url).pathname).toBe("/contacts/person%23tag%40example.com");
    return Response.json({
      id: "existing",
      email: "person#tag@example.com",
      unsubscribed: true,
    });
  });
  vi.stubGlobal("fetch", fake);
  expect(
    await createResendProvider("fake").createContact({
      email: "person#tag@example.com",
      unsubscribed: false,
    }),
  ).toBe("existing");
});
it("creates an unsent broadcast, maps queued state, and disables unsubscribe in transactional tests", async () => {
  vi.useFakeTimers();
  const fake = vi.fn(async (_url, init) =>
    Response.json(
      init.method === "GET"
        ? { id: "broadcast", status: "queued" }
        : { id: "broadcast" },
    ),
  );
  vi.stubGlobal("fetch", fake);
  const provider = createResendProvider("fake");
  const message = {
    subject: "Example",
    html: '<a href="{{unsubscribe_url}}">Leave</a>',
    from: "sender@example.com",
    replyTo: "reply@example.com",
    previewText: "Preview",
  };
  const created = provider.createBroadcast({ ...message, audience: "segment" });
  await vi.runAllTimersAsync();
  expect(await created).toBe("broadcast");
  const body = JSON.parse(fake.mock.calls[0][1].body);
  expect(body).toMatchObject({
    send: false,
    segment_id: "segment",
    html: '<a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Leave</a>',
  });
  const state = provider.getBroadcastState("broadcast");
  await vi.runAllTimersAsync();
  expect(await state).toBe("sending");
  const sent = provider.sendBroadcast("broadcast");
  await vi.runAllTimersAsync();
  await sent;
  expect(fake.mock.calls[2][0]).toBe(
    "https://api.resend.com/broadcasts/broadcast/send",
  );
  const test = provider.sendTest({ ...message, to: "owner@example.com" });
  await vi.runAllTimersAsync();
  await test;
  expect(JSON.parse(fake.mock.calls[3][1].body)).toMatchObject({
    to: "owner@example.com",
    html: '<a href="#unsubscribe-disabled-in-test">Leave</a>',
  });
});

it("only updates the tracking property, preserves suppression, and renders safe fallbacks", async () => {
  vi.useFakeTimers();
  const fake = vi.fn(async () => Response.json({ id: "contact" }));
  vi.stubGlobal("fetch", fake);
  const provider = createResendProvider("fake");
  const update = provider.setTrackingToken("contact", null);
  await vi.runAllTimersAsync();
  await update;
  expect(JSON.parse(fake.mock.calls[0][1].body)).toEqual({
    properties: { newsletter_token: "none" },
  });
  expect(fake.mock.calls[0][1].method).toBe("PATCH");
  const create = provider.createBroadcast({
    audience: "a",
    from: "s@example.com",
    replyTo: "s@example.com",
    subject: "Issue",
    html: '<a href="https://example.com/r?token={{tracking_token}}">Read</a>',
  });
  await vi.runAllTimersAsync();
  await create;
  expect(JSON.parse(fake.mock.calls[1][1].body).html).toContain(
    "{{{contact.newsletter_token|none}}}",
  );
});
it.each([true, undefined, false])(
  "fails closed unless native tracking is explicitly off (%s)",
  async (open_tracking) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        Response.json(
          String(url).includes("contact-properties")
            ? {
                data: [
                  {
                    id: "p",
                    key: "newsletter_token",
                    type: "string",
                    fallback_value: "none",
                  },
                ],
                has_more: false,
              }
            : {
                data: [
                  {
                    id: "d",
                    name: "example.com",
                    open_tracking,
                    click_tracking: false,
                  },
                ],
                has_more: false,
              },
        ),
      ),
    );
    const check = createResendProvider("fake").assertTrackingDisabled(
      "Sender <s@example.com>",
    );
    const assertion =
      open_tracking === false
        ? expect(check).resolves.toBeUndefined()
        : expect(check).rejects.toThrow(/tracking/i);
    await vi.runAllTimersAsync();
    await assertion;
  },
);
it("uses an anonymous literal in transactional tests, never a Broadcast-only contact placeholder", async () => {
  const fake = vi.fn(async () => Response.json({ id: "test" }));
  vi.stubGlobal("fetch", fake);
  await createResendProvider("fake").sendTest({
    to: "owner@example.com",
    from: "s@example.com",
    replyTo: "s@example.com",
    subject: "[TEST] Issue",
    html: '<a href="https://example.com/r?token={{tracking_token}}">Read</a>',
  });
  expect(JSON.parse(fake.mock.calls[0][1].body).html).toBe(
    '<a href="https://example.com/r?token=none">Read</a>',
  );
});
