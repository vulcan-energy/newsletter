import type { NewsletterSubscriber } from "./types.js";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContactProvider } from "./provider.js";
import { nextStatus, type Status } from "./rules.js";
import { NewsletterError } from "./errors.js";
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const hashEmail = (email: string) =>
  createHash("sha256").update(normalizeEmail(email)).digest("hex");
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function checked<T>({ data, error }: { data: T; error: unknown }): T {
  // The driver error stays in `cause` for host logs; it is not shown over HTTP.
  if (error)
    throw new NewsletterError("Newsletter storage operation failed", "storage_failed", {
      cause: error,
    });
  return data;
}
// Signup and erasure share this check, so every stored address can be erased.
export function storedAddress(input: string) {
  const email = normalizeEmail(input);
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 320)
    throw new NewsletterError("Email address required");
  return email;
}
export type SubscriberInput = {
  email: string;
  status: Status;
  consent_source: string;
  tracking_consent_source?: string;
  tags: string[];
  first_name?: string;
  last_name?: string;
  company?: string;
  external_id?: string;
  status_changed_at?: string;
  consent_at?: string | null;
  consent_ip?: string | null;
};
export async function importSubscriber(
  db: SupabaseClient,
  input: SubscriberInput,
): Promise<NewsletterSubscriber | null> {
  const email = storedAddress(input.email);
  if (!input.consent_source.trim()) throw new NewsletterError("Consent source required");
  for (let attempt = 0; attempt < 3; attempt++) {
    const erased = checked(
      await db
        .from("newsletter_erasures")
        .select("email_sha256")
        .eq("email_sha256", hashEmail(email))
        .maybeSingle(),
    );
    if (erased) return null;
    const row = checked(
      await db
        .from("newsletter_subscribers")
        .select("*")
        .eq("email", email)
        .maybeSingle<NewsletterSubscriber>(),
    );
    const now = new Date().toISOString();
    if (!row) {
      const inserted = await db.rpc("newsletter_insert_subscriber", {
        p_row: { ...input, email, updated_at: now },
        p_hash: hashEmail(email),
      });
      if (inserted.error?.code === "23505") continue;
      return checked<NewsletterSubscriber | null>(inserted);
    }
    const status =
      input.status === "subscribed"
        ? nextStatus(row, { type: "import" })
        : nextStatus(row, {
            type: "external_suppression",
            status: input.status,
            at: input.status_changed_at ?? "",
          });
    const patch = {
      first_name: input.first_name ?? row.first_name,
      last_name: input.last_name ?? row.last_name,
      company: input.company ?? row.company,
      external_id: input.external_id ?? row.external_id,
      tags: [...new Set([...row.tags, ...input.tags])],
      status,
      status_changed_at:
        status === row.status ? row.status_changed_at : input.status_changed_at,
      updated_at: new Date(
        Math.max(Date.now(), Date.parse(row.updated_at) + 1),
      ).toISOString(),
    };
    const saved = checked(
      await db
        .from("newsletter_subscribers")
        .update(patch)
        .eq("id", row.id)
        .eq("updated_at", row.updated_at)
        .eq("status", row.status)
        .select()
        .maybeSingle<NewsletterSubscriber>(),
    );
    if (saved) return saved;
  }
  throw new NewsletterError("Subscriber changed concurrently; retry import");
}

export type SignupInput = {
  email: string;
  consent_source: string;
  tracking_consent_source?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  tags?: string[];
};
export function addSubscriber(db: SupabaseClient, input: SignupInput) {
  return importSubscriber(db, {
    email: input.email,
    first_name: input.first_name,
    last_name: input.last_name,
    company: input.company,
    tags: input.tags ?? [],
    consent_source: input.consent_source,
    tracking_consent_source: input.tracking_consent_source,
    consent_at: new Date().toISOString(),
    status: "subscribed",
  });
}
export async function syncSubscriber(
  db: SupabaseClient,
  provider: ContactProvider,
  audience: string,
  row: {
    id: string;
    email: string;
    status: Status;
    first_name?: string | null;
    last_name?: string | null;
  },
) {
  if (!audience) throw new NewsletterError("Audience required");
  async function current() {
    if (
      checked(
        await db
          .from("newsletter_erasures")
          .select("email_sha256")
          .eq("email_sha256", hashEmail(row.email))
          .maybeSingle(),
      )
    )
      return null;
    return checked(
      await db
        .from("newsletter_subscribers")
        .select("*")
        .eq("id", row.id)
        .maybeSingle<NewsletterSubscriber>(),
    );
  }
  const before = await current();
  if (!before) return null;
  const id = await provider.createContact({
    email: before.email,
    firstName: before.first_name ?? undefined,
    lastName: before.last_name ?? undefined,
    unsubscribed: before.status !== "subscribed",
  });
  const after = await current();
  if (!after) {
    await provider.deleteContact(id);
    return null;
  }
  if (after.status !== "subscribed") await provider.setUnsubscribed(id);
  await provider.addToAudience(id, audience);
  checked(
    await db
      .from("newsletter_subscribers")
      .update({ provider_contact_id: id })
      .eq("id", row.id),
  );
  return id;
}
