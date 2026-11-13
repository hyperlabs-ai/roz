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
| Runtime / deploy | **zeus**: one long-lived Node process (`src/index.ts`, Docker → Railway). The frontend (`web/`) deploys separately as static files on Vercel |
| HTTP framework | **Hono** |
| Language | **TypeScript** (ESM, `strict`) |
| Data + vectors | **Supabase Postgres + pgvector** (service role, server-side) |
| Reasoning | **Claude** (Anthropic SDK, with prompt caching) — spec, classification, reconciliation |
| Judgments | **TypeSafe Jev** (plain `fetch`, optional) — typed questions about a task for automatic assignment |
| Embeddings | **OpenAI** `text-embedding-3-large` (3072 dims) — via API |
| Async queue | **Postgres outbox drained by the in-process scheduler** (`src/jobs/scheduler.ts`) — no external service |
| Interactive face | **MCP server** over HTTP (own stateless JSON-RPC) |
| Integrations | **GitHub** (truth of code), **Resend** (email) |

> **The outbox is still the queue.** Each effect is written as an `outbox_event`; zeus's scheduler
> calls `/v1/internal/drain` every 15 s (in memory, no network hop) and runs the pending ones.
> Retries with **exponential backoff** (`attempts` + `next_attempt_at`) and **dead-letter** after 5
> attempts. Zero extra vendor; idempotency via `idempotency_key`.

---

## Deployment: frontend (roz) and backend (zeus), separately

roz started as a single Vercel serverless function serving both the API and the SPA. It is now two
deployments (the Spanish document, `ARCHITECTURE.es.md`, has the full rationale and the zeus context
module; contracts are in `docs/zeus-contracts.md`):

- **roz** (frontend) on Vercel, Root Directory `web/`: static SPA only. `web/vercel.ts` rewrites
  `/api/*` to zeus, so the browser sees one origin. No secrets live here.
- **zeus** (backend) on Railway, from the root `Dockerfile`: the API, the MCP server, the in-process
  scheduler that replaced Vercel Cron (`src/jobs/scheduler.ts`), the Discord gateway
  (`src/bridge/`, formerly a separate service) and the unified-context module (`src/zeus/`). Single
  instance; graceful shutdown on SIGTERM.

What carries over from the original design:

1. **The outbox is drained by polling.** Every state change writes an `OutboxEvent` in
   the same transaction as the data (outbox pattern). The scheduler (`/v1/internal/drain`, every 15 s)
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
    adapters/           # github, email(resend), anthropic, embeddings(openai), typesafe(jev)
    mcp/server.ts       # MCP server: defines the tools (interactive face)
    intake/             # proposal -> evaluation -> native task (MCP + apps) [phase 1]
    assign/             # automatic assignment: Jev judges, pure policy decides, decision log
    router/             # embedding-based suggestion (MCP, and intake when assign/ is off) [phase 2]
    notify/             # email (Resend): assignment, close, doc, repo, digest [phase 3]
    brain/              # second brain: atoms, embeddings, graph, retrieval [phase 4]
    reconcile/          # commits (dedup/auto-doc) + new repos (detection/link) [phase 5-6]
    projects/           # repo→project resolution and project auto-onboarding
    dashboard/          # engineering-visibility queries (consumed by web/)
    chat/               # team chat: channels, DMs, threads, attachments, realtime and push
    routes/             # health, mcp, webhooks (github), intake, dashboard (+ chat), internal
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

### 2. Smart tickets and automatic assignment (`src/tickets/`, `src/assign/`)
**`/ticket`** (the *Ticket* tab at `/app/ticket`, or typing `/ticket` in chat): anyone on the team
writes only **name, project and description**. roz reads it with Jev, fills in the rest (solution
type, skills, level, points, urgency), proposes an assignee and shows it all in an editable
**preview**. Correcting the type, points, priority or due date does NOT call Jev again: its answer is
reused and only the policy is recomputed. On **create**, the task is assigned and the assignee gets a
DM **from the requester's own profile** ("Te asigné una nueva tarea #KEY-12"). The preview is an
`assignment_decision` row with `outcome='preview'` that becomes the task's decision on create.

