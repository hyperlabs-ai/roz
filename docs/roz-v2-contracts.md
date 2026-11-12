# roz v2 — contratos entre módulos

Este documento es el contrato EXACTO que siguen los módulos de roz v2. Si una firma, un campo o un
nombre de evento cambia, cambia aquí, en `src/types/roz-v2.ts` y en `web/src/lib/api.ts` en el
mismo cambio (el front duplica los tipos a mano: un campo renombrado compila y rompe la UI en runtime).

Base ya construida (no la reescribas, impórtala):

| Pieza | Archivo |
|---|---|
| Migración (tablas, índices, RPC, RLS) | `migrations/0036_roz_v2.sql` |
| Tipos de dominio compartidos + máquina de estados del plan | `src/types/roz-v2.ts` |
| Cliente GraphQL de Linear + firma del webhook | `src/adapters/linear.ts` |
| Flag | `src/linear/enabled.ts` (`linearSourceOfTruth()`, `assertTasksWritable()`) |
| Config | `config.linear.{apiKey, webhookSecret, teamId, apiUrl, sourceOfTruth}`, `config.granola.{apiKey, baseUrl}` |
| Categoría de override `reclamado` | `src/assign/rules.ts` (`CLAIM_OVERRIDE_CATEGORY`, `STORED_OVERRIDE_CATEGORY_VALUES`) |

Reglas transversales:

- **Todo detrás de `ROZ_LINEAR_SOT`** (default `false`). Con el flag apagado: ningún endpoint nuevo
  escribe, ningún cron nuevo hace nada (responde `{ ok: true, skipped: 'flag' }`), la pantalla
  principal sigue siendo la de hoy, y `/ticket`/intake crean `work_item` nativos como hoy.
- **Endpoints de juntas, planes y runners con el flag apagado** → `409 { error: { code: 'LINEAR_SOT_OFF', message } }`.
  Excepciones: `GET /api/dashboard/roz-v2/status` y `GET /api/dashboard/pulse*` (lectura pura, funcionan siempre).
- Errores con la forma existente: `{ error: { code, message, details? } }` vía `AppError` (ver `src/app.ts`).
- HTTP en camelCase; filas en snake_case.
- Ninguna escritura de `work_item` desde roz con el flag encendido salvo `upsertMirrorFromLinear`
  (y lo que él llame). Toda ruta/herramienta MCP que hoy crea/edita tareas llama `assertTasksWritable()` al inicio.
- No se reintenta dentro de los adapters: un `LinearError`/`TypeSafeError` con `retryable: true` se relanza y el outbox reintenta.

---

## (a) Módulo `src/linear` — API para los demás

Dueño: agente de Linear. Archivos sugeridos: `src/linear/issues.ts` (crear/comentar/reasignar),
`src/linear/mirror.ts` (espejo), `src/linear/links.ts` (mapeos), `src/linear/webhook.ts`,
`src/linear/reconcile.ts`. Los demás SOLO importan de `src/linear/index.ts`, que reexporta esto:

