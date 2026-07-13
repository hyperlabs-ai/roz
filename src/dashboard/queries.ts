// Consultas de agregación para el dashboard de visibilidad de ingeniería. Lee el schema `roz`
// con el service_role (la autorización ya la hizo el middleware de auth). Los volúmenes son
// pequeños (equipo de ~10), así que se agrega en JS en vez de meter funciones SQL: más simple
// de mantener y sin migraciones extra. Todo es time-series filtrable por período; la comparación
// es EXPLÍCITA (el front manda el rango a comparar, o ninguno) → soporta vs período anterior,
// vs año pasado, o sin comparación, sin lógica especial en el backend.
import { db } from '../db/supabase.js';
import { embed } from '../adapters/embeddings.js';
import { slugKey } from '../projects/resolve.js';

export interface Period {
  from: string; // ISO
  to: string; // ISO
}

/** Período anterior del mismo largo, contiguo hacia atrás (default de comparación). */
export function previousPeriod(p: Period): Period {
  const from = new Date(p.from).getTime();
  const to = new Date(p.to).getTime();
  const span = to - from;
  return { from: new Date(from - span).toISOString(), to: p.from };
}

/** Período por defecto: mes calendario actual (del día 1 a ahora). */
export function currentMonthPeriod(): Period {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: first.toISOString(), to: now.toISOString() };
}

export interface Metric {
  value: number;
  compare: number | null; // valor del período de comparación; null = sin comparación
  changePct: number | null;
  direction: 'up' | 'down' | 'flat' | 'none';
}

function metric(value: number, compare: number | null): Metric {
  if (compare === null) return { value, compare: null, changePct: null, direction: 'none' };
  const changePct = compare === 0 ? (value > 0 ? 100 : 0) : Math.round(((value - compare) / compare) * 100);
  const direction = value > compare ? 'up' : value < compare ? 'down' : 'flat';
  return { value, compare, changePct, direction };
}

const PRIORITY_WEIGHT: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 };
const CLOSED_STATES = ['completed', 'done', 'canceled'];

function avatarFor(login: string | null): string | null {
  return login ? `https://github.com/${login}.png?size=96` : null;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function hoursBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
}

function cycleTime(items: WorkItemRow[]): number {
  const durs = items.filter((w) => w.started_at && w.completed_at).map((w) => hoursBetween(w.started_at!, w.completed_at!));
  return durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0;
}

// ---- Lectores base (una sola pasada, se reparten en JS) ----

interface CommitRow {
  sha: string;
  repo: string;
  project_id: string | null;
  dev_id: string | null;
  author_login: string | null;
  message: string | null;
  url: string | null;
  additions: number | null;
  deletions: number | null;
  committed_at: string | null;
}

const COMMIT_COLS = 'sha, repo, project_id, dev_id, author_login, message, url, additions, deletions, committed_at';

async function commitsInRange(from: string, to: string, opts?: { devId?: string; projectId?: string }): Promise<CommitRow[]> {
  let q = db().from('commit').select(COMMIT_COLS).gte('committed_at', from).lt('committed_at', to);
  if (opts?.devId) q = q.eq('dev_id', opts.devId);
  if (opts?.projectId) q = q.eq('project_id', opts.projectId);
  const { data } = await q;
  return (data ?? []) as unknown as CommitRow[];
}

interface WorkItemRow {
  id: string;
  identifier: string;
  title: string;
  state: string;
  priority: string | null;
  project_id: string | null;
  assignee_dev_id: string | null;
  url: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
}

const WORK_ITEM_COLS =
  'id, identifier, title, state, priority, project_id, assignee_dev_id, url, started_at, completed_at, updated_at';

async function resolvedInRange(from: string, to: string, opts?: { devId?: string; projectId?: string }): Promise<WorkItemRow[]> {
  let q = db().from('work_item').select(WORK_ITEM_COLS).gte('completed_at', from).lt('completed_at', to);
  if (opts?.devId) q = q.eq('assignee_dev_id', opts.devId);
  if (opts?.projectId) q = q.eq('project_id', opts.projectId);
  const { data } = await q;
  return (data ?? []) as unknown as WorkItemRow[];
}

async function openWorkItems(devId?: string): Promise<WorkItemRow[]> {
  let q = db().from('work_item').select(WORK_ITEM_COLS).not('state', 'in', `(${CLOSED_STATES.join(',')})`);
  if (devId) q = q.eq('assignee_dev_id', devId);
  const { data } = await q;
  return (data ?? []) as unknown as WorkItemRow[];
}

interface DevRow {
  id: string;
  name: string;
  email: string | null;
  github_login: string | null;
  linear_user_id: string | null;
  active: boolean;
  availability: number;
}

async function allDevs(): Promise<DevRow[]> {
  const { data } = await db().from('dev').select('id, name, email, github_login, linear_user_id, active, availability');
  return (data ?? []) as unknown as DevRow[];
}

async function allProjects(): Promise<{ id: string; name: string; key: string; kind: string }[]> {
  const { data } = await db().from('project').select('id, name, key, kind');
  return (data ?? []) as unknown as { id: string; name: string; key: string; kind: string }[];
}

/**
 * Colores fijados por proyecto (roz.project.color). Aparte de allProjects para NO acoplar infra/
 * overview a esta columna, y tolerante: si la migración 0012 aún no se aplicó (columna inexistente),
 * devuelve un mapa vacío y el front cae al color automático en vez de romper.
 */
async function projectColors(): Promise<Map<string, string | null>> {
  const { data, error } = await db().from('project').select('id, color');
  if (error) return new Map();
  return new Map((data as unknown as { id: string; color: string | null }[]).map((r) => [r.id, r.color]));
}

/** Normaliza un repo a full_name "owner/name" (acepta "name", URL de GitHub, o full_name). */
export function normalizeRepo(input: string): string {
  // GitHub trata owner/repo como case-insensitive y preserva solo el casing de visualización; roz
  // guarda y compara en minúsculas para que un webhook "owner/Mind-playground" matchee el repo
  // vinculado "owner/mind-playground" (ver resolveProjectByRepo).
  const r = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
  return r.includes('/') ? r : `hyperlabs-ai/${r}`;
}

/** Vincula un repo a un proyecto (idempotente por repo). Si se conoce el id numérico de GitHub se
 *  sella como ancla inmutable (sobrevive renames/transfers). Devuelve el repo normalizado para que
 *  el caller pueda encolar su backfill de historial. */
export async function addProjectRepo(projectId: string, repo: string, githubId?: number | null): Promise<string> {
  const normalized = normalizeRepo(repo);
  const row: Record<string, unknown> = { project_id: projectId, repo: normalized };
  if (githubId != null) row.github_repo_id = githubId;
  const { error } = await db().from('project_repo').insert(row);
  if (error) throw error;
  return normalized;
}

export async function removeProjectRepo(projectId: string, repo: string) {
  const { error } = await db().from('project_repo').delete().eq('project_id', projectId).eq('repo', repo);
  if (error) throw error;
}

/** Repos (full_name) vinculados a un proyecto. Para el re-sync (backfill forzado de cada uno). */
export async function listProjectRepos(projectId: string): Promise<string[]> {
  const { data } = await db().from('project_repo').select('repo').eq('project_id', projectId);
  return ((data ?? []) as unknown as { repo: string }[]).map((r) => r.repo);
}

export interface RepoSync {
  repo: string;
  status: string; // idle | queued | syncing | done | error
  pages: number;
  commits: number;
  totalPages: number | null;
  error: string | null;
  updatedAt: string | null;
}

export interface ActiveSync extends RepoSync {
  projectId: string | null;
}

/**
 * Sincronizaciones (backfill) activas en TODA la org, para el widget global de progreso: las que
 * están en cola/corriendo, más las recién terminadas (2 min) para alcanzar a mostrar el ✓/error.
 * Ligero (una fila por repo). Tolerante: si la migración 0014 falta, devuelve [].
 */
