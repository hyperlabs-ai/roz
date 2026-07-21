# roz — Architecture

> 🇪🇸 *Español:* [ARCHITECTURE.es.md](ARCHITECTURE.es.md)

`roz` is the layer of **context, routing and notification** around development work. Work lives in
roz as **native tasks** (a calendar + backlog with local `ROZ-123` identifiers), and on top of that
roz does three things and only three:

1. **Manage context** (the *second brain*): Claude *reads* project context via MCP; roz *writes*
   context (almost always when work is completed).
2. **Route**: decides which developer a proposal is assigned to (skill + load).
3. **Notify**: email (Resend).

Intake is **multi-channel** but converges on the same pipeline (evaluate against context →
document → route → native task): (a) **conversational** via MCP — the chat drives a guided interview
and roz documents and suggests an assignee; the human confirms; (b) **tickets from apps** via
`POST /v1/intake` — auto-documented and auto-assigned, no human in the loop; (c) **directly in the
dashboard** — a task is created natively (calendar / backlog). From there, work lives in roz. The
follow-up (on completion): document / update context, reconcile GitHub commits, and notify whoever
proposed it. The hardest part — and the reason behind several design decisions — is to **not
duplicate**: not tasks, not documentation, not knowledge.

---

## Guiding principles

Four patterns recur across ALL of roz's domains:

1. **Canonical identity.** Each unit (task, commit, knowledge atom) has a stable ID. roz's native
   tasks are the **source of truth for work**; GitHub is the **source of truth for code**.
2. **Supersede, don't duplicate.** Nothing is deleted or blindly stacked: the old is marked
   `superseded` and kept with its provenance. Applies to the brain and to documentation.
3. **Provenance back to the task.** Every knowledge atom and every generated doc points back to the
   task (`work_item`) that originated it.
4. **MCP inward, direct APIs outward.**
   - *Inward* (Claude/humans → roz): roz **exposes an MCP server** (Streamable HTTP). That's how you
     "ship a feature from Claude": the chat calls roz's tools.
   - *Outward* (roz → tools): roz consumes **direct APIs/webhooks** from GitHub, Resend
     (email) and OpenAI/Anthropic.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime / deploy | **Vercel serverless functions** (single entry `api/index.ts`) |
| HTTP framework | **Hono** |
| Language | **TypeScript** (ESM, `strict`) |
| Data + vectors | **Supabase Postgres + pgvector** (service role, server-side) |
| Reasoning | **Claude** (Anthropic SDK, with prompt caching) — spec, classification, reconciliation |
| Embeddings | **OpenAI** `text-embedding-3-large` (3072 dims) — via API |
| Async queue | **Postgres outbox drained by Vercel Cron** — no external service |
| Interactive face | **MCP server** over HTTP (own stateless JSON-RPC) |
| Integrations | **GitHub** (truth of code), **Resend** (email) |

> **No persistent worker.** In serverless there is no long-lived process. The worker's role is
> filled by the **Postgres outbox + Vercel Cron**: each effect is written as an `outbox_event` and a
> cron (`/v1/internal/drain`, every minute) picks up the pending ones and runs them. Retries with
> **exponential backoff** (`attempts` + `next_attempt_at`) and **dead-letter** after 5 attempts.
> Zero extra vendor; idempotency via `idempotency_key`.

---

## Why serverless changes the design

Three direct consequences of having no persistent process:

1. **The outbox is drained by polling (Vercel Cron).** Every state change writes an `OutboxEvent` in
   the same transaction as the data (outbox pattern). A cron (`/v1/internal/drain`, every minute)
   takes the due `pending`/`failed` events, claims them optimistically (`pending`→`processing`) and
   runs the effect. On failure it reschedules with exponential backoff (`next_attempt_at`) up to 5
   attempts, then `dead`. Idempotency via `idempotency_key` makes retries safe.
2. **No local embeddings.** Embeddings are an OpenAI API call. That means per-use cost and network
   latency → the vector is **cached** by content hash and only reindexed when the atom's body changes.
3. **Stateless MCP per request.** The MCP server is mounted as an HTTP handler (Streamable HTTP).
   Each request carries its own context; there's no in-memory session between invocations.

---

## Code layout

```
roz/
  api/
    index.ts            # Vercel entry: re-exports the Hono app
  src/
    index.ts            # local (dev) server with @hono/node-server
    app.ts              # Hono app: mounts middleware + routes
    config.ts           # settings (zod) from env
    db/supabase.ts      # Supabase client (service role)
    types/              # shared types (Hono context, domain)
    middleware/         # logger, MCP auth
    utils/              # errors, webhook signature verification
    events/outbox.ts    # emit() + idempotent drain with retries (drainOutbox)
    adapters/           # github, email(resend), anthropic, embeddings(openai)
    mcp/server.ts       # MCP server: defines the tools (interactive face)
    intake/             # proposal -> evaluation -> native task (MCP + apps) [phase 1]
    router/             # suggests assignee by skill + load          [phase 2]
    notify/             # email (Resend): assignment, close, doc, repo, digest [phase 3]
    brain/              # second brain: atoms, embeddings, graph, retrieval [phase 4]
    reconcile/          # commits (dedup/auto-doc) + new repos (detection/link) [phase 5-6]
    projects/           # repo→project resolution and project auto-onboarding
    dashboard/          # engineering-visibility queries (consumed by web/)
    routes/             # health, mcp, webhooks (github), intake, dashboard, internal
  migrations/           # full schema (pgvector, outbox, idempotency)
  web/                  # React SPA: public landing (/) + dashboard (/app)
```

---

## The flow, end to end