```ts
import type { LinearIssue } from '../adapters/linear.js';
import type { IssueOrigin, LinearPriority } from '../types/roz-v2.js';
import type { TaskState } from '../tasks/states.js';

// ---------------------------------------------------------------- crear

export interface CreateIssueFromTicketInput {
  /** roz.project.id. El equipo de Linear sale de project.linear_team_id ?? config.linear.teamId;
   *  sin ninguno → AppError 422 'LINEAR_TEAM_MISSING'. El proyecto de Linear, de project.linear_project_id (opcional). */
  projectId: string;
  title: string;
  description: string | null;
  /** → etiqueta de Linear vía linear_link(kind='label', roz_id = solution_type.id). Sin vínculo: se omite + warning. */
  solutionTypeId: string | null;
  /** Puntos (1,2,3,5,8,13). */
  estimate: number | null;
  /** 1 urgente … 4 baja. null = sin prioridad (0). */
  priority: Exclude<LinearPriority, 0> | null;
  /** roz.dev.id → usuario de Linear por correo (linear_link kind='user', key = email en minúsculas;
   *  se compara contra dev.email y dev.github_email). Sin match: se crea sin asignado + warning. */
  assigneeDevId: string | null;
  dueDate: string | null; // YYYY-MM-DD
  origin: IssueOrigin;
  /** Para dejar rastro en la descripción del issue ("Desde la junta X: «cita»"). */
  source?: { meetingId?: string; candidateId?: string; quote?: string; requester?: string | null };
  /** auth.users.id de quien lo pidió (null en intake). */
  requestedBy: string | null;
}

export interface CreatedIssue {
  linearIssueId: string;
  identifier: string; // "HYP-123"
  url: string;
  /** El espejo se escribe EN EL MOMENTO (upsertMirrorFromLinear con source 'create'): quien llama
   *  puede ligar assignment_decision.work_item_id sin esperar al webhook. */
  workItemId: string;
  assigneeDevId: string | null;
  /** Lo que no se pudo mapear (etiqueta, asignado, proyecto). Se muestran en la UI, no fallan. */
  warnings: string[];
}

export function createIssueFromTicket(input: CreateIssueFromTicketInput): Promise<CreatedIssue>;

// ---------------------------------------------------------------- comentar (duplicados)

export function commentOnIssue(input: {
  /** Uno de los dos. workItemId se resuelve a work_item.linear_id. */
  workItemId?: string;
  linearIssueId?: string;
  body: string; // markdown
}): Promise<{ commentId: string; url: string | null; identifier: string }>;

// ---------------------------------------------------------------- reasignar (reclamar)

export function reassignIssue(input: {
  workItemId: string;
  toDevId: string;
  reason: 'reclamado' | 'manual';
}): Promise<{ assigneeLinearId: string; identifier: string }>;
// Sin usuario de Linear para toDevId → AppError 422 'LINEAR_USER_MISSING'. Escribe el espejo con el
// issue que devuelve Linear (upsertMirrorFromLinear source 'create'), así el webhook que llega después es no-op.

// ---------------------------------------------------------------- espejo

export interface MirrorResult {
  workItemId: string;
  created: boolean;
  status: TaskState;
  statusChanged: boolean;
  previousStatus: TaskState | null;
  assigneeDevId: string | null;
  previousAssigneeDevId: string | null;
  assigneeChanged: boolean;
  /** true = el issue venía con updatedAt <= linear_updated_at guardado: no se escribió nada. */
  stale: boolean;
}

export function upsertMirrorFromLinear(
  issue: LinearIssue,
  opts: { source: 'webhook' | 'reconcile' | 'create' },
): Promise<MirrorResult>;

/** Issue borrado/archivado en Linear (webhook action 'remove' o archivedAt != null): status 'cancelada'. */
export function retireMirror(linearIssueId: string): Promise<{ workItemId: string | null }>;

// ---------------------------------------------------------------- resolución (lectura)

export function linearUserForDev(devId: string): Promise<string | null>;
export function devForLinearUser(linearUserId: string): Promise<string | null>;
export function teamForProject(projectId: string): Promise<{ teamId: string; teamKey: string | null } | null>;
export function projectForLinear(teamId: string, linearProjectId: string | null): Promise<string | null>;

// ---------------------------------------------------------------- procesos (outbox / cron)

/** Refresca linear_link: equipos, usuarios (match por correo), etiquetas (match por nombre con
 *  solution_type.name, sin distinguir mayúsculas), estados, proyectos (match por linear_project_id). */
export function syncLinearLinks(): Promise<{ teams: number; users: number; labels: number; states: number; projects: number }>;
export function reconcileLinear(p: import('../types/roz-v2.js').LinearReconcilePayload): Promise<{ upserted: number; truncated: boolean }>;
export function handleLinearWebhook(p: import('../types/roz-v2.js').LinearWebhookPayload): Promise<void>;
```

Reglas del espejo (`upsertMirrorFromLinear`):

- Llave: `work_item.linear_id = issue.id`. Escribe: `identifier`, `number`, `name ← title`,
  `description`, `status ← linearStateToStatus(state.type, state.name)`, `priority ← LINEAR_PRIORITY_TO_ROZ`,
  `linear_priority`, `estimate`, `due_date`, `labels ← labels[].name`, `url`, `project_id ← projectForLinear(...)`,
  `assignee_dev_id ← devForLinearUser(assignee.id)` (y `work_item_assignee` con ese único principal),
  `solution_type_id` (de la primera etiqueta con vínculo), `linear_team_id`, `linear_project_id`,
  `linear_state_id/type/name`, `linear_assignee_id`, `linear_cycle`, `linear_branch_name`,
  `linear_created_at`, `linear_updated_at`, `linear_completed_at`, `linear_canceled_at`,
  `started_at/completed_at/canceled_at` (coalesce), `creator_name`, `source = 'linear'`, `linear_synced_at = now()`.
- **Monótono:** si `issue.updatedAt <= work_item.linear_updated_at` no escribe (`stale: true`). Webhook y
  reconciliación pueden llegar en cualquier orden.
