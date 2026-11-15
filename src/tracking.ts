import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NewsletterCampaign, NewsletterSubscriber } from "./types.js";
import { checked, hashEmail, sha256 } from "./subscribers.js";
import { NewsletterError } from "./errors.js";
import { renderTracking } from "./tracking-html.js";

type TrackingCampaign = Pick<
  NewsletterCampaign,
  | "id"
  | "status"
  | "provider_broadcast_id"
  | "tracking_started_at"
  | "tracking_links"
>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const pixel = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
function response(
  body: BodyInit | null,
  status = 200,
  extra: Record<string, string> = {},
) {
  return new Response(body, { status, headers: { ...headers, ...extra } });
}
async function erased(db: SupabaseClient, row: NewsletterSubscriber) {
  return checked(
    await db
      .from("newsletter_erasures")
      .select("email_sha256")
      .eq("email_sha256", hashEmail(row.email))
      .maybeSingle(),
  );
}
async function changeConsent(
  db: SupabaseClient,
  row: NewsletterSubscriber,
  source: string | null,
) {
  const now = new Date().toISOString();
  const patch =
    source === null
      ? { tracking_token: null, tracking_revoked_at: now }
      : {
          tracking_token: randomUUID(),
          tracking_consent_source: source,
          tracking_granted_at: now,
          tracking_revoked_at: null,
        };
  return checked(
    await db
      .from("newsletter_subscribers")
      .update({
        ...patch,
        updated_at: new Date(
          Math.max(Date.now(), Date.parse(row.updated_at) + 1),
        ).toISOString(),
      })
      .eq("id", row.id)
      .eq("updated_at", row.updated_at)
      .select()
      .maybeSingle<NewsletterSubscriber>(),
  );
}
/** Only an explicit recorded tracking choice may call this; ordinary subscription sync must not. */
export async function setTrackingConsent(
  db: SupabaseClient,
  id: string,
  source: string | null,
): Promise<NewsletterSubscriber> {
  if (source !== null && (!source.trim() || source.length > 2000))
    throw new NewsletterError("Tracking consent proof required");
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = checked(
      await db
        .from("newsletter_subscribers")
        .select("*")
        .eq("id", id)
        .maybeSingle<NewsletterSubscriber>(),
    );
    if (!row) throw new NewsletterError("Subscriber not found");
    if (
      source !== null &&
      (row.status !== "subscribed" || (await erased(db, row)))
    )
      throw new NewsletterError(
        "Tracking consent requires a subscribed, non-erased recipient",
      );
    const saved = await changeConsent(db, row, source?.trim() ?? null);
    if (saved) return saved;
  }
  throw new NewsletterError("Subscriber changed concurrently; retry consent update");
}
async function preferences(
  db: SupabaseClient,
  request: Request,
  token: string | null,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (request.method === "POST" && origin && origin !== url.origin)
    return response("Forbidden", 403);
  const row = token
    ? checked(
        await db
          .from("newsletter_subscribers")
          .select("*")
          .eq("tracking_token", token)
          .maybeSingle<NewsletterSubscriber>(),
      )
    : null;
  if (request.method === "POST" && row && !(await changeConsent(db, row, null)))
    return response("Preferences changed. Reload and try again.", 409);
  const content =
    request.method === "POST" || !row
      ? "<p>Tracking is off for this link. Your newsletter subscription has not changed.</p>"
      : '<p>Stop recording opens and clicks from your newsletter emails?</p><form method="post"><button type="submit">Turn off tracking</button></form>';
  return response(
    request.method === "HEAD"
      ? null
      : `<!doctype html><html lang="en"><meta charset="utf-8"><title>Newsletter tracking</title><meta name="viewport" content="width=device-width,initial-scale=1"><body><main>${content}</main></body></html>`,
    200,
    {
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "same-origin",
      "content-security-policy":
        "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  );
}
// PostgreSQL timestamps retain microseconds; Date.parse alone could revive an old queued issue.
function micros(value: string) {
  return (
    BigInt(Date.parse(value)) * 1000n +
    BigInt((value.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0").slice(3, 6))
  );
}
export function trackingConsentEligible(
  row: Pick<
    NewsletterSubscriber,
    "status" | "tracking_token" | "tracking_granted_at" | "tracking_revoked_at"
  >,
  cutoff: string,
): boolean {
  try {
    return (
      row.status === "subscribed" &&
      !!row.tracking_token &&
      !!row.tracking_granted_at &&
      !row.tracking_revoked_at &&
      micros(row.tracking_granted_at) <= micros(cutoff)
    );
  } catch {
    return false;
  }
}
async function collect(
  db: SupabaseClient,
  campaign: TrackingCampaign,
  token: string,
  destination: string | null,
) {
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 24);
  if (
    !campaign.tracking_started_at ||
    micros(campaign.tracking_started_at) <= micros(cutoff.toISOString()) ||
    !campaign.provider_broadcast_id ||
    !["sending", "sent", "send_unknown"].includes(campaign.status)
  )
    return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = checked(
      await db
        .from("newsletter_subscribers")
        .select("*")
        .eq("tracking_token", token)
        .maybeSingle<NewsletterSubscriber>(),
    );
    if (
      !row ||
      !trackingConsentEligible(row, campaign.tracking_started_at) ||
      (await erased(db, row))
    )
      return;
    const recorded = checked(
      await db.rpc("newsletter_record_event", {
        p_subscriber_id: row.id,
        p_expected_updated_at: row.updated_at,
        p_status: row.status,
        p_contact_unsubscribed: false,
        p_event: {
          campaign_id: campaign.id,
          type: destination === null ? "opened" : "clicked",
          url: destination,
          occurred_at: new Date().toISOString(),
          // Coalesce repeated scanner/replay requests without storing client metadata.
          provider_event_id: `tracking:${campaign.id}:${row.id}:${destination === null ? "open" : sha256(destination)}:${Math.floor(Date.now() / 60_000)}`,
        },
      }),
    );
    if (recorded) return;
  }
}
/** Mount only on the host's tracking route; exclude application telemetry and follow the host's approved operational-log policy. */
export async function handleTrackingRequest(
  db: SupabaseClient,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const action = parts.pop() ?? "",
    campaignId = parts.pop() ?? "";
  if (
    !uuid.test(campaignId) ||
    !/^(open|preferences|0|[1-9]\d{0,5})$/.test(action)
  )
    return response("Not found", 404);
  if (url.searchParams.getAll("token").length > 1)
    return response("Invalid token", 400);
  const value = url.searchParams.get("token") ?? "none";
  const token = uuid.test(value) ? value.toLowerCase() : null;
  if (
    !["GET", "HEAD", ...(action === "preferences" ? ["POST"] : [])].includes(
      request.method,
    )
  )
    return response("Method not allowed", 405);
  try {
    const campaign = checked(
      await db
        .from("newsletter_campaigns")
        .select(
          "id,status,provider_broadcast_id,tracking_started_at,tracking_links",
        )
        .eq("id", campaignId.toLowerCase())
        .maybeSingle<TrackingCampaign>(),
    );
    if (!campaign) return response("Not found", 404);
    if (action === "preferences") return await preferences(db, request, token);
    let destination: string | null = null;
    if (action !== "open") {
      destination = campaign.tracking_links?.[Number(action)] ?? null;
      if (!destination || /[\u0000-\u0020\u007f]/.test(destination))
        return response("Not found", 404);
      // Test-email links work only while still in the draft and for 72 hours after its
      // last test or edit, so they never become a lasting open redirect.
      if (campaign.status === "draft" || campaign.status === "failed") {
        const draft = checked(
          await db
            .from("newsletter_campaigns")
            .select("html,updated_at")
            .eq("id", campaign.id)
            .maybeSingle<Pick<NewsletterCampaign, "html" | "updated_at">>(),
        );
        if (
          !draft ||
          Date.now() - Date.parse(draft.updated_at) > 72 * 3_600_000 ||
          renderTracking(draft.html, campaign.id, "https://tracking.invalid/").links[
            Number(action)
          ] !== destination
        )
          return response("Not found", 404);
      }
      let target: URL;
      try {
        target = new URL(destination);
      } catch {
        return response("Not found", 404);
      }
      if (
        !["http:", "https:"].includes(target.protocol) ||
        target.username ||
        target.password
      )
        return response("Not found", 404);
    }
    if (request.method === "GET" && token) {
      try {
        await collect(db, campaign, token, destination);
      } catch {
        /* Collection failure must not break a reader's link. */
      }
    }
    return destination === null
      ? response(request.method === "HEAD" ? null : pixel, 200, {
          "content-type": "image/gif",
        })
      : response(null, 302, { location: destination });
  } catch {
    return response("Temporarily unavailable. Please try again.", 503);
  }
}