export async function listActiveSyncs(): Promise<ActiveSync[]> {
  const since = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data, error } = await db()
    .from('project_repo')
    .select('repo, project_id, sync_status, sync_pages, sync_commits, sync_total_pages, sync_error, sync_updated_at')
    .or(`sync_status.in.(queued,syncing),and(sync_status.in.(done,error),sync_updated_at.gte.${since})`);
  if (error) return [];
  return ((data ?? []) as any[]).map((r) => ({
    repo: r.repo,
    projectId: r.project_id ?? null,
    status: r.sync_status ?? 'idle',
    pages: r.sync_pages ?? 0,
    commits: r.sync_commits ?? 0,
    totalPages: r.sync_total_pages ?? null,
    error: r.sync_error ?? null,
    updatedAt: r.sync_updated_at ?? null,
  }));
}

/**
 * Estado de sincronización (backfill) de los repos de un proyecto. Tolerante: si la migración 0014
 * aún no se aplicó (columnas sync_* inexistentes), devuelve [] y el front no muestra badges.
 */
async function projectRepoSync(projectId: string): Promise<RepoSync[]> {
  const { data, error } = await db()
    .from('project_repo')
    .select('repo, sync_status, sync_pages, sync_commits, sync_total_pages, sync_error, sync_updated_at')
    .eq('project_id', projectId);
  if (error) return [];
  return ((data ?? []) as any[]).map((r) => ({
    repo: r.repo,
    status: r.sync_status ?? 'idle',
    pages: r.sync_pages ?? 0,
    commits: r.sync_commits ?? 0,
    totalPages: r.sync_total_pages ?? null,
    error: r.sync_error ?? null,
    updatedAt: r.sync_updated_at ?? null,
  }));
}

export interface ProjectRow {
  id: string;
  name: string;
  key: string;
  kind: string;
  color: string | null;
}

/** Crea un proyecto manual (sin ancla a Linear/HyperOps). La `key` se deriva del nombre si no
 *  se da; queda en MAYÚSCULAS y debe ser única (lo garantiza el unique de la tabla). */
export async function createProject(input: { name: string; key?: string | null; kind?: 'client' | 'internal'; color?: string | null }): Promise<ProjectRow> {
  const name = input.name.trim();
  const key = (input.key?.trim() || slugKey(name)).toUpperCase();
  const base = { name, key, kind: input.kind ?? 'internal' };
  let res = await db().from('project').insert({ ...base, color: input.color?.trim() || null }).select('id, name, key, kind, color').single();
  if (res.error && /color/i.test(res.error.message ?? '')) {
    // columna color aún no migrada (0012): crea sin color.
    res = await db().from('project').insert(base).select('id, name, key, kind').single();
  }
  if (res.error) throw res.error;
  const d = res.data as Record<string, any>;
  return { id: d.id, name: d.name, key: d.key, kind: d.kind, color: d.color ?? null };
}

export interface NewDeveloperInput {
  name: string;
  email?: string | null;
  githubLogin?: string | null;
  githubEmail?: string | null;
  linearUserId?: string | null;
  availability?: number | null;
}

/**
 * Da de alta un developer con las credenciales que hacen funcionar su flujo: github_login +
 * github_email (atribución de commits/PRs), linear_user_id (mapear assignees de Linear y asignar
 * tickets) y email (notificaciones). Rechaza duplicados en los campos de identidad porque la
 * resolución de devs usa maybeSingle(), que ERRORA si dos devs comparten login/email/linear —
 * un duplicado rompería la atribución de TODO el equipo, no solo del dev nuevo.
 */
export async function createDeveloper(input: NewDeveloperInput): Promise<{ id: string; name: string }> {
  const supabase = db();
  const name = input.name.trim();
  const email = input.email?.trim() || null;
  const githubLogin = input.githubLogin?.trim() || null;
  const githubEmail = input.githubEmail?.trim().toLowerCase() || null;
  const linearUserId = input.linearUserId?.trim() || null;

  // Anti-duplicado por identidad. github_* son texto → comparación case-insensitive (ilike sin
  // comodines = igualdad sin distinguir mayúsculas); linear_user_id es uuid → igualdad exacta.
  const checks: { col: string; val: string; ci: boolean; label: string }[] = [];
  if (githubLogin) checks.push({ col: 'github_login', val: githubLogin, ci: true, label: 'login de GitHub' });
  if (githubEmail) checks.push({ col: 'github_email', val: githubEmail, ci: true, label: 'email de GitHub' });
  if (linearUserId) checks.push({ col: 'linear_user_id', val: linearUserId, ci: false, label: 'usuario de Linear' });
  for (const ch of checks) {
    const base = supabase.from('dev').select('id, name');
    const { data: dupe } = await (ch.ci ? base.ilike(ch.col, ch.val) : base.eq(ch.col, ch.val)).maybeSingle();
    if (dupe) throw new Error(`Ya existe un developer (${(dupe as { name: string }).name}) con ese ${ch.label}`);
  }

  const { data, error } = await supabase
    .from('dev')
    .insert({
      name,
      email,
      github_login: githubLogin,
      github_email: githubEmail,
      linear_user_id: linearUserId,
      availability: input.availability ?? 1,
      active: true,
    })
    .select('id, name')
    .single();
  if (error) throw error;
  const dev = data as unknown as { id: string; name: string };

  // Cierra el ciclo: el trabajo del dev ya ingerido con dev_id=null (porque no existía al llegar)
  // se le atribuye ahora por su identidad de GitHub. Sin esto, solo contaría su trabajo futuro.
  await reattributeOrphans(dev.id, githubLogin, githubEmail);
  return dev;
}

export interface DeveloperPatch {
  name?: string;
  email?: string | null;
  githubLogin?: string | null;
  githubEmail?: string | null;
  linearUserId?: string | null;
  availability?: number;
  active?: boolean;
}

export interface DeveloperCredentials {
  id: string;
  name: string;
  email: string | null;
  githubLogin: string | null;
  githubEmail: string | null;
  linearUserId: string | null;
  availability: number;
  active: boolean;
}

/** Credenciales editables de un dev (para prellenar el formulario de edición). */
export async function getDeveloperCredentials(id: string): Promise<DeveloperCredentials | null> {
  const { data } = await db()
    .from('dev')
    .select('id, name, email, github_login, github_email, linear_user_id, availability, active')
    .eq('id', id)
    .maybeSingle();
  if (!data) return null;
  const d = data as Record<string, any>;
  return {
    id: d.id,
    name: d.name,
    email: d.email,
    githubLogin: d.github_login,
    githubEmail: d.github_email,
    linearUserId: d.linear_user_id,
    availability: d.availability,
    active: d.active,
  };
}

/**
 * Edita las credenciales de un dev. Solo aplica los campos presentes. Rechaza identidades que ya
 * usa OTRO dev (mismo motivo que createDeveloper: maybeSingle() en la resolución falla con dupes).
 * Tras guardar, re-atribuye su trabajo huérfano por la identidad de GitHub vigente — así corregir
 * o agregar el email/login recupera los commits que habían entrado sin dueño.
 */
