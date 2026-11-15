# Reference

## Configuration

`createNewsletter(config)` takes these options:

| Option | Required | What it does |
|---|---|---|
| `supabase` | yes | A server-side Supabase client using the service-role key |
| `provider` | yes | The email provider. Use `createResendProvider(apiKey, webhookSecret)` from `@vulcan-energy/newsletter/resend` |
| `audienceId` | yes | The Resend segment that holds your list |
| `from`, `replyTo` | yes | The sender and the reply-to address |
| `footerAddress` | yes | Your postal address. Every issue must contain it exactly |
| `testRecipient` | yes | Where token API tests go |
| `tokenHash`, `sendTokenHash` | for the token API | SHA-256 hex of the drafting and send tokens. They must differ |
| `trackingBaseUrl` | no | The HTTPS URL of your tracking route. Set it to turn on per-person tracking |
| `publicPageUrl` | no | `(slug) => url` for public web copies of issues, which your app serves itself |
| `onSent` | no | `async (campaign) => {}`, called after a confirmed send, for example to notify you. If it fails, the send still counts and the result has `notificationFailed: true` |
| `onError` | no | Called with every error the HTTP handler turns into a failure |
| `sendingLimits` | no | `{ bounceRate, complaintRate, minimumEvents }` for sending holds, all three required. Defaults are `0.05`, `0.003` and `2` |
| `fetch` | no | For tests only. Replaces the image checker's own fetch, which refuses private addresses |
| `getExternalSuppressions` | no | Returns opt-outs held in a previous email tool, so they're applied before every send while you move over. If it throws, sending stops |

`webhookHandler` takes `{ supabase, provider, newsletterDomain, ignoreEngagement, onError }`:

- `newsletterDomain` is the domain in your `from` address. It must match exactly. A complaint about other mail from that domain unsubscribes the person, and a permanent bounce marks them cleaned.
- Set `ignoreEngagement: true` when you use `trackingBaseUrl`, so Resend's own open and click events are ignored.
- `onError` receives errors from failed webhook deliveries. Resend retries those.

## The newsletter object

`createNewsletter` returns:

| Method | What it does |
|---|---|
| `campaign(id)` | Loads a campaign. A claim older than 15 minutes is released here |
| `send(input, actor, options?)` | Sends once. `input` is `{ campaign_id, expected_recipient_count, review_sha256 }`. `options.overrideLimits` overrides a sending hold; only pass it for an owner |
| `resolveUnknown(id, "sent" \| "failed", actor, options?)` | Settles a send whose outcome was unknown. Pass `{ confirmedDeleted: true }` only after checking Resend. See [Sending](sending.md) |
| `reconcile(tag)` | Syncs the audience and returns `{ audience, count }`. Pass a tag, or `null` for everyone. A tag send uses a Resend segment named `tag:<tag>`, created on first use |
| `health()` | The sending-hold check: `{ blockers, warnings, … }` |
| `pendingSend(exceptId?)` | The id of a send in progress or unresolved, or `null` |
| `validate(campaign)` | Runs the draft checks |

## Campaigns

- `saveDraft(config, draft, dryRun?)`: create or update a draft
- `testCampaign(config, id, recipient?)`: send a test. Only pass `recipient` after checking who is asking
- `uploadAsset(config, { mime, base64 })`: store a PNG, JPEG, GIF or WebP image of up to 5 MB. Returns `{ url }`
- `campaignStats(supabase, id, people?)`: totals, or per-person detail as well
- `reviewHash(campaign)`: the `review_sha256` a sender confirms
- `retainEvents(supabase)`: daily clean-up of events older than 24 months

## Subscribers

- `addSubscriber(supabase, { email, consent_source, tracking_consent_source?, first_name?, last_name?, company?, tags? })`: for signup forms
- `importSubscriber(supabase, input)`: like `addSubscriber`, but `tags` is required (use `[]`), and it also takes `status`, `status_changed_at`, `consent_at`, `consent_ip` and `external_id`, so opt-outs and bounces carry over. For someone already on the list, it never restores consent or changes their tracking choice
- `editSubscriber(supabase, id, profile)`: change name, company or tags. Never changes status
- `resubscribeSubscriber(supabase, provider, id, reason)`: the only way back to subscribed
- `eraseSubscriber(supabase, provider, email)` and `clearErasure(supabase, email)`: see [Privacy](privacy.md)
- `setTrackingConsent(supabase, id, source | null)`: grant or withdraw tracking consent
- `screenAddresses(emails, resolver?, budgetMs?)`: check addresses before an import. See [Sending](sending.md)

