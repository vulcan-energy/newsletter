# Changelog

## 0.1.0 (unreleased)

First public release.

- Newsletter tables and functions for Supabase: subscribers, campaigns, events and erasures.
- Guarded sending through Resend broadcasts:
  - a test of the exact HTML
  - a confirmed recipient count and review hash
  - one send at a time
  - no automatic retries
- Sending holds after high bounce or complaint rates.
- Consent rules that never restore an opt-out, plus erasure that keeps only a hash.
- Opt-in, per-person open and click tracking.
- Address screening for imports.
- HTTP API, `vulcan-newsletter` CLI and MCP server, with a separate token for sending.

Known limitations:

- Supabase and Resend only.
- ESM only.
- Work runs inside web requests, which limits list size on hosts with short request limits.
- Each sync looks up every carried-over opt-out at Resend.
