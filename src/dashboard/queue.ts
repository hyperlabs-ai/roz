// Consola de la cola de procesamiento: convierte `roz.outbox_event` en algo legible para el
// dashboard. Hasta ahora el pipeline era invisible — un commit entraba, se procesaba en silencio
// y nadie veía qué estaba por atribuirse ni qué había fallado.
//
// Dos consumidores, dos formas:
//   · queuePulse()  → ligero, para el indicador del header (se sondea siempre, en toda pantalla).
//   · listQueue()   → completo, para la sección (cola + historial acreditado + latido del cron).
//
// La distinción que da sentido a todo esto: cada evento tiene DOS personas.
//   · `actor` — quién lo originó en GitHub. Viene en el payload desde que el evento nace, así que
//     está disponible MIENTRAS sigue pendiente. Es lo que permite decir "commit de Sebas" antes de
//     que el drain haya corrido.
//   · `dev`   — a quién se le ACREDITÓ el trabajo. Sale de la reconciliación (roz.commit.dev_id) y
//     solo existe una vez resuelto. Puede diferir del actor (p.ej. un squash-merge).
// Cuando difieren, la UI lo dice. Ese hueco entre "quién lo hizo" y "a quién se le contó" es
// justamente el punto ciego que motivó esta vista.
import { db } from '../db/supabase.js';
import { avatarFor } from './queries.js';
import { lastJobRun } from '../events/job-run.js';
import { MAX_ATTEMPTS } from '../events/outbox.js';

// ---- Tipos (espejados a mano en web/src/lib/api.ts — los nombres deben calzar EXACTO) ----

export type QueueStatus = 'pending' | 'processing' | 'done' | 'failed' | 'dead';
export type QueuePhase = 'inflight' | 'resolved' | 'failed';
export type QueueHealth = 'idle' | 'working' | 'delayed' | 'failing' | 'unknown';

export interface QueuePerson {
  login: string | null;
  name: string;
  avatarUrl: string | null;
  /** Solo si el login está mapeado a un roz.dev. null = persona de GitHub sin alta en roz. */
  devId: string | null;
}

export interface QueueTask {
  identifier: string;
  title: string | null;
  url: string | null;
}

export interface QueueEvent {
  id: string;
  type: string;
  status: string;
  phase: QueuePhase;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  createdAt: string;
  /** updated_at cuando el estado ya es terminal. null mientras sigue en vuelo. */
  resolvedAt: string | null;
  nextAttemptAt: string | null;
  /** createdAt → resolvedAt: espera en cola + ejecución. */
  latencyMs: number | null;
  // Contexto derivado del payload
  repo: string | null;
  sha: string | null;
  prNumber: number | null;
  page: number | null;
  subject: string | null;
  url: string | null;
  projectName: string | null;
  // Las dos personas
  actor: QueuePerson | null;
  dev: QueuePerson | null;
  // Resultado
  additions: number | null;
  deletions: number | null;
  task: QueueTask | null;
}

export interface QueueCounts {
  pending: number;
  processing: number;
  failed: number;
  dead: number;
  ready: number;
  scheduled: number;
  stuck: number;
  doneLastHour: number;
}

export interface QueueBeat {
  minute: string;
  done: number;
  failed: number;
}

export interface QueuePulse {
  health: QueueHealth;
  counts: QueueCounts;
  lastDrainAt: string | null;
  drainStale: boolean;
  oldestPendingSec: number | null;
  /** Hasta 5 eventos en vuelo, ya con actor, para nombrar al autor en el indicador del header. */
  inflight: QueueEvent[];
}

export interface QueueResponse extends QueuePulse {
  beat: QueueBeat[];
  events: QueueEvent[];
  truncated: boolean;
}

// ---- Constantes ----

const EVENT_COLS = 'id, type, payload, status, attempts, next_attempt_at, error, created_at, updated_at';
/** Segundos sin drenar tras los cuales la cola se declara retrasada (el cron corre cada minuto). */
const DRAIN_STALE_SEC = 180;
/** Minutos del latido del cron que muestra la sección. */
const BEAT_MINUTES = 30;

