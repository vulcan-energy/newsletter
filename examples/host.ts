import {
  createNewsletter,
  newsletterHandler,
  webhookHandler,
  handleTrackingRequest,
  type NewsletterConfig,
} from "@vulcan-energy/newsletter";

// The host supplies server-side configuration; importing this example has no side effects.
export function createHost(
  config: NewsletterConfig & { newsletterDomain: string },
) {
  const api = newsletterHandler(createNewsletter(config));
  const webhook = webhookHandler({
    supabase: config.supabase,
    provider: config.provider,
    newsletterDomain: config.newsletterDomain,
    ignoreEngagement: !!config.trackingBaseUrl,
  });
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/api/webhooks/newsletter" && request.method === "POST")
      return webhook(request);
    if (
      config.trackingBaseUrl &&
      path.startsWith(
        new URL(config.trackingBaseUrl).pathname.replace(/\/$/, "") + "/",
      )
    )
      return handleTrackingRequest(config.supabase, request);
    if (path.startsWith("/api/newsletter/v1/")) return api(request);
    return new Response("Not found", { status: 404 });
  };
}