Everything else the package exports is a building block for host apps and may change before 1.0.

## HTTP API

The API is mounted at `/api/newsletter/v1` unless you pass a `basePath`. Send the token as `Authorization: Bearer <token>`.

| Route | Token | What it does |
|---|---|---|
| `GET /campaigns` | drafting | Lists campaigns |
| `POST /campaigns` | drafting | Creates or updates a draft. Add `?dry_run=1` to only validate |
| `GET /campaigns/:id` | drafting | Status, `review_sha256`, and what each action needs or is blocked by |
| `POST /campaigns/:id/test` | drafting | Sends a test to `testRecipient` |
| `POST /campaigns/:id/reconcile` | drafting | Syncs and counts recipients |
| `POST /campaigns/:id/send` | send | Body `{ expected_recipient_count, review_sha256 }` |
| `GET /campaigns/:id/stats` | drafting | Totals. With `?people=1`, per-person detail, which needs the send token |
| `POST /assets` | drafting | Body `{ mime, base64 }`. Returns `{ url }` |

Every response is `{ ok: true, data }` or `{ ok: false, code, message, next_action }`. Failures use 400 for bad input, 401 or 403 for tokens, 404 for unknown routes, 413 for oversized bodies, and 409 for everything else (422 on a dry run).

## Error codes

| Code | Meaning |
|---|---|
| `invalid_input` | The request didn't match the schema. The message names the field |
| `body_too_large` | The request is over the size limit |
| `operation_failed` | A check failed. The message says which one, for example "Footer address required" |
| `send_unknown` | The send's outcome is unknown. Check Resend before doing anything else |
| `claim_expired` | The send's claim expired before dispatch. Nothing was sent |
| `storage_failed` | A database call failed. The detail is passed to `onError` |
| `provider_failed` | A Resend call failed. The message includes Resend's status and error name |
| `unauthorized`, `forbidden` | The token is missing or wrong, or this route needs the send token |
| `not_found` | Unknown route |
| `invalid_webhook`, `webhook_retry` | Webhook only: the signature was wrong, or processing failed and Resend should retry |
| `invalid_arguments`, `configuration_required`, `transport_error` | CLI only: bad arguments, a missing setting or token, or no valid response. A wrong URL or a redirect by login middleware usually shows as `transport_error` |

## CLI

```text
vulcan-newsletter status [--id ID]
vulcan-newsletter draft --input FILE [--dry-run]
vulcan-newsletter upload-asset --file PATH --mime TYPE
vulcan-newsletter test --id ID
vulcan-newsletter reconcile --id ID
vulcan-newsletter send --id ID --count N --sha256 REVIEW_SHA256
vulcan-newsletter stats --id ID [--people]
vulcan-newsletter mcp
```

The CLI reads three environment variables:

- `NEWSLETTER_API_URL`: HTTPS, or plain HTTP to localhost
- `NEWSLETTER_API_TOKEN`: the drafting token
- `NEWSLETTER_SEND_TOKEN`: the send token, only for `send` and `stats --people`

Output is JSON. Exit codes are 0 for success, 1 for an error from the API, and 2 for bad arguments or setup.

## MCP server

`vulcan-newsletter mcp` runs an MCP server over stdio, with one tool per CLI command. It needs `@modelcontextprotocol/sdk` installed. The `send` tool only appears when `NEWSLETTER_SEND_TOKEN` is set. The read-only tools are `status` and `stats`, and `send` is marked as destructive.

## Writing another provider

A provider implements the exported `EmailProvider` type. It must:

- manage contacts and segment membership
- suppress and resubscribe contacts on request
- create a broadcast without sending it, send it once, and report its state
- send tests to a single address
- verify and normalise webhook events

It must never restore consent on its own. A provider that only has SMTP would also need batched sending, broadcast state, one-click unsubscribe and a source of bounce events.
