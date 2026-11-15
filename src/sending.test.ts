import { expect, it, vi } from "vitest";
import { createNewsletter, reviewHash, validateCampaign } from "./sending.js";
import { fakeDatabase } from "./testing/database.js";
import { FakeProvider } from "./testing/provider.js";
import { testCampaign } from "./campaigns.js";
import { handleTrackingRequest } from "./tracking.js";
import { sha256 } from "./subscribers.js";
const html =
  '<p>Example Company, 1 Example Street</p><a href="{{unsubscribe_url}}">Unsubscribe</a>';
const imageFetch = vi.fn(
  async () => new Response("", { headers: { "content-type": "image/png" } }),
);
async function setup(overrides: Record<string, any> = {}) {
  const db = fakeDatabase({
    newsletter_campaigns: [
      {
        id: "campaign",
        slug: "issue",
        subject: "Issue",
        html,
        html_sha256: sha256(html),
        last_test_sha256: sha256(html),
        status: "draft",
        updated_at: "2026-01-01T00:00:00Z",
        target_tag: null,
        is_public: false,
        ...overrides,
      },
    ],
    newsletter_subscribers: [
      {
        id: "person",
        email: "person@example.com",
        status: "subscribed",
        tags: [],
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
  });
  const provider = new FakeProvider();
  const audienceId = await provider.ensureAudience("everyone");
  const onSent = vi.fn();
  const config = {
    supabase: db.client,
    provider,
    audienceId,
    from: "sender@example.com",
    replyTo: "reply@example.com",
    footerAddress: "Example Company, 1 Example Street",
    testRecipient: "owner@example.com",
    fetch: imageFetch,
    publicPageUrl: (slug: string) => `https://example.com/newsletter/${slug}`,
    onSent,
  };
  const core = createNewsletter(config);
  const send = () =>
    core.send(
      {
        campaign_id: "campaign",
        expected_recipient_count: 1,
        review_sha256: reviewHash(db.rows.newsletter_campaigns[0]),
      },
      "owner",
    );
  return {
    db,
    provider,
    config,
    core,
    send,
    onSent,
    row: db.rows.newsletter_campaigns[0],
  };
}
it("claims concurrent sends once and records the successful send", async () => {
  const { send, provider, row, onSent } = await setup();
  const results = await Promise.allSettled([send(), send(), send()]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(provider.broadcasts.size).toBe(1);
  expect(provider.sendCalls).toBe(1);
  expect(row).toMatchObject({
    status: "sent",
    recipient_count: 1,
    sent_by: "owner",
  });
  expect(onSent).toHaveBeenCalledTimes(1);
});
it.each([
  { html_sha256: "wrong" },
  { last_test_sha256: null },
  { html: html + "edited" },
  { status: "sent" },
])("refuses unsafe or already claimed draft %j", async (patch) => {
  const { send, provider } = await setup(patch);
  await expect(send()).rejects.toThrow();
  expect(provider.sendCalls).toBe(0);
});
it("rejects supplied hash and changed counts before creating a broadcast", async () => {
  const { core, row, provider } = await setup();
  await expect(
    core.send(
      {
        campaign_id: "campaign",
        review_sha256: "wrong",
        expected_recipient_count: 1,
      },
      "owner",
    ),
  ).rejects.toThrow();
  await expect(
    core.send(
      {
        campaign_id: "campaign",
        review_sha256: reviewHash(row),
        expected_recipient_count: 2,
      },
      "owner",
    ),
  ).rejects.toThrow("count");
  expect(row.status).toBe("draft");
  expect(provider.broadcasts.size).toBe(0);
});
it("external suppression failures abort and release the claim", async () => {
  const { config, row, provider } = await setup();
  const core = createNewsletter({
    ...config,
    getExternalSuppressions: async () => {
      throw new Error("offline");
    },
  });
  await expect(
    core.send(
      {
        campaign_id: "campaign",
        review_sha256: reviewHash(row),
        expected_recipient_count: 1,
      },
      "owner",
    ),
  ).rejects.toThrow();
  expect(row.status).toBe("draft");
  expect(provider.broadcasts.size).toBe(0);
});
it.each(["create", "persist", "send", "complete"])(
  "handles failure at %s without repeating send",
  async (stage) => {
    const { provider, db, send, row } = await setup();
    if (stage === "create")
      vi.spyOn(provider, "createBroadcast").mockRejectedValue(
        new Error("offline"),
      );
    if (stage === "persist") {
      const create = provider.createBroadcast.bind(provider);
      vi.spyOn(provider, "createBroadcast").mockImplementation(
        async (input) => {
          const id = await create(input);
          db.failNext = { table: "newsletter_campaigns", op: "update" };
          return id;
        },
      );
    }
    if (stage === "send")
      vi.spyOn(provider, "sendBroadcast").mockRejectedValue(
        new Error("timeout"),
      );
    if (stage === "complete") {
      const send = provider.sendBroadcast.bind(provider);
      vi.spyOn(provider, "sendBroadcast").mockImplementation(async (id) => {
        await send(id);
        db.failNext = { table: "newsletter_campaigns", op: "update" };
      });
    }
    await expect(send()).rejects.toThrow();
    expect(row.status).toBe(
      stage === "create" || stage === "persist" ? "draft" : "send_unknown",
    );
    if (stage === "persist")
      expect(row.provider_broadcast_id ?? null).toBeNull();
    if (row.status === "send_unknown") {
      await expect(send()).rejects.toThrow();
      expect(provider.broadcasts.size).toBe(1);
    }
    if (stage === "create" || stage === "persist")
      expect(provider.sendCalls).toBe(0);
  },
);
it("notification failure does not change confirmed delivery", async () => {
  const { send, onSent, row } = await setup();
  onSent.mockRejectedValue(new Error("offline"));
  await send();
  expect(row.status).toBe("sent");
});
it.each([null, "broadcast"])(
  "recovers stale sending with ID %s",
  async (id) => {
    const { core, row } = await setup({
      status: "sending",
      provider_broadcast_id: id,
    });
    await core.campaign("campaign");
    expect(row.status).toBe(id ? "send_unknown" : "draft");
  },
);
it("will not send after losing its claim during reconcile", async () => {
  const { config, row, provider } = await setup();
  const core = createNewsletter({
    ...config,
    getExternalSuppressions: async () => {
      row.updated_at = "2099-01-01";
      return [];
    },
  });
  await expect(
    core.send(
      {
        campaign_id: "campaign",
        review_sha256: reviewHash(row),
        expected_recipient_count: 1,
      },
      "owner",
    ),
  ).rejects.toThrow();
  expect(provider.sendCalls).toBe(0);
});
it("unknown resolution never resends; only a provider draft permits a failed copy", async () => {
  const { core, row, provider } = await setup({
    status: "send_unknown",
    provider_broadcast_id: "broadcast",
  });
  provider.broadcasts.set("broadcast", "sending");
  await expect(
    core.resolveUnknown("campaign", "failed", "owner"),
  ).rejects.toThrow();
  provider.broadcasts.set("broadcast", "draft");
  const copy = await core.resolveUnknown("campaign", "failed", "owner");
  expect(row.status).toBe("failed");
  expect(copy).toMatchObject({
    status: "draft",
    last_test_sha256: null,
    provider_broadcast_id: null,
  });
  expect(copy.id).not.toBe(row.id);
  expect(provider.sendCalls).toBe(0);
});
it("external suppression respects a newer explicit resubscribe and never creates unknown rows", async () => {
  const { config, db, provider } = await setup();
  const person = db.rows.newsletter_subscribers[0];
  person.resubscribed_at = "2026-02-01T00:00:00Z";
  const core = createNewsletter({
    ...config,
    getExternalSuppressions: async () => [
      {
        email: person.email,
        status: "unsubscribed",
        at: "2026-01-01T00:00:00Z",
      },
      {
        email: "unknown@example.com",
        status: "cleaned",
        at: "2026-01-01T00:00:00Z",
      },
    ],
  });
  expect((await core.reconcile(null)).count).toBe(1);
  expect(person.status).toBe("subscribed");
  expect(db.rows.newsletter_subscribers).toHaveLength(1);
  person.resubscribed_at = null;
  expect((await core.reconcile(null)).count).toBe(0);
  expect(person.status).toBe("unsubscribed");
  expect((await provider.findContact(person.email))?.unsubscribed).toBe(true);
});
it("adds an existing global contact without recreating or restoring consent", async () => {
  const { core, provider, db } = await setup();
  await provider.createContact({
    email: "person@example.com",
    unsubscribed: true,
  });
  const create = vi.spyOn(provider, "createContact");
  expect((await core.reconcile(null)).count).toBe(0);
  expect(create).not.toHaveBeenCalled();
  expect(db.rows.newsletter_subscribers[0].status).toBe("unsubscribed");
});
it("removes obsolete tag members and blocks unknown contacts or failed suppression", async () => {
  const { core, provider, config, db } = await setup();
  await core.reconcile(null);
  const tag = await provider.ensureAudience("tag:chosen");
  await provider.addToAudience("contact-0", tag);
  expect((await core.reconcile("chosen")).count).toBe(0);
  expect(provider.memberships.get(tag)?.size).toBe(0);
  const unknown = await provider.createContact({
    email: "unknown@example.com",
    unsubscribed: false,
  });
  await provider.addToAudience(unknown, config.audienceId);
  await expect(core.reconcile(null)).rejects.toThrow("Unknown");
  await provider.removeFromAudience(unknown, config.audienceId);
  db.rows.newsletter_subscribers[0].status = "unsubscribed";
  vi.spyOn(provider, "setUnsubscribed").mockResolvedValue();
  await expect(core.reconcile(null)).rejects.toThrow("suppression");
});
it.each([
  [html.replace("{{unsubscribe_url}}", ""), "Issue", false],
  [html + "*|NAME|*", "Issue", false],
  [html + "{{other}}", "Issue", false],
  [html.replace("Example Company, 1 Example Street", ""), "Issue", false],
  [html + "x".repeat(102 * 1024), "Issue", false],
  [html, " ", false],
  [html + '<img src="http://example.com/a.png">', "Issue", false],
  [
    html + '<a href="https://example.com/newsletter/issue">Read</a>',
    "Issue",
    false,
  ],
])(
  "validates required content and public links",
  async (body, subject, is_public) => {
    await expect(
      validateCampaign(
        {
          html: body as string,
          subject: subject as string,
          is_public: is_public as boolean,
          slug: "issue",
        },
        {
          footerAddress: "Example Company, 1 Example Street",
          publicPageUrl: () => "https://example.com/newsletter/issue",
          fetch: imageFetch,
        },
      ),
    ).rejects.toThrow();
  },
);
it("checks each image and rejects redirects, wrong types and missing images", async () => {
  const input = {
    html:
      html +
      '<img src="https://example.com/a.png"><img src="https://example.com/b.png">',
    subject: "Issue",
    slug: "issue",
    is_public: true,
  };
  for (const response of [
    new Response("", { status: 404 }),
    new Response("", { headers: { "content-type": "text/html" } }),
  ]) {
    await expect(
      validateCampaign(input, {
        footerAddress: "Example Company, 1 Example Street",
        fetch: async () => response,
      }),
    ).rejects.toThrow();
  }
  imageFetch.mockClear();
  await validateCampaign(input, {
    footerAddress: "Example Company, 1 Example Street",
    fetch: imageFetch,
  });
  expect(imageFetch).toHaveBeenCalledTimes(2);
  expect(imageFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
});

it("prepares one broadcast with stable consent tokens and immutable anonymous destinations", async () => {
  const { config, db, provider, row } = await setup();
  const person = db.rows.newsletter_subscribers[0];
  Object.assign(person, {
    tracking_token: "00000000-0000-4000-8000-000000000002",
    tracking_granted_at: "2026-01-01T00:00:00Z",
  });
  const broadcast = vi.spyOn(provider, "createBroadcast");
  const guard = vi.spyOn(provider, "assertTrackingDisabled");
  const core = createNewsletter({
    ...config,
    trackingBaseUrl: "https://example.com/api/newsletter/tracking",
  });
  await core.send(
    {
      campaign_id: row.id,
      expected_recipient_count: 1,
      review_sha256: reviewHash(row),
    },
    "owner",
  );
  expect(guard).toHaveBeenCalled();
  expect(broadcast).toHaveBeenCalledTimes(1);
  expect(broadcast.mock.calls[0][0].html).toContain("{{tracking_token}}");
  expect(row.html).toBe(html);
  expect(row.tracking_started_at).toBeTruthy();
  expect(row.tracking_recipient_count).toBe(1);
  expect(provider.trackingTokens.get("contact-0")).toBe(person.tracking_token);
});
it("fails before creating or sending when native tracking or property synchronization is unsafe", async () => {
  for (const method of [
    "assertTrackingDisabled",
    "setTrackingToken",
  ] as const) {
    const { config, provider, row } = await setup();
    vi.spyOn(provider, method).mockRejectedValue(new Error("unsafe tracking"));
    const core = createNewsletter({
      ...config,
      trackingBaseUrl: "https://example.com/api/newsletter/tracking",
    });
    await expect(
      core.send(
        {
          campaign_id: row.id,
          expected_recipient_count: 1,
          review_sha256: reviewHash(row),
        },
        "owner",
      ),
    ).rejects.toThrow("unsafe tracking");
    expect(provider.broadcasts.size).toBe(0);
    expect(provider.sendCalls).toBe(0);
    expect(row.status).toBe("draft");
  }
});
it("does not provision a tracking identity for a subscriber without consent", async () => {
  const { config, provider, row } = await setup();
  await createNewsletter({
    ...config,
    trackingBaseUrl: "https://example.com/api/newsletter/tracking",
  }).send(
    {
      campaign_id: row.id,
      expected_recipient_count: 1,
      review_sha256: reviewHash(row),
    },
    "owner",
  );
  expect(provider.trackingTokens.get("contact-0")).toBeNull();
  expect(row.tracking_recipient_count).toBe(0);
});
it("rechecks native tracking immediately before dispatch after slow preparation", async () => {
  const { config, provider, row } = await setup();
  const check = vi
    .spyOn(provider, "assertTrackingDisabled")
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("tracking changed"));
  const core = createNewsletter({
    ...config,
    trackingBaseUrl: "https://example.com/api/newsletter/tracking",
  });
  await expect(
    core.send(
      {
        campaign_id: row.id,
        expected_recipient_count: 1,
        review_sha256: reviewHash(row),
      },
      "owner",
    ),
  ).rejects.toThrow();
  expect(check).toHaveBeenCalledTimes(2);
  expect(provider.sendCalls).toBe(0);
  expect(provider.broadcasts.size).toBe(1);
  expect(row.status).toBe("send_unknown");
});
it("rechecks the reviewed audience count after slow token synchronization", async () => {
  const { config, provider, row } = await setup();
  const setToken = provider.setTrackingToken.bind(provider);
  vi.spyOn(provider, "setTrackingToken").mockImplementation(
    async (id, token) => {
      await setToken(id, token);
      await provider.setUnsubscribed(id);
    },
  );
  const core = createNewsletter({
    ...config,
    trackingBaseUrl: "https://example.com/api/newsletter/tracking",
  });
  await expect(
    core.send(
      {
        campaign_id: row.id,
        expected_recipient_count: 1,
        review_sha256: reviewHash(row),
      },
      "owner",
    ),
  ).rejects.toThrow(/count/);
  expect(provider.broadcasts.size).toBe(0);
  expect(provider.sendCalls).toBe(0);
});

it("test emails exercise transformed links and footer anonymously before send approval", async () => {
  const linked = html + '<a href="https://example.com/article">Read</a>';
  const { config, db, provider, row } = await setup({
    id: "11111111-1111-4111-8111-111111111111",
    html: linked,
    html_sha256: sha256(linked),
    last_test_sha256: null,
  });
  const send = vi
    .spyOn(provider, "sendTest")
    .mockImplementation(async (input) => {
      expect(row.tracking_links).toEqual(["https://example.com/article"]);
      expect(input.html).toContain(`/tracking/${row.id}/0?token=none`);
      expect(input.html).toContain(
        `/tracking/${row.id}/preferences?token=none`,
      );
      expect(input.html).toContain(`/tracking/${row.id}/open?token=none`);
      const response = await handleTrackingRequest(
        db.client,
        new Request(
          `https://example.com/api/newsletter/tracking/${row.id}/0?token=none`,
        ),
      );
      expect(response.headers.get("location")).toBe(
        "https://example.com/article",
      );
      expect(db.rows.newsletter_events).toHaveLength(0);
      expect(row.last_test_sha256).toBeNull();
    });
  await testCampaign(
    {
      ...config,
      trackingBaseUrl: "https://example.com/api/newsletter/tracking",
    },
    row.id,
  );
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][0].html).not.toContain("{{tracking_token}}");
  expect(row.html).toBe(linked);
  expect(row.last_test_sha256).toBe(sha256(linked));
});
it("does not send a preview if its draft changed before tracking links were saved", async () => {
  const { config, db, provider, row } = await setup({ last_test_sha256: null });
  const send = vi.spyOn(provider, "sendTest");
  db.beforeCampaignUpdate = () => {
    row.updated_at = "2099-01-01T00:00:00Z";
  };
  await expect(
    testCampaign(
      { ...config, trackingBaseUrl: "https://example.com/tracking" },
      row.id,
    ),
  ).rejects.toThrow(/changed/i);
  expect(send).not.toHaveBeenCalled();
  expect(row.last_test_sha256).toBeNull();
});
it("uses the database clock for consent cutoff even when the application clock is ahead", async () => {
  const { config, db, provider, row } = await setup();
  const databaseTime = "2026-02-01T12:00:00.000000+00:00";
  db.databaseNow = () => databaseTime;
  Object.assign(db.rows.newsletter_subscribers[0], {
    tracking_token: "00000000-0000-4000-8000-000000000002",
    tracking_granted_at: "2026-02-01T12:00:00.000001+00:00",
  });
  const create = provider.createBroadcast.bind(provider);
  vi.spyOn(provider, "createBroadcast").mockImplementation(async (input) => {
    expect(row.tracking_started_at).toBe(databaseTime);
    expect(row.tracking_links).toEqual([]);
    return create(input);
  });
  await createNewsletter({
    ...config,
    trackingBaseUrl: "https://example.com/api/newsletter/tracking",
  }).send(
    {
      campaign_id: row.id,
      expected_recipient_count: 1,
      review_sha256: reviewHash(row),
    },
    "owner",
  );
  expect(row.tracking_started_at).toBe(databaseTime);
  expect(row.tracking_recipient_count).toBe(0);
});

it("skips property writes for suppressed recipients during tracking preparation", async () => {
  const { config, db, provider, row } = await setup();
  db.rows.newsletter_subscribers.push({
    id: "suppressed",
    email: "suppressed@example.com",
    status: "unsubscribed",
    tags: [],
    updated_at: "2026-01-01T00:00:00Z",
  });
  const suppressed = await provider.createContact({
    email: "suppressed@example.com",
    unsubscribed: true,
  });
  await provider.addToAudience(suppressed, config.audienceId);
  const sync = vi.spyOn(provider, "setTrackingToken");
  await createNewsletter({
    ...config,
    trackingBaseUrl: "https://example.com/tracking",
  }).send(
    {
      campaign_id: row.id,
      expected_recipient_count: 1,
      review_sha256: reviewHash(row),
    },
    "owner",
  );
  expect(sync).toHaveBeenCalledTimes(1);
  expect(sync).toHaveBeenCalledWith("contact-1", null);
});
it("holds a send after a bad last send until an in-process owner overrides", async () => {
  const { db, core, provider } = await setup();
  db.rows.newsletter_campaigns.push({
    id: "previous",
    slug: "previous",
    status: "sent",
    source: "provider",
    sent_at: "2025-12-01T00:00:00Z",
    recipient_count: 20,
    stats: null,
  });
  for (const i of [1, 2])
    db.rows.newsletter_events.push({
      id: `complaint-${i}`,
      campaign_id: "previous",
      subscriber_id: `someone-${i}`,
      type: "complained",
      occurred_at: "2025-12-02T00:00:00Z",
      provider_event_id: `complaint-${i}`,
    });
  const input = { campaign_id: "campaign", expected_recipient_count: 1, review_sha256: reviewHash(db.rows.newsletter_campaigns[0]) };
  await expect(core.send(input, "api-token")).rejects.toThrow(
    "The last send had 2 complaints (10.00%), above the 0.30% limit.",
  );
  expect(provider.broadcasts.size).toBe(0);
  expect(db.rows.newsletter_campaigns[0].status).toBe("draft");
  expect((await core.health()).blockers).toHaveLength(1);
  await expect(core.send(input, "owner", { overrideLimits: true })).resolves.toMatchObject({
    status: "sent",
  });
});
it("refuses a new send while another send is in progress or has an unknown outcome", async () => {
  const { db, send, provider } = await setup();
  db.rows.newsletter_campaigns.push({
    id: "earlier",
    slug: "earlier",
    status: "send_unknown",
    source: "provider",
    provider_broadcast_id: "earlier-broadcast",
    updated_at: new Date().toISOString(),
  });
  await expect(send()).rejects.toThrow(
    "Another send is in progress or has an unknown outcome; resolve it first",
  );
  expect(provider.broadcasts.size).toBe(0);
  db.rows.newsletter_campaigns[1].status = "sending";
  await expect(send()).rejects.toThrow("Another send is in progress");
  db.rows.newsletter_campaigns[1].status = "sent";
  await expect(send()).resolves.toMatchObject({ status: "sent" });
});
it("does not dispatch when its claim expired between saving the broadcast and sending it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { config, provider, row } = await setup();
    const core = createNewsletter({
      ...config,
      trackingBaseUrl: "https://example.com/api/newsletter/tracking",
    });
    let calls = 0;
    vi.spyOn(provider, "assertTrackingDisabled").mockImplementation(async () => {
      if (++calls < 2) return;
      // A status read after the 15-minute lease marks the send unknown.
      vi.setSystemTime(Date.now() + 16 * 60_000);
      await core.campaign(row.id);
    });
    await expect(
      core.send(
        { campaign_id: row.id, expected_recipient_count: 1, review_sha256: reviewHash(row) },
        "owner",
      ),
    ).rejects.toThrow("Send claim expired before dispatch");
    expect(provider.sendCalls).toBe(0);
    expect(row.status).toBe("send_unknown");
  } finally {
    vi.useRealTimers();
  }
});
it("a claim that expires during slow preparation fails safely without dispatching", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { config, provider, row, db } = await setup();
    for (let i = 1; i < 150; i++)
      db.rows.newsletter_subscribers.push({
        id: `person-${i}`,
        email: `person-${i}@example.com`,
        status: "subscribed",
        tags: [],
        updated_at: "2026-01-01T00:00:00Z",
      });
    const core = createNewsletter({
      ...config,
      trackingBaseUrl: "https://example.com/api/newsletter/tracking",
    });
    let calls = 0;
    const original = provider.setTrackingToken.bind(provider);
    vi.spyOn(provider, "setTrackingToken").mockImplementation(async (id, token) => {
      calls++;
      // Twenty minutes pass during preparation, then a status read expires the claim.
      if (calls === 50 || calls === 150) vi.setSystemTime(Date.now() + 10 * 60_000);
      if (calls === 150) await core.campaign(row.id);
      return original(id, token);
    });
    await expect(
      core.send(
        { campaign_id: row.id, expected_recipient_count: 150, review_sha256: reviewHash(row) },
        "owner",
      ),
    ).rejects.toThrow("Send claim expired");
    expect(provider.sendCalls).toBe(0);
    expect(row.status).toBe("draft");
  } finally {
    vi.useRealTimers();
  }
});
it("accepts {{unsubscribe_url}} only as the whole link of an anchor", async () => {
  const footer = "<p>Example Company, 1 Example Street</p>";
  const check = (body: string) =>
    validateCampaign(
      { html: footer + body, subject: "Issue", slug: "issue", is_public: false },
      { footerAddress: "Example Company, 1 Example Street", fetch: imageFetch },
    );
  await expect(check('<a href="{{unsubscribe_url}}">Leave</a>')).resolves.toBeUndefined();
  await expect(check("<a href='{{unsubscribe_url}}'>Leave</a>")).resolves.toBeUndefined();
  await expect(check('<A HREF="{{unsubscribe_url}}">Leave</A>')).resolves.toBeUndefined();
  // A mis-nested anchor is rebuilt by the parser but is still one link.
  await expect(check('<a href="{{unsubscribe_url}}"><div>Leave</a></div>')).resolves.toBeUndefined();
  for (const bad of [
    '<img src="https://tracker.example/p.gif?u={{unsubscribe_url}}"><a href="{{unsubscribe_url}}">Leave</a>',
    "<!-- {{unsubscribe_url}} -->",
    '<a href="https://example.com/?u={{unsubscribe_url}}">Leave</a>',
    '<a title="{{unsubscribe_url}}" href="https://example.com">Leave</a>',
    `<a title=' href="{{unsubscribe_url}}"' href="https://example.com/">Leave</a>`,
    // Entity-encoded hrefs decode to the placeholder but the provider never fills them in.
    '<p title="{{unsubscribe_url}}">x</p><a href="&#123;&#123;unsubscribe_url&#125;&#125;">Leave</a>',
    '<img src="https://t.example/p.gif?u={{unsubscribe_url}}"><a href="{{unsubscribe_url}}"><div>Leave</a></div>',
    '<svg><a href="{{unsubscribe_url}}">Leave</a></svg>',
    '<math><a href="{{unsubscribe_url}}">Leave</a></math>',
  ])
    await expect(check(bad)).rejects.toThrow(
      "Use {{unsubscribe_url}} only as the full link of an unsubscribe anchor",
    );
});
it("limits how many images a campaign checks, and checks them in parallel", async () => {
  const footer =
    '<p>Example Company, 1 Example Street</p><a href="{{unsubscribe_url}}">Leave</a>';
  const images = (n: number) =>
    Array.from({ length: n }, (_, i) => `<img src="https://example.com/${i}.png">`).join("");
  let active = 0,
    peak = 0;
  const slowFetch = vi.fn(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return new Response("", { headers: { "content-type": "image/png" } });
  });
  const config = { footerAddress: "Example Company, 1 Example Street", fetch: slowFetch };
  const content = (n: number) => ({
    html: footer + images(n),
    subject: "Issue",
    slug: "issue",
    is_public: false,
  });
  await expect(validateCampaign(content(50), config)).resolves.toBeUndefined();
  expect(peak).toBeGreaterThan(1);
  await expect(validateCampaign(content(51), config)).rejects.toThrow(
    "Use at most 50 different images",
  );
});
it("an old confirmation cannot send after the subject or audience changed and was re-tested", async () => {
  const { core, row, provider } = await setup({ target_tag: null, preview_text: "" });
  const reviewed = reviewHash(row);
  for (const change of [{ subject: "Embargoed results" }, { target_tag: "press" }]) {
    Object.assign(row, change);
    await expect(
      core.send(
        { campaign_id: row.id, expected_recipient_count: 1, review_sha256: reviewed },
        "owner",
      ),
    ).rejects.toThrow("Review hash and a test of the current HTML required");
    Object.assign(row, { subject: "Issue", target_tag: null });
  }
  expect(provider.broadcasts.size).toBe(0);
});
it("a broadcast the provider can't find is marked failed only when the owner confirms it was deleted", async () => {
  const { core, db, provider } = await setup({ status: "send_unknown", provider_broadcast_id: "deleted" });
  provider.broadcasts.set("deleted", "missing");
  // A 404 can also mean a wrong key or account, so it is not proof the send never happened.
  await expect(core.resolveUnknown("campaign", "failed", "owner")).rejects.toThrow(
    "Resend has no record of this broadcast",
  );
  const copy = await core.resolveUnknown("campaign", "failed", "owner", { confirmedDeleted: true });
  expect(copy).toMatchObject({ status: "draft" });
  expect(await core.pendingSend()).toBeNull();
  expect(db.rows.newsletter_campaigns[0].status).toBe("failed");
  expect(await provider.getBroadcastState("never-seen")).toBe("unknown");
});
it("a storage failure during the after-claim check releases the claim", async () => {
  const { db, send, provider } = await setup();
  let armed = false;
  db.beforeCampaignUpdate = () => {
    if (armed) return;
    armed = true; // the claim is the first update; fail the check that follows it
    db.failNext = { table: "newsletter_campaigns", op: "select" };
  };
  await expect(send()).rejects.toThrow("Newsletter storage operation failed");
  expect(db.rows.newsletter_campaigns[0].status).toBe("draft");
  expect(provider.broadcasts.size).toBe(0);
});