- Conflicto de `identifier` con una tarea nativa (mismo `HYP-305`, `linear_id` null): el espejo NO pisa la
  nativa; renombra la nativa a `<identifier>-N` (N = 1, 2…) y registra un warning en el log. (Solo puede pasar con
  tareas creadas antes de encender el flag.)
- Efectos (emitidos por el espejo, no por quien llama):
  - `assigneeChanged && assigneeDevId && status abierto` → `emit('plan.enqueue', { workItemId, linearIssueId, ownerDevId: assigneeDevId, reason: previousAssigneeDevId ? 'reasignado' : 'asignado' }, { idempotencyKey: \`plan:${workItemId}:${assigneeDevId}:${issue.updatedAt}\` })`.
  - Transición a `completada` → `emit('work_item.done', …)` como hoy (documentación al brain) + transición
    `issue_cerrado` del plan vivo. A `cancelada` → transición `issue_cancelado`.
- Los triggers del puente con Ops (`roz.on_work_item_change`, migración 0021) siguen activos: el espejo
  propaga a `public.tasks` igual que las tareas nativas. (Ver "Pendientes" al final.)

---

## (b) Endpoints del dashboard

Todos bajo `/api/dashboard`, con `requireDashboardAuth` (montado en el router). `user = c.get('user')!`
trae `id` (auth.users), `devId`, `devName`. Cualquier usuario autenticado puede ejecutar cualquier acción
(igual que `requireAdmin` hoy); se registra SIEMPRE quién la hizo.

### Estado

```
GET /api/dashboard/roz-v2/status → 200 RozV2Status
```
```ts
interface RozV2Status { linearSourceOfTruth: boolean; linearConfigured: boolean; granolaEnabled: boolean }
```

### Juntas — `/api/dashboard/meetings*`

Dueño: agente de juntas (`src/meetings/*`, `src/adapters/granola.ts`, rutas en `src/routes/meetings.ts`
montadas con `dashboardRoutes.route('/meetings', meetingRoutes)`).

```
GET    /meetings?status=<MeetingStatus>&projectId=<uuid>&limit=<1..100, def 30>
         → 200 { meetings: MeetingSummary[]; granolaEnabled: boolean }
POST   /meetings                      body CreateMeetingRequest → 201 { meeting: MeetingSummary }
GET    /meetings/resolve-project?emails=a@x.com,b@y.com
         → 200 { projectId: string | null; matches: { projectId: string; projectName: string; domain: string }[] }
GET    /meetings/inbox?projectId=<uuid>  → 200 { candidates: InboxCandidate[] }   (solo status 'pendiente')
GET    /meetings/:id                  → 200 { meeting: MeetingDetail; candidates: MeetingCandidate[] }
PATCH  /meetings/:id                  body { projectId: string | null } → 200 { meeting: MeetingSummary }
POST   /meetings/:id/retry            → 202 { meeting: MeetingSummary }   (solo status 'error'; reemite meeting.extract)
DELETE /meetings/:id                  → 200 { ok: true }                  (borra en cascada sus candidatas)
POST   /meetings/candidates/:id/accept   body AcceptCandidateRequest → 200 AcceptCandidateResponse
POST   /meetings/candidates/:id/discard  body { reason?: string | null } → 200 { candidate: MeetingCandidate }
```

```ts
interface CreateMeetingRequest {
  title: string;                       // 1..200
  heldAt: string;                      // ISO
  durationMin?: number | null;         // 1..1440
  attendees: MeetingAttendee[];        // { name, email | null }, 0..100
  /** null/ausente = resolver por dominio de correo de los asistentes (project.client_email_domains). */
  projectId?: string | null;
  format: ManualTranscriptFormat;      // 'texto' | 'vtt' | 'srt' | 'granola_resumen'
  /** El texto. Los archivos .txt/.vtt/.srt los lee el front (FileReader) y manda su contenido. */
  content: string;                     // 1..MEETING_TRANSCRIPT_MAX_CHARS tras normalizar
  fileName?: string | null;
}

interface AcceptCandidateRequest {
  /** 'crear' = issue nuevo en Linear; 'comentar' = comentario en el duplicado. Default: 'comentar' si la
   *  candidata tiene duplicate, 'crear' si no. 'comentar' sin duplicate → 422. */
  mode?: 'crear' | 'comentar';
  title?: string;
  description?: string | null;
  assigneeDevId?: string | null;       // default: proposedDev
  priority?: 1 | 2 | 3 | 4 | null;
  estimate?: number | null;
  solutionTypeId?: string | null;
  dueDate?: string | null;
  /** Obligatorio si assigneeDevId ≠ proposedDev (mismo 409 OVERRIDE_REASON_REQUIRED que /ticket). */
  override?: { category: OverrideCategory; note?: string | null };
}
interface AcceptCandidateResponse {
  candidate: MeetingCandidate;
  issue: { linearIssueId: string; identifier: string; url: string; workItemId: string } | null; // mode 'crear'
  comment: { commentId: string; url: string | null; identifier: string } | null;              // mode 'comentar'
  warnings: string[];
}
```

