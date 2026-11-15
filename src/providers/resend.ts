import { Resend, type Response as ProviderResponse } from "resend";
import { z } from "zod";
import type { EmailProvider, NormalizedEvent, EventType } from "../provider.js";
import { NewsletterError } from "../errors.js";

export function createResendProvider(
  key: string,
  webhookSecret?: string,
): EmailProvider {
  if (!key) throw new NewsletterError("Provider key required");
  const client = new Resend(key);
  let nextRequest = 0;
  async function request<T>(
    call: () => Promise<ProviderResponse<T>>,
    missing = false,
  ): Promise<T | null> {
    const wait = Math.max(0, nextRequest - Date.now());
    nextRequest = Date.now() + wait + 200;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const result = await call();
    if (result.error) {
      if (
        missing &&
        (result.error.statusCode === 404 || result.error.name === "not_found")
      )
        return null;
      // Status and name diagnose setup without personal data; the message stays in `cause`.
      throw new NewsletterError(
        `Provider request failed (${result.error.statusCode ?? "no status"} ${result.error.name})`,
        "provider_failed",
        { cause: result.error },
      );
    }
    if (!result.data) throw new NewsletterError("Provider response missing");
    return result.data;
  }
  async function findContact(email: string) {
    return request(() => client.contacts.get(encodeURIComponent(email)), true);
  }
  return {
    async assertTrackingDisabled(from) {
      const domain = from.match(/@([^<>\s]+)>?$/)?.[1]?.toLowerCase();
      let after: string | undefined;
      let found = false;
      do {
        const page = (await request(() =>
          client.domains.list({ limit: 100, after }),
        ))!;
        const match = page.data.find(
          (item) => item.name.toLowerCase() === domain,
        );
        if (match) {
          if (match.open_tracking !== false || match.click_tracking !== false)
            throw new NewsletterError("Native provider tracking must be disabled");
          found = true;
          break;
        }
        if (!page.has_more) break;
        const last = page.data.at(-1)?.id;
        if (!last || last === after)
          throw new NewsletterError("Incomplete domain pagination");
        after = last;
      } while (true);
      if (!found) throw new NewsletterError("Sending domain tracking state unavailable");
      after = undefined;
      do {
        const page = (await request(() =>
          client.contactProperties.list({ limit: 100, after }),
        ))!;
        const property = page.data.find(
          (item) => item.key === "newsletter_token",
        );
        if (property?.type === "string" && property.fallbackValue === "none")
          return;
        if (!page.has_more) break;
        const last = page.data.at(-1)?.id;
        if (!last || last === after)
          throw new NewsletterError("Incomplete property pagination");
        after = last;
      } while (true);
      throw new NewsletterError(
        "Tracking property newsletter_token with fallback none required",
      );
    },
    async setTrackingToken(id, token) {
      await request(() =>
        client.contacts.update({
          id,
          properties: { newsletter_token: token ?? "none" },
        }),
      );
    },
    async createBroadcast({ audience, html, ...message }) {
      return (await request(() =>
        client.broadcasts.create({
          ...message,
          segmentId: audience,
          send: false,
          html: html
            .replaceAll(
              "{{tracking_token}}",
              "{{{contact.newsletter_token|none}}}",
            )
            .replaceAll("{{unsubscribe_url}}", "{{{RESEND_UNSUBSCRIBE_URL}}}"),
        }),
      ))!.id;
    },
    async sendBroadcast(id) {
      await request(() => client.broadcasts.send(id));
    },
    async getBroadcastState(id) {
      const result = await request(() => client.broadcasts.get(id), true);
      if (!result) return "missing";
      const state = result.status;
      return state === "queued"
        ? "sending"
        : state === "draft" || state === "sent"
          ? state
          : "unknown";
    },
    async sendTest({ html, previewText: _preview, ...message }) {
      await request(() =>
        client.emails.send({
          ...message,
          html: html
            .replaceAll("{{tracking_token}}", "none")
            .replaceAll("{{unsubscribe_url}}", "#unsubscribe-disabled-in-test"),
        }),
      );
    },
    parseWebhook(rawBody, headers) {
      if (!webhookSecret) throw new NewsletterError("Webhook secret required");
      const verified = client.webhooks.verify({
        payload: rawBody,
        webhookSecret,
        headers: {
          id: headers.get("svix-id") ?? "",
          timestamp: headers.get("svix-timestamp") ?? "",
          signature: headers.get("svix-signature") ?? "",
        },
      });
      const event = z
        .object({
          type: z.string(),
          created_at: z.string().datetime({ offset: true }),
          data: z.object({
            email: z.string().optional(),
            to: z.array(z.string()).optional(),
            from: z.string().optional(),
            broadcast_id: z.string().optional(),
            unsubscribed: z.boolean().optional(),
            click: z.object({ link: z.string() }).optional(),
            bounce: z.object({ type: z.string() }).optional(),
          }),
        })
        .parse(verified);
      const contact = event.type === "contact.updated";
      if (contact && event.data.unsubscribed !== true) return [];
      const type = (
        contact ? "contact_unsubscribed" : event.type.replace(/^email\./, "")
      ) as EventType;
      if (
        ![
          "contact_unsubscribed",
          "delivered",
          "opened",
          "clicked",
          "bounced",
          "complained",
          "failed",
          "suppressed",
        ].includes(type)
      )
        return [];
      const emails = contact ? [event.data.email] : event.data.to;
      if (!emails?.length || emails.some((email) => !email?.includes("@")))
        throw new NewsletterError("Event recipient missing");
      let url = event.data.click?.link;
      if (url && new URL(url).hostname === "unsubscribe.resend.com")
        url = undefined;
      const sender = event.data.from?.match(/<?([^<>\s]+@[^<>\s]+)>?$/)?.[1];
      return emails.map(
        (email, index): NormalizedEvent => ({
          id: headers.get("svix-id")! + (emails.length > 1 ? `:${index}` : ""),
          type,
          email: email!.trim().toLowerCase(),
          occurredAt: event.created_at,
          broadcastId: event.data.broadcast_id,
          fromDomain: sender?.split("@").at(-1)?.toLowerCase(),
          permanent: event.data.bounce?.type === "Permanent",
          url,
        }),
      );
    },
    findContact,
    async createContact(contact) {
      const existing = await findContact(contact.email);
      if (existing) return existing.id;
      return (await request(() => client.contacts.create(contact)))!.id;
    },
    async *listContacts(audience) {
      let after: string | undefined;
      do {
        const page = (await request(() =>
          client.contacts.list({ segmentId: audience, limit: 100, after }),
        ))!;
        yield* page.data;
        if (!page.has_more) return;
        const last = page.data.at(-1)?.id;
        if (!last || last === after)
          throw new NewsletterError("Incomplete provider pagination");
        after = last;
      } while (true);
    },
    async ensureAudience(name) {
      let after: string | undefined;
      do {
        const page = (await request(() =>
          client.segments.list({ limit: 100, after }),
        ))!;
        const found = page.data.find((audience) => audience.name === name);
        if (found) return found.id;
        if (!page.has_more) break;
        const last = page.data.at(-1)?.id;
        if (!last || last === after)
          throw new NewsletterError("Incomplete provider pagination");
        after = last;
      } while (true);
      return (await request(() => client.segments.create({ name })))!.id;
    },
    async deleteContact(id) {
      await request(() => client.contacts.remove(id), true);
    },
    async setUnsubscribed(id) {
      await request(() => client.contacts.update({ id, unsubscribed: true }));
    },
    async resubscribe(id) {
      await request(() => client.contacts.update({ id, unsubscribed: false }));
    },
    async addToAudience(id, audience) {
      await request(() =>
        client.contacts.segments.add({ contactId: id, segmentId: audience }),
      );
    },
    async removeFromAudience(id, audience) {
      await request(() =>
        client.contacts.segments.remove({ contactId: id, segmentId: audience }),
      );
    },
  };
}
