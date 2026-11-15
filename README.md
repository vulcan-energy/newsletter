# @vulcan-energy/newsletter

Add a newsletter to an app that already runs on Supabase. Your own database is the source of truth for the list, Resend delivers the mail, and nothing goes out until someone has tested the exact email and confirmed how many people it will reach.

There's no editor. You write each issue in HTML, or have an AI agent draft it, then send it from the command line or from your own admin page. The package is free and MIT-licensed. You pay Resend its usual rates.

## What a send looks like

```console
$ vulcan-newsletter draft --input issue.json
$ vulcan-newsletter test --id 8f1c…                 # arrives in your test inbox
$ vulcan-newsletter status --id 8f1c…               # review_sha256, plus anything blocking a send
$ vulcan-newsletter reconcile --id 8f1c…            # {"count": 284}
$ vulcan-newsletter send --id 8f1c… --count 284 --sha256 3b9e…
```

Every command prints JSON; the comments here are shortened. The send only goes ahead if the email you tested, the content you reviewed and the count you confirmed are all still true at that moment. Otherwise it's refused and nothing is sent.

## Who it's for

It's for developers with a product on Supabase who use Resend, or are happy to, and want product updates or a newsletter to live in the app rather than in another tool.

**Why not use Resend Broadcasts directly?** Broadcasts on its own keeps your list in Resend. This package keeps the list in your database, syncs it to Resend before each send, and adds checks on top: a required test, a confirmed count, opt-outs that an import can't undo, and tracking only for people who agreed to it.

Use something else if you:

- write a newsletter with no product behind it: Buttondown or Ghost will suit you better
- need automated sequences such as welcome series: try Loops or Plunk
- have a large list and want the cheapest sending: listmonk or Sendy with Amazon SES

## Why use it

- **Your database is the source of truth.** Subscribers are rows next to your users, so you can join, export and back them up with the rest of your data. Resend keeps a copy only to deliver the mail.
- **Sends are hard to get wrong.** A send needs a test of the exact email, the recipient count typed back and a hash of what was reviewed, and changing the subject, audience or HTML afterwards voids that confirmation. Only one send runs at a time. A send whose outcome is unclear is never retried automatically.
- **Opt-outs stick.** Imports, signup forms and webhooks can't re-subscribe anyone; only an explicit resubscribe with a recorded reason can. Erasing someone deletes them and keeps just a hash, so they can't be imported again by accident.
- **Tracking can be opt-in, per person.** With per-person tracking switched on, opens and clicks are recorded only for people who agreed to it, and everyone else gets the same email with nothing in it that identifies them.
- **AI agents can draft but not send.** An agent with the drafting token can write issues, send tests and read reports through the CLI or the MCP server. Sending needs a separate token you issue for one task, and neither token can import, erase or resubscribe anyone.
- **Small and free.** It's under 3,000 lines of TypeScript, MIT-licensed, and runs inside your app with no server of its own.

## Getting started

You need Node 22.1 or later, a Supabase project and a Resend account with a verified sending domain.

1. Install: `npm install @vulcan-energy/newsletter @supabase/supabase-js resend`
2. Add the tables: apply `schema.sql`, then each file in `migrations/` in order.
3. In Resend, create a segment for your list and set up the webhook. For per-person tracking, also turn off Resend's own open and click tracking and add a `newsletter_token` contact property.
4. Create a drafting token and a send token, and store only their hashes.
5. Configure the package and mount its routes:

```ts
import { createClient } from "@supabase/supabase-js";
import { createNewsletter, newsletterHandler, webhookHandler } from "@vulcan-energy/newsletter";
import { createResendProvider } from "@vulcan-energy/newsletter/resend";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const provider = createResendProvider(process.env.RESEND_API_KEY!, process.env.RESEND_WEBHOOK_SECRET);

const newsletter = createNewsletter({
  supabase,
  provider,
  audienceId: process.env.RESEND_SEGMENT_ID!,
  from: "Example <news@news.example.com>",
  replyTo: "hello@example.com",
  footerAddress: "Example Ltd, 1 Example Street, London",
  testRecipient: "you@example.com",
  tokenHash: process.env.NEWSLETTER_TOKEN_SHA256,
  sendTokenHash: process.env.NEWSLETTER_SEND_TOKEN_SHA256,
});

// Web-standard Request/Response handlers, for the Node runtime.
export const api = newsletterHandler(newsletter); // serves /api/newsletter/v1/*
export const webhook = webhookHandler({ supabase, provider, newsletterDomain: "news.example.com" });
```

6. Add people from your signup form with `addSubscriber`, recording where their consent came from.

[Setup](docs/setup.md) walks through each step with the exact commands.

## Limits

- **Supabase only.** The schema relies on Supabase's roles and Storage, so plain Postgres won't work. Resend is the only email provider so far. There's an interface for adding others, but nobody has built one yet.
- **One list.** Tags pick out subsets, but you can't run separate lists for different customers.
- **No editor, signup forms or automations.** You bring the HTML, and your app owns its forms and pages.
- **List size.** The work runs inside web requests, and Resend's API is called at most five times a second.
  - New subscribers are synced to Resend at send time, at about 0.8 seconds each.
  - A tracked send also writes one token per contact.
  - On a host with a 5-minute request limit, that's roughly 300 new subscribers per send, and about a thousand contacts for a tracked send.
  - Every sync also looks up each carried-over opt-out at Resend, so thousands of them keep every send slow. That's a known limitation.
  - [Sending](docs/sending.md#claims-and-timing) has the details.
- **Node only.** It uses Node's DNS and HTTPS modules, so it won't run on edge runtimes.
- **Version 0.1.** Expect the API to change before 1.0.

## Documentation

- [Setup](docs/setup.md): every step, with commands
- [Sending](docs/sending.md): how the checks work, sending holds, and what to do when a send's outcome is unknown
- [Privacy](docs/privacy.md): consent, tracking, erasure and data retention
- [Reference](docs/reference.md): configuration, HTTP API, CLI, MCP tools and error codes
- [AGENTS.md](AGENTS.md): rules for an AI agent running a newsletter through the CLI or MCP

## Licence

MIT. Built by Vulcan, which makes energy-modelling software for building assessors, for our own newsletter. See [CONTRIBUTING](CONTRIBUTING.md) to help, and [SECURITY](SECURITY.md) to report a vulnerability.
