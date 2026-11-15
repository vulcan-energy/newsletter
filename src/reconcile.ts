import type { NewsletterTables, NewsletterSubscriber } from "./types.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContactProvider, Contact } from "./provider.js";
import { checked, normalizeEmail, syncSubscriber } from "./subscribers.js";
import { nextStatus, type StatusInput, type Status } from "./rules.js";
import { NewsletterError } from "./errors.js";
export type Suppression = {
  email: string;
  status: Exclude<Status, "subscribed">;
  at: string;
};
type RowQuery = ReturnType<ReturnType<SupabaseClient["from"]>["select"]>;
export async function allRows<T extends keyof NewsletterTables>(
  db: SupabaseClient,
  table: T,
  scope: (query: RowQuery) => RowQuery = (query) => query,
): Promise<NewsletterTables[T][]> {
  const rows: NewsletterTables[T][] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = (checked(
      await scope(db.from(table).select("*"))
        .order("id")
        .range(offset, offset + 999),
    ) ?? []) as NewsletterTables[T][];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}
export async function applySuppression(db: SupabaseClient, email: string, input: StatusInput) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = checked(
      await db
        .from("newsletter_subscribers")
        .select("*")
        .eq("email", normalizeEmail(email))
        .maybeSingle<NewsletterSubscriber>(),
    );
    if (!row) return;
    const status = nextStatus(row, input);
    if (status === row.status) return;
    const now = new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1)).toISOString();
    const saved = checked(
      await db
        .from("newsletter_subscribers")
        .update({
          status,
          status_changed_at: input.type === "external_suppression" ? input.at : now,
          updated_at: now,
        })
        .eq("id", row.id)
        .eq("updated_at", row.updated_at)
        .select()
        .maybeSingle<NewsletterSubscriber>(),
    );
    if (saved) return;
  }
  throw new NewsletterError("Subscriber changed concurrently; reconcile again");
}
export async function reconcile(
  config: {
    supabase: SupabaseClient;
    provider: ContactProvider;
    audienceId: string;
    getExternalSuppressions?: () => Promise<Suppression[]>;
  },
  tag: string | null,
) {
  const { supabase: db, provider } = config;
  for (const suppression of (await config.getExternalSuppressions?.()) ?? [])
    await applySuppression(db, suppression.email, {
      type: "external_suppression",
      ...suppression,
    });
  const audience = tag ? await provider.ensureAudience(`tag:${tag}`) : config.audienceId;
  if (!audience) throw new NewsletterError("Audience required");
  const remote = new Map<string, Contact>();
  for await (const contact of provider.listContacts(audience)) {
    const email = normalizeEmail(contact.email);
    remote.set(email, contact);
    if (contact.unsubscribed) await applySuppression(db, email, { type: "contact_unsubscribed" });
  }
  const locals = await allRows(db, "newsletter_subscribers");
  for (const row of locals) {
    const belongs = !tag || row.tags.includes(tag);
    let contact: Contact | null | undefined = remote.get(row.email);
    if (contact && !belongs) {
      await provider.removeFromAudience(contact.id, audience);
      continue;
    }
    if (!belongs) continue;
    contact ??= await provider.findContact(row.email);
    if (contact?.unsubscribed)
      await applySuppression(db, row.email, { type: "contact_unsubscribed" });
    if (contact && row.status !== "subscribed") await provider.setUnsubscribed(contact.id);
    if (row.status === "subscribed" && !remote.has(row.email)) {
      if (contact) await provider.addToAudience(contact.id, audience);
      else await syncSubscriber(db, provider, audience, row);
    }
  }
  const latest = new Map(
    (await allRows(db, "newsletter_subscribers")).map((row) => [row.email, row]),
  );
  let count = 0;
  for await (const contact of provider.listContacts(audience)) {
    const row = latest.get(normalizeEmail(contact.email));
    if (!row) throw new NewsletterError("Unknown contact in audience; review before sending");
    if (tag && !row.tags.includes(tag)) throw new NewsletterError("Tag membership changed; reconcile again");
    if (contact.unsubscribed && row.status === "subscribed") {
      await applySuppression(db, row.email, { type: "contact_unsubscribed" });
      continue;
    }
    if (!contact.unsubscribed && row.status !== "subscribed")
      throw new NewsletterError("Provider suppression not confirmed");
    if (!contact.unsubscribed) count++;
  }
  return { audience, count };
}
