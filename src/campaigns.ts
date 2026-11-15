import type { NewsletterCampaign } from "./types.js";
import { randomUUID } from "node:crypto";
import { draftSchema, assetSchema } from "./schemas.js";
import { checked, sha256 } from "./subscribers.js";
import { validateCampaign, type NewsletterConfig } from "./sending.js";
import { renderTracking } from "./tracking-html.js";
import { NewsletterError } from "./errors.js";
export async function saveDraft(
  config: NewsletterConfig,
  input: unknown,
  dryRun = false,
) {
  const data = draftSchema.parse(input);
  await validateCampaign(data, config);
  if (config.trackingBaseUrl)
    renderTracking(data.html, data.id ?? randomUUID(), config.trackingBaseUrl);
  const db = config.supabase;
  if (dryRun) return { ...data, html_sha256: sha256(data.html), dry_run: true };
  const { id, ...fields } = data;
  const patch = {
    ...fields,
    html_sha256: sha256(data.html),
    last_test_sha256: null,
    // Links from an earlier test must not keep redirecting after an edit.
    tracking_links: [],
    updated_at: new Date().toISOString(),
  };
  if (!id)
    return checked(
      await db
        .from("newsletter_campaigns")
        .insert({ ...patch, source: "provider", status: "draft" })
        .select()
        .single<NewsletterCampaign>(),
    );
  const old = checked(
    await db
      .from("newsletter_campaigns")
      .select("*")
      .eq("id", id)
      .maybeSingle<NewsletterCampaign>(),
  );
  if (!old || old.status !== "draft")
    throw new NewsletterError("Only drafts can be edited");
  patch.updated_at = new Date(
    Math.max(Date.now(), Date.parse(old.updated_at) + 1),
  ).toISOString();
  const saved = checked(
    await db
      .from("newsletter_campaigns")
      .update(patch)
      .eq("id", id)
      .eq("status", "draft")
      .eq("updated_at", old.updated_at)
      .select()
      .maybeSingle<NewsletterCampaign>(),
  );
  if (!saved) throw new NewsletterError("Draft changed; reload");
  return saved;
}
export async function testCampaign(
  config: NewsletterConfig,
  id: string,
  recipient = config.testRecipient,
) {
  const db = config.supabase;
  const row = checked(
    await db
      .from("newsletter_campaigns")
      .select("*")
      .eq("id", id)
      .maybeSingle<NewsletterCampaign>(),
  );
  if (!row || row.status !== "draft")
    throw new NewsletterError("Only drafts can be tested");
  await validateCampaign(row, config);
  if (!recipient || sha256(row.html) !== row.html_sha256)
    throw new NewsletterError("Test recipient and matching HTML required");
  let outgoing = row.html,
    current = row;
  if (config.trackingBaseUrl) {
    const rendered = renderTracking(row.html, row.id, config.trackingBaseUrl);
    await config.provider.assertTrackingDisabled(config.from);
    const prepared = checked(
      await db
        .from("newsletter_campaigns")
        // Refreshing updated_at restarts the 72-hour window for draft links.
        .update({
          tracking_links: rendered.links,
          updated_at: new Date(
            Math.max(Date.now(), Date.parse(row.updated_at) + 1),
          ).toISOString(),
        })
        .eq("id", id)
        .eq("status", "draft")
        .eq("updated_at", row.updated_at)
        .eq("html_sha256", row.html_sha256)
        .select()
        .maybeSingle<NewsletterCampaign>(),
    );
    if (!prepared) throw new NewsletterError("Draft changed before test; reload");
    current = prepared;
    outgoing = rendered.html.replaceAll("{{tracking_token}}", "none");
  }
  await config.provider.sendTest({
    to: recipient,
    html: outgoing,
    subject: `[TEST] ${row.subject}`,
    previewText: row.preview_text,
    from: config.from,
    replyTo: config.replyTo,
  });
  const saved = checked(
    await db
      .from("newsletter_campaigns")
      .update({ last_test_sha256: row.html_sha256 })
      .eq("id", id)
      .eq("status", "draft")
      .eq("updated_at", current.updated_at)
      .eq("html_sha256", row.html_sha256)
      .select()
      .maybeSingle<NewsletterCampaign>(),
  );
  if (!saved) throw new NewsletterError("Draft changed while test was sent; test again");
  return saved;
}
export async function uploadAsset(config: NewsletterConfig, input: unknown) {
  const data = assetSchema.parse(input);
  const bytes = Buffer.from(data.base64, "base64");
  if (!bytes.length || bytes.length > 5 * 1024 * 1024)
    throw new NewsletterError("Image must be between 1 byte and 5 MB");
  const signature = {
    "image/png": bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
    "image/jpeg": bytes.subarray(0, 3).toString("hex") === "ffd8ff",
    "image/gif": /^GIF8[79]a/.test(bytes.subarray(0, 6).toString("latin1")),
    "image/webp":
      bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
      bytes.subarray(8, 12).toString("latin1") === "WEBP",
  }[data.mime];
  if (!signature) throw new NewsletterError(`Image bytes do not match ${data.mime}`);
  const key = randomUUID();
  const bucket = config.supabase.storage.from("newsletter-assets");
  checked(
    await bucket.upload(key, bytes, { contentType: data.mime, upsert: false }),
  );
  return { url: bucket.getPublicUrl(key).data.publicUrl };
}
