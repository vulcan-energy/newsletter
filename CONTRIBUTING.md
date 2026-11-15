# Contributing

Thanks for helping. This package sends email to real people, so changes are held to a few firm rules.

## Setup

```sh
npm install
npm run build
npm test
npm run test:package
```

`test:package` packs the package, installs it into a temporary project and compiles the example host against the published types. Tests use in-memory fakes for the database and Resend. Never point them at live services or use real credentials.

## Rules

- **Consent only goes one way.** Nothing automatic may turn an unsubscribed or cleaned person back into a subscriber: not create, import, edit, webhook, sign-up or provider sync. Only `resubscribeSubscriber` may call the provider's resubscribe.
- **Sending stays guarded.** Don't add a new way to send without its safety checks and tests. A send must never be retried automatically.
- **Write the failing test first** for any change in behaviour, and include it in the pull request.
- **Keep it small.** Non-test TypeScript in `src/` stays under 3,000 lines. The tests enforce this.
- **No copied copyleft code.** Reimplementing an idea is fine; pasting GPL or AGPL code isn't.
- **No host-specific code.** Branding, templates and migration code for other email tools belong in the app that uses the package.

## Database changes

Add a new file to `migrations/` and never edit one that has been released. Keep every change additive, so existing installs can apply it on top. Functions use `SECURITY INVOKER` with a fixed `search_path`, and only the service role may run them.

## Pull requests

Describe what changed and why, how you tested it, and anything you couldn't test, such as live Resend behaviour.
