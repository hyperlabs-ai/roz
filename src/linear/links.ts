// Mapeo roz ↔ Linear (roz.linear_link, migración 0036). El webhook y la API de Linear solo hablan
// en ids; aquí se traducen a lo que son en roz:
//
//   · user  → roz.dev por CORREO (dev.email o dev.github_email, en minúsculas). No por nombre: dos
//             "Ana" en el equipo no deben cruzarse.
//   · label → roz.solution_type por NOMBRE (sin distinguir mayúsculas): el tipo de solución viaja a
//             Linear como etiqueta y regresa por la misma etiqueta.
//   · team  → equipo de Linear; el de cada proyecto vive en project.linear_team_id (o el default
//             LINEAR_TEAM_ID).
//   · project → roz.project por project.linear_project_id.
//   · state → estados del workflow de cada equipo (key = tipo), para mover issues por estado.
//
// syncLinearLinks() refresca la tabla completa (cron de reconciliación y webhooks de etiquetas,
// usuarios o proyectos). Los resolvedores leen solo la tabla: nunca le pegan a Linear.
import { db } from '../db/supabase.js';
import { config } from '../config.js';
import {
  listLabels,
  listProjects,
  listTeams,
  listUsers,
  listWorkflowStates,
  type LinearLabel,
  type LinearProject,
  type LinearTeam,
  type LinearUser,
  type LinearWorkflowState,
} from '../adapters/linear.js';
import type { LinearLinkKind, LinearStateType } from '../types/roz-v2.js';
import type { TaskState } from '../tasks/states.js';

// ---------------------------------------------------------------- piezas puras (probadas)

export interface DevLite {
  id: string;
  email: string | null;
  github_email: string | null;
  linear_user_id?: string | null;
}

export interface ProjectLite {
  id: string;
  linear_team_id: string | null;
  linear_project_id: string | null;
}

export interface SolutionTypeLite {
  id: string;
  name: string;
}

/** Fila de linear_link lista para upsert (sin id ni timestamps). */
export interface LinkRow {
  kind: LinearLinkKind;
  linear_id: string;
  roz_id: string | null;
  team_id: string | null;
  name: string;
  key: string | null;
  meta: Record<string, unknown>;
  active: boolean;
}

const lower = (s: string | null | undefined): string | null => (s ? s.trim().toLowerCase() : null) || null;

/** Correo → dev. Si dos devs reclaman el mismo correo, gana el de `email` sobre `github_email`. */
export function devByEmail(devs: DevLite[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of devs) {
    const g = lower(d.github_email);
    if (g && !out.has(g)) out.set(g, d.id);
  }
  for (const d of devs) {
    const e = lower(d.email);
    if (e) out.set(e, d.id);
  }
  return out;
}

export function userLinks(users: LinearUser[], devs: DevLite[]): LinkRow[] {
  const byEmail = devByEmail(devs);
  return users.map((u) => {
    const email = lower(u.email);
    return {
      kind: 'user',
      linear_id: u.id,
      roz_id: email ? byEmail.get(email) ?? null : null,
      team_id: null,
      name: u.displayName || u.name,
      key: email,
      meta: { name: u.name, avatarUrl: u.avatarUrl },
      active: u.active,
    };
  });
}

/** Un equipo solo se liga a un proyecto si es el ÚNICO que lo usa (varios proyectos pueden compartir equipo). */
export function teamLinks(teams: LinearTeam[], projects: ProjectLite[]): LinkRow[] {
  return teams.map((t) => {
    const owners = projects.filter((p) => p.linear_team_id === t.id);
    return {
      kind: 'team',
      linear_id: t.id,
      roz_id: owners.length === 1 ? owners[0]!.id : null,
      team_id: null,
      name: t.name,
      key: t.key,
      meta: { projects: owners.map((p) => p.id) },
      active: true,
    };
  });
}

export function labelLinks(labels: LinearLabel[], types: SolutionTypeLite[]): LinkRow[] {
  const byName = new Map(types.map((t) => [t.name.trim().toLowerCase(), t.id]));
  return labels.map((l) => ({
    kind: 'label',
    linear_id: l.id,
    roz_id: byName.get(l.name.trim().toLowerCase()) ?? null,
    team_id: l.teamId,
    name: l.name,
    key: null,
    meta: { color: l.color },
    active: true,
  }));
}

export function stateLinks(states: LinearWorkflowState[]): LinkRow[] {
  return states.map((s) => ({
    kind: 'state',
    linear_id: s.id,
    roz_id: null,
    team_id: s.teamId,
    name: s.name,
    key: s.type,
    meta: { position: s.position },
    active: true,
  }));
}

export function projectLinks(linearProjects: LinearProject[], projects: ProjectLite[]): LinkRow[] {
  const byLinear = new Map(projects.filter((p) => p.linear_project_id).map((p) => [p.linear_project_id!, p.id]));
  return linearProjects.map((p) => ({
    kind: 'project',
    linear_id: p.id,
    roz_id: byLinear.get(p.id) ?? null,
    team_id: p.teamIds[0] ?? null,
    name: p.name,
    key: null,
    meta: { state: p.state, teamIds: p.teamIds },
    active: true,
  }));
}

