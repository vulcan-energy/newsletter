import { expect, it, vi, afterEach } from "vitest";
import { FakeProvider } from "./testing/provider.js";
import type { Message } from "./provider.js";
import { createResendProvider } from "./providers/resend.js";
import { providerContract as contract } from "./testing/provider-contract.js";
class ContractProvider extends FakeProvider {
  audience = "";
  async createBroadcast(input: Message & { audience: string }) {
    this.audience = input.audience;
    return super.createBroadcast(input);
  }
  async sendBroadcast(id: string) {
    const contacts = [];
    for await (const contact of this.listContacts(this.audience))
      contacts.push(contact);
    const recipients = contacts.filter((contact) => !contact.unsubscribed);
    if (!recipients.length)
      throw new Error("The audience you are sending has no contacts");
    expect(recipients.map((contact) => contact.email)).toEqual([
      "owner@example.com",
    ]);
    expect(
      contacts.find((contact) => contact.email === "person@example.com")
        ?.unsubscribed,
    ).toBe(true);
    await super.sendBroadcast(id);
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("provider contract: subscribed alias receives broadcast while original contact stays suppressed", async () => {
  const provider = new ContractProvider();
  await contract(provider);
  expect(provider.sendCalls).toBe(1);
  expect(provider.contacts.size).toBe(0);
});
it("provider contract: SDK adapter over fake HTTP", async () => {
  vi.useFakeTimers();
  const state = new ContractProvider();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const parts = new URL(url).pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const method = init.method ?? "GET";
    let data: any;
    if (parts[0] === "domains") {
      data = {
        data: [
          {
            id: "domain",
            name: "example.com",
            open_tracking: false,
            click_tracking: false,
          },
        ],
        has_more: false,
      };
    } else if (parts[0] === "contact-properties") {
      data = {
        data: [
          {
            id: "property",
            key: "newsletter_token",
            type: "string",
            fallback_value: "none",
          },
        ],
        has_more: false,
      };
    } else if (parts[0] === "segments") {
      if (method === "POST")
        data = { id: await state.ensureAudience(body.name) };
      else if (parts[2] === "contacts") {
        const contacts = [];
        for await (const c of state.listContacts(parts[1])) contacts.push(c);
        data = { data: contacts, has_more: false };
      } else
        data = {
          data: [...state.audiences].map(([name, id]) => ({ id, name })),
          has_more: false,
        };
    } else if (parts[0] === "contacts") {
      if (parts[2] === "segments") {
        if (method === "POST") await state.addToAudience(parts[1], parts[3]);
        else await state.removeFromAudience(parts[1], parts[3]);
        data = { id: parts[3] };
      } else if (method === "POST") {
        const id = await state.createContact({
          ...body,
          unsubscribed: body.unsubscribed ?? false,
        });
        state.contacts.get(id)!.unsubscribed = body.unsubscribed ?? false;
        data = { id };
      } else if (method === "PATCH") {
        if (body.unsubscribed !== undefined)
          state.contacts.get(parts[1])!.unsubscribed = body.unsubscribed;
        if (body.properties)
          await state.setTrackingToken(
            parts[1],
            body.properties.newsletter_token,
          );
        data = { id: parts[1] };
      } else if (method === "DELETE") {
        await state.deleteContact(parts[1]);
        data = { deleted: true };
      } else data = await state.findContact(parts[1]);
    } else if (parts[0] === "broadcasts") {
      if (parts[2] === "send") {
        await state.sendBroadcast(parts[1]);
        data = { id: parts[1] };
      } else if (method === "POST") {
        expect(body.send).toBe(false);
        data = {
          id: await state.createBroadcast({
            ...body,
            audience: body.segment_id,
          }),
        };
      } else
        data = {
          id: parts[1],
          status: await state.getBroadcastState(parts[1]),
        };
    } else if (parts[0] === "emails") {
      expect(body.to).toBe("owner@example.com");
      data = { id: "test" };
    } else throw new Error("Unexpected fake endpoint");
    return data
      ? Response.json(data)
      : Response.json(
          { name: "not_found", message: "missing" },
          { status: 404 },
        );
  });
  const running = contract(createResendProvider("fake"));
  const checked = expect(running).resolves.toHaveProperty("broadcast");
  await Promise.all([checked, vi.runAllTimersAsync()]);
  expect(state.contacts.size).toBe(0);
});
