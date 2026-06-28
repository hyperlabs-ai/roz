# Contributing to roz

Thanks for your interest in improving roz. This guide covers local setup and the conventions
we follow.

## Prerequisites

- Node.js 20+ and npm
- A Supabase project (Postgres + pgvector) — see the [Self-hosting](README.md#self-hosting)
  section for the full list of accounts roz integrates with (Linear, Anthropic, OpenAI,
  GitHub, Resend).

## Local setup

```bash
# 1. Install backend + dashboard dependencies
npm install
npm install --prefix web

# 2. Configure environment
cp .env.example .env        # fill in the keys you need (see comments in the file)

# 3. Run the backend (http://localhost:3000)
npm run dev
```

`GET /health` should return `{ "status": "ok" }`. In local dev, effects stay `pending` in the
outbox; drain them manually with `GET /v1/internal/drain` (the cron header is not required in
dev).

To run the dashboard SPA:

```bash
cp web/.env.example web/.env   # set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev --prefix web
```

The public landing page lives at `/`; the operator dashboard lives behind login at `/app`.

## Checks before opening a PR

```bash
npm run typecheck          # backend (tsc --noEmit)
npm run typecheck --prefix web
npm test                   # vitest (backend)
npm run build --prefix web # production build of the dashboard
```

All of the above must pass.

## Conventions

- **Language:** TypeScript, ESM, `strict` mode. Match the style of the surrounding code.
- **Commits:** short, imperative, conventional-ish prefixes used in this repo: `feat:`,
  `fix:`, `chore:`, `docs:`.
- **Comments:** explain the *why*, not the *what* — see the existing modules for the tone.
- **Scope:** keep PRs focused. If you're changing behavior, add or update a test under `test/`.
- **Secrets:** never commit real credentials. `.env` is git-ignored; update `.env.example`
  (placeholders only) when you add a new variable.

## Project layout

A quick map (full detail in [`ARCHITECTURE.md`](ARCHITECTURE.md)):

```
api/            Vercel entry (re-exports the Hono app)
src/
  adapters/     external integrations (github, linear, anthropic, openai, resend, ...)
  events/       outbox: emit() + idempotent drain with retries
  intake/       proposal -> evaluation -> Linear
  router/       assignee suggestion (skill + load)
  notify/       transactional email (Resend)
  brain/        second brain: atoms, embeddings, hybrid retrieval
  reconcile/    commit dedup/auto-doc + new-repo detection
  routes/       health, mcp, webhooks, intake, dashboard, internal (crons)
migrations/     SQL schema (pgvector, outbox, idempotency)
web/            React dashboard SPA + public landing
```

## Reporting bugs and security issues

- **Bugs / features:** open a GitHub issue.
- **Security vulnerabilities:** do *not* open a public issue — see [`SECURITY.md`](SECURITY.md).
