# Connecting roz to GitHub

roz integrates with GitHub through the **REST API** (read-only) and **webhooks**. It never
writes to your repositories — it only reads commits, pull requests and repository metadata to
reconcile work. This guide walks through connecting a self-hosted roz to a GitHub organization
or repository.

> roz authenticates with a **fine-grained Personal Access Token (PAT)**. A GitHub App is not
> required. If you later want per-organization installs, a GitHub App is a natural upgrade —
> but everything below works with a PAT.

---

## 1. Create a fine-grained Personal Access Token

GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens →
Generate new token**.

- **Resource owner:** your organization (or your account).
- **Repository access:** all repositories, or only the ones roz should track.
- **Repository permissions** (read-only — roz never writes):

  | Permission       | Access |
  |------------------|--------|
  | Contents         | Read   |
  | Metadata         | Read   |
  | Pull requests    | Read   |

Copy the token into your `.env`:

```bash
GITHUB_TOKEN=github_pat_xxx
```

That's all roz needs to call the API. The endpoints it uses (API version `2022-11-28`):

- `GET /repos/{owner}/{repo}/commits` and `/commits/{sha}` — commit metadata
- `GET /repos/{owner}/{repo}` — repository metadata
- `GET /repos/{owner}/{repo}/pulls/{n}`, `/pulls/{n}/commits`, `/pulls/{n}/reviews`
- `GET /repos/{owner}/{repo}/compare/{base}...{head}` — backfill of truncated pushes (>20 commits)
- `GET /repos/{owner}/{repo}/commits/{sha}/pulls` — PRs associated with a commit

---

## 2. Set the webhook secret

Pick a strong random secret and put it in your `.env`:

```bash
GITHUB_WEBHOOK_SECRET=<long-random-string>
```

roz verifies every webhook with **HMAC-SHA256** (the `x-hub-signature-256` header) using a
constant-time comparison. A request with a missing or wrong signature is rejected.

---

## 3. Create the webhook

Org-wide (recommended): **Organization → Settings → Webhooks → Add webhook**.
Or per-repo: **Repository → Settings → Webhooks → Add webhook**.

- **Payload URL:** `https://<your-roz-deployment>/webhooks/github`
- **Content type:** `application/json`
- **Secret:** the same value as `GITHUB_WEBHOOK_SECRET`
- **Which events?** → *Let me select individual events*, then enable:
  - **Pushes** (`push`)
  - **Pull requests** (`pull_request`)
  - **Repositories** (`repository`)
- **Active:** checked.

Save. GitHub sends a `ping`; roz responds `200`.

---

## 4. What each event does

| Event          | roz's behavior |
|----------------|----------------|
| `push`         | Emits a `commit.received` event per commit on the default branch. For pushes truncated at 20 commits, it backfills the full range via the compare API. |
| `pull_request` | On merge, emits `pr.merged` to document the change with attribution (author / reviewers / merger). |
| `repository`   | On `created`, emits `repo.detected` to link the new repo to a project (by name similarity) or notify the team. |

---

## 5. How delivery works (and why it's reliable)

roz does **not** process webhooks synchronously. The flow:

1. The webhook handler verifies the signature and writes an **idempotent event** to a Postgres
   outbox (`outbox_event`), then responds `200` immediately.
2. A Vercel Cron job drains the outbox every minute: it claims each event optimistically
   (`pending` → `processing`), runs the effect, and marks it `done`.
3. Failures are retried with **exponential backoff** (up to 5 attempts) and then dead-lettered
   for inspection. Idempotency keys (e.g. `commit:{repo}:{sha}`) make retries and duplicate
   deliveries safe — no double effects.

This means a slow downstream call (Claude) never blocks GitHub's webhook delivery, and
a transient failure never loses an event. No external queue (Redis, etc.) is required — Postgres
+ cron is the whole pipeline.

> Requires `CRON_SECRET` to be set in production so the drain endpoint isn't publicly callable.

---

## 6. Verify it's working

- `GET https://<your-roz-deployment>/health` → `{ "status": "ok" }`
- In GitHub's webhook settings, the **Recent Deliveries** tab should show `200` responses.
- Push a commit to a tracked repo, then watch the outbox drain (every minute) reconcile it.

If deliveries fail with `401`/signature errors, double-check that `GITHUB_WEBHOOK_SECRET`
matches the webhook's **Secret** exactly.

---

## Optional: HyperLabs-internal fallback

roz was originally built at HyperLabs alongside an internal system ("HyperOps"). A
`HYPEROPS_FALLBACK` flag (default **`false`**) gates an optional read of a `public` schema to
resolve repo→project mappings. **Self-hosters should leave it off** — roz resolves repos via
its own `roz.project_repo` table and manual projects, with no dependency on any external schema.
