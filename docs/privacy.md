# Privacy

The package enforces the rules that are easy to get wrong in code. The legal side stays with you: your lawful basis for emailing people, your privacy notice, and a record of where each person's consent came from. This page covers what the package does and where your part begins.

## Subscription status

Each subscriber is `subscribed`, `unsubscribed` or `cleaned`. Cleaned means the address bounced permanently.

| What happens | Effect |
|---|---|
| Signup, import or profile edit | Can add a new person. Never changes an existing person's status back to subscribed. |
| Unsubscribe link, complaint or contact opt-out in Resend | Unsubscribed |
| Permanent bounce | Cleaned |
| Explicit resubscribe, with a recorded reason | Subscribed again. A cleaned address can't be resubscribed. |

An opt-out that arrives late, dated before a resubscribe, is ignored. Nothing infers consent from opens, clicks, form submissions or a contact existing in Resend.

## Tracking opens and clicks

With `trackingBaseUrl` set, tracking is off for everyone unless they agreed to it. Without it, the package records whatever opens and clicks Resend reports, so either turn Resend's own tracking off or make sure your privacy notice covers it.

- **Separate consent.** For a new subscriber, pass `tracking_consent_source` only when they explicitly opt in. For someone already on the list, a repeated signup doesn't change their tracking choice, so use `setTrackingConsent(supabase, id, source)`, or pass `null` to withdraw.
- **Anonymous for everyone else.** A person who has agreed gets a random token, unique to that period of consent. Everyone else gets the value `none`. Their links and images still work, but nothing is recorded.
- **What's stored.** The collector keeps no cookies, IP addresses or browser details. Repeated opens or clicks by the same person on the same link in the same clock minute count once.
- **Withdrawing.** Every tracked email has a footer link to a confirmation page. Withdrawal only happens when the reader presses the button, and it makes their old token useless straight away. Consenting again later gives a new token, so the old emails stay untracked.
- **Cut-off.** Activity stops being recorded 24 months after a campaign was prepared.

Some limits sit outside the package:

- Your hosting provider may keep request logs that include tracking URLs. Exclude the tracking route from your own analytics, and treat those logs under your own retention policy.
- Opens and clicks can come from security scanners, link previews and forwarded mail. Report them as counts among people who agreed to tracking, not as a rate across everyone.

## Erasure

`eraseSubscriber(supabase, provider, email)` does three things:

- removes the person's row and their individual events from your database
- deletes their contact in Resend
- keeps their share of campaign totals, with nothing that identifies them

It keeps a SHA-256 hash of the address, so the person can't be re-imported or re-added by mistake. The hash isn't salted, so anyone with the address can match it: treat it as personal data kept for a stated reason. Resend keeps its own logs of past sends, which erasure doesn't touch. `clearErasure` removes that hash, but only do that when the person asks to come back. It doesn't re-subscribe them on its own.

If the address also lives in other systems, such as an older email tool, delete it there too.

## Retention

Run `retainEvents(supabase)` once a day from a scheduled job. It deletes individual events older than 24 months, after saving each affected campaign's totals.

## Logging

`onError` receives every error the HTTP handler turns into a failure. Storage errors keep the database's message in `error.cause`, and that message can include an email address. Log error names and codes rather than whole messages.