Errores: candidata no `pendiente` → `409 CANDIDATE_DECIDED`; junta sin proyecto al aceptar 'crear' → `422 MEETING_PROJECT_MISSING`.

Pipeline (`meeting.extract`):
1. `meeting.status = 'extrayendo'`.
2. Claude (`config.anthropic.model`) extrae `{ tareas[], compromisos[], decisiones[] }`, cada una con `quote` literal.
3. **Verificación de cita en código**: normalizar texto y cita (minúsculas, sin acentos, espacios colapsados,
   comillas tipográficas → rectas); la cita debe ser substring. Si no: se descarta la candidata (no se guarda).
   `quote_start` = índice en el `transcript` normalizado guardado.
4. `decision` → átomo del brain (`knowledge_atom`, `scope 'project'`, `provenance ['meeting:<id>']`) y candidata
   `status 'guardada'` con `knowledge_atom_id`. No pasan por la bandeja.
5. `tarea`/`compromiso` → Jev con las preguntas q3 existentes (`src/assign/jev-questions.ts`) → `classification`,
   `solution_type_id`, `estimate`, `priority` (de urgencia: urgente→1, no_urgente→3).
6. Dedup: `rpc('search_work_items_hybrid', { p_project_id, p_query: title + ' ' + description, p_embedding, p_limit: 3 })`;
   si `score >= 0.025` (umbral inicial, ajustable) → `duplicate_work_item_id`, `duplicate_score`.
7. Política p2 (`src/assign/policy.ts`) → `proposed_dev_id` + fila `assignment_decision` (`origin 'meeting'`,
   `outcome 'preview'`, `work_item_id null`) → `assignment_decision_id`. Al aceptar con 'crear' la fila pasa a
   `assigned` con el `work_item_id` que devuelve `createIssueFromTicket` (y override si cambió el responsable).
8. `meeting.status = 'lista'`, `extracted_at`, `extraction_model`. Error no reintentable → `status 'error'` + `error`.

### Planes — `/api/dashboard/plans*` y runners — `/api/dashboard/runners*`

Dueño: agente de planes (`src/plans/*`, `src/routes/plans.ts`, `src/routes/runner.ts`).

```
GET  /plans?scope=mine|team|claimable (def mine)&status=<PlanStatus>&devId=<uuid>&projectId=<uuid>
       → 200 { plans: AgentPlanSummary[]; counts: Record<PlanStatus, number> }
GET  /plans/:id                       → 200 { plan: AgentPlanDetail }
POST /plans/:id/approve               body {}                          → 200 { plan: AgentPlanSummary }
POST /plans/:id/request-changes       body { feedback: string }        → 200 { plan: AgentPlanSummary }  (1..4000)
POST /plans/:id/claim                 body { note?: string | null }    → 200 { plan: AgentPlanSummary }
POST /plans/:id/pull                  body {}                          → 200 { plan: AgentPlanSummary; pull: RunnerPullResponse }
POST /plans/:id/release               body {}                          → 200 { plan: AgentPlanSummary }
POST /plans/:id/cancel                body { reason?: string | null }  → 200 { plan: AgentPlanSummary }

GET    /runners                       → 200 { runners: RunnerSummary[] }     (los míos; ?all=1 todos)
POST   /runners                       body { name: string; schedule?: RunnerSchedule; maxConcurrent?: number }
                                      → 201 { runner: RunnerSummary; token: string }   (token SOLO aquí)
PATCH  /runners/:id                   body { name?; schedule?; maxConcurrent? } → 200 { runner: RunnerSummary }
DELETE /runners/:id                   → 200 { runner: RunnerSummary }   (revoca: revoked_at = now())
```

Errores de acciones: transición no permitida (`nextPlanState` devuelve null) → `409 PLAN_CONFLICT`
`details: { status, phase }`; perdió la carrera (update condicional 0 filas) → `409 PLAN_TAKEN`;
`request-changes` sin feedback → 400.

Token de runner: `rozr_` + 32 bytes base64url. Se guarda `token_hash = sha256(token) hex`, `token_prefix = token.slice(0, 12)`.

### Pulso — `/api/dashboard/pulse`