/** status de roz → tipo de estado de Linear (lo inverso de linearStateToStatus). */
export function statusToLinearStateType(status: TaskState): LinearStateType {
  switch (status) {
    case 'planificada':
      return 'backlog';
    case 'pendiente':
      return 'unstarted';
    case 'en_progreso':
    case 'revision':
      return 'started';
    case 'completada':
      return 'completed';
    case 'cancelada':
      return 'canceled';
  }
}

const REVIEW_NAME = /review|revisi[oó]n|qa/i;

/**
 * Estado de Linear para un status de roz, entre los estados de UN equipo. `revision` busca un
 * estado `started` con nombre de revisión; `en_progreso`, uno `started` que NO lo sea. Dentro del
 * tipo gana el de menor posición (el primero del tablero). null = el equipo no tiene ese tipo.
 */
export function pickStateForStatus(
  states: { id: string; name: string; key: string | null; position: number }[],
  status: TaskState,
): string | null {
  const type = statusToLinearStateType(status);
  let pool = states.filter((s) => s.key === type);
  if (type === 'started') {
    const wantReview = status === 'revision';
    const exact = pool.filter((s) => REVIEW_NAME.test(s.name) === wantReview);
    if (exact.length) pool = exact;
  }
  pool.sort((a, b) => a.position - b.position);
  return pool[0]?.id ?? null;
}

// ---------------------------------------------------------------- base

async function upsertLinks(rows: LinkRow[], kind: LinearLinkKind, teamScope?: string | null): Promise<number> {
  const supabase = db();
  const now = new Date().toISOString();
  if (rows.length) {
    const { error } = await supabase
      .from('linear_link')
      .upsert(rows.map((r) => ({ ...r, updated_at: now })), { onConflict: 'kind,linear_id' });
    if (error) throw error;
  }
  // Lo que ya no existe en Linear queda inactivo (no se borra: issues viejos aún lo referencian).
  const seen = new Set(rows.map((r) => r.linear_id));
  let q = supabase.from('linear_link').select('id, linear_id').eq('kind', kind).eq('active', true);
  if (teamScope) q = q.eq('team_id', teamScope);
  const { data } = await q;
  const gone = ((data ?? []) as { id: string; linear_id: string }[]).filter((r) => !seen.has(r.linear_id)).map((r) => r.id);
  if (gone.length) await supabase.from('linear_link').update({ active: false, updated_at: now }).in('id', gone);
  return rows.length;
}

/** Refresca linear_link: equipos, usuarios, etiquetas, estados y proyectos. Una llamada por tipo. */
export async function syncLinearLinks(): Promise<{ teams: number; users: number; labels: number; states: number; projects: number }> {
  const supabase = db();
  const [teams, users, labels, states, linearProjects, devsQ, projectsQ, typesQ] = await Promise.all([
    listTeams(),
    listUsers(),
    listLabels(),
    listWorkflowStates(),
    listProjects(),
    supabase.from('dev').select('id, email, github_email'),
    supabase.from('project').select('id, linear_team_id, linear_project_id'),
    supabase.from('solution_type').select('id, name'),
  ]);
  const devs = (devsQ.data ?? []) as DevLite[];
  const projects = (projectsQ.data ?? []) as ProjectLite[];
  const types = (typesQ.data ?? []) as SolutionTypeLite[];

  return {
    teams: await upsertLinks(teamLinks(teams, projects), 'team'),
    users: await upsertLinks(userLinks(users, devs), 'user'),
    labels: await upsertLinks(labelLinks(labels, types), 'label'),
    states: await upsertLinks(stateLinks(states), 'state'),
    projects: await upsertLinks(projectLinks(linearProjects, projects), 'project'),
  };
}

// ---------------------------------------------------------------- resolvedores (solo lectura)

/** Usuario de Linear de un dev: por vínculo directo (roz_id) o por su correo. */
export async function linearUserForDev(devId: string): Promise<string | null> {
  const supabase = db();
  const { data: direct } = await supabase
    .from('linear_link')
    .select('linear_id')
    .eq('kind', 'user')
    .eq('roz_id', devId)
    .eq('active', true)
    .limit(1)
    .maybeSingle();
  if (direct) return (direct as { linear_id: string }).linear_id;

  const { data: dev } = await supabase.from('dev').select('id, email, github_email, linear_user_id').eq('id', devId).maybeSingle();
  if (!dev) return null;
  const d = dev as DevLite;
  const emails = [lower(d.email), lower(d.github_email)].filter((e): e is string => !!e);
  if (emails.length) {
    const { data: byEmail } = await supabase
      .from('linear_link')
      .select('linear_id, key')
      .eq('kind', 'user')
      .eq('active', true)
      .in('key', emails);
    const rows = (byEmail ?? []) as { linear_id: string; key: string }[];
    // dev.email gana sobre github_email.
    const hit = emails.map((e) => rows.find((r) => r.key === e)).find(Boolean);
    if (hit) return hit.linear_id;
  }
  // Compat: el campo de la era del espejo viejo (0001).
  return d.linear_user_id ?? null;
}

