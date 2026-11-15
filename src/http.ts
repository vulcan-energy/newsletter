import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sha256 } from "./subscribers.js";
import { allRows } from "./reconcile.js";
import { saveDraft, testCampaign, uploadAsset } from "./campaigns.js";
import { campaignStats } from "./reports.js";
import { draftSchema, assetSchema, sendSchema, failure } from "./schemas.js";
import { reviewHash, type createNewsletter } from "./sending.js";
import { NewsletterError } from "./errors.js";
export function tokenRole(header: string | null, ordinary?: string, send?: string) {
  const token = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(header ?? "")?.[1];
  if (!token) return null;
  const hash = Buffer.from(sha256(token), "hex");
  const matches = (expected?: string) =>
    !!expected &&
    /^[a-f0-9]{64}$/.test(expected) &&
    timingSafeEqual(hash, Buffer.from(expected, "hex"));
  const canSend = matches(send),
    canRead = matches(ordinary);
  return canSend && send !== ordinary ? "send" : canRead ? "ordinary" : null;
}
export const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
export async function readJson(request: Request) {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 7_050_000) {
          await reader.cancel();
          throw new NewsletterError("Request body too large; reduce the upload to 5 MB", "body_too_large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
// basePath is where the host mounts the API; every route sits below it.
export function newsletterHandler(
  core: ReturnType<typeof createNewsletter>,
  { basePath = "/api/newsletter/v1" } = {},
) {
  const base = `${basePath.replace(/\/$/, "")}/`;
  return async (request: Request) => {
    const role = tokenRole(
      request.headers.get("authorization"),
      core.config.tokenHash,
      core.config.sendTokenHash,
    );
    if (!role)
      return json(
        failure("unauthorized", "Newsletter token required", "Supply a valid newsletter token"),
        401,
      );
    const url = new URL(request.url);
    const path = url.pathname.startsWith(base)
      ? url.pathname.slice(base.length).split("/").filter(Boolean)
      : [];
    const [resource, id, action] = path;
    const method = request.method;
    if ((action === "send" || url.searchParams.get("people") === "1") && role !== "send")
      return json(
        failure("forbidden", "Send token required", "Ask the owner for task-specific access"),
        403,
      );
    try {
      let data: unknown;
      if (resource === "assets" && path.length === 1 && method === "POST")
        data = await uploadAsset(core.config, assetSchema.parse(await readJson(request)));
      else if (resource !== "campaigns" || path.length > 3)
        return json(
          failure("not_found", "Unknown newsletter route", "Use the documented campaign API"),
          404,
        );
      else if (!id && method === "POST")
        data = await saveDraft(
          core.config,
          draftSchema.parse(await readJson(request)),
          url.searchParams.get("dry_run") === "1",
        );
      else if (!id && method === "GET")
        data = (await allRows(core.config.supabase, "newsletter_campaigns")).map(
          ({ html: _html, ...row }) => row,
        );
      else if (id && !/^[A-Za-z0-9-]{1,100}$/.test(id))
        throw new NewsletterError("Invalid campaign ID", "invalid_input");
      else if (id && !action && method === "GET") {
        const campaign = await core.campaign(id);
        const blockers: string[] = [];
        if (campaign.status !== "draft") blockers.push("Campaign is not a draft");
        if (campaign.html_sha256 !== sha256(campaign.html)) blockers.push("HTML hash mismatch");
        if (campaign.last_test_sha256 !== campaign.html_sha256)
          blockers.push("Test the current HTML");
        try {
          await core.validate(campaign);
        } catch (e) {
          blockers.push(e instanceof Error ? e.message : "Validation failed");
        }
        const health = campaign.status === "draft" ? await core.health() : null;
        if (campaign.status === "draft" && (await core.pendingSend(campaign.id)))
          blockers.push("Another send is in progress or has an unknown outcome; resolve it first");
        data = {
          ...campaign,
          provider_state:
            campaign.status === "send_unknown" && campaign.provider_broadcast_id
              ? await core.config.provider.getBroadcastState(campaign.provider_broadcast_id)
              : null,
          actions: {
            draft: {
              allowed: campaign.status === "draft",
              blockers: campaign.status === "draft" ? [] : ["Only drafts can be edited"],
            },
            test: {
              allowed: campaign.status === "draft",
              blockers: campaign.status === "draft" ? [] : ["Only drafts can be tested"],
            },
            reconcile: {
              allowed: campaign.status === "draft",
              blockers: campaign.status === "draft" ? [] : ["Campaign is not a draft"],
            },
            send: {
              allowed: role === "send" && !blockers.length && !health?.blockers.length,
              blockers: [
                ...blockers,
                ...(health?.blockers ?? []),
                ...(role === "send" ? [] : ["Send token required"]),
              ],
              warnings: health?.warnings ?? [],
              requires: ["expected_recipient_count", "review_sha256"],
            },
          },
        };
      } else if (id && action === "stats" && method === "GET")
        data = await campaignStats(
          core.config.supabase,
          id,
          url.searchParams.get("people") === "1",
        );
      else if (id && method === "POST" && ["test", "reconcile", "send"].includes(action)) {
        const body = await readJson(request);
        if (action === "send")
          data = await core.send({ campaign_id: id, ...sendSchema.parse(body) }, "api-token");
        else {
          z.object({}).strict().parse(body);
          if (action === "test") data = await testCampaign(core.config, id);
          else {
            const campaign = await core.campaign(id);
            if (campaign.status !== "draft") throw new NewsletterError("Only drafts can reconcile");
            data = await core.reconcile(campaign.target_tag);
          }
        }
      } else
        return json(
          failure("not_found", "Unknown newsletter route", "Use the documented campaign API"),
          404,
        );
      // Campaign responses carry the hash a sender confirms.
      if (data && typeof data === "object" && "html_sha256" in data && "subject" in data)
        data = { ...data, review_sha256: reviewHash(data as never) };
      return json({ ok: true, data });
    } catch (error) {
      try {
        core.config.onError?.(error);
      } catch {
        /* Logging must never change the response. */
      }
      const known = error instanceof NewsletterError;
      const input = error instanceof z.ZodError || error instanceof SyntaxError;
      const code = known ? error.code : input ? "invalid_input" : "operation_failed";
      const status = { body_too_large: 413, invalid_input: 400, send_unknown: 409 }[code];
      return json(
        failure(
          code,
          known
            ? error.message
            : error instanceof z.ZodError
              ? `Input does not match the schema: ${error.issues
                  .slice(0, 3)
                  .map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`)
                  .join("; ")}`
              : input
                ? "Request body is not valid JSON"
                : "Newsletter operation failed",
          code === "send_unknown"
            ? "Check the broadcast in Resend before resolving; never retry automatically"
            : "Check campaign state and configuration before retrying",
        ),
        status ?? (url.searchParams.get("dry_run") === "1" ? 422 : 409),
      );
    }
  };
}