Dueño: agente de Pulso/front (`src/dashboard/pulse.ts`, ruta en `dashboard.ts`, `web/src/pages/Pulse.tsx`).

```
GET /pulse?groupBy=persona|proyecto|cliente (def persona)&weekStart=YYYY-MM-DD (def lunes actual, zona del equipo)
      → 200 PulseResponse
GET /pulse/feed?after=<ISO>&limit=<1..100, def 50>
      → 200 PulseFeedResponse      (items con at > after, del más nuevo al más viejo; para poll cada 20 s)
```

Tipos `PulseResponse`, `PulseKpis`, `PulsePerson`, `PulseHeatCell`, `PulseFeedItem`, `PulseGroup` en
`src/types/roz-v2.ts`. Notas:
- `avatarUrl = avatarFor(dev.github_login)` (`src/dashboard/queries.ts`).
- `state`: `ocupado` si el calendario lo marca busy (`getTeamPresence`), `activo` si hubo commit/evento de plan en
  30 min, `inactivo` si hubo actividad hoy, `fuera` si no.
- `currentIssue`: el issue abierto del dev con `status 'en_progreso'` más reciente (`linear_updated_at`), si no el
  `revision`, si no null.
- `cycle`: del `linear_cycle` de su issue actual; `issuesDone/Total` = sus issues de ese ciclo.
- Commits = trabajo real (no-merge en rama por defecto, cada sha una vez), igual que el resto del dashboard.
- Grupo `cliente`: `key = project.client_email_domains[0]` si existe; si `project.kind = 'client'` sin dominio,
  `key = project.id` con el nombre del proyecto; internos → `key 'interno'`.
- `feed`: commits, ramas, PRs, issues (espejo), eventos de plan (`agent_plan_event`) y juntas. `id = '<tipo>:<id>'`.

---

## (c) API del runner — `/v1/runner/*`

Montada en `app.ts` como `app.route('/v1/runner', runnerRoutes)`. Auth: `Authorization: Bearer <token>` →
`sha256` → `roz.runner` por `token_hash` con `revoked_at is null`; si no → `401 { error: { code: 'RUNNER_UNAUTHORIZED' } }`.
Cada request válida actualiza `runner.last_seen_at`. Con el flag apagado → 409 `LINEAR_SOT_OFF`.
Todos los cuerpos son JSON; tipos en `src/types/roz-v2.ts`.

```
POST /v1/runner/register   body RunnerRegisterRequest   → 200 RunnerRegisterResponse
POST /v1/runner/heartbeat  body RunnerHeartbeatRequest  → 200 RunnerHeartbeatResponse
POST /v1/runner/next-job   body {}                      → 200 RunnerNextJobResponse
POST /v1/runner/progress   body RunnerProgressRequest   → 200 RunnerProgressResponse
POST /v1/runner/pull       body RunnerPullRequest       → 200 RunnerPullResponse
```

- `register`: idempotente; actualiza `name`, `version`, `platform` y, si vienen, `schedule`/`max_concurrent`.
  `mcpUrl = config.dashboard.url + '/mcp'` (el MCP acepta el mismo token de runner, ver Pendientes).
  `heartbeatIntervalMs = RUNNER_HEARTBEAT_INTERVAL_MS`, `pollIntervalMs = 30_000`.
- `heartbeat`: para cada `running[]` con `lease_id` vigente → `heartbeat_at = now()`, `progress`. Devuelve en
  `stop` los que ya no son suyos (lease distinto/null → `lease_perdido`; `cancelado`; dueño cambió → `reasignado`).
  `inSchedule` se calcula con `runner.schedule`.
- `next-job`: fuera de horario → `{ job: null, retryAfterMs: <hasta el inicio del horario> }`. Si no,
  `rpc('agent_plan_next', { p_runner_id, p_max_attempts: PLAN_MAX_ATTEMPTS })`; 0 filas → `{ job: null, retryAfterMs: 30_000 }`.
  Con fila: evento `started`, arma `RunnerJob` (prompt, `allowedTools` = `RUNNER_ALLOWED_TOOLS_PLAN` o
  `_IMPLEMENT` según fase, `maxTurns` 40/120). `branch` = `linear_branch_name ?? <identifier minúsculas>-<slug título, 40>`.