export async function updateDeveloper(id: string, patch: DeveloperPatch): Promise<{ id: string; name: string }> {
  const supabase = db();

  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.email !== undefined) row.email = patch.email?.trim() || null;
  if (patch.githubLogin !== undefined) row.github_login = patch.githubLogin?.trim() || null;
  if (patch.githubEmail !== undefined) row.github_email = patch.githubEmail?.trim().toLowerCase() || null;
  if (patch.linearUserId !== undefined) row.linear_user_id = patch.linearUserId?.trim() || null;
  if (patch.availability !== undefined) row.availability = patch.availability;
  if (patch.active !== undefined) row.active = patch.active;

  // Anti-duplicado sobre los campos de identidad que se están cambiando, excluyendo al propio dev.
  const checks: { col: string; val: unknown; ci: boolean; label: string }[] = [];
  if (typeof row.github_login === 'string') checks.push({ col: 'github_login', val: row.github_login, ci: true, label: 'login de GitHub' });
  if (typeof row.github_email === 'string') checks.push({ col: 'github_email', val: row.github_email, ci: true, label: 'email de GitHub' });
  if (typeof row.linear_user_id === 'string') checks.push({ col: 'linear_user_id', val: row.linear_user_id, ci: false, label: 'usuario de Linear' });
  for (const ch of checks) {
    const base = supabase.from('dev').select('id, name').neq('id', id);
    const { data: dupe } = await (ch.ci ? base.ilike(ch.col, ch.val as string) : base.eq(ch.col, ch.val as string)).maybeSingle();
    if (dupe) throw new Error(`Otro developer (${(dupe as { name: string }).name}) ya usa ese ${ch.label}`);
  }

  row.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from('dev').update(row).eq('id', id).select('id, name, github_login, github_email').single();
  if (error) throw error;
  const d = data as Record<string, any>;

  await reattributeOrphans(d.id, d.github_login ?? null, d.github_email ?? null);
  return { id: d.id, name: d.name };
}

/**
 * Atribuye al dev el trabajo huérfano (dev_id=null) que coincide con su identidad de GitHub:
 * commits por email (más confiable) y por login, y actores de PR (work_item_actor) por login.
 * Case-insensitive (ilike sin comodines = igualdad sin distinguir mayúsculas). Idempotente.
 */
async function reattributeOrphans(devId: string, githubLogin: string | null, githubEmail: string | null): Promise<void> {
  const supabase = db();
  if (githubEmail) {
    await supabase.from('commit').update({ dev_id: devId }).is('dev_id', null).ilike('author_email', githubEmail);
  }
  if (githubLogin) {
    await supabase.from('commit').update({ dev_id: devId }).is('dev_id', null).ilike('author_login', githubLogin);
    await supabase.from('work_item_actor').update({ dev_id: devId }).is('dev_id', null).ilike('github_login', githubLogin);
  }
}

/** Edita nombre / key / kind de un proyecto. Solo aplica los campos presentes. */
export async function updateProject(id: string, patch: { name?: string; key?: string; kind?: 'client' | 'internal'; color?: string | null }): Promise<ProjectRow> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.key !== undefined) row.key = patch.key.trim().toUpperCase();
  if (patch.kind !== undefined) row.kind = patch.kind;
  if (patch.color !== undefined) row.color = patch.color?.trim() || null;
  row.updated_at = new Date().toISOString();
  let res = await db().from('project').update(row).eq('id', id).select('id, name, key, kind, color').single();
  if (res.error && /color/i.test(res.error.message ?? '')) {
    // columna color aún no migrada (0012): actualiza sin color.
    const { color: _color, ...rest } = row as Record<string, unknown>;
    void _color;
    res = await db().from('project').update(rest).eq('id', id).select('id, name, key, kind').single();
  }
  if (res.error) throw res.error;
  const d = res.data as Record<string, any>;
  return { id: d.id, name: d.name, key: d.key, kind: d.kind, color: d.color ?? null };
}

/** Borra un proyecto. Los repos (project_repo) caen por cascade; el trabajo y el conocimiento
 *  se desvinculan (project_id → null) y los borradores (proposal) se eliminan, ya que esas FK
 *  no tienen cascade. Acción destructiva: el front exige confirmación escribiendo el nombre. */
export async function deleteProject(id: string) {
  const supabase = db();
  await supabase.from('work_item').update({ project_id: null }).eq('project_id', id);
  await supabase.from('knowledge_atom').update({ project_id: null }).eq('project_id', id);
  await supabase.from('proposal').delete().eq('project_id', id);
  const { error } = await supabase.from('project').delete().eq('id', id);
  if (error) throw error;
}

// ---- Infraestructura (Vercel / Railway / Supabase) ----
// El dashboard lee el último snapshot por servicio (lo escribe el cron infra-poll); nunca pega a
// las APIs externas. Fase "solo datos": se muestra el estado tal cual, sin umbrales/anomalías.

const PROVIDERS = ['vercel', 'railway', 'supabase'] as const;
export type ServiceProvider = (typeof PROVIDERS)[number];

interface ProjectServiceRow {
  id: string;
  project_id: string;
  provider: string;
  external_ref: string;
  label: string | null;
  config: Record<string, unknown> | null;
}

interface SnapshotRow {
  captured_at: string;
  ok: boolean;
  status: string;
  provider_status: string | null;
  active: boolean | null;
  deploy: Record<string, unknown> | null;
  metrics: Record<string, number | null> | null;
  details: Record<string, unknown> | null;
  error: string | null;
}

async function allProjectServices(): Promise<ProjectServiceRow[]> {
  const { data } = await db().from('project_service').select('id, project_id, provider, external_ref, label, config');
  return (data ?? []) as unknown as ProjectServiceRow[];
}

async function latestSnapshot(serviceId: string): Promise<SnapshotRow | null> {
  const { data } = await db()
    .from('service_snapshot')
    .select('captured_at, ok, status, provider_status, active, deploy, metrics, details, error')
    .eq('project_service_id', serviceId)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as unknown as SnapshotRow) ?? null;
}

/** Estado de infraestructura por proyecto: cada servicio con su último snapshot. Incluye los
 *  proyectos SIN servicios (para poder vincular el primero desde la UI). */
export async function listInfra() {
  const [projects, services] = await Promise.all([allProjects(), allProjectServices()]);
  const snaps = await Promise.all(services.map((s) => latestSnapshot(s.id)));
  const snapById = new Map(services.map((s, i) => [s.id, snaps[i]]));

  const byProject = new Map<string, { projectId: string; name: string; kind: string; services: any[] }>();
  projects.forEach((p) => byProject.set(p.id, { projectId: p.id, name: p.name, kind: p.kind, services: [] }));

  services.forEach((s) => {
    const grp = byProject.get(s.project_id);
    if (!grp) return;
    const snap = snapById.get(s.id) ?? null;
    grp.services.push({
      id: s.id,
      provider: s.provider,
      externalRef: s.external_ref,
      label: s.label,
      config: s.config ?? {},
      capturedAt: snap?.captured_at ?? null,
      ok: snap?.ok ?? null,
      status: snap?.status ?? 'unknown',
      providerStatus: snap?.provider_status ?? null,
      active: snap?.active ?? null,
      deploy: snap?.deploy ?? null,
      metrics: snap?.metrics ?? null,
      details: snap?.details ?? null,
      error: snap?.error ?? null,
    });
  });

  // Proyectos con servicios primero; dentro, por nombre.
  return {
    projects: [...byProject.values()].sort(
      (a, b) => b.services.length - a.services.length || a.name.localeCompare(b.name),
    ),
  };
}

/** Vincula un servicio externo a un proyecto. `externalRef` = id del recurso en el proveedor. */
export async function linkService(
  projectId: string,
  input: { provider: ServiceProvider; externalRef: string; label?: string | null; config?: Record<string, unknown> },
): Promise<ProjectServiceRow> {
  const { data, error } = await db()
    .from('project_service')
    .insert({
      project_id: projectId,
      provider: input.provider,
      external_ref: input.externalRef.trim(),
      label: input.label?.trim() || null,
      config: input.config ?? {},
    })
    .select('id, project_id, provider, external_ref, label')
    .single();
  if (error) throw error;
  return data as unknown as ProjectServiceRow;
}

/** Edita un servicio vinculado (proveedor / referencia / nombre / config). */
export async function updateService(
  serviceId: string,
  patch: { provider?: ServiceProvider; externalRef?: string; label?: string | null; config?: Record<string, unknown> },
): Promise<ProjectServiceRow> {
  const row: Record<string, unknown> = {};
  if (patch.provider !== undefined) row.provider = patch.provider;
  if (patch.externalRef !== undefined) row.external_ref = patch.externalRef.trim();
  if (patch.label !== undefined) row.label = patch.label?.trim() || null;
  if (patch.config !== undefined) row.config = patch.config;
  const { data, error } = await db()
    .from('project_service')
    .update(row)
    .eq('id', serviceId)
    .select('id, project_id, provider, external_ref, label, config')
    .single();
  if (error) throw error;
  return data as unknown as ProjectServiceRow;
}

