# Setup

This takes about an hour, most of it waiting for DNS and Resend. At the end you'll have sent yourself a test issue.

## 1. Install

```sh
npm install @vulcan-energy/newsletter @supabase/supabase-js resend
```

You need Node 22.1 or later. To run the MCP server for AI agents, also install `@modelcontextprotocol/sdk`.

## 2. Add the tables

Apply `schema.sql` first, then each file in `migrations/` in filename order. You'll find them in `node_modules/@vulcan-energy/newsletter/`.

With the Supabase CLI, create one migration per file, paste each file's contents in, then apply them:

```sh
supabase migration new newsletter_schema            # paste schema.sql
supabase migration new newsletter_event_rpc         # paste migrations/20261103164600_newsletter_event_rpc.sql
supabase migration new newsletter_admin_rpcs        # paste migrations/20261103164700_newsletter_admin_rpcs.sql
supabase migration new newsletter_finish_erasure    # paste migrations/20261103164812_newsletter_finish_erasure.sql
supabase migration new newsletter_tracking_consent  # paste migrations/20261103210043_newsletter_tracking_consent.sql
supabase db push
```

Don't copy the files in under their own names. They're dated November 2026, so they could sort before or after your existing migrations, and the later files alter tables that `schema.sql` creates.

This creates four tables, `newsletter_subscribers`, `newsletter_campaigns`, `newsletter_events` and `newsletter_erasures`, plus a few database functions and a public Storage bucket called `newsletter-assets` for email images (5 MB each). Row-level security is on, and only the service role can read or write. The schema relies on Supabase's roles and Storage, so plain Postgres won't work.

## 3. Set up Resend

1. **Verify a sending domain**, ideally a subdomain such as `news.example.com`, so newsletter complaints don't affect your other email.
2. **Create a segment** for your list. Its ID is `audienceId` in the configuration. Resend used to call these audiences.
3. **Create an API key with full access.** Contacts, segments and broadcasts need it; a sending-only key won't work.
4. **Add a webhook** pointing at your webhook route (step 5), for these events: `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed` and `contact.updated`. Copy its signing secret.
5. **If you want per-person tracking** (recommended, see [Privacy](privacy.md)):
   - turn off open tracking and click tracking for the sending domain
   - add a contact property named `newsletter_token`, type string, with fallback value `none`

   The package checks both before every test and send, and refuses to continue if either is wrong.

If you skip per-person tracking, Resend's own tracking applies to everyone when it's switched on, and its opens and clicks are recorded for everyone. Make sure that matches what your privacy notice says.

`trackingBaseUrl` must be HTTPS, so leave it out while you test on your own machine and add it once the app is deployed.

## 4. Create the two tokens

The HTTP API, the CLI and the MCP server use bearer tokens:

- the **drafting token** can draft, upload images, send tests, count recipients and read summary reports
- the **send token** can also send, and read per-person reports

Create each one like this and keep both lines somewhere safe:

```sh
node -e "const c=require('node:crypto'); const t=c.randomBytes(32).toString('base64url'); console.log('token: ' + t); console.log('sha256: ' + c.createHash('sha256').update(t).digest('hex'))"
```

Only the `sha256` values go into your app's configuration, as `NEWSLETTER_TOKEN_SHA256` and `NEWSLETTER_SEND_TOKEN_SHA256` in the example below. They must be different, and lowercase exactly as printed. A wrong or missing hash makes every request fail with "Newsletter token required". Give the drafting token to whoever drafts, person or agent. Hand out the send token for a specific send, then rotate it by generating a new one and swapping the hash.

## 5. Configure and mount

Your app needs these environment variables:

| Variable | Value |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | From your Supabase project's API settings |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_SEGMENT_ID` | From step 3 |
| `NEWSLETTER_TOKEN_SHA256`, `NEWSLETTER_SEND_TOKEN_SHA256` | The two hashes from step 4 |

Create the newsletter on the server only, because it holds your service-role key. This module reads the variables when it's first imported. If your framework imports routes during the build, as Next.js does, make sure the variables exist at build time too, or create the objects inside a function the first time a request arrives.