- `progress`: exige `planId` + `leaseId` vigentes (si no → `409 LEASE_LOST`). `kind`:
  - `progress` → `heartbeat_at`, `progress`; evento `progress` (como mucho 1 por minuto por plan).
  - `plan_ready` (exige `planMd`) → `plan_md`, `plan_version + 1`, transición `plan_listo`. Riesgo 0 →
    `continue: true` (mismo lease, fase implementar). Riesgo 1-2 → suelta runner, `continue: false`.
  - `pr_opened` (exige `prNumber`, `prUrl`, `branch`) → transición `pr_abierto`.
  - `failed` (exige `error`) → transición `fallo`, `attempts + 1`, `error`; si `attempts >= PLAN_MAX_ATTEMPTS`
    → `claimable = true`, `claimable_reason 'fallos'`.
  - `released` → transición `liberar` (sin sumar intento).
- `pull`: por `planId` o `identifier`. Transición `jalar` si el plan está `en_cola`/`esperando_aprobacion`;
  si ya está `jalado` por el MISMO dev, es idempotente. Devuelve rama y `planMd` (si no hay plan aún,
  `planMd` = plantilla con título y descripción del issue). El runner crea la rama (worktree) y escribe `PLAN.md`.

El runner (paquete `runner/`) NUNCA habla con Supabase ni con Linear: solo con `/v1/runner/*` y el MCP.

---

## (d) Eventos de outbox nuevos

Se agregan a `OutboxEventType` en `src/events/outbox.ts` (tipo `RozV2OutboxEventType`) y a su `switch`.
Payloads en `src/types/roz-v2.ts`.

| Tipo | Payload | Lo emite | Idempotency key | Lo procesa |
|---|---|---|---|---|
| `linear.webhook` | `LinearWebhookPayload` | `POST /webhooks/linear` | `linear:<deliveryId>` | `handleLinearWebhook` (src/linear) |
| `linear.reconcile` | `LinearReconcilePayload` | cron `/v1/internal/linear-reconcile` (cada 30 min) | `linear-reconcile:<ISO truncado a 30 min>` | `reconcileLinear` |
| `plan.enqueue` | `PlanEnqueuePayload` | espejo (`upsertMirrorFromLinear`) | `plan:<workItemId>:<ownerDevId>:<issue.updatedAt>` | `enqueuePlan` (src/plans) |
| `plan.claimable` | `PlanClaimablePayload` | watchdog | `plan-claimable:<planId>:<claimable_at>` | push al equipo del proyecto (devs con `dev_assignment` en el proyecto; sin proyecto → todos) |
| `plan.reassign_linear` | `PlanReassignLinearPayload` | acción reclamar | `plan-reassign:<planId>:<toDevId>` | `reassignIssue` (src/linear) |
| `meeting.extract` | `MeetingExtractPayload` | `POST /meetings`, `/retry`, `granola.import` | `meeting-extract:<meetingId>:<n intento manual>` | src/meetings |
| `granola.import` | `GranolaImportPayload` | cron `/v1/internal/granola-poll` (cada 5 min) | `granola:<noteId>` | src/meetings: crea `meeting` (`source 'granola'`, `transcript_format 'granola_api'`) y emite `meeting.extract` |

Webhook de Linear (`POST /webhooks/linear`, en `src/routes/webhooks.ts`): leer cuerpo crudo →
`verifyLinearSignature(raw, header('linear-signature'), config.linear.webhookSecret)` (401 si falla) →
`JSON.parse` → `isFreshLinearWebhook(body.webhookTimestamp)` (401 si viejo) → `emit('linear.webhook', …)` →
`200 { ok: true }`. Con el flag apagado: `200 { ok: true, skipped: 'flag' }` sin emitir (Linear no reintenta en bucle).

`handleLinearWebhook`: para `type 'Issue'` relee el issue completo con `getIssue(data.id)` (el webhook no
trae ciclo ni etiquetas completas) y llama `upsertMirrorFromLinear(issue, { source: 'webhook' })`;
`action 'remove'` → `retireMirror`. `IssueLabel`, `User`, `Project` → `syncLinearLinks()`. Lo demás se ignora.

Cron nuevos (en `src/routes/internal.ts` + `vercel.json`), todos con `requireCron` y `recordJobRun`:

| Ruta | Horario | Qué hace |
|---|---|---|
| `/v1/internal/linear-reconcile` | `*/30 * * * *` | `emit('linear.reconcile', { since: null, reason: 'cron', refreshLinks: true })` |
| `/v1/internal/granola-poll` | `*/5 * * * *` | sin `GRANOLA_API_KEY` → skip; lista notas nuevas desde el cursor y emite `granola.import` por nota |
| `/v1/internal/plan-watchdog` | `*/5 * * * *` | ver (e) |

---

## (e) Estados del plan y transiciones

