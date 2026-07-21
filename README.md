# roz

[![License: MIT](https://img.shields.io/badge/License-MIT-2853ff.svg)](LICENSE)
![Works with GitHub](https://img.shields.io/badge/Works%20with-GitHub-181717?logo=github)
![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white)

**The intelligence layer over GitHub.** roz is a layer of **context, routing and
notification** around development work. Work lives in roz as **native tasks** (a calendar +
backlog you manage inside the app); roz is the **reasoning layer** that watches what happens
across those tasks and GitHub, understands it with AI, and keeps each project's and each
developer's context alive — to **document, route and notify** automatically, with nobody having
to administer it.

> 🇪🇸 *Español:* [README.es.md](README.es.md)

What sets it apart from a plain task manager: a plain tracker waits for you to feed it (mark the
task done, link the repo). roz **derives state from reality** — commits, PRs, repos — and
reconciles: a branch named `ROZ-123` moves the task to *in progress*, an open PR to *in review*,
a merge to *completed*. The work is the source of truth; roz interprets it.

- **Reasons, doesn't just record.** For an orphan commit, Claude decides whether it's trivial or
  substantive, whether it resolves an existing open issue (semantic dedup, no embeddings) and, if
  not, **creates the already-documented issue**. It doesn't ask you to document — it documents for you.
- **Has project context.** Anchors native tasks (work) and GitHub (code) to the same canonical
  project, auto-onboards new projects, and links new repos to the project they belong to by
  similarity — or flags them for someone to link.
- **Has developer context.** Resolves the same person across their GitHub login and their commit
  email; knows their load and availability to route work by **skill + capacity**, not at random.
- **Closes the loop with people.** Notifies by email what matters (you were assigned, your change was
  documented, a repo was detected) — targeted communication, not a board you have to go check.
- **Second brain.** Embeddings + retrieval to recover historical project context and feed its own reasoning.

## Stack

**TypeScript + Hono** on **Vercel serverless** · **Supabase Postgres + pgvector** · async queue =
**Postgres outbox drained by Vercel Cron** (no external service) · **Claude** (reasoning) ·
**OpenAI** (embeddings) · **GitHub / Resend** (email) · **React** dashboard SPA in `web/`.

Full design: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Self-hosting

roz is open source under [MIT](LICENSE). There is **no hosted service** — you run your own
deployment, so **your data stays in your own database**.

### Prerequisites (accounts)

| Service | Why |
|---|---|
| **Supabase** | Postgres + pgvector (roz's database) |
| **Vercel** | serverless runtime + cron |
| **GitHub** | a fine-grained PAT — see [`docs/GITHUB-SETUP.md`](docs/GITHUB-SETUP.md) |
| **Anthropic** | Claude (reasoning) |
| **OpenAI** | embeddings (`text-embedding-3-large`, 3072 dims) |
| **Resend** | transactional email |

Infrastructure observability tokens (Vercel / Railway / Supabase Management) are **optional** and
degrade gracefully if unset.

### Steps

```bash
# 1. Install
npm install
npm install --prefix web

# 2. Configure
cp .env.example .env        # fill in your keys (see the comments in the file)

# 3. Run locally (http://localhost:3000)
npm run dev                 # GET /health -> { "status": "ok" }
```

1. **Database.** Apply the migrations in `migrations/` **in order** (`0001_roz_schema.sql` …
   `0011_pr_attribution.sql`) to your Supabase project (SQL editor or `supabase db push`). The
   schema lives isolated in `roz`; make sure `roz` is in the API's **exposed schemas**
   (Supabase → Settings → API), or everything fails with `PGRST106`.
2. **Deploy** to Vercel. The build runs the dashboard build; `vercel.json` defines the crons
   (outbox drain every minute, infra-poll every 15 min, brain-sweep daily, weekly digest on
   Fridays). Set `CRON_SECRET` in production or the crons return `403`.
3. **Connect GitHub.** Follow [`docs/GITHUB-SETUP.md`](docs/GITHUB-SETUP.md) (PAT scopes +
   webhook).
4. **Seed.** Run `npx tsx scripts/backfill-embeddings.ts` to generate skill embeddings.
   Optionally `npx tsx scripts/backfill-commits.ts` for historical commits. Create your projects
   and tasks natively from the dashboard.

The public **landing page** is served at `/`; the operator **dashboard** lives behind login at
`/app`.

> **HyperOps fallback.** roz was built at HyperLabs and has an optional, internal-only fallback
> (`HYPEROPS_FALLBACK`, default `false`) for resolving repos via a separate `public` schema.
> Leave it off for self-hosting — roz uses its own `roz.project_repo` mapping + manual projects.

## HTTP surface

| Route | Caller | What it does |
|---|---|---|
| `GET /health` | — | healthcheck |
| `POST /mcp` | Claude (bearer `ROZ_MCP_TOKEN`) | intake/dev/context tools: `get_intake_form`, `propose_change`, `confirm_proposal`, `list_projects`, `suggest_assignee`, `list_devs`, `upsert_dev`, `set_availability`, `set_dev_skills`, `get_project_context` |
| `POST /webhooks/github` | GitHub | push/commits (reconciliation), PR lifecycle (task state) and new-repo detection; HMAC-verified |
| `POST /v1/intake` | Client apps (bearer `ROZ_INGEST_TOKEN`) | auto-documented, auto-assigned intake |
| `GET /api/dashboard/*` | Dashboard SPA (Supabase auth + domain) | engineering metrics + infra health |
| `GET /v1/internal/drain` | Vercel Cron (every min) | drains the outbox (idempotent, with retries) |
| `GET /v1/internal/infra-poll` | Vercel Cron (every 15 min) | polls Vercel/Railway/Supabase status |
| `GET /v1/internal/brain-sweep` | Vercel Cron (daily) | backfills missing embeddings |
| `GET /v1/internal/weekly-digest` | Vercel Cron (Fridays) | team + per-dev digest email |
| `GET *` | browser | serves the dashboard SPA / public landing |

## Status

Implemented: multi-channel intake (conversational via MCP + apps via `/v1/intake` + native tasks),
skill-based router, email notifications, second brain (documentation on close + hybrid retrieval +
embedding sweep), commit reconciliation, new-repo tracking (detection + similarity link + dev
notification), the visibility dashboard, and the weekly digest. See [`ARCHITECTURE.md`](ARCHITECTURE.md)
for the phase-by-phase detail.

## Documentation

- [Architecture](ARCHITECTURE.md) · [Arquitectura (ES)](ARCHITECTURE.es.md)
- [GitHub setup](docs/GITHUB-SETUP.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## License

[MIT](LICENSE) © HyperLabs. Support: **manuel@hyperlabs.vc**.