/** Dev de roz de un usuario de Linear: vínculo, luego correo, luego dev.linear_user_id. */
export async function devForLinearUser(linearUserId: string): Promise<string | null> {
  const supabase = db();
  const { data: link } = await supabase
    .from('linear_link')
    .select('roz_id, key')
    .eq('kind', 'user')
    .eq('linear_id', linearUserId)
    .maybeSingle();
  const l = link as { roz_id: string | null; key: string | null } | null;
  if (l?.roz_id) return l.roz_id;
  if (l?.key) {
    const { data: devs } = await supabase.from('dev').select('id, email, github_email');
    const hit = devByEmail((devs ?? []) as DevLite[]).get(l.key);
    if (hit) return hit;
  }
  const { data: legacy } = await supabase.from('dev').select('id').eq('linear_user_id', linearUserId).limit(1).maybeSingle();
  return (legacy as { id: string } | null)?.id ?? null;
}

/** Equipo de Linear donde nacen los issues de un proyecto: el suyo o el default. */
export async function teamForProject(projectId: string): Promise<{ teamId: string; teamKey: string | null } | null> {
  const supabase = db();
  const { data: p } = await supabase.from('project').select('linear_team_id').eq('id', projectId).maybeSingle();
  const teamId = (p as { linear_team_id: string | null } | null)?.linear_team_id || config.linear.teamId || null;
  if (!teamId) return null;
  const { data: t } = await supabase.from('linear_link').select('key').eq('kind', 'team').eq('linear_id', teamId).maybeSingle();
  return { teamId, teamKey: (t as { key: string | null } | null)?.key ?? null };
}

/**
 * Proyecto de roz de un issue. Por proyecto de Linear (project.linear_project_id o su vínculo); sin
 * él, por equipo solo si UN proyecto de roz usa ese equipo. null = no se sabe (queda sin proyecto).
 */
export async function projectForLinear(teamId: string, linearProjectId: string | null): Promise<string | null> {
  const supabase = db();
  if (linearProjectId) {
    const { data: p } = await supabase.from('project').select('id').eq('linear_project_id', linearProjectId).limit(1).maybeSingle();
    if (p) return (p as { id: string }).id;
    const { data: l } = await supabase.from('linear_link').select('roz_id').eq('kind', 'project').eq('linear_id', linearProjectId).maybeSingle();
    const rozId = (l as { roz_id: string | null } | null)?.roz_id;
    if (rozId) return rozId;
  }
  const { data: byTeam } = await supabase.from('project').select('id').eq('linear_team_id', teamId);
  const rows = (byTeam ?? []) as { id: string }[];
  return rows.length === 1 ? rows[0]!.id : null;
}

/** Etiqueta de Linear de un tipo de solución, preferente la del equipo; si no, la del workspace. */
export async function labelForSolutionType(solutionTypeId: string, teamId: string): Promise<string | null> {
  const { data } = await db()
    .from('linear_link')
    .select('linear_id, team_id')
    .eq('kind', 'label')
    .eq('roz_id', solutionTypeId)
    .eq('active', true);
  const rows = (data ?? []) as { linear_id: string; team_id: string | null }[];
  return (rows.find((r) => r.team_id === teamId) ?? rows.find((r) => r.team_id === null))?.linear_id ?? null;
}

/** Tipo de solución de un issue: la PRIMERA de sus etiquetas (en el orden de Linear) con vínculo. */
export async function solutionTypeForLabels(labelIds: string[]): Promise<string | null> {
  if (!labelIds.length) return null;
  const { data } = await db().from('linear_link').select('linear_id, roz_id').eq('kind', 'label').in('linear_id', labelIds);
  const byId = new Map(((data ?? []) as { linear_id: string; roz_id: string | null }[]).map((r) => [r.linear_id, r.roz_id]));
  for (const id of labelIds) {
    const rozId = byId.get(id);
    if (rozId) return rozId;
  }
  return null;
}

/** Estado de Linear para un status de roz dentro de un equipo (lo usa la migración de tareas nativas). */
export async function stateForStatus(teamId: string, status: TaskState): Promise<string | null> {
  const { data } = await db().from('linear_link').select('linear_id, name, key, meta').eq('kind', 'state').eq('team_id', teamId).eq('active', true);
  const rows = ((data ?? []) as { linear_id: string; name: string; key: string | null; meta: { position?: number } | null }[]).map((r) => ({
    id: r.linear_id,
    name: r.name,
    key: r.key,
    position: Number(r.meta?.position ?? 0),
  }));
  return pickStateForStatus(rows, status);
}