Fuente única: `nextPlanState(plan, transición)` en `src/types/roz-v2.ts` (probada en `test/plan-states.test.ts`).
Las rutas NUNCA deciden el estado nuevo a mano: llaman `nextPlanState`, y si devuelve null → 409 `PLAN_CONFLICT`.

```
estados: en_cola → planeando → esperando_aprobacion → implementando → pr_abierto → hecho
         + jalado (una persona implementa)  + cancelado
fase:    planear | implementar  (qué hace el runner al tomarlo desde en_cola)
riesgo:  0 planea e implementa hasta PR · 1 planea y espera aprobación · 2 solo plan
```

| Transición | Desde | A | Quién |
|---|---|---|---|
| `tomar` | en_cola | planeando (fase planear) / implementando (fase implementar; nunca con riesgo 2) | runner (`agent_plan_next`) |
| `plan_listo` | planeando | riesgo 0: implementando (sigue el mismo lease) · riesgo 1-2: esperando_aprobacion | runner |
| `pr_abierto` | implementando | pr_abierto | runner |
| `fallo` / `liberar` / `watchdog` | planeando, implementando | en_cola (misma fase; `fallo` suma intento) | runner / watchdog |
| `aprobar` | esperando_aprobacion (solo riesgo 1) | en_cola, fase implementar | persona |
| `pedir_cambios` | esperando_aprobacion | en_cola, fase planear, `feedback` | persona |
| `reclamar` | en_cola, esperando_aprobacion | mismo estado, `owner_dev_id = yo` | cualquier dev ≠ dueño |
| `jalar` | en_cola, esperando_aprobacion | jalado (`pulled_by_dev_id`) | cualquier dev |
| `soltar` | en_cola, esperando_aprobacion (dueño) · jalado (quien jaló) | mismo estado + `claimable` · jalado → en_cola fase planear + `claimable` | persona |
| `cancelar` | cualquiera no terminal salvo jalado | cancelado | persona |
| `issue_cerrado` | cualquiera no terminal (incl. jalado) | hecho | espejo (Linear completed) / PR mergeada |
| `issue_cancelado` | cualquiera no terminal salvo jalado | cancelado | espejo (Linear canceled) |

Si la transición tiene `releasesRunner: true`: `runner_id`, `lease_id`, `heartbeat_at` → null (el check
`agent_plan_running_check` lo exige). Cada transición inserta un `agent_plan_event` (`from_status`, `to_status`,
`actor_dev_id` o `runner_id`, `data`). Al terminar (`hecho`/`cancelado`/`jalado`) → `finished_at = now()`.

**Atomicidad.** Toda transición es un update condicional:
`update agent_plan set … where id = :id and status = :statusLeído and updated_at = :updatedAtLeído returning *`.
0 filas → `409 PLAN_TAKEN`. `reclamar` además condiciona `owner_dev_id = :dueñoLeído`; tras ganar:
1. `assignment_decision`: si la última decisión del `work_item` es `assigned` sin override → se le escribe el override
   (`overridden_at`, `overridden_by = user.id`, `override_dev_id = yo`, `override_category = CLAIM_OVERRIDE_CATEGORY`,
   `override_note = note`). Si no hay → se inserta una fila `origin 'manual'`, `outcome 'assigned'`,
   `policy_version POLICY_VERSION`, `chosen_dev_id = dueñoAnterior`, `decided_at = now()` + el override.
2. `emit('plan.reassign_linear', …)` → cambia el asignado en Linear. Su webhook llega como `plan.enqueue` del mismo
   dueño → no-op (ya es el dueño).

**Encolar (`plan.enqueue`).** Si hay plan vivo del `work_item` (índice `uq_roz_agent_plan_live`):
mismo dueño → no-op; otro dueño y no corriendo → cambia `owner_dev_id` (evento `claimed` con actor null,
`data.reason 'reasignado_en_linear'`); corriendo → el heartbeat devuelve `stop: reasignado`, se reencola al nuevo
dueño. Sin plan vivo → insert con `risk`/`risk_reasons` por reglas (abajo), `repo` = primer `project_repo` del
proyecto, `identifier`, evento `enqueued`. Un 23505 en el insert = otro tick ganó → no-op.

**Riesgo por reglas** (sin IA; el máximo gana): texto del issue (título + descripción + etiquetas) y rutas que
mencione, contra: `ruta_sensible` (`.env`, `secrets`, `infra/`, `.github/workflows`, `vercel.json`) → 1;
`migracion` (`migrations/`, `migración`, `schema`, `alter table`) → 2; `auth_rls` (`auth`, `rls`, `policy`,
`login`, `token`, `permis`) → 2; `pagos` (`pago`, `payment`, `stripe`, `factura`, `billing`) → 2;
`cliente_sla` (`project.client_sla`) → 1; `ruta_proyecto` (`project.agent_risk_paths`) → 1. Sin reglas → 0.