interface OutboxRow {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
  status: string;
  attempts: number | null;
  next_attempt_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface CommitRow {
  repo: string;
  sha: string;
  dev_id: string | null;
  author_login: string | null;
  message: string | null;
  url: string | null;
  additions: number | null;
  deletions: number | null;
}

interface TaskRow {
  id: string;
  identifier: string;
  name: string | null;
  url: string | null;
  repo: string | null;
  pr_number: number | null;
  project_id: string | null;
  assignee_dev_id: string | null;
}

interface DevRow {
  id: string;
  name: string;
  github_login: string | null;
}

/** Índices ya resueltos que `describeEvent` consulta. Se pasan explícitos para que sea pura. */
export interface QueueLookups {
  /** clave `repo::sha`, en minúsculas (ver key2) */
  commits: Map<string, CommitRow>;
  /** clave `identifier` y también `repo::#prNumber` */
  tasks: Map<string, TaskRow>;
  devs: Map<string, DevRow>;
  devsByLogin: Map<string, DevRow>;
  projects: Map<string, string>;
  /** repo (minúsculas) → nombre de proyecto, para eventos que no llegan a una tarea. */
  reposToProject: Map<string, string>;
}

const emptyLookups = (): QueueLookups => ({
  commits: new Map(),
  tasks: new Map(),
  devs: new Map(),
  devsByLogin: new Map(),
  projects: new Map(),
  reposToProject: new Map(),
});

// ---- Helpers puros ----

const key2 = (a: string, b: string) => `${a.toLowerCase()}::${b.toLowerCase()}`;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function phaseOf(status: string): QueuePhase {
  if (status === 'done') return 'resolved';
  if (status === 'failed' || status === 'dead') return 'failed';
  return 'inflight';
}

/** Persona a partir de un dev de roz (tiene nombre real y, casi siempre, login de GitHub). */
function personFromDev(dev: DevRow | undefined): QueuePerson | null {
  if (!dev) return null;
  return { login: dev.github_login, name: dev.name, avatarUrl: avatarFor(dev.github_login), devId: dev.id };
}

/**
 * Persona a partir de un login de GitHub suelto. Si ese login está dado de alta como dev de roz se
 * prefiere el registro (nombre real); si no, se muestra igual — no saber quién es en roz no es
 * razón para no poder decir de quién es el commit.
 */
function personFromLogin(login: string | null, fallbackName: string | null, l: QueueLookups): QueuePerson | null {
  if (!login) return fallbackName ? { login: null, name: fallbackName, avatarUrl: null, devId: null } : null;
  const dev = l.devsByLogin.get(login.toLowerCase());
  if (dev) return personFromDev(dev);
  return { login, name: fallbackName ?? login, avatarUrl: avatarFor(login), devId: null };
}

/**
 * Traduce una fila cruda del outbox a algo mostrable. Función PURA (todas las búsquedas entran por
 * `lookups`): es la superficie con más riesgo de bug —15 tipos × con/sin enriquecimiento— y así se
 * puede probar entera sin base de datos.
 *
 * Nunca lanza ni devuelve huecos: un tipo desconocido o un payload viejo sin `actor` degradan a
 * mostrar el repo como sujeto, jamás a "undefined".
 */
export function describeEvent(row: OutboxRow, lookups: QueueLookups = emptyLookups()): QueueEvent {
  const p = row.payload ?? {};
  const status = row.status;
  const phase = phaseOf(status);
  const terminal = status === 'done' || status === 'dead' || status === 'failed';

  const repo = str(p.repo) ?? str(p.to) ?? null;
  const sha = str(p.sha);
  const prNumber = num(p.number);
  const identifier = str(p.identifier);
  const page = num(p.page);

  // Actor del payload (webhook enriquecido). Los eventos encolados antes de ese cambio no lo
  // traen: el resto de la función tolera `null` en todos los caminos.
  const rawActor = (p.actor ?? null) as { login?: string; name?: string | null } | null;
  const actor = personFromLogin(rawActor?.login ?? null, rawActor?.name ?? null, lookups);

  let subject = str(p.subject);
  let url: string | null = null;
  let dev: QueuePerson | null = null;
  let additions: number | null = null;
  let deletions: number | null = null;
  let task: QueueTask | null = null;
  let projectName: string | null = repo ? lookups.reposToProject.get(repo.toLowerCase()) ?? null : null;

  // --- Enriquecimiento con el RESULTADO ya persistido, si existe ---
  if (sha && repo) {
    const c = lookups.commits.get(key2(repo, sha));
    if (c) {
      subject = subject ?? (c.message ? c.message.split('\n')[0]!.trim() || null : null);
      url = c.url;
      additions = c.additions;
      deletions = c.deletions;
      dev = personFromDev(c.dev_id ? lookups.devs.get(c.dev_id) : undefined)
        ?? personFromLogin(c.author_login, null, lookups);
    }
  }

  const taskRow =
    (identifier ? lookups.tasks.get(identifier) : undefined) ??
    (repo && prNumber != null ? lookups.tasks.get(`${repo.toLowerCase()}::#${prNumber}`) : undefined);
  if (taskRow) {
    task = { identifier: taskRow.identifier, title: taskRow.name, url: taskRow.url };
    subject = subject ?? taskRow.name;
    url = url ?? taskRow.url;
    projectName = projectName ?? (taskRow.project_id ? lookups.projects.get(taskRow.project_id) ?? null : null);
    dev = dev ?? personFromDev(taskRow.assignee_dev_id ? lookups.devs.get(taskRow.assignee_dev_id) : undefined);
  }

  // change.documented no apunta a un commit ni a una tarea: su sujeto ES el dev notificado.
  const payloadDevId = str(p.devId);
  if (!dev && payloadDevId) dev = personFromDev(lookups.devs.get(payloadDevId));

  const resolvedAt = terminal ? row.updated_at : null;
  const latencyMs = resolvedAt ? Date.parse(resolvedAt) - Date.parse(row.created_at) : null;

  return {
    id: row.id,
    type: row.type,
    status,
    phase,
    attempts: row.attempts ?? 0,
    maxAttempts: MAX_ATTEMPTS,
    error: row.error,
    createdAt: row.created_at,
    resolvedAt,
    nextAttemptAt: row.next_attempt_at,
    latencyMs: latencyMs != null && latencyMs >= 0 ? latencyMs : null,
    repo,
    sha: sha ? sha.slice(0, 8) : null,
    prNumber,
    page,
    subject,
    url,
    projectName,
    actor,
    dev,
    additions,
    deletions,
    task,
  };
}

// ---- Carga de los índices de enriquecimiento ----

/**
 * Resuelve, en lotes, todo lo que las filas necesitan. Una query por bucket y solo si el bucket
 * tiene contenido: con la cola al día (el caso normal) casi todas se omiten.
 */
async function loadLookups(rows: OutboxRow[]): Promise<QueueLookups> {
  const l = emptyLookups();
  if (!rows.length) return l;

  const repos = new Set<string>();
  const shas = new Set<string>();
  const prNumbers = new Set<number>();
  const identifiers = new Set<string>();

  for (const r of rows) {
    const p = r.payload ?? {};
    const repo = str(p.repo) ?? str(p.to);
    if (repo) repos.add(repo.toLowerCase());
    const sha = str(p.sha);
    if (sha) shas.add(sha);
    const n = num(p.number);
    if (n != null) prNumbers.add(n);
    const id = str(p.identifier);
    if (id) identifiers.add(id);
  }

  const supabase = db();

  // OJO con los dos `.in` encadenados: PostgREST los traduce a un AND de dos IN, o sea el producto
  // cartesiano repo × sha. Trae combinaciones que nadie pidió, pero es correcto porque el índice
  // se construye por clave exacta y solo se consultan las reales. La alternativa (un or(and(...))
  // por par) es ilegible y además no usaría bien el índice.
  //
  // El `.in('repo')` NO es opcional: el índice es (repo, sha) con repo de guía, así que filtrar
  // solo por sha degradaría a seq-scan sobre roz.commit.
  const [commitsRes, tasksByIdRes, tasksByPrRes, devsRes, projectsRes, projectReposRes] = await Promise.all([
    repos.size && shas.size
      ? supabase
          .from('commit')
          .select('repo, sha, dev_id, author_login, message, url, additions, deletions')
          .in('repo', [...repos])
          .in('sha', [...shas])
      : null,
    identifiers.size
      ? supabase
          .from('work_item')
          .select('id, identifier, name, url, repo, pr_number, project_id, assignee_dev_id')
          .in('identifier', [...identifiers])
      : null,
    repos.size && prNumbers.size
      ? supabase
          .from('work_item')
          .select('id, identifier, name, url, repo, pr_number, project_id, assignee_dev_id')
          .in('repo', [...repos])
          .in('pr_number', [...prNumbers])
      : null,
    supabase.from('dev').select('id, name, github_login'),
    supabase.from('project').select('id, name'),
    repos.size ? supabase.from('project_repo').select('repo, project_id').in('repo', [...repos]) : null,
  ]);

  for (const c of (commitsRes?.data ?? []) as CommitRow[]) l.commits.set(key2(c.repo, c.sha), c);

  for (const t of (tasksByIdRes?.data ?? []) as TaskRow[]) l.tasks.set(t.identifier, t);
  for (const t of (tasksByPrRes?.data ?? []) as TaskRow[]) {
    if (t.repo && t.pr_number != null) l.tasks.set(`${t.repo.toLowerCase()}::#${t.pr_number}`, t);
  }

  for (const d of (devsRes.data ?? []) as DevRow[]) {
    l.devs.set(d.id, d);
    if (d.github_login) l.devsByLogin.set(d.github_login.toLowerCase(), d);
  }

  for (const p of (projectsRes.data ?? []) as { id: string; name: string }[]) l.projects.set(p.id, p.name);

  for (const pr of (projectReposRes?.data ?? []) as { repo: string; project_id: string | null }[]) {
    const name = pr.project_id ? l.projects.get(pr.project_id) : null;
    if (name) l.reposToProject.set(pr.repo.toLowerCase(), name);
  }

  return l;
}

// ---- Salud ----

interface PulseRow {
  pending: number; processing: number; failed: number; dead: number;
  ready: number; scheduled: number; stuck: number;
  oldestReadyAt: string | null;
  doneWindow: number; deadWindow: number;
  drainLastRunAt: string | null;
}

const ZERO_PULSE: PulseRow = {
  pending: 0, processing: 0, failed: 0, dead: 0, ready: 0, scheduled: 0, stuck: 0,
  oldestReadyAt: null, doneWindow: 0, deadWindow: 0, drainLastRunAt: null,
};

function healthOf(p: PulseRow, oldestPendingSec: number | null, drainStale: boolean): QueueHealth {
  if (p.dead > 0) return 'failing';
  // El drain caído importa MÁS que la cola vacía: sin esto, un cron muerto se vería como "al día".
  if (drainStale || (oldestPendingSec != null && oldestPendingSec > DRAIN_STALE_SEC) || p.stuck > 0) return 'delayed';
  if (p.pending + p.processing > 0) return 'working';
  return 'idle';
}

/** Toda la salud en un round-trip (la vista se sondea cada pocos segundos). */
async function loadPulse(): Promise<{ pulse: PulseRow; lastDrainAt: string | null; drainStale: boolean }> {
  const [rpc, drain] = await Promise.all([
    db().rpc('outbox_pulse', { p_window_sec: 3600 }),
    lastJobRun('drain'),
  ]);
  const pulse = { ...ZERO_PULSE, ...((rpc.data as Partial<PulseRow> | null) ?? {}) };
  // Se prefiere job_run (registra CADA corrida, incluso las que no procesaron nada) sobre el
  // último `done`, que con la cola vacía llevaría horas sin moverse y fingiría un cron muerto.
  const lastDrainAt = drain?.lastRunAt ?? pulse.drainLastRunAt ?? null;
  const drainStale = lastDrainAt ? Date.now() - Date.parse(lastDrainAt) > DRAIN_STALE_SEC * 1000 : false;
  return { pulse, lastDrainAt, drainStale };
}

function countsOf(p: PulseRow): QueueCounts {
  return {
    pending: p.pending,
    processing: p.processing,
    failed: p.failed,
    dead: p.dead,
    ready: p.ready,
    scheduled: p.scheduled,
    stuck: p.stuck,
    doneLastHour: p.doneWindow,
  };
}

// ---- API pública ----

/** Sondeo ligero: contadores + lo que está en vuelo. Alimenta el indicador del header. */
export async function queuePulse(): Promise<QueuePulse> {
  const [{ pulse, lastDrainAt, drainStale }, inflightRes] = await Promise.all([
    loadPulse(),
    db()
      .from('outbox_event')
      .select(EVENT_COLS)
      .in('status', ['processing', 'pending'])
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  const rows = (inflightRes.data ?? []) as OutboxRow[];
  const lookups = await loadLookups(rows);
  const oldestPendingSec = pulse.oldestReadyAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(pulse.oldestReadyAt)) / 1000))
    : null;

