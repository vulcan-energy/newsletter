# Running a newsletter as an AI agent

These rules are for an AI agent using the `vulcan-newsletter` CLI or its MCP server. A newsletter reaches real people and can't be unsent, so when you're unsure, stop and ask the owner.

## What you can do

With `NEWSLETTER_API_TOKEN` you can:

- list campaigns and read their status
- create and edit drafts, and upload images
- send a test to the configured test inbox
- count recipients
- read summary reports

Sending, and reports that name individual people, need `NEWSLETTER_SEND_TOKEN`. The owner issues it for one task. Never save it in a file, a prompt library or a standing setup.

Neither token can import, edit, erase or resubscribe anyone, or list subscribers. Those are owner actions in the host app.

## How to prepare an issue

1. Run `status` first to see what already exists.
2. Write the draft. Check it with `draft --dry-run` before saving. Any edit cancels the last test.
3. Run `test`, then ask the owner to read the test email.
4. Run `status --id` and `reconcile --id`. Report the recipient count, the `review_sha256` and anything listed as blocking, then stop. With only `NEWSLETTER_API_TOKEN`, status always lists "Send token required"; that's expected and doesn't need reporting.

## How to send, only when the owner has asked

Run `send --id ID --count N --sha256 REVIEW_SHA256`, using the count and hash the owner approved.

- If the count or the content has changed, the send is refused. Report it; don't adjust the values to make it pass.
- If the send fails, times out or returns `send_unknown`, **do not send again**. Run `status` and report. Only the owner resolves an unknown send, after checking Resend.
- A sending hold after high bounces or complaints can only be lifted by the owner.

With the MCP server, the tools take the same fields as JSON: `draft` takes the draft's fields directly, and `upload-asset` takes `mime` and `base64`.

## Consent

Never treat opens, clicks, form submissions, imports or a contact existing in Resend as permission to email someone. Consent comes only from the host app's records.

## Output

Every command prints JSON: `{ ok: true, data }` or `{ ok: false, code, message, next_action }`. `transport_error` means no valid response arrived, which is often a wrong URL or a redirect by the app's login middleware. Follow `next_action`. Exit codes are 0 for success, 1 for an API error, and 2 for bad arguments or missing setup.
