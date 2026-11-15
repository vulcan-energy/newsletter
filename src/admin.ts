import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ContactProvider } from "./provider.js";
import { checked, hashEmail, normalizeEmail, storedAddress } from "./subscribers.js";
import { nextStatus } from "./rules.js";
import { allRows } from "./reconcile.js";
import { eventsForSubscriber, isErasedStats, reportTotals, mergeStats } from "./reports.js";
import type { NewsletterSubscriber } from "./types.js";
import { NewsletterError } from "./errors.js";
const profile = z
  .object({
    first_name: z.string().max(200).nullable().optional(),
    last_name: z.string().max(200).nullable().optional(),
    company: z.string().max(200).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  })
  .strict();
export async function editSubscriber(
  db: SupabaseClient,
  id: string,
  input: unknown,
): Promise<NewsletterSubscriber> {
  const patch = profile.parse(input);
  const row: NewsletterSubscriber | null = checked(
    await db.from("newsletter_subscribers").select("*").eq("id", id).maybeSingle(),
  );
  if (!row) throw new NewsletterError("Subscriber not found");
  const saved: NewsletterSubscriber | null = checked(
    await db
      .from("newsletter_subscribers")
      .update({
        ...patch,
        status: nextStatus(row, { type: "edit" }),
        updated_at: new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1)).toISOString(),
      })
      .eq("id", id)
      .eq("updated_at", row.updated_at)
      .select()
      .maybeSingle(),
  );
  if (!saved) throw new NewsletterError("Subscriber changed; reload");
  return saved;
}
export async function clearErasure(db: SupabaseClient, email: string) {
  checked(
    await db
      .from("newsletter_erasures")
      .delete()
      .eq("email_sha256", hashEmail(storedAddress(email))),
  );
}
export async function resubscribeSubscriber(
  db: SupabaseClient,
  provider: ContactProvider,
  id: string,
  reason: string,
): Promise<NewsletterSubscriber> {
  const consent = z.string().trim().min(1).max(1000).parse(reason);
  const row: NewsletterSubscriber | null = checked(
    await db.from("newsletter_subscribers").select("*").eq("id", id).maybeSingle(),
  );
  if (!row) throw new NewsletterError("Subscriber not found");
  nextStatus(row, { type: "resubscribe" });
  const hash = hashEmail(row.email);
  if (
    checked(await db.from("newsletter_erasures").select("*").eq("email_sha256", hash).maybeSingle())
  )
    throw new NewsletterError("Clear erasure before accepting fresh consent");
  const contact = await provider.createContact({ email: row.email, unsubscribed: true });
  await provider.resubscribe(contact);
  try {
    const saved = checked<NewsletterSubscriber | null>(
      await db.rpc("newsletter_resubscribe", {
        p_id: id,
        p_hash: hash,
        p_expected_updated_at: row.updated_at,
        p_reason: consent,
      }),
    );
    if (!saved) throw new NewsletterError("Subscriber changed; reload");
    return saved;
  } catch (error) {
    // A failed local commit must not leave provider consent ahead of the database.
    await provider.setUnsubscribed(contact);
    if (
      checked(
        await db.from("newsletter_erasures").select("*").eq("email_sha256", hash).maybeSingle(),
      )
    )
      await provider.deleteContact(contact);
    throw error;
  }
}
export async function eraseSubscriber(
  db: SupabaseClient,
  provider: ContactProvider,
  input: string,
) {
  const email = storedAddress(input);
  const hash = hashEmail(email);
  let row: NewsletterSubscriber | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    row = checked(
      await db.from("newsletter_subscribers").select("*").eq("email", email).maybeSingle(),
    );
    if (
      checked(
        await db.rpc("newsletter_begin_erasure", {
          p_email: email,
          p_hash: hash,
          p_expected_updated_at: row?.updated_at ?? null,
          p_status: row ? nextStatus(row, { type: "contact_unsubscribed" }) : "unsubscribed",
        }),
      )
    )
      break;
    if (attempt === 2) throw new NewsletterError("Subscriber changed; retry erasure");
  }
  const contact = await provider.findContact(email);
  if (contact) await provider.deleteContact(contact.id);
  if (!row) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    row = checked(
      await db.from("newsletter_subscribers").select("*").eq("email", email).maybeSingle(),
    );
    if (!row) return;
    const campaigns = await allRows(db, "newsletter_campaigns");
    const events = await eventsForSubscriber(db, row.id);
    const updates = campaigns
      .filter(
        (campaign) =>
          (!campaign.stats || isErasedStats(campaign.stats)) &&
          (events.some((event) => event.campaign_id === campaign.id) ||
            reportTotals({ ...campaign, stats: null }, events, campaigns).unsubscribes),
      )
      .map((campaign) => ({
        id: campaign.id,
        expected_stats: campaign.stats ?? null,
        stats: {
          kind: "erased",
          totals: mergeStats(
            reportTotals({ ...campaign, stats: null }, events, campaigns),
            isErasedStats(campaign.stats) ? campaign.stats.totals : undefined,
          ),
        },
      }));
    if (
      checked(
        await db.rpc("newsletter_finish_erasure", {
          p_email: email,
          p_hash: hash,
          p_subscriber_id: row.id,
          p_event_ids: events.map((event) => event.id),
          p_campaign_updates: updates,
        }),
      )
    )
      return;
  }
  throw new NewsletterError("Subscriber history changed concurrently; retry erasure");
}
export const subscriberInputSchema = profile
  .extend({
    email: z.email().transform(normalizeEmail),
    status: z.enum(["subscribed", "unsubscribed", "cleaned"]).default("subscribed"),
    tags: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    consent_source: z.string().trim().min(1).max(1000),
    status_changed_at: z.iso.datetime({ offset: true }).optional(),
  })
  .refine(
    (row) => row.status === "subscribed" || !!row.status_changed_at,
    "Suppression timestamp required",
  );
