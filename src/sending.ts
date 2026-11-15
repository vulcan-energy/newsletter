import type { NewsletterCampaign } from "./types.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { imageResponse } from "./images.js";
import type { EmailProvider } from "./provider.js";
import { checked, sha256 } from "./subscribers.js";
import { allRows, reconcile, type Suppression } from "./reconcile.js";
import { trackingConsentEligible } from "./tracking.js";
import { renderTracking, unsubscribeLinks } from "./tracking-html.js";
import { sendingHealth, type SendingLimits } from "./health.js";
import { NewsletterError } from "./errors.js";
export type CampaignContent = {
  html: string;
  subject: string;
  slug: string;
  is_public: boolean;
};
export type ValidationConfig = {
  footerAddress: string;
  publicPageUrl?: (slug: string) => string;
  fetch?: typeof fetch;
};
export async function validateCampaign(
  c: CampaignContent,
  config: ValidationConfig,
) {
  if (!c.subject.trim()) throw new NewsletterError("Subject required");
  if (Buffer.byteLength(c.html) >= 102 * 1024)
    throw new NewsletterError("HTML must be under 102 KB");
  // The provider fills this in per reader: anywhere but a whole href it leaks or breaks.
  const placeholders = c.html.split("{{unsubscribe_url}}").length - 1;
  if (!placeholders) throw new NewsletterError("Unsubscribe placeholder required");
  if (unsubscribeLinks(c.html) !== placeholders)
    throw new NewsletterError(
      "Use {{unsubscribe_url}} only as the full link of an unsubscribe anchor",
    );
  if (/\*\||{{/.test(c.html.replaceAll("{{unsubscribe_url}}", "")))
    throw new NewsletterError("Unresolved merge tag");
  if (!config.footerAddress || !c.html.includes(config.footerAddress))
    throw new NewsletterError("Footer address required");
  if (
    !c.is_public &&
    config.publicPageUrl &&
    c.html.includes(config.publicPageUrl(c.slug))
  )
    throw new NewsletterError("Own public link requires public visibility");
  const urls = new Set<string>();
  for (const tag of c.html.matchAll(/<img\b[^>]*>/gi)) {
    const src = tag[0].match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!src) throw new NewsletterError("Image source required");
    urls.add(src[1] ?? src[2] ?? src[3]);
    // Responsive sources need the same checks as the fallback image.
    const srcset = tag[0].match(/\bsrcset\s*=\s*["']([^"']*)["']/i)?.[1];
    for (const source of srcset?.split(",") ?? [])
      urls.add(source.trim().split(/\s+/)[0]);
  }
  for (const match of c.html.matchAll(
    /\bbackground\s*=\s*["']([^"']+)["']|url\(\s*["']?([^\s)'";]+)["']?\s*\)/gi,
  ))
    urls.add(match[1] ?? match[2]);
  if (urls.size > 50) throw new NewsletterError("Use at most 50 different images");
  const sources = [...urls];
  for (let i = 0; i < sources.length; i += 10)
    await Promise.all(sources.slice(i, i + 10).map((source) => checkImage(source, config)));
}
async function checkImage(source: string, config: ValidationConfig) {
  let url: URL;
  try {
    url = new URL(source.replaceAll("&amp;", "&"));
  } catch {
    throw new NewsletterError("Image URL invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new NewsletterError("Images require HTTPS");
  const response = config.fetch
    ? await config.fetch(url.href, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      })
    : await imageResponse(url.href);
  const valid =
    response.status === 200 &&
    /^image\//i.test(response.headers.get("content-type") ?? "");
  await response.body?.cancel();
  if (!valid)
    throw new NewsletterError("Image must return 200 and an image content type");
}
export type NewsletterConfig = ValidationConfig & {
  supabase: SupabaseClient;
  provider: EmailProvider;
  audienceId: string;
  from: string;
  replyTo: string;
  testRecipient: string;
  trackingBaseUrl?: string;
  tokenHash?: string;
  sendTokenHash?: string;
  onSent?: (campaign: NewsletterCampaign) => Promise<void>;
  getExternalSuppressions?: () => Promise<Suppression[]>;
  sendingLimits?: SendingLimits;
  // Every error the HTTP handler turns into a failure, with detail in `cause`.
  onError?: (error: unknown) => void;
};
export type SendInput = {
  campaign_id: string;
  expected_recipient_count: number;
  review_sha256: string;
};
// What a sender confirms; changing any of these after review voids the confirmation.
export function reviewHash(
  c: Pick<NewsletterCampaign, "subject" | "preview_text" | "html_sha256" | "target_tag" | "is_public">,
) {
  return sha256(
    JSON.stringify([c.subject, c.preview_text ?? "", c.html_sha256, c.target_tag ?? null, !!c.is_public]),
  );
}
export function createNewsletter(config: NewsletterConfig) {
  const { supabase: db, provider } = config;
  async function load(id: string) {
    const row = checked(
      await db
        .from("newsletter_campaigns")
        .select("*")
        .eq("id", id)
        .maybeSingle<NewsletterCampaign>(),
    );
    if (!row) throw new NewsletterError("Campaign not found");
    return row;
  }
  async function change(
    row: NewsletterCampaign,
    patch: Partial<NewsletterCampaign>,
  ) {
    return checked(
      await db
        .from("newsletter_campaigns")
        .update(patch)
        .eq("id", row.id)
        .eq("status", row.status)
        .eq("updated_at", row.updated_at)
        .select()
        .maybeSingle<NewsletterCampaign>(),
    );
  }
  async function campaign(id: string) {
    const row = await load(id);
    if (
      row.status === "sending" &&
      Date.now() - Date.parse(row.updated_at) > 15 * 60_000
    )
      return (
        (await change(row, {
          status: row.provider_broadcast_id ? "send_unknown" : "draft",
          updated_at: new Date().toISOString(),
        })) ?? (await load(id))
      );
    return row;
  }
  const health = () => sendingHealth(db, config.sendingLimits);
  // One send at a time: an unresolved send must be settled before another starts.
  async function pendingSend(exceptId?: string) {
    for (const other of await allRows(db, "newsletter_campaigns", (q) =>
      q.in("status", ["sending", "send_unknown"]),
    ))
      if (other.id !== exceptId && (await campaign(other.id)).status !== "draft")
        return other.id;
    return null;
  }
  const bump = (row: NewsletterCampaign) =>
    new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1)).toISOString();
  // overrideLimits is for in-process owner actions only; the token API never passes it.
  async function send(
    input: SendInput,
    actor: string,
    options: { overrideLimits?: boolean } = {},
  ) {
    const row = await campaign(input.campaign_id);
    if (row.status !== "draft") throw new NewsletterError("Campaign is not a draft");
    if (
      !Number.isInteger(input.expected_recipient_count) ||
      input.expected_recipient_count < 0
    )
      throw new NewsletterError("Expected count required");
    await validateCampaign(row, config);
    if (
      input.review_sha256 !== reviewHash(row) ||
      sha256(row.html) !== row.html_sha256 ||
      row.last_test_sha256 !== row.html_sha256
    )
      throw new NewsletterError("Review hash and a test of the current HTML required");
    if (await pendingSend(row.id))
      throw new NewsletterError(
        "Another send is in progress or has an unknown outcome; resolve it first",
      );
    const { blockers } = await health();
    if (blockers.length && options.overrideLimits !== true)
      throw new NewsletterError(
        `${blockers.join(" ")} Review the last send; only an owner can override this hold.`,
      );
    const lease = new Date(
      Math.max(Date.now(), Date.parse(row.updated_at) + 1),
    ).toISOString();
    const claimed = await change(row, {
      status: "sending",
      updated_at: lease,
      provider_broadcast_id: null,
    });
    if (!claimed) throw new NewsletterError("Campaign already claimed or edited");
    // Re-check after claiming so racing sends both stop; if the check fails, release.
    const busy = await pendingSend(row.id).catch(async (error) => {
      await change(claimed, { status: "draft", updated_at: bump(claimed) }).catch(() => null);
      throw error;
    });
    if (busy) {
      await change(claimed, { status: "draft", updated_at: bump(claimed) });
      throw new NewsletterError(
        "Another send is in progress or has an unknown outcome; resolve it first",
      );
    }
    // The 15-minute claim is re-checked just before dispatch, so an expired one never sends.
    let current = claimed;
    let saved: NewsletterCampaign | null;
    try {
      const target = await reconcile(config, row.target_tag);
      if (target.count !== input.expected_recipient_count)
        throw new NewsletterError("Recipient count changed; review and test again");
      let outgoing = row.html;
      let tracking: Partial<NewsletterCampaign> = {};
      if (config.trackingBaseUrl) {
        await provider.assertTrackingDisabled(config.from);
        const rendered = renderTracking(
          row.html,
          row.id,
          config.trackingBaseUrl,
        );
        // The database stamps this cutoff using the same clock as consent grants.
        const prepared = await change(current, {
          tracking_started_at: new Date().toISOString(),
          tracking_links: rendered.links,
        });
        if (!prepared?.tracking_started_at)
          throw new NewsletterError("Tracking preparation lost its send claim");
        current = prepared;
        const started = prepared.tracking_started_at;
        const people = new Map(
          (await allRows(db, "newsletter_subscribers")).map((person) => [
            person.email,
            person,
          ]),
        );
        let eligible = 0;
        for await (const contact of provider.listContacts(target.audience)) {
          const person = people.get(contact.email.trim().toLowerCase());
          if (!person)
            throw new NewsletterError(
              "Unknown audience contact during tracking preparation",
            );
          if (contact.unsubscribed) continue;
          const token =
            person.status === "subscribed" ? person.tracking_token : null;
          await provider.setTrackingToken(contact.id, token ?? null);
          if (trackingConsentEligible(person, started)) eligible++;
        }
        tracking = {
          tracking_recipient_count: eligible,
        };
        outgoing = rendered.html;
        if (
          (await reconcile(config, row.target_tag)).count !==
          input.expected_recipient_count
        )
          throw new NewsletterError(
            "Recipient count changed during tracking preparation; review again",
          );
      }
      const id = await provider.createBroadcast({
        audience: target.audience,
        subject: row.subject,
        html: outgoing,
        previewText: row.preview_text,
        from: config.from,
        replyTo: config.replyTo,
      });
      saved = await change(current, {
        ...tracking,
        provider_broadcast_id: id,
        recipient_count: target.count,
        sent_by: actor,
      });
      if (!saved)
        throw new NewsletterError("Send claim expired; broadcast remains unsent");
    } catch (error) {
      await change(current, {
        status: "draft",
        provider_broadcast_id: null,
        updated_at: new Date().toISOString(),
      });
      throw error;
    }
    let sent,
      fresh: NewsletterCampaign | null = null;
    try {
      if (config.trackingBaseUrl)
        await provider.assertTrackingDisabled(config.from);
      fresh = await change(saved, { updated_at: bump(saved) });
      if (!fresh)
        throw new NewsletterError(
          "Send claim expired before dispatch; the broadcast was not sent. Resolve it as failed",
          "claim_expired",
        );
      await provider.sendBroadcast(fresh.provider_broadcast_id!);
      sent = await change(fresh, {
        status: "sent",
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      if (!sent) throw new NewsletterError("Send outcome needs review");
    } catch (error) {
      if (error instanceof NewsletterError && error.code === "claim_expired") throw error;
      await change(fresh ?? saved, {
        status: "send_unknown",
        updated_at: new Date().toISOString(),
      });
      throw new NewsletterError(
        "Send outcome unknown; inspect provider state, never retry automatically",
        "send_unknown",
      );
    }
    let notificationFailed = false;
    try {
      await config.onSent?.(sent);
    } catch {
      notificationFailed = true;
    }
    return { ...sent, notificationFailed };
  }
  // "Not found" can also mean a wrong key or account, so the owner must confirm deletion.
  async function resolveUnknown(
    id: string,
    outcome: "sent" | "failed",
    actor: string,
    { confirmedDeleted = false } = {},
  ) {
    const row = await campaign(id);
    if (row.status !== "send_unknown" || !row.provider_broadcast_id)
      throw new NewsletterError("No unknown send to resolve");
    const state = await provider.getBroadcastState(row.provider_broadcast_id);
    if (outcome === "failed" && state === "missing" && !confirmedDeleted)
      throw new NewsletterError(
        "Resend has no record of this broadcast. Check the dashboard and confirm it was deleted unsent",
      );
    if (outcome === "failed" && state !== "draft" && state !== "missing")
      throw new NewsletterError("Only an unsent or deleted provider broadcast can be marked failed");
    const changed = await change(row, {
      status: outcome,
      sent_by: actor,
      ...(outcome === "sent" ? { sent_at: new Date().toISOString() } : {}),
      updated_at: new Date().toISOString(),
    });
    if (!changed) throw new NewsletterError("Campaign changed; reload");
    if (outcome === "sent") {
      try {
        await config.onSent?.(changed);
      } catch {
        return { ...changed, notificationFailed: true };
      }
      return changed;
    }
    const slug = `${row.slug}-${randomUUID().slice(0, 8)}`;
    const html = config.publicPageUrl
      ? row.html.replaceAll(
          config.publicPageUrl(row.slug),
          config.publicPageUrl(slug),
        )
      : row.html;
    return checked(
      await db
        .from("newsletter_campaigns")
        .insert({
          slug,
          html,
          html_sha256: sha256(html),
          subject: row.subject,
          preview_text: row.preview_text,
          target_tag: row.target_tag,
          is_public: row.is_public,
          source: "provider",
          status: "draft",
          last_test_sha256: null,
          provider_broadcast_id: null,
        })
        .select()
        .single<NewsletterCampaign>(),
    );
  }
  return {
    config,
    campaign,
    send,
    health,
    pendingSend,
    resolveUnknown,
    reconcile: (tag: string | null) => reconcile(config, tag),
    validate: (c: CampaignContent) => validateCampaign(c, config),
  };
}