```ts
// lib/newsletter.ts
import { createClient } from "@supabase/supabase-js";
import {
  createNewsletter,
  newsletterHandler,
  webhookHandler,
  handleTrackingRequest,
} from "@vulcan-energy/newsletter";
import { createResendProvider } from "@vulcan-energy/newsletter/resend";

export const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const provider = createResendProvider(process.env.RESEND_API_KEY!, process.env.RESEND_WEBHOOK_SECRET);

export const newsletter = createNewsletter({
  supabase,
  provider,
  audienceId: process.env.RESEND_SEGMENT_ID!,
  from: "Example <news@news.example.com>",
  replyTo: "hello@example.com",
  footerAddress: "Example Ltd, 1 Example Street, London",
  testRecipient: "you@example.com",
  tokenHash: process.env.NEWSLETTER_TOKEN_SHA256,
  sendTokenHash: process.env.NEWSLETTER_SEND_TOKEN_SHA256,
  trackingBaseUrl: "https://example.com/api/newsletter/tracking", // omit to skip per-person tracking
  publicPageUrl: (slug) => `https://example.com/newsletter/${slug}`, // optional
});

export const api = newsletterHandler(newsletter);
export const webhook = webhookHandler({
  supabase,
  provider,
  newsletterDomain: "news.example.com",
  ignoreEngagement: true, // true when trackingBaseUrl is set: Resend's own opens and clicks are ignored
});
export const track = (request: Request) => handleTrackingRequest(supabase, request);
```

Then mount the handlers. In a Next.js App Router project:

```ts
// app/api/newsletter/v1/[...path]/route.ts
export { api as GET, api as POST } from "@/lib/newsletter";

// app/api/webhooks/newsletter/route.ts
export { webhook as POST } from "@/lib/newsletter";

// app/api/newsletter/tracking/[...path]/route.ts
export { track as GET, track as HEAD, track as POST } from "@/lib/newsletter";
```

Each handler takes a standard `Request` and returns a `Response`, so other frameworks work the same way. Some points to check:

- **Path.** The API expects to be served at `/api/newsletter/v1`. Pass `newsletterHandler(newsletter, { basePath: "/your/path" })` to move it.
- **Runtime and time limits.** Use the Node runtime, not an edge runtime. Give these routes the longest request time your platform allows, for example `export const maxDuration = 300` on Vercel. See [Sending](sending.md#claims-and-timing).
- **Login middleware.** Keep it away from these routes. If it redirects them, the CLI only sees `transport_error`.

[Reference](reference.md#configuration) lists every option.

## 6. Add subscribers

Call `addSubscriber` from your signup form after the person has agreed to hear from you. Record where that agreement came from:

```ts
import { addSubscriber } from "@vulcan-energy/newsletter";

await addSubscriber(supabase, {
  email: form.email,
  first_name: form.firstName,
  consent_source: "Newsletter box on /pricing, form v3",
  tracking_consent_source: form.allowTracking ? "Tracking box on /pricing, form v3" : undefined,
});
```

It returns the subscriber, or `null` if that address was erased. It never re-subscribes someone who opted out, and for someone already on the list it changes neither their consent record nor their tracking choice. To record tracking consent for an existing subscriber, call `setTrackingConsent`. New people reach Resend when the list is next synced, which happens automatically before every send.

To bring in an existing list, run the addresses through `screenAddresses` first, then call `importSubscriber` for each row, carrying over each person's status. See [Reference](reference.md#subscribers).

## 7. Send yourself a test

Write the issue as HTML and save it as JSON:

```json
{
  "slug": "november-update",
  "subject": "What's new in November",
  "preview_text": "Three changes worth knowing about",
  "html": "<p>Hello…</p><p>Example Ltd, 1 Example Street, London</p><p><a href=\"{{unsubscribe_url}}\">Unsubscribe</a></p>"
}
```

A draft is accepted only if:

- it contains your `footerAddress` exactly
- it has at least one link whose whole `href` is `{{unsubscribe_url}}`, written exactly like that, and the placeholder appears nowhere else
- it has no other merge tags such as `{{first_name}}` or `*|FNAME|*`
- links are full URLs (`https://…`, not `/pricing`)
- every image, including `srcset` and CSS backgrounds, is on HTTPS at a public address and answers 200 with an image directly, with no redirect. There are no more than 50 of them.
- the HTML is under 102 KB, and still under it after tracked links are rewritten
- the slug is lowercase words joined by hyphens and not already used
- a draft that links to its own public page is marked public

Then point the CLI at your app and send the test:

```sh
export NEWSLETTER_API_URL=https://example.com/api/newsletter/v1
export NEWSLETTER_API_TOKEN=<drafting token>
npx vulcan-newsletter draft --input issue.json
npx vulcan-newsletter test --id <id from the draft>
```

The test goes to `testRecipient`, with `[TEST]` in front of the subject. When you're ready to send for real, read [Sending](sending.md).