The same assignment runs for `/v1/intake` and for the "Asignar automáticamente" button on an open,
unassigned task. The regular "New task" dialog no longer auto-assigns (`POST /tickets` only does it
with `autoAssign: true`).

**Skills ≠ solution types.** A *skill* is what a person knows (level 1–5). A *solution type*
(`roz.solution_type`, 0032, editable under Skills → Tipos de solución) is what kind of work the task
is, and sets the primary skill (or "the affected module's", for bugs and refactors), minimum level,
secondary skill and typical size. Jev only picks the type; the table decides the rest.

**Jev judges, code decides.** One TypeSafe request per task (`jev-questions.ts`, the only place with
question wording and thresholds; questions `q2`) answers only what needs reading the task text: which
solution type it is (Choice + companion Noul), which skill/module it touches (Choice + Noul), how big
(Score → 1/2/3/5/8/13 points; below the type's minimum it is raised to the minimum, above its maximum
it is kept and flagged), whether production is broken / a client is blocked (two Nouls), and the
project if missing. Questions are in English (Jev's strongest language); the task text and the type
table go as-is. Jev never sees people or dates. Anything a human set wins (project, type, priority,
due date, estimate). Without a clear type, the task asks for a human decision.

**Project context (q3, migration 0033).** Jev receives the project's *profile* — its main type
(landing, e-commerce, web app with backend, mobile app, API, AI product) and a description — so "fix a
button" isn't read the same in a landing page as in an app with a backend. Plus one more question,
`server_side` (does it touch the server side?): for a bug/refactor in a project **with a backend**, if
the ticket isn't clearly UI-only, the skill Jev guessed doesn't filter and the task goes to
whoever runs the project first. roz proposes the profile by reading the project's GitHub repos
(`src/projects/profile.ts`): Jev judges the type; Claude writes the description or, when unavailable,
it's assembled from GitHub (description/README and detected stack). It stays flagged "IA" until a
person reviews it; `scripts/fill-project-profiles.ts` fills every project's empty fields without
overwriting human input.

Everything else is a **pure, tested policy** (`policy.ts`, `p2`):

1. **Hard filters** (exclude, never penalize): active, assignable role (dev/designer/intern),
   availability > 0, skill ≥ required level, WIP ≤ 3 active tasks (`en_progreso` + `revision`, as
   primary) and ≤ 2 simultaneous projects.
2. **Order:** project lead (`dev_assignment` principal) → secondary → specialist (level ≥ 4) → pool.
   If the task needs level ≥ 4, specialists go first. The type's secondary skill excludes nobody: among
   specialists and in the pool it orders people who tie on the primary skill.
3. **Tie-break** (within a tier): among candidates ≤ 1 level apart, the lower level wins when the task
   is ≤ 3 pts, not urgent and a senior reviewer (level ≥ 4) exists — avoids a single point of failure.
4. **Effective size** (context cost): ×1.0 lead, ×1.15 secondary, ×1.3 external, ×1.5 external with no
   history on the project (1 pt = 2 h).
5. **Capacity as a per-candidate filter:** load + effective hours ≤ 85% of the hours left before the
   due date (business days × weekly hours / 5 × availability). First that fits wins.
6. **Escalate** when nobody fits: suggest splitting (specialist defines the approach in 1–2 h, lead
   implements), reprioritizing (who would fit by deferring lower-priority work) or backlog. The task
   stays unassigned with a visible "Necesita decisión"; nothing is split automatically.

**Log and overrides.** Every run writes `roz.assignment_decision` (0031): the exact Jev payload and
model, the classification with the source of each field, every candidate with its reasons, and the
outcome. Changing the assignee roz chose asks for a **closed-category reason** (once): that log is
what lets the algorithm improve instead of being argued every sprint. A Jev failure is an error
(task unassigned and marked, retried by the outbox), never a "no". Creation never waits for Jev: the
run goes through the `work_item.auto_assign` outbox event, processed right away in the background.
Without `TYPESAFE_API_KEY` the feature is off and intake keeps the embedding router (`src/router/`).

### 3. Notifications (via outbox → drain)
An **email (Resend)** adapter with branded HTML templates: assignment, close, change documented,
repo detected, and the weekly digest. Each notification is an idempotent effect fired by the drain;
it claims a per-recipient key so a retried event never sends duplicates.

**Switches (killswitch).** `roz.notification_switch` governs whether roz sends at all, with two
scopes that multiply: **global** (the whole environment) and **per person**. Both are flipped from
Settings in the dashboard, no redeploy. With a switch off the notice is **skipped silently** instead
of throwing: the outbox event closes as `done` and the queue does not fill with dead letters — which
is exactly what happened while Resend failed permanently (unverified domain, exhausted quota).

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

### 7. Team chat
A Slack-style chat inside the dashboard (`/app/chat`): public and private channels, direct
messages (1:1 and group), threads, attachments, @mentions (including `@canal`) and editing/deleting
your own messages. Identity is `roz.dev`, same as the rest of the app. The code lives in `src/chat/`
(pure rules in `rules.ts`/`text.ts`, tested without a database) and the API at `/api/dashboard/chat/*`.

- **Message → task.** Every message has a "Create task" action: it opens the task dialog with the
  title, description (with a link back) and assignees (the mentioned devs) pre-filled. The task
  stores `work_item.chat_message_id`; the message shows its card with current status and assignees,
  and a system notice lands in its thread. From the task, "View source conversation" opens that thread.
- **Citing tasks.** In the composer, `@tarea <person> <text>` searches tasks (words that match a dev
  filter by assignee; the rest match the name or identifier) and inserts `#ROZ-12`. The text is
  stored as-is — the identifier is already canonical and stable — and the backend resolves the cards
  on read, in one query per page. Each citation renders with the SAME kanban card
  (`web/src/components/tasks/card-parts.tsx`, shared with the board), with its current status and
  assignees, and opens the task on click.
- **Realtime: one inbox per person.** Supabase Realtime Broadcast on PRIVATE channels
  (`chat:dev:<devId>`). The backend publishes each message fully enriched, in ONE REST request for
  all members. The policy on `realtime.messages` (migration 0030) lets each client listen only to its
  own inbox, using the same user→dev mapping as the dashboard auth. Without the socket, the client
  keeps polling `/chat/unread` and re-syncs the open conversation.
  **Manual Supabase step:** turn off "Allow public access" under Realtime → Settings so only
  private channels exist.
- **Push without the outbox.** A chat that notifies a minute late is useless, so message push does
  NOT go through the outbox: it is sent right after responding (`waitUntil`,
  `src/utils/background.ts`) and is best-effort like all push. It honors the Settings switches and
  each conversation's notify level (all / mentions only / muted; DM → all, channel → mentions). The
  service worker skips the notification when the person already has that conversation open and
  focused. Successful sends are not logged to `roz.notification` (only failures): it would be one row
  per message.
- **Private attachments.** A private `chat-attachments` bucket; the backend signs temporary URLs when
  serving messages. Same 4 MB cap as task attachments (Vercel body limit).

---

## Event core (outbox + scheduler)

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
- **notification_switch** — send switches: a `global` row (team killswitch) plus one per muted dev.
  Sending requires both scopes to be on.
- **outbox_event / idempotency_key** — the event core and idempotency.
- **chat_conversation / chat_member / chat_message / chat_attachment** — team chat (0030).
  `work_item.chat_message_id` links a task to the message it came from.
- **assignment_decision** — automatic-assignment log (0031): Jev payload/model, classification,
  candidates with reasons, outcome, and the human override (closed category). `work_item.estimate`
  (story points) is now written by the task dialog and by automatic assignment. Since 0032 it also
  stores a ticket preview (`outcome='preview'`, no task yet).
- **solution_type** — solution types (0032): primary skill (or "the module's"), minimum level,
  secondary skill and typical size. `work_item.solution_type_id` is the type a person set.
- **project.project_type / description / profile_source** — project profile (0033): the context Jev
  reads; `profile_source='ia'` = proposed by roz from GitHub, pending review.

### The dashboard SPA (`web/`)

Four pieces carry the feel of the app; each one came from a concrete "the app feels broken" symptom:

- **Session outside React** (`web/src/auth/store.ts`, via `useSyncExternalStore`). supabase-js can
  emit a TRANSIENT `SIGNED_OUT` when you come back to the tab (expired refresh token, two tabs
  fighting over it). With the session in a context, that unmounted the whole dashboard. Now a sign-out
  counts as real only if we asked for it or another tab cleared the session; anything else is
  recovered silently with backoff (3 tries) while the user keeps working, and `RequireAuth` guarantees
  that once you are in, no later state swaps the `<Outlet/>`.
- **Shared stale-while-revalidate cache** (`web/src/lib/store.ts` + `useApi`, opt-in via `key`/`ttl`).
  Every mount used to start at `loading`, so returning to a section always meant skeletons and a
  refetch. The cache key embeds the user id and the map is dropped on account change (plus in-flight
  responses are discarded): those are the three locks against serving another account's data. After a
  mutation, use `invalidate(prefix)` rather than `reload()`.
- **Persistent chrome** (`web/src/components/AppShell.tsx`, a route layout). `Layout` keeps its
  signature and publishes title and actions into the header through a portal, so navigating between
  sections no longer rebuilds the sidebar, header and queue pill.
- **Mutations with feedback** (`web/src/lib/useMirror.ts` and `useAction.ts`): optimistic updates,
  per-row or per-action `busy`, per-entity chaining, partial rollback and adoption of whatever entity
  the backend returns. Extracted from what fixed Tasks, so no section has to rewrite it.

### Design system (`web/src/styles.css`, `charts.tsx`, `bits.tsx`)

Two more pieces, added when the charts were called out as too basic:

- **One motion scale** (`:root` in `web/src/styles.css`). Durations, easings, distances, scales and
  blurs come from [transitions.dev](https://transitions.dev), and the recipes live in the same file
  under `t-*` classes. Two rules: `--ease-smooth-out` **is** Tailwind's `ease-spring` (the config
  reads the token, so there is one value, not two), and a hardcoded value is only replaced when its
  USE matches a documented use — "hover lift" and the landing's decorative loops keep their own
  numbers on purpose. The recipes are written as `@keyframes` over Radix's `data-state` rather than
  as transitions: Radix's Presence decides when to unmount by reading `animationName`, so with a
  plain transition the closing animation is never seen. `prefers-reduced-motion` already turns
  everything off globally.
- **One component per concept.** `charts.tsx` is the only boundary with recharts; the visual recipe
  is amicro's "mono" family, ported rather than copied (the originals hardcode their data and their
  colors). Every colour comes from a token — no hex anywhere in the dataviz — so light and dark need
  a single declaration. One shape rule, set by the user: comparing categories is
  always **vertical columns** (`Columns`) — no horizontal bars anywhere, and the ranked list,
  funnel, radar and the `Bar` primitive were deleted so they cannot creep back. Composition is
  `Donut` / `StackedBar`; time is `AreaTrend`. `bits.tsx` holds the primitives that used to be
  duplicated: one `ProgressBar` (was two), one `SegmentMeter` (was three), and `MetricCard`
  absorbed the five different stat cards that each had their own API and only one of which
  animated its number.

### Hybrid retrieval
Postgres provides **full-text (keyword)** + **pgvector (semantic)** combined with reciprocal rank
fusion. Keyword catches exact identifiers (`ROZ-123`); embeddings catch the disguised duplicate. At
small scale, exact KNN is enough.

---

## Security / public surface

- **MCP** (`/mcp`): a personal `zeus_…` token per dev (only its sha256 is stored), so every call is
  attributed. Runner tokens and the shared `ROZ_MCP_TOKEN` still work with a reduced tool set.
- **zeus CLI** (`/v1/zeus`) and the zero-knowledge env vault: see `docs/zeus-contracts.md` §4–§5.
- **App intake** (`/v1/intake`): bearer `ROZ_INGEST_TOKEN` (the project is distinguished by
  `projectKey`). At scale, prefer a per-app token + rate limiting.
- **Webhooks**: GitHub signature verified via HMAC (`GITHUB_WEBHOOK_SECRET`).
- **Internal/jobs** (`/v1/internal/*`): protected by `CRON_SECRET` (sent by the scheduler).
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
| + | **Team chat**: channels, DMs, threads and attachments; message → task; realtime and push. |
