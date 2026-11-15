import { createNewsletter } from "../sending.js";
import { newsletterHandler } from "../http.js";
import { fakeDatabase } from "./database.js";
import { FakeProvider } from "./provider.js";
import { sha256 } from "../subscribers.js";
const ordinary = "o".repeat(43),
  sender = "s".repeat(43);
export async function httpFixture() {
  const db = fakeDatabase();
  const provider = new FakeProvider();
  const audienceId = await provider.ensureAudience("everyone");
  const core = createNewsletter({
    supabase: db.client,
    provider,
    audienceId,
    footerAddress: "Example Address",
    from: "sender@example.com",
    replyTo: "reply@example.com",
    testRecipient: "owner@example.com",
    tokenHash: sha256(ordinary),
    sendTokenHash: sha256(sender),
  });
  const handler = newsletterHandler(core);
  const request = (path: string, method = "GET", data?: unknown, token: string | null = ordinary) =>
    handler(
      new Request(`https://example.com/api/newsletter/v1/${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      }),
    );
  return { db, provider, core, handler, request };
}