/** Desvincula un servicio (sus snapshots caen por cascade). */
export async function unlinkService(serviceId: string) {
  const { error } = await db().from('project_service').delete().eq('id', serviceId);
  if (error) throw error;
}

function sumLines(commits: CommitRow[]): { additions: number; deletions: number } {
  return commits.reduce(
    (acc, c) => ({ additions: acc.additions + (c.additions ?? 0), deletions: acc.deletions + (c.deletions ?? 0) }),
    { additions: 0, deletions: 0 },
  );
}

/** Hyper points de un dev en un período: √(commits × líneas cambiadas) / 10 — la media
 *  geométrica entre actividad y volumen. La proporción de puntos entre dos devs cae justo a
 *  medio camino (multiplicativo) entre su proporción de commits y su proporción de líneas,
 *  para cualquier par (criterio de Cris; con la curva por commit anterior cada par pedía un
 *  exponente distinto). Al usar solo totales del período es inmune al empaquetado — partir un
 *  scaffold en 6 commits no cambia nada — y anti-spam en ambas direcciones: micro-commits sin
 *  líneas no escalan, y un mega-dump sin actividad tampoco. */
function hyperPoints(commits: CommitRow[]): number {
  const lines = commits.reduce((s, c) => s + (c.additions ?? 0) + (c.deletions ?? 0), 0);
  return Math.sqrt(commits.length * lines) / 10;
}

/** Distribución de commits por tamaño (conteo y líneas por franja). Es descriptiva del estilo
 *  de trabajo: con la fórmula agregada de hyper points, el empaquetado no afecta el puntaje. */
export interface SizeBucket { key: 'micro' | 'chico' | 'mediano' | 'grande'; commits: number; lines: number }
function commitSizeDist(commits: CommitRow[]): SizeBucket[] {
  const buckets: SizeBucket[] = [
    { key: 'micro', commits: 0, lines: 0 },
    { key: 'chico', commits: 0, lines: 0 },
    { key: 'mediano', commits: 0, lines: 0 },
    { key: 'grande', commits: 0, lines: 0 },
  ];
  for (const c of commits) {
    const lines = (c.additions ?? 0) + (c.deletions ?? 0);
    const b = buckets[lines < 30 ? 0 : lines <= 300 ? 1 : lines <= 2000 ? 2 : 3]!;
    b.commits += 1;
    b.lines += lines;
  }
  return buckets;
}

// ---- Overview (landing del CEO) ----