**Watchdog (cada 5 min).**
1. `planeando`/`implementando` con `heartbeat_at < now() - PLAN_HEARTBEAT_STALE_MS` → transición `watchdog`
   (vuelve a `en_cola` con lo escrito: `plan_md`, `progress`, `branch` se conservan), evento `requeued`.
2. `en_cola`/`esperando_aprobacion` no reclamables cuyo dueño:
   - está fuera de línea > `PLAN_OWNER_OFFLINE_MS` DENTRO de su horario (ningún runner suyo con `last_seen_at` reciente
     y ahora está dentro del `schedule` de alguno) → `claimable_reason 'dueño_fuera_de_linea'`; o
   - el plan lleva > `PLAN_QUEUE_STALE_BUSINESS_DAYS` día hábil en cola (`businessDaysBetween` de `src/assign/policy.ts`)
     → `claimable_reason 'mucho_en_cola'`.

   → `claimable = true`, `claimable_at = now()`, evento `claimable`, `emit('plan.claimable', …)`.

---

## Pendientes conocidos (decidir al integrar)

- **Puente con Ops**: los triggers de 0021 propagan cada escritura de `work_item` a `public.tasks`. Con el espejo de
  Linear eso duplica el trabajo en Ops. Opción: que el espejo escriba con `source = 'linear'` y que el trigger lo ignore
  (requiere migración nueva que toque `roz.on_work_item_change`).
- **MCP con token de runner**: `/mcp` hoy solo acepta `ROZ_MCP_TOKEN`. El runner configura Claude Code con su propio
  token; hay que aceptar también tokens de runner vigentes (mismo hash) en `src/routes/mcp.ts`.
- **Granola**: la API pública y su forma de autenticación se fijan en `src/adapters/granola.ts` (mockeada en tests).

## Integración (estado del cableado)

- **Rutas**: `POST /webhooks/linear` (app.ts), `/v1/runner/*` (app.ts, auth propia por Bearer `rozr_…`),
  `/api/dashboard/{pulse,roz-v2,meetings,plans,runners}` (dashboard.ts, detrás de `requireDashboardAuth`).
- **Outbox**: los 7 tipos de `RozV2OutboxEventType` forman parte de `OutboxEventType` y se despachan con import
  dinámico (los módulos v2 emiten al outbox; un import estático formaría ciclo).
- **Crons** (vercel.json + internal.ts): `linear-reconcile` (*/30), `granola-poll` (*/5), `plan-watchdog` (*/5). Los
  tres responden `skipped: 'flag'` con el flag apagado. `ops-bridge` se salta (`skipped: 'linear_sot'`) con el flag
  encendido; apagado corre como siempre.
- **Escrituras de tareas**: `assertTasksWritable()` al inicio de `POST/PATCH/DELETE /tickets*`, auto-assign,
  comentarios y adjuntos (incluye crear tarea desde el chat, que va por `POST /tickets`). `/ticket` y
  `confirm_proposal` crean en Linear con el flag.
- **Señales de código**: `task-events.ts` ya no mueve `work_item.status` con el flag (solo liga rama/PR y
  atribución); `completeLinkedIssue` (PR mergeada) tampoco cierra: lo hace Linear y llega por el espejo. Las
  referencias de ramas/commits/PR pasan por `resolveReference` (src/linear/legacy.ts) → un `ROZ-123` viejo lleva a su
  issue vigente. Con el flag apagado `resolveReference` devuelve lo mismo sin consultar.
- **MCP con token de runner** (resuelto): `/mcp` acepta `ROZ_MCP_TOKEN` (todas las herramientas) o un token de
  runner vigente, que solo ve `get_plan`, `get_decisions`, `report_progress`, `get_project_context` y `list_projects`.
- Exportaciones extra de `src/linear`: `reassignFromEvent`, `reconcileFromEvent`, `linearWebhookFromEvent`,
  `scheduleLinearReconcile`, `labelForSolutionType`, `solutionTypeForLabels`, `stateForStatus`,
  `findWorkItemIdByIdentifier`, `currentIdentifier`, `resolveReference`, `transitionLivePlan`,
  `recordLinearReassignment`; opción `effects?: boolean` de `upsertMirrorFromLinear`; `stateId?` en
  `CreateIssueFromTicketInput`. Ventana de reconciliación: último `linear_synced_at` menos 2 h de traslape.