  return {
    health: healthOf(pulse, oldestPendingSec, drainStale),
    counts: countsOf(pulse),
    lastDrainAt,
    drainStale,
    oldestPendingSec,
    inflight: rows.map((r) => describeEvent(r, lookups)),
  };
}

/** Agrupa por minuto los eventos resueltos de la última media hora: el "latido" del cron. */
function buildBeat(rows: { status: string; updated_at: string }[]): QueueBeat[] {
  const buckets = new Map<string, { done: number; failed: number }>();
  const now = Date.now();
  const minuteKey = (ms: number) => new Date(Math.floor(ms / 60000) * 60000).toISOString();

  for (let i = BEAT_MINUTES - 1; i >= 0; i--) buckets.set(minuteKey(now - i * 60000), { done: 0, failed: 0 });

  for (const r of rows) {
    const k = minuteKey(Date.parse(r.updated_at));
    const b = buckets.get(k);
    if (!b) continue; // fuera de la ventana
    if (r.status === 'done') b.done++;
    else b.failed++;
  }

  return [...buckets.entries()].map(([minute, v]) => ({ minute, ...v }));
}

/** Snapshot completo para la sección: cola viva, muertos, historial acreditado y latido. */
export async function listQueue(opts: { limit?: number } = {}): Promise<QueueResponse> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 40));
  const beatSince = new Date(Date.now() - BEAT_MINUTES * 60000).toISOString();

  const [{ pulse, lastDrainAt, drainStale }, liveRes, deadRes, doneRes, beatRes] = await Promise.all([
    loadPulse(),
    // Cola viva, en el orden en que se va a ejecutar.
    db()
      .from('outbox_event')
      .select(EVENT_COLS)
      .in('status', ['processing', 'pending', 'failed'])
      .order('next_attempt_at', { ascending: true })
      .limit(60),
    // Los muertos van en su PROPIA consulta: bajo un limit compartido con la cola viva, un backlog
    // de muertos viejos taparía lo que está pasando ahora.
    db()
      .from('outbox_event')
      .select(EVENT_COLS)
      .eq('status', 'dead')
      .order('created_at', { ascending: false })
      .limit(20),
    // Historial: lo ya resuelto, que es lo que hace que la vista tenga algo que contar cuando la
    // cola está vacía (o sea, casi siempre).
    db()
      .from('outbox_event')
      .select(EVENT_COLS)
      .eq('status', 'done')
      .order('updated_at', { ascending: false })
      .limit(limit),
    db()
      .from('outbox_event')
      .select('status, updated_at')
      .in('status', ['done', 'dead'])
      .gte('updated_at', beatSince)
      .limit(1000),
  ]);

  const live = (liveRes.data ?? []) as OutboxRow[];
  const dead = (deadRes.data ?? []) as OutboxRow[];
  const done = (doneRes.data ?? []) as OutboxRow[];

  // Un solo lote de enriquecimiento para las tres listas: los buckets se comparten.
  const all = [...live, ...dead, ...done];
  const lookups = await loadLookups(all);

  const inflight = live.filter((r) => r.status === 'processing' || r.status === 'pending');
  const oldestPendingSec = pulse.oldestReadyAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(pulse.oldestReadyAt)) / 1000))
    : null;

  return {
    health: healthOf(pulse, oldestPendingSec, drainStale),
    counts: countsOf(pulse),
    lastDrainAt,
    drainStale,
    oldestPendingSec,
    inflight: inflight.map((r) => describeEvent(r, lookups)),
    beat: buildBeat((beatRes.data ?? []) as { status: string; updated_at: string }[]),
    // `events` mezcla lo que sigue reintentándose con lo ya resuelto, más reciente primero: es el
    // stream que lee el usuario. Lo en vuelo va aparte (arriba) para no depender de este orden.
    events: [...live.filter((r) => r.status === 'failed'), ...dead, ...done]
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .map((r) => describeEvent(r, lookups)),
    truncated: done.length >= limit,
  };
}

/**
 * Revive un evento muerto (o fuerza el reintento de uno con backoff largo).
 *
 * Ojo: esto reencola el EVENTO, no deshace la idempotencia fina. Si el efecto ya reclamó su llave
 * en `roz.idempotency_key` vía claimOnce(), el reintento la verá ocupada y se saltará el trabajo.
 * Sirve para lo que falló ANTES de ese claim, y para los efectos que liberan con releaseOnce().
 */
export async function retryQueueEvent(id: string): Promise<{ id: string; status: string } | null> {
  const now = new Date().toISOString();
  const { data } = await db()
    .from('outbox_event')
    .update({ status: 'failed', attempts: 0, error: null, next_attempt_at: now, updated_at: now })
    .eq('id', id)
    .in('status', ['dead', 'failed']) // nunca pisar uno que está en processing o ya resuelto
    .select('id, status')
    .maybeSingle();
  return (data as { id: string; status: string } | null) ?? null;
}