```
Native task lifecycle (in-app):
  task created / moved         → calendar + backlog; task.done → document/update brain + email
Incoming webhooks:
  GitHub   → branch ROZ-123     → moves the task to "in progress"
           → PR opened          → moves the task to "in review"
           → PR merged          → moves the task to "completed" (fires work_item.done)
           → push/commit        → does it point to a task? if not, substantive orphan work?
                                   → link/dedup against existing tasks + auto-doc
           → new repo (1st push) → link to a project by similarity, or notify the devs
```

### 1. Intake (multi-channel, native tasks)
Three entry doors, one pipeline: conversational (MCP), tickets from apps (`/v1/intake`) and directly
in the dashboard (calendar / backlog). On confirm/ingest, roz **creates the native task already
assigned** (`source='native'`, local `ROZ-123` identifier), saves the `WorkItem` and emits the event
to the outbox. From then on, the task lives in roz and its state is driven by the dashboard and by
GitHub activity.

### 2. Developer router
roz has context on every dev: skills (with a profile embedding), manual availability and **derived
load** (number of tasks `in progress`). It computes `skill_match × availability`, **proposes**
and a human confirms.

### 3. Notifications (via outbox → drain)
An **email (Resend)** adapter with branded HTML templates: assignment, close, change documented,
repo detected, and the weekly digest. Each notification is an idempotent effect fired by the drain;
it claims a per-recipient key so a retried event never sends duplicates.

### 4. Second brain (on completion)
Triggered by `work_item.done`, emitted when a task moves to **completed** — either manually in the
dashboard or automatically when its PR is merged. roz creates/updates a **knowledge atom** with an
embedding and provenance tied to the identifier; if an atom already existed for that task with
different content, it marks it **superseded** rather than duplicating. A daily sweep backfills
missing embeddings.

### 5. Commit reconciliation (the main challenge)
For each commit (GitHub webhook): (1) does it point to a task? (a `ROZ-123` reference in the branch
or message links it); (2) if not → **orphan work**: a single Claude pass decides trivial/substantive
and semantic dedup against open tasks; (3) substantive with no match → roz creates the task
**already completed** and notifies the author; (4) persists the commit for the dashboard; (5)
idempotency by `repo:sha`.

Project and dev are resolved **live** (`resolveProjectByRepo`). The repo→project mapping lives in
`roz.project_repo`; there is an **optional** fallback (`HYPEROPS_FALLBACK`, default off) to a
HyperLabs-internal `public` schema — self-hosters leave it off.

### 6. New-repo tracking
On the first `push` of a repo roz can't resolve, the webhook emits `repo.detected`. The drain tries
to link it to a project by name similarity (tokens/Levenshtein → Claude fallback); with or without a
match, it notifies the devs. It doesn't create projects — that decision is left to a human.

---

## Event core (outbox + Vercel Cron)

Every state change writes an `OutboxEvent` in the **same transaction** as the data. The cron
`/v1/internal/drain` (every minute) drains the queue: (1) optimistic claim; (2) run the effect while
checking `idempotency_key` (effectively exactly-once); (3) success → `done`, failure → `failed` with
exponential backoff, and after 5 attempts → `dead`.

> Latency ~≤1 min. For instant push, a Supabase Database Webhook (pg_net) can hit the drain on
> insert — without changing anything else.

---

## Data model (summary)

See `migrations/0001_roz_schema.sql`:

- **dev / skill / dev_skill** — router: person, skill profile (with `embedding`), level and load.
- **project / project_repo** — canonical project and repo→project mapping.
- **work_item** — native tasks (`source='native'`); the local `identifier` (ROZ-123) is canonical.
  Legacy `linear_*` columns are kept read-only as a historical mirror of pre-teardown tickets.
- **commit** — history of reconciled commits (resolved project/dev) for the dashboard.
- **knowledge_atom / atom_edge** — second brain: an addressable atom and the relationship graph.
- **notification** — outgoing email (Resend) with send status and `provider_id`.
- **outbox_event / idempotency_key** — the event core and idempotency.

### Hybrid retrieval
Postgres provides **full-text (keyword)** + **pgvector (semantic)** combined with reciprocal rank
fusion. Keyword catches exact identifiers (`ROZ-123`); embeddings catch the disguised duplicate. At
small scale, exact KNN is enough.

---

## Security / public surface

- **MCP** (`/mcp`): bearer `ROZ_MCP_TOKEN`.
- **App intake** (`/v1/intake`): bearer `ROZ_INGEST_TOKEN` (the project is distinguished by
  `projectKey`). At scale, prefer a per-app token + rate limiting.
- **Webhooks**: GitHub signature verified via HMAC (`GITHUB_WEBHOOK_SECRET`).
- **Internal/cron** (`/v1/internal/*`): protected by `CRON_SECRET` (Vercel injects the bearer).
- **Dashboard** (`/app`): Supabase Auth + domain filter (`DASHBOARD_ALLOWED_DOMAINS`). The role is
  resolved best-effort; if the profiles table doesn't exist, the dashboard is read-only.
- roz uses the Supabase **service role key**: it runs server-side, with no user session.

---

## Build phases

| Phase | Delivery |
|---|---|
| 0 | Scaffold: Hono+Vercel, config, db, outbox+drain (cron), MCP, webhook stubs, migration. |
| 1 | **Intake**: `propose_change` / `confirm_proposal` → native task + notification. |
| 2 | **Router**: skills, task-derived load, assignee suggestion. |
| 3 | **Notifications**: idempotent email templates (Resend). |
| 4 | **Brain**: atoms with embeddings (OpenAI), hybrid retrieval, documentation on close + sweep. |
| 5 | **Reconciliation**: orphan commits, classification, dedup, auto-doc. |
| 6 | **Repo tracking**: new-repo detection, similarity link, dev notification. |
| + | **Dashboard** for visibility (SPA in `web/`) and **weekly digest** email (Fridays). |
