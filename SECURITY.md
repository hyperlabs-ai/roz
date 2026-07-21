# Security Policy

We take the security of roz seriously. Thanks for helping keep it and its users safe.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Email **manuel@hyperlabs.vc** with:

- a description of the issue and its impact,
- steps to reproduce (proof-of-concept if possible),
- affected version / commit, and
- any suggested remediation.

We aim to acknowledge reports within **3 business days** and to provide a remediation
timeline after triage. Please give us a reasonable window to ship a fix before any public
disclosure. We're happy to credit you once the issue is resolved (let us know how you'd like
to be named).

## Scope

roz is **self-hosted**: each operator runs their own deployment (Vercel + Supabase) with their
own secrets. This policy covers vulnerabilities in the roz source code in this repository —
for example webhook signature verification, the MCP/intake auth surface, the outbox/cron
handling, or the dashboard auth flow.

Issues that depend entirely on an operator's misconfiguration (e.g. leaking their own
`.env`, exposing the `service_role` key to the client, or not setting `CRON_SECRET` in
production) are out of scope, but we still appreciate a heads-up if the docs could prevent
the mistake.

## Operator hardening checklist

If you self-host roz, the essentials:

- Keep `.env` out of version control (it already is in `.gitignore`) and never expose
  `SUPABASE_SERVICE_ROLE_KEY` to the browser.
- Set every variable marked **[required in prod]** in `.env.example` — the server fails fast
  in production if a critical secret is missing.
- Set a strong, unique `GITHUB_WEBHOOK_SECRET`; roz verifies every webhook signature.
- Set `CRON_SECRET` so the internal cron endpoints (`/v1/internal/*`, including the outbox
  drain) are not publicly invocable.
- Rotate tokens periodically and restrict the GitHub PAT to the read-only scopes documented
  in [`docs/GITHUB-SETUP.md`](docs/GITHUB-SETUP.md).
