# Sending

A newsletter goes to everyone at once and can't be taken back, so a send has to clear several checks. This page explains each one and what to do when something goes wrong.

## The steps

1. **Draft.** Save the subject, preview text, HTML, target tag (if any) and slug. Saving again replaces the draft and cancels its last test.
2. **Test.** Send the current HTML to the test inbox, with `[TEST]` added to the subject. The test goes through the same link rewriting and footer as the real send, with nothing that identifies anyone. Its unsubscribe link is disabled. Its tracked links stop working 72 hours after the last test or edit.
3. **Review.** Read the campaign's status. It shows two things you'll need:
   - `review_sha256`: a hash of the subject, preview text, HTML, target tag and public visibility
   - any blockers: a missing test, failed validation, a sending hold, or another send in progress. With the drafting token, "Send token required" always appears; that's expected.
4. **Count.** Reconcile the audience. This syncs your subscribers to Resend and returns how many people the send would reach.
5. **Send.** Supply the count and the `review_sha256`. The package then checks everything again:
   - the HTML still matches what was tested
   - the review hash still matches, so the subject, preview, audience and visibility haven't changed
   - no other send is running or unresolved
   - the last send didn't break the bounce or complaint limits
   - the count is still the same after a fresh sync

   Only then does it create the broadcast and send it once.

Through the token API, only the send token can do step 5. In your own admin screens, call `newsletter.send(...)` after checking that the person is allowed to send.

## Sending holds

The package looks at the most recent send before allowing the next one.

| On the last send | What happens |
|---|---|
| 2 or more bounces, above 5% of recipients | The next send is held |
| 2 or more complaints, above 0.3% of recipients | The next send is held |
| At least one bounce above 2.5%, or at least one complaint above 0.08% | A warning only |

A broadcast can't be stopped once it starts, so a hold applies to the following send. Bounces include temporary ones, because the stored events don't record the bounce type.

A hold protects your sending domain. Look at who bounced or complained and clean the list before you send again. An owner can then override the hold from your own admin code with `newsletter.send(input, actor, { overrideLimits: true })`. Tokens and agents can't override it. You can change the thresholds with the `sendingLimits` option.

## One send at a time

While one campaign is sending, or has an unknown outcome, no other campaign can start. The check runs before and again after a send claims its campaign, so two sends started together both stop rather than both going out. The status of every other draft shows the block until it's resolved.

## When a send's outcome is unknown

Sometimes the package can't tell whether Resend received the send. A network error at the wrong moment is the usual cause. The campaign is then marked `send_unknown`.

**Never create a new broadcast to fix this.** Check what Resend says about the broadcast, then resolve it:

- **Sent or sending in Resend:** mark it sent with `newsletter.resolveUnknown(id, "sent", actor)`.
- **A draft in Resend:** mark it failed with `newsletter.resolveUnknown(id, "failed", actor)`. This also makes a fresh draft copy, with `-` and eight characters added to the slug, which needs its own test before it can be sent.
- **Resend has no record of it:** check the Resend dashboard yourself first. Resend only lets you delete unsent broadcasts, but a wrong API key or account returns the same "not found". Once you're sure it was deleted unsent, mark it failed with `{ confirmedDeleted: true }` as a fourth argument.

## Claims and timing

A send claims its campaign while it prepares. If anything loads that campaign more than 15 minutes after the claim, for example a status check, the claim is released: back to draft if no broadcast was created yet, or to unknown if one was. The send checks its claim again just before dispatch and stops if it was released, so a released claim never goes out. If it stops, Resend may be left holding an unsent draft broadcast; check it and resolve as above.

Where the time goes (Resend calls are paced at five a second):

- **New subscribers.** A subscriber who isn't in Resend yet takes about four calls, roughly 0.8 seconds, the first time they're synced. Syncing happens when you count recipients and when you send, not when you import, so importing in small batches doesn't spread the cost.
- **Carried-over opt-outs.** Every sync looks up, at Resend, each opted-out person who isn't in the list's segment, at about 0.2 seconds each. If you brought thousands of opt-outs over from another tool, every sync stays slow. This is a known limitation.
- **Per-person tracking.** A tracked send writes one token per contact, about 0.2 seconds each, and syncs twice.

On a host with a 5-minute request limit, that's roughly 300 new subscribers per send and about a thousand contacts for a tracked send. Bigger lists need a host that allows longer requests. Set your platform's request limit (for example `maxDuration` on Vercel) to the longest it allows for the newsletter routes. The CLI itself waits at most about 5 minutes for a response.

## Cleaning addresses before an import

`screenAddresses(emails)` checks addresses before you import them:

| Result | Addresses |
|---|---|
| Refused | malformed addresses, common domain typos (with a suggested fix, such as `gmial.com` to `gmail.com`), throwaway domains, automated mailboxes like `noreply@`, and domains whose DNS says they can't receive mail |
| Allowed but flagged | shared inboxes such as `info@` or `office@`, which small businesses often use as their real address |
| Kept unchecked | addresses whose DNS lookup timed out |

The whole batch has a time budget, 60 seconds by default. Screen only new subscribers. Never drop an unsubscribe or a bounce from an import.