it("re-checks for another send after claiming, so a send that starts in between cannot also dispatch", async () => {
  const { db, send, provider } = await setup();
  const from = db.client.from.bind(db.client);
  let started = false;
  // Another campaign claims its send just after this one checked for pending sends.
  db.client.from = ((table: string) => {
    const query = from(table);
    if (table !== "newsletter_campaigns") return query;
    const eq = query.eq.bind(query);
    query.eq = (key: string, value: unknown) => {
      if (!started && key === "status" && value === "sent") {
        started = true;
        db.rows.newsletter_campaigns.push({
          id: "racing",
          slug: "racing",
          status: "sending",
          source: "provider",
          updated_at: new Date().toISOString(),
        });
      }
      return eq(key, value);
    };
    return query;
  }) as typeof db.client.from;
  await expect(send()).rejects.toThrow("Another send is in progress");
  expect(provider.broadcasts.size).toBe(0);
  expect(db.rows.newsletter_campaigns[0].status).toBe("draft");
});
it("explains a relative link instead of failing with a generic error", async () => {
  const { config, row } = await setup({ html: html + '<a href="/pricing">Pricing</a>' });
  row.html_sha256 = sha256(row.html);
  await expect(
    testCampaign({ ...config, trackingBaseUrl: "https://example.com/api/newsletter/tracking" }, row.id),
  ).rejects.toThrow("Links must be full URLs: /pricing");
});