export async function getOverview(period: Period, cmp: Period | null) {
  const [curCommits, curResolved, open, devs, projects, cmpCommits, cmpResolved] = await Promise.all([
    commitsInRange(period.from, period.to),
    resolvedInRange(period.from, period.to),
    openWorkItems(),
    allDevs(),
    allProjects(),
    cmp ? commitsInRange(cmp.from, cmp.to) : Promise.resolve(null),
    cmp ? resolvedInRange(cmp.from, cmp.to) : Promise.resolve(null),
  ]);

  const projName = new Map(projects.map((p) => [p.id, p.name]));
  const devName = new Map(devs.map((d) => [d.id, d.name]));

  const activeSet = (commits: CommitRow[], resolved: WorkItemRow[]) => {
    const s = new Set<string>();
    commits.forEach((c) => c.dev_id && s.add(c.dev_id));
    resolved.forEach((w) => w.assignee_dev_id && s.add(w.assignee_dev_id));
    return s;
  };

  const kpis = {
    commits: metric(curCommits.length, cmpCommits ? cmpCommits.length : null),
    ticketsResolved: metric(curResolved.length, cmpResolved ? cmpResolved.length : null),
    activeContributors: metric(
      activeSet(curCommits, curResolved).size,
      cmpCommits && cmpResolved ? activeSet(cmpCommits, cmpResolved).size : null,
    ),
    avgCycleTimeHours: metric(cycleTime(curResolved), cmpResolved ? cycleTime(cmpResolved) : null),
    linesChanged: metric(
      sumLines(curCommits).additions + sumLines(curCommits).deletions,
      cmpCommits ? sumLines(cmpCommits).additions + sumLines(cmpCommits).deletions : null,
    ),
  };

  // Contribución por proyecto (commits + tickets resueltos en el período).
  const byProjectMap = new Map<string, { projectId: string | null; name: string; commits: number; ticketsResolved: number }>();
  const bucketProj = (id: string | null) => {
    const key = id ?? 'none';
    if (!byProjectMap.has(key)) {
      byProjectMap.set(key, { projectId: id, name: id ? projName.get(id) ?? '(desconocido)' : '(sin proyecto)', commits: 0, ticketsResolved: 0 });
    }
    return byProjectMap.get(key)!;
  };
  curCommits.forEach((c) => bucketProj(c.project_id).commits++);
  curResolved.forEach((w) => bucketProj(w.project_id).ticketsResolved++);
  const byProject = [...byProjectMap.values()].sort((a, b) => b.commits + b.ticketsResolved - (a.commits + a.ticketsResolved));

  // Balance de carga: tickets abiertos asignados, ponderados por prioridad.
  const workloadMap = new Map<string, { devId: string; name: string; avatarUrl: string | null; openTickets: number; weighted: number }>();
  const devAvatar = new Map(devs.map((d) => [d.id, avatarFor(d.github_login)]));
  open.forEach((w) => {
    if (!w.assignee_dev_id) return;
    if (!workloadMap.has(w.assignee_dev_id)) {
      workloadMap.set(w.assignee_dev_id, {
        devId: w.assignee_dev_id,
        name: devName.get(w.assignee_dev_id) ?? '—',
        avatarUrl: devAvatar.get(w.assignee_dev_id) ?? null,
        openTickets: 0,
        weighted: 0,
      });
    }
    const row = workloadMap.get(w.assignee_dev_id)!;
    row.openTickets++;
    row.weighted += PRIORITY_WEIGHT[w.priority ?? ''] ?? 1;
  });
  const workload = [...workloadMap.values()].sort((a, b) => b.weighted - a.weighted);

  const skillsCoverage = await getSkillCatalog();

  // Contribución por developer (commits + tickets resueltos + líneas) en el período.
  const devAgg = new Map<string, { devId: string; name: string; avatarUrl: string | null; commits: number; ticketsResolved: number; lines: number }>();
  const ensureDev = (id: string) => {
    if (!devAgg.has(id)) devAgg.set(id, { devId: id, name: devName.get(id) ?? '—', avatarUrl: devAvatar.get(id) ?? null, commits: 0, ticketsResolved: 0, lines: 0 });
    return devAgg.get(id)!;
  };
  curCommits.forEach((c) => {
    if (!c.dev_id) return;
    const r = ensureDev(c.dev_id);
    r.commits++;
    r.lines += (c.additions ?? 0) + (c.deletions ?? 0);
  });
  curResolved.forEach((w) => w.assignee_dev_id && ensureDev(w.assignee_dev_id).ticketsResolved++);
  const byDeveloper = [...devAgg.values()].sort((a, b) => b.commits + b.ticketsResolved - (a.commits + a.ticketsResolved));

  // Cliente vs Interno: a dónde va el esfuerzo (commits + tickets) según project.kind.
  const kindByProject = new Map(projects.map((p) => [p.id, p.kind]));
  const split = { client: { commits: 0, ticketsResolved: 0 }, internal: { commits: 0, ticketsResolved: 0 } };
  curCommits.forEach((c) => {
    const k = c.project_id ? kindByProject.get(c.project_id) : null;
    if (k === 'client') split.client.commits++;
    else if (k === 'internal') split.internal.commits++;
  });
  curResolved.forEach((w) => {
    const k = w.project_id ? kindByProject.get(w.project_id) : null;
    if (k === 'client') split.client.ticketsResolved++;
    else if (k === 'internal') split.internal.ticketsResolved++;
  });

  // Tickets abiertos por estado (salud del pipeline, no atado al período).
  const stateAgg = new Map<string, number>();
  open.forEach((w) => stateAgg.set(w.state, (stateAgg.get(w.state) ?? 0) + 1));
  const ticketsByState = [...stateAgg.entries()].map(([state, count]) => ({ state, count })).sort((a, b) => b.count - a.count);

  // Tendencia diaria dentro del período.
  const trendMap = new Map<string, { date: string; commits: number; ticketsResolved: number }>();
  const ensureDay = (k: string) => {
    if (!trendMap.has(k)) trendMap.set(k, { date: k, commits: 0, ticketsResolved: 0 });
    return trendMap.get(k)!;
  };
  curCommits.forEach((c) => c.committed_at && ensureDay(dayKey(c.committed_at)).commits++);
  curResolved.forEach((w) => w.completed_at && ensureDay(dayKey(w.completed_at)).ticketsResolved++);
  const trend = [...trendMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  return { period, compare: cmp, kpis, byProject, byDeveloper, split, ticketsByState, workload, skillsCoverage, trend };
}

// ---- Lista de developers ----

export async function listDevelopers(period: Period) {
  const [commits, resolved, open, devs, skills] = await Promise.all([
    commitsInRange(period.from, period.to),
    resolvedInRange(period.from, period.to),
    openWorkItems(),
    allDevs(),
    devSkillsByDev(),
  ]);

  const commitsByDev = countBy(commits, (c) => c.dev_id);
  const resolvedByDev = countBy(resolved, (w) => w.assignee_dev_id);
  const openByDev = countBy(open, (w) => w.assignee_dev_id);
  const linesByDev = new Map<string, number>();
  commits.forEach((c) => c.dev_id && linesByDev.set(c.dev_id, (linesByDev.get(c.dev_id) ?? 0) + (c.additions ?? 0) + (c.deletions ?? 0)));
  const projectsByDev = new Map<string, Set<string>>();
  commits.forEach((c) => {
    if (!c.dev_id || !c.project_id) return;
    if (!projectsByDev.has(c.dev_id)) projectsByDev.set(c.dev_id, new Set());
    projectsByDev.get(c.dev_id)!.add(c.project_id);
  });
  const commitsListByDev = new Map<string, CommitRow[]>();
  commits.forEach((c) => {
    if (!c.dev_id) return;
    if (!commitsListByDev.has(c.dev_id)) commitsListByDev.set(c.dev_id, []);
    commitsListByDev.get(c.dev_id)!.push(c);
  });

  return devs
    .filter((d) => d.active)
    .map((d) => ({
      id: d.id,
      name: d.name,
      githubLogin: d.github_login,
      avatarUrl: avatarFor(d.github_login),
      active: d.active,
      availability: d.availability,
      commits: commitsByDev.get(d.id) ?? 0,
      ticketsResolved: resolvedByDev.get(d.id) ?? 0,
      openTickets: openByDev.get(d.id) ?? 0,
      linesChanged: linesByDev.get(d.id) ?? 0,
      hyperPoints: Math.round(hyperPoints(commitsListByDev.get(d.id) ?? [])),
      sizeDist: commitSizeDist(commitsListByDev.get(d.id) ?? []),
      projects: projectsByDev.get(d.id)?.size ?? 0,
      topSkills: (skills.get(d.id) ?? []).slice(0, 5).map((s) => ({ tag: s.tag, level: s.level })),
    }))
    .sort((a, b) => b.hyperPoints - a.hyperPoints);
}

// ---- Perfil de un developer ----

export async function getDeveloper(devId: string, period: Period, cmp: Period | null) {
  const dev = await db().from('dev').select('id, name, email, github_login, linear_user_id, active, availability').eq('id', devId).maybeSingle();
  const d = dev.data as unknown as DevRow | null;
  if (!d) return null;

  const [curCommits, curResolved, open, projects, skills, cmpCommits, cmpResolved] = await Promise.all([
    commitsInRange(period.from, period.to, { devId }),
    resolvedInRange(period.from, period.to, { devId }),
    openWorkItems(devId),
    allProjects(),
    devSkills(devId),
    cmp ? commitsInRange(cmp.from, cmp.to, { devId }) : Promise.resolve(null),
    cmp ? resolvedInRange(cmp.from, cmp.to, { devId }) : Promise.resolve(null),
  ]);
  const projName = new Map(projects.map((p) => [p.id, p.name]));

  const projectsTouched = new Set(curCommits.map((c) => c.project_id).filter(Boolean));
  const lines = sumLines(curCommits);

  const sumHyper = (cs: CommitRow[]) => Math.round(hyperPoints(cs));
  const kpis = {
    commits: metric(curCommits.length, cmpCommits ? cmpCommits.length : null),
    hyperPoints: metric(sumHyper(curCommits), cmpCommits ? sumHyper(cmpCommits) : null),
    ticketsResolved: metric(curResolved.length, cmpResolved ? cmpResolved.length : null),
    avgCycleTimeHours: metric(cycleTime(curResolved), cmpResolved ? cycleTime(cmpResolved) : null),
    linesChanged: metric(lines.additions + lines.deletions, cmpCommits ? sumLines(cmpCommits).additions + sumLines(cmpCommits).deletions : null),
  };

  const trendMap = new Map<string, number>();
  curCommits.forEach((c) => c.committed_at && trendMap.set(dayKey(c.committed_at), (trendMap.get(dayKey(c.committed_at)) ?? 0) + 1));
  const commitTrend = [...trendMap.entries()].map(([date, commits]) => ({ date, commits })).sort((a, b) => a.date.localeCompare(b.date));

  const projAgg = new Map<string, { projectId: string | null; name: string; commits: number }>();
  curCommits.forEach((c) => {
    const key = c.project_id ?? 'none';
    if (!projAgg.has(key)) projAgg.set(key, { projectId: c.project_id, name: c.project_id ? projName.get(c.project_id) ?? '(desconocido)' : '(sin proyecto)', commits: 0 });
    projAgg.get(key)!.commits++;
  });
  const repoAgg = countBy(curCommits, (c) => c.repo);

  const inProgress = open.filter((w) => w.state === 'started' || w.state === 'in_progress');
  const openOnly = open.filter((w) => !(w.state === 'started' || w.state === 'in_progress'));

  // Actividad reciente = últimos 30 días del período (relativo a period.to para que los
  // períodos históricos sigan mostrando su propio "último mes").
  const activityCutoff = new Date(new Date(period.to).getTime() - 30 * 24 * 3600_000).toISOString();
  const activity = [
    ...curCommits.filter((c) => c.committed_at).map((c) => ({ type: 'commit' as const, ts: c.committed_at!, title: (c.message ?? '').split('\n')[0], url: c.url, repo: c.repo, additions: c.additions, deletions: c.deletions })),
    ...curResolved.filter((w) => w.completed_at).map((w) => ({ type: 'ticket_resolved' as const, ts: w.completed_at!, title: `${w.identifier}: ${w.title}`, url: w.url, repo: null, additions: null, deletions: null })),
  ]
    .filter((a) => a.ts >= activityCutoff)
    .sort((a, b) => b.ts.localeCompare(a.ts));

  return {
    dev: { id: d.id, name: d.name, email: d.email, githubLogin: d.github_login, avatarUrl: avatarFor(d.github_login), active: d.active, availability: d.availability },
    period,
    compare: cmp,
    kpis,
    commitTrend,
    projects: [...projAgg.values()].sort((a, b) => b.commits - a.commits),
    repos: [...repoAgg.entries()].map(([repo, commits]) => ({ repo, commits })).sort((a, b) => b.commits - a.commits),
    sizeDist: commitSizeDist(curCommits),
    tickets: { open: openOnly.map(slimTicket), inProgress: inProgress.map(slimTicket), resolved: curResolved.map(slimTicket).slice(0, 20) },
    skills: skills.map((s) => ({ skillId: s.skill_id, tag: s.tag, level: s.level })),
    activity,
  };
}

function slimTicket(w: WorkItemRow) {
  return { id: w.id, identifier: w.identifier, title: w.title, state: w.state, priority: w.priority, url: w.url };
}

// ---- Proyectos (historial de commits + líneas) ----

export async function listProjects(period: Period) {
  const [commits, projects, resolved, devs, repoLinks, colorById] = await Promise.all([
    commitsInRange(period.from, period.to),
    allProjects(),
    resolvedInRange(period.from, period.to),
    allDevs(),
    projectRepos(),
    projectColors(),
  ]);
  const devName = new Map(devs.map((d) => [d.id, d.name]));
  const kindById = new Map(projects.map((p) => [p.id, p.kind]));
  const keyById = new Map(projects.map((p) => [p.id, p.key]));
  const byId = new Map<string, { projectId: string; name: string; commits: number; additions: number; deletions: number; contributors: Set<string>; repos: Set<string>; ticketsResolved: number }>();
  projects.forEach((p) => byId.set(p.id, { projectId: p.id, name: p.name, commits: 0, additions: 0, deletions: 0, contributors: new Set(), repos: new Set(), ticketsResolved: 0 }));

  // repos = los MAPEADOS del proyecto (configurados), no solo los que tuvieron actividad.
  repoLinks.forEach((l) => {
    if (byId.has(l.project_id)) byId.get(l.project_id)!.repos.add(l.repo);
  });

  commits.forEach((c) => {
    if (!c.project_id || !byId.has(c.project_id)) return;
    const row = byId.get(c.project_id)!;
    row.commits++;
    row.additions += c.additions ?? 0;
    row.deletions += c.deletions ?? 0;
    if (c.dev_id) row.contributors.add(c.dev_id);
  });
  resolved.forEach((w) => {
    if (w.project_id && byId.has(w.project_id)) byId.get(w.project_id)!.ticketsResolved++;
  });

  return [...byId.values()]
    .map((p) => ({
      projectId: p.projectId,
      name: p.name,
      key: keyById.get(p.projectId) ?? '',
      kind: kindById.get(p.projectId) ?? 'internal',
      color: colorById.get(p.projectId) ?? null,
      commits: p.commits,
      additions: p.additions,
      deletions: p.deletions,
      contributors: [...p.contributors].map((id) => devName.get(id) ?? '—'),
      repos: [...p.repos],
      ticketsResolved: p.ticketsResolved,
    }))
    // Con actividad arriba; a igualdad, los que tienen más repos configurados.
    .sort((a, b) => b.commits - a.commits || b.repos.length - a.repos.length);
}

/** Mapeos repo → proyecto configurados (roz.project_repo). */
async function projectRepos(): Promise<{ project_id: string; repo: string }[]> {
  const { data } = await db().from('project_repo').select('project_id, repo');
  return (data ?? []) as unknown as { project_id: string; repo: string }[];
}

export async function getProject(projectId: string, period: Period) {
  const proj = await db().from('project').select('id, name, key, kind').eq('id', projectId).maybeSingle();
  const p = proj.data as unknown as { id: string; name: string; key: string; kind: string } | null;
  if (!p) return null;
  const color = (await projectColors()).get(projectId) ?? null;

  const [commits, devs, resolved, repoRows, openRows, allItemRows, repoSync] = await Promise.all([
    commitsInRange(period.from, period.to, { projectId }),
    allDevs(),
    resolvedInRange(period.from, period.to, { projectId }),
    db().from('project_repo').select('repo').eq('project_id', projectId),
    db()
      .from('work_item')
      .select('id, identifier, title, state, state_name, priority, assignee_dev_id, url')
      .eq('project_id', projectId)
      .in('state', OPEN_STATES),
    // Todos los work_items del proyecto (para el desglose por estado, incluidos cerrados).
    db().from('work_item').select('state, state_name').eq('project_id', projectId),
    projectRepoSync(projectId),
  ]);
  const repos = ((repoRows.data ?? []) as unknown as { repo: string }[]).map((r) => r.repo).sort();
  const devName = new Map(devs.map((d) => [d.id, d.name]));
  const devAvatar = new Map(devs.map((d) => [d.id, avatarFor(d.github_login)]));
  const lines = sumLines(commits);

  // Historial de commits (más recientes primero).
  const history = commits
    .slice()
    .sort((a, b) => (b.committed_at ?? '').localeCompare(a.committed_at ?? ''))
    .slice(0, 100)
    .map((c) => ({
      sha: c.sha.slice(0, 8),
      message: (c.message ?? '').split('\n')[0],
      author: c.dev_id ? devName.get(c.dev_id) ?? c.author_login : c.author_login,
      avatarUrl: c.dev_id ? devAvatar.get(c.dev_id) ?? null : avatarFor(c.author_login),
      committedAt: c.committed_at,
      additions: c.additions,
      deletions: c.deletions,
      repo: c.repo,
      url: c.url,
    }));

  // Contribuidores con su volumen.
  const contribMap = new Map<string, { name: string; avatarUrl: string | null; commits: number; lines: number }>();
  commits.forEach((c) => {
    const key = c.dev_id ?? c.author_login ?? 'desconocido';
    const name = c.dev_id ? devName.get(c.dev_id) ?? '—' : c.author_login ?? 'desconocido';
    const avatarUrl = c.dev_id ? devAvatar.get(c.dev_id) ?? null : avatarFor(c.author_login);
    if (!contribMap.has(key)) contribMap.set(key, { name, avatarUrl, commits: 0, lines: 0 });
    const row = contribMap.get(key)!;
    row.commits++;
    row.lines += (c.additions ?? 0) + (c.deletions ?? 0);
  });

  // Tendencia diaria de líneas.
  const trendMap = new Map<string, { date: string; additions: number; deletions: number }>();
  commits.forEach((c) => {
    if (!c.committed_at) return;
    const k = dayKey(c.committed_at);
    if (!trendMap.has(k)) trendMap.set(k, { date: k, additions: 0, deletions: 0 });
    const row = trendMap.get(k)!;
    row.additions += c.additions ?? 0;
    row.deletions += c.deletions ?? 0;
  });

  // Commits por repo (en el período): en qué repo se concentra el trabajo.
  const repoCommits = new Map<string, number>();
  commits.forEach((c) => repoCommits.set(c.repo, (repoCommits.get(c.repo) ?? 0) + 1));
  const byRepo = repos
    .map((r) => ({ repo: r.replace('hyperlabs-ai/', ''), commits: repoCommits.get(r) ?? 0 }))
    .sort((a, b) => b.commits - a.commits);

  // Desglose de TODOS los tickets del proyecto por estado (incluye cerrados).
  const stateAgg = new Map<string, { state: string; label: string; count: number }>();
  ((allItemRows.data ?? []) as any[]).forEach((w) => {
    const key = w.state;
    if (!stateAgg.has(key)) stateAgg.set(key, { state: key, label: w.state_name ?? key, count: 0 });
    stateAgg.get(key)!.count++;
  });
  const ticketsByState = [...stateAgg.values()].sort((a, b) => b.count - a.count);

  // Tickets abiertos del proyecto (ordenados por prioridad).
  const PRIO_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
  const openTickets = ((openRows.data ?? []) as any[])
    .map((w) => ({
      id: w.id,
      identifier: w.identifier,
      title: w.title,
      state: w.state,
      stateName: w.state_name ?? w.state,
      priority: w.priority,
      url: w.url,
      assignee: w.assignee_dev_id ? { name: devName.get(w.assignee_dev_id) ?? '—', avatarUrl: devAvatar.get(w.assignee_dev_id) ?? null } : null,
    }))
    .sort((a, b) => (PRIO_ORDER[a.priority ?? ''] ?? 9) - (PRIO_ORDER[b.priority ?? ''] ?? 9));

  return {
    project: { id: p.id, name: p.name, key: p.key, kind: p.kind, color },
    repos,
    repoSync,
    period,
    totals: { commits: commits.length, additions: lines.additions, deletions: lines.deletions, ticketsResolved: resolved.length, contributors: contribMap.size, openTickets: openTickets.length },
    contributors: [...contribMap.values()].sort((a, b) => b.commits - a.commits),
    openTickets,
    byRepo,
    ticketsByState,
    history,
    trend: [...trendMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// ---- Tickets (espejo de Linear) ----

const OPEN_STATES = ['backlog', 'unstarted', 'triage', 'started'];

export interface TicketFilters {
  projectId?: string;
  state?: string; // tipo de estado
  assigneeDevId?: string;
  priority?: string;
  scope?: 'open' | 'all'; // open = no cerrados (default)
}

interface TicketActor { name: string; avatarUrl: string | null; login: string | null; devId: string | null; reviewState: string | null }

/** Carga la atribución (autor/revisor/merger) de `roz.work_item_actor` para un set de tickets. */
async function loadTicketActors(
  ids: string[],
  devName: Map<string, string>,
  devAvatar: Map<string, string | null>,
): Promise<Map<string, { authors: TicketActor[]; reviewers: TicketActor[]; merger: TicketActor | null }>> {
  const map = new Map<string, { authors: TicketActor[]; reviewers: TicketActor[]; merger: TicketActor | null }>();
  if (!ids.length) return map;
  const { data } = await db()
    .from('work_item_actor')
    .select('work_item_id, dev_id, github_login, role, review_state')
    .in('work_item_id', ids);
  for (const a of (data ?? []) as any[]) {
    const person: TicketActor = {
      name: a.dev_id ? devName.get(a.dev_id) ?? a.github_login : a.github_login,
      avatarUrl: a.dev_id ? devAvatar.get(a.dev_id) ?? avatarFor(a.github_login) : avatarFor(a.github_login),
      login: a.github_login ?? null,
      devId: a.dev_id ?? null,
      reviewState: a.review_state ?? null,
    };
    if (!map.has(a.work_item_id)) map.set(a.work_item_id, { authors: [], reviewers: [], merger: null });
    const e = map.get(a.work_item_id)!;
    if (a.role === 'author') e.authors.push(person);
    else if (a.role === 'reviewer') e.reviewers.push(person);
    else if (a.role === 'merger') e.merger = person;
  }
  return map;
}

/** ¿Es la misma persona? Prefiere dev_id; cae a github_login. */
function samePerson(a: TicketActor, b: TicketActor): boolean {
  if (a.devId && b.devId) return a.devId === b.devId;
  if (a.login && b.login) return a.login === b.login;
  return false;
}

export async function getTickets(f: TicketFilters) {
  const [devs, projects] = await Promise.all([allDevs(), allProjects()]);
  const devName = new Map(devs.map((d) => [d.id, d.name]));
  const devAvatar = new Map(devs.map((d) => [d.id, avatarFor(d.github_login)]));
  const projName = new Map(projects.map((p) => [p.id, p.name]));

  let q = db()
    .from('work_item')
    .select(
      'id, identifier, number, title, state, state_name, priority, project_id, assignee_dev_id, estimate, due_date, labels, creator_name, url, started_at, completed_at, linear_created_at, linear_updated_at, pr_number, repo, source, merger_dev_id',
    );
  if (f.projectId) q = q.eq('project_id', f.projectId);
  if (f.assigneeDevId) q = q.eq('assignee_dev_id', f.assigneeDevId);
  if (f.priority) q = q.eq('priority', f.priority);
  if (f.state) q = q.eq('state', f.state);
  else if (f.scope !== 'all') q = q.in('state', OPEN_STATES);
  const { data } = await q.order('linear_updated_at', { ascending: false }).limit(500);
  const rows = (data ?? []) as any[];

  const PRIO_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
  const now = Date.now();

  // Atribución por PR (autor/revisor/merger) para los tickets visibles.
  const actorsByItem = await loadTicketActors(rows.map((w) => w.id), devName, devAvatar);

  const tickets = rows
    .map((w) => {
      const act = actorsByItem.get(w.id);
      const merger = act?.merger
        ?? (w.merger_dev_id
          ? { name: devName.get(w.merger_dev_id) ?? '—', avatarUrl: devAvatar.get(w.merger_dev_id) ?? null, login: null, devId: w.merger_dev_id, reviewState: null }
          : null);
      return {
        id: w.id,
        identifier: w.identifier,
        number: w.number,
        title: w.title,
        state: w.state,
        stateName: w.state_name ?? w.state,
        priority: w.priority,
        projectId: w.project_id,
        projectName: w.project_id ? projName.get(w.project_id) ?? null : null,
        assignee: w.assignee_dev_id ? { name: devName.get(w.assignee_dev_id) ?? '—', avatarUrl: devAvatar.get(w.assignee_dev_id) ?? null } : null,
        estimate: w.estimate,
        dueDate: w.due_date,
        overdue: w.due_date ? !['completed', 'done', 'canceled'].includes(w.state) && new Date(w.due_date).getTime() < now : false,
        labels: w.labels ?? [],
        creatorName: w.creator_name,
        url: w.url,
        updatedAt: w.linear_updated_at,
        ageDays: w.linear_created_at ? Math.floor((now - new Date(w.linear_created_at).getTime()) / 86_400_000) : null,
        // Conexión con código
        source: (w.source as 'pr' | 'commit' | null) ?? null,
        pr: w.pr_number && w.repo ? { repo: w.repo, number: w.pr_number, url: `https://github.com/${w.repo}/pull/${w.pr_number}` } : null,
        authors: act?.authors ?? [],
        reviewers: act?.reviewers ?? [],
        merger,
      };
    })
    .sort((a, b) => (PRIO_ORDER[a.priority ?? ''] ?? 9) - (PRIO_ORDER[b.priority ?? ''] ?? 9));

  // Agregaciones para los KPIs/gráficas (sobre el conjunto filtrado).
  const byState = countMap(tickets, (t) => t.stateName);
  const byPriority = countMap(tickets, (t) => t.priority ?? 'sin prioridad');
  const byProject = countMap(tickets, (t) => t.projectName ?? 'sin proyecto');
  const bySource = countMap(tickets, (t) => t.source ?? 'linear');

  // Top revisores: quién aparece más como reviewer (no es el assignee; hoy invisible).
  const revMap = new Map<string, { name: string; avatarUrl: string | null; count: number }>();
  tickets.forEach((t) =>
    t.reviewers.forEach((r) => {
      const k = r.login ?? r.name;
      if (!revMap.has(k)) revMap.set(k, { name: r.name, avatarUrl: r.avatarUrl, count: 0 });
      revMap.get(k)!.count++;
    }),
  );
  const topReviewers = [...revMap.values()].sort((a, b) => b.count - a.count);

  // Insight de atribución: tickets cuyo merger no es ninguno de los autores (ver squash/merge).
  const attributionMismatch = tickets.filter(
    (t) => t.merger && t.authors.length > 0 && !t.authors.some((a) => samePerson(a, t.merger!)),
  ).length;
  // Trabajo cerrado sin PR vinculado (no trazable a código).
  const withoutPr = tickets.filter((t) => ['completed', 'done'].includes(t.state) && !t.pr).length;

  // Resumen por categoría, SIEMPRE sobre todos los tickets del filtro (ignora el scope), para
  // que los KPIs muestren abiertos / en curso / completados sin importar el toggle.
  let sq = db().from('work_item').select('state, assignee_dev_id, due_date');
  if (f.projectId) sq = sq.eq('project_id', f.projectId);
  if (f.assigneeDevId) sq = sq.eq('assignee_dev_id', f.assigneeDevId);
  if (f.priority) sq = sq.eq('priority', f.priority);
  const { data: allRows } = await sq.limit(2000);
  const all = (allRows ?? []) as any[];

  // Developers involucrados: sobre el conjunto COMPLETO (no los 500 visibles), para que no
  // dependa del scope/orden. Antes se calculaba sobre `tickets` y devs con tickets viejos
  // quedaban fuera del corte de 500 en scope "todos".
  const devMap = new Map<string, { name: string; avatarUrl: string | null; count: number }>();
  all.forEach((w) => {
    if (!w.assignee_dev_id) return;
    const name = devName.get(w.assignee_dev_id) ?? '—';
    if (!devMap.has(name)) devMap.set(name, { name, avatarUrl: devAvatar.get(w.assignee_dev_id) ?? null, count: 0 });
    devMap.get(name)!.count++;
  });
  const developers = [...devMap.values()].sort((a, b) => b.count - a.count);
  const summary = {
    total: all.length,
    open: all.filter((w) => OPEN_STATES.includes(w.state)).length,
    inProgress: all.filter((w) => w.state === 'started' || w.state === 'in_progress').length,
    completed: all.filter((w) => ['completed', 'done'].includes(w.state)).length,
    unassigned: all.filter((w) => OPEN_STATES.includes(w.state) && !w.assignee_dev_id).length,
    overdue: all.filter((w) => w.due_date && !['completed', 'done', 'canceled'].includes(w.state) && new Date(w.due_date).getTime() < now).length,
  };

  return {
    total: tickets.length,
    overdue: tickets.filter((t) => t.overdue).length,
    unassigned: tickets.filter((t) => !t.assignee).length,
    summary,
    byState,
    byPriority,
    byProject,
    bySource,
    developers,
    topReviewers,
    attributionMismatch,
    withoutPr,
    tickets,
  };
}

/** Opciones para los filtros del front (proyectos con tickets, devs, estados presentes). */
export async function getTicketFilters() {
  const [{ data: wi }, devs, projects] = await Promise.all([
    db().from('work_item').select('project_id, assignee_dev_id, state, state_name'),
    allDevs(),
    allProjects(),
  ]);
  const rows = (wi ?? []) as any[];
  const projWithTickets = new Set(rows.map((r) => r.project_id).filter(Boolean));
  const states = [...new Map(rows.filter((r) => r.state).map((r) => [r.state, r.state_name ?? r.state])).entries()].map(([value, label]) => ({ value, label }));
  return {
    projects: projects.filter((p) => projWithTickets.has(p.id)).map((p) => ({ id: p.id, name: p.name })),
    devs: devs.filter((d) => d.active).map((d) => ({ id: d.id, name: d.name })),
    states,
  };
}

function countMap<T>(items: T[], key: (t: T) => string): { label: string; value: number }[] {
  const m = new Map<string, number>();
  items.forEach((it) => {
    const k = key(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  });
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

// ---- Skills (catálogo, matriz, CRUD) ----

export async function getSkillCatalog() {
  const [{ data: skills }, links] = await Promise.all([db().from('skill').select('id, tag, description'), devSkillLinks()]);
  const countBySkill = new Map<string, { sum: number; n: number }>();
  links.forEach((l) => {
    const c = countBySkill.get(l.skill_id) ?? { sum: 0, n: 0 };
    c.sum += l.level;
    c.n++;
    countBySkill.set(l.skill_id, c);
  });
  return ((skills ?? []) as unknown as { id: string; tag: string; description: string | null }[])
    .map((s) => {
      const c = countBySkill.get(s.id);
      return {
        skillId: s.id,
        tag: s.tag,
        description: s.description,
        devCount: c?.n ?? 0,
        avgLevel: c && c.n ? Math.round((c.sum / c.n) * 10) / 10 : 0,
        busFactorRisk: (c?.n ?? 0) <= 1,
      };
    })
    .sort((a, b) => b.devCount - a.devCount);
}

export async function getSkillsMatrix() {
  const [devs, { data: skills }, links] = await Promise.all([allDevs(), db().from('skill').select('id, tag'), devSkillLinks()]);
  return {
    devs: devs.filter((d) => d.active).map((d) => ({ id: d.id, name: d.name, avatarUrl: avatarFor(d.github_login) })),
    skills: ((skills ?? []) as unknown as { id: string; tag: string }[]).map((s) => ({ id: s.id, tag: s.tag })),
    cells: links.map((l) => ({ devId: l.dev_id, skillId: l.skill_id, level: l.level })),
  };
}

export async function createSkill(tag: string, description: string | null) {
  const embedding = await embed(`${tag}. ${description ?? ''}`.trim()).catch(() => null);
  const { data, error } = await db().from('skill').insert({ tag, description, embedding }).select('id, tag, description').single();
  if (error) throw error;
  return data;
}

export async function updateSkill(id: string, patch: { tag?: string; description?: string | null }) {
  const row: Record<string, unknown> = {};
  if (patch.tag !== undefined) row.tag = patch.tag;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.tag !== undefined || patch.description !== undefined) {
    const { data: cur } = await db().from('skill').select('tag, description').eq('id', id).maybeSingle();
    const c = cur as { tag?: string; description?: string | null } | null;
    const tag = patch.tag ?? c?.tag ?? '';
    const desc = patch.description !== undefined ? patch.description : c?.description ?? '';
    row.embedding = await embed(`${tag}. ${desc ?? ''}`.trim()).catch(() => null);
  }
  row.updated_at = new Date().toISOString();
  const { data, error } = await db().from('skill').update(row).eq('id', id).select('id, tag, description').single();
  if (error) throw error;
  return data;
}

export async function deleteSkill(id: string) {
  const { error } = await db().from('skill').delete().eq('id', id);
  if (error) throw error;
}

/** Ajusta la disponibilidad de un dev (0 saturado .. 1 libre). Afecta al router de asignación. */
export async function setDevAvailability(devId: string, availability: number) {
  const a = Math.max(0, Math.min(1, availability));
  const { error } = await db().from('dev').update({ availability: a, updated_at: new Date().toISOString() }).eq('id', devId);
  if (error) throw error;
  return { id: devId, availability: a };
}

export async function setDevSkill(devId: string, skillId: string, level: number) {
  const { error } = await db().from('dev_skill').upsert({ dev_id: devId, skill_id: skillId, level }, { onConflict: 'dev_id,skill_id' });
  if (error) throw error;
}

export async function removeDevSkill(devId: string, skillId: string) {
  const { error } = await db().from('dev_skill').delete().eq('dev_id', devId).eq('skill_id', skillId);
  if (error) throw error;
}

// ---- helpers de skills ----

interface SkillLink {
  dev_id: string;
  skill_id: string;
  level: number;
  tag: string;
}

async function devSkillLinks(): Promise<SkillLink[]> {
  const [{ data: ds }, { data: sk }] = await Promise.all([
    db().from('dev_skill').select('dev_id, skill_id, level'),
    db().from('skill').select('id, tag'),
  ]);
  const tagById = new Map(((sk ?? []) as unknown as { id: string; tag: string }[]).map((s) => [s.id, s.tag]));
  return ((ds ?? []) as unknown as { dev_id: string; skill_id: string; level: number }[]).map((l) => ({ ...l, tag: tagById.get(l.skill_id) ?? '?' }));
}

async function devSkillsByDev(): Promise<Map<string, SkillLink[]>> {
  const links = await devSkillLinks();
  links.sort((a, b) => b.level - a.level);
  const map = new Map<string, SkillLink[]>();
  links.forEach((l) => {
    if (!map.has(l.dev_id)) map.set(l.dev_id, []);
    map.get(l.dev_id)!.push(l);
  });
  return map;
}

async function devSkills(devId: string): Promise<SkillLink[]> {
  return (await devSkillLinks()).filter((l) => l.dev_id === devId).sort((a, b) => b.level - a.level);
}

// ---- util ----

function countBy<T>(items: T[], key: (t: T) => string | null): Map<string, number> {
  const m = new Map<string, number>();
  items.forEach((it) => {
    const k = key(it);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  });
  return m;
}
