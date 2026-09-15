// Capacidad del equipo: quién es cada quien, dónde está puesto, y cuánto le queda.
//
// Aquí vive la REGLA, no solo la consulta. Dos cosas se calculan y por eso nunca se escriben a
// mano:
//
//  · Cuántas asignaciones principales caben — sale de la dedicación (full_time = 2, part_time = 1).
//  · El estado de carga — sale de sumar el `load_pct` de las asignaciones. La etiqueta
//    ("Disponible", "Carga óptima", "Saturado") es una lectura de ese número, no un campo.
//
// El texto libre sigue existiendo donde el cálculo no llega: `profile` para el matiz del puesto,
// `load_note` para lo que no es una cifra, `continuous_work` para el mantenimiento que alguien
// absorbe. Lo que NO existe es un porcentaje escrito a mano: eso envejece mal.
import { db } from '../db/supabase.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { avatarFor } from './queries.js';

// ---------------------------------------------------------------- vocabulario

export const ROLES = ['ceo', 'pm', 'account_manager', 'dev', 'designer', 'intern'] as const;
export const COMMITMENTS = ['full_time', 'part_time'] as const;
export const ASSIGNMENT_KINDS = ['principal', 'secondary'] as const;

export type Role = (typeof ROLES)[number];
export type Commitment = (typeof COMMITMENTS)[number];
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];

/** Horas semanales por defecto de cada dedicación. `dev.weekly_hours` las pisa cuando está puesta. */
const WEEKLY_HOURS: Record<Commitment, number> = { full_time: 40, part_time: 20 };

/**
 * Cuántas asignaciones PRINCIPALES admite cada dedicación.
 *
 * Es la regla que pidió el equipo: quien está de tiempo completo puede encabezar dos frentes; quien
 * está de medio tiempo, uno — repartir a alguien de 20 h entre dos proyectos principales no es una
 * asignación, es una cola de espera.
 */
const MAX_PRINCIPAL: Record<Commitment, number> = { full_time: 2, part_time: 1 };

/** Las secundarias no tienen tope duro: son apoyo, y el freno real es el % de carga. */
export function maxPrincipal(commitment: Commitment): number {
  return MAX_PRINCIPAL[commitment] ?? 1;
}

export function weeklyHoursOf(commitment: Commitment, override: number | null): number {
  return override && override > 0 ? override : WEEKLY_HOURS[commitment] ?? WEEKLY_HOURS.part_time;
}

// ---------------------------------------------------------------- estado de carga

export type LoadState = 'libre' | 'disponible' | 'optima' | 'completa' | 'saturada';

/**
 * Lectura del porcentaje de carga.
 *
 * Los cortes no son redondos por gusto: 85-100 es "óptima" porque planificar a alguien al 100%
 * clavado no deja hueco para lo que siempre aparece, y >100 es "saturada" — un dato que hay que
 * poder ver, no uno que haya que impedir escribir. Topar la suma en 100 escondería justo el
 * problema que esta pantalla existe para enseñar.
 */
export function loadState(pct: number): LoadState {
  if (pct > 100) return 'saturada';
  if (pct >= 85) return pct === 100 ? 'completa' : 'optima';
  if (pct >= 50) return 'disponible';
  return 'libre';
}

// ---------------------------------------------------------------- tipos de salida

export interface CapacityAssignment {
  id: string;
  kind: AssignmentKind;
  projectId: string | null;
  projectName: string | null;
  repoId: string | null;
  repo: string | null;
  focus: string | null;
  loadPct: number;
  position: number;
}

export interface CapacitySkill { skillId: string; tag: string; level: number }

export interface CapacityRow {
  id: string;
  name: string;
  avatarUrl: string | null;
  active: boolean;
  role: Role;
  commitment: Commitment;
  profile: string | null;
  /** Horas efectivas: las suyas si las tiene, si no el default de su dedicación. */
  weeklyHours: number;
  /** Lo que hay guardado en la fila (null = hereda). Lo necesita el formulario para no fijar un valor que era heredado. */
  weeklyHoursOverride: number | null;
  continuousWork: string | null;
  loadNote: string | null;
  principal: CapacityAssignment[];
  secondary: CapacityAssignment[];
  skills: CapacitySkill[];
  /** Todo lo derivado, junto y nombrado, para que el front no vuelva a calcularlo por su cuenta. */
  load: {
    pct: number;
    state: LoadState;
    hoursUsed: number;
    hoursFree: number;
    maxPrincipal: number;
    /** true = tiene más principales de las que su dedicación admite (p.ej. tras bajarle las horas). */
    overAssigned: boolean;
  };
}

export interface CapacityResponse {
  devs: CapacityRow[];
  projects: { id: string; name: string; key: string; repos: { id: string; repo: string }[] }[];
  totals: { people: number; hours: number; hoursUsed: number; saturated: number; free: number };
}

// ---------------------------------------------------------------- lectura

interface DevRecord {
  id: string; name: string; github_login: string | null; active: boolean;
  role: string | null; commitment: string | null; profile: string | null;
  weekly_hours: number | null; continuous_work: string | null; load_note: string | null;
}

interface AssignmentRecord {
  id: string; dev_id: string; kind: string; project_id: string | null; repo_id: string | null;
  focus: string | null; load_pct: number; sort_order: number;
}

export async function getCapacity(): Promise<CapacityResponse> {
  const supabase = db();
  const [devs, assignments, projects, repos, skillLinks, skills] = await Promise.all([
    supabase.from('dev')
      .select('id, name, github_login, active, role, commitment, profile, weekly_hours, continuous_work, load_note')
      .order('name'),
    supabase.from('dev_assignment').select('id, dev_id, kind, project_id, repo_id, focus, load_pct, sort_order'),
    supabase.from('project').select('id, name, key, active').order('name'),
    supabase.from('project_repo').select('id, repo, project_id').order('repo'),
    supabase.from('dev_skill').select('dev_id, skill_id, level'),
    supabase.from('skill').select('id, tag'),
  ]);

  const devRows = (devs.data ?? []) as unknown as DevRecord[];
  const assignRows = (assignments.data ?? []) as unknown as AssignmentRecord[];
  const projectRows = (projects.data ?? []) as unknown as { id: string; name: string; key: string; active: boolean }[];
  const repoRows = (repos.data ?? []) as unknown as { id: string; repo: string; project_id: string }[];
  const linkRows = (skillLinks.data ?? []) as unknown as { dev_id: string; skill_id: string; level: number }[];
  const skillRows = (skills.data ?? []) as unknown as { id: string; tag: string }[];

  const projectName = new Map(projectRows.map((p) => [p.id, p.name]));
  const repoById = new Map(repoRows.map((r) => [r.id, r]));
  const tagById = new Map(skillRows.map((s) => [s.id, s.tag]));

  const byDev = new Map<string, AssignmentRecord[]>();
  for (const a of assignRows) {
    if (!byDev.has(a.dev_id)) byDev.set(a.dev_id, []);
    byDev.get(a.dev_id)!.push(a);
  }

  // Skills de mayor a menor nivel: la columna de trabajo continuo se lee de arriba abajo, y lo que
  // importa ahí es en qué es más fuerte la persona.
  const skillsByDev = new Map<string, CapacitySkill[]>();
  for (const l of linkRows) {
    if (!skillsByDev.has(l.dev_id)) skillsByDev.set(l.dev_id, []);
    skillsByDev.get(l.dev_id)!.push({ skillId: l.skill_id, tag: tagById.get(l.skill_id) ?? '?', level: l.level });
  }
  for (const list of skillsByDev.values()) list.sort((a, b) => b.level - a.level || a.tag.localeCompare(b.tag));

  const shape = (a: AssignmentRecord): CapacityAssignment => {
    const repo = a.repo_id ? repoById.get(a.repo_id) ?? null : null;
    return {
      id: a.id,
      kind: (a.kind === 'secondary' ? 'secondary' : 'principal') as AssignmentKind,
      projectId: a.project_id,
      projectName: a.project_id ? projectName.get(a.project_id) ?? null : null,
      repoId: a.repo_id,
      repo: repo?.repo ?? null,
      focus: a.focus,
      loadPct: a.load_pct ?? 0,
      position: a.sort_order ?? 0,
    };
  };
  const byPosition = (a: CapacityAssignment, b: CapacityAssignment) => a.position - b.position;

  const rows: CapacityRow[] = devRows.map((d) => {
    const commitment: Commitment = d.commitment === 'full_time' ? 'full_time' : 'part_time';
    const role = (ROLES as readonly string[]).includes(d.role ?? '') ? (d.role as Role) : 'dev';
    const mine = (byDev.get(d.id) ?? []).map(shape);
    const principal = mine.filter((a) => a.kind === 'principal').sort(byPosition);
    const secondary = mine.filter((a) => a.kind === 'secondary').sort(byPosition);

    const hours = weeklyHoursOf(commitment, d.weekly_hours);
    const pct = mine.reduce((sum, a) => sum + a.loadPct, 0);
    const cap = maxPrincipal(commitment);

    return {
      id: d.id,
      name: d.name,
      avatarUrl: avatarFor(d.github_login),
      active: d.active,
      role,
      commitment,
      profile: d.profile,
      weeklyHours: hours,
      weeklyHoursOverride: d.weekly_hours,
      continuousWork: d.continuous_work,
      loadNote: d.load_note,
      principal,
      secondary,
      skills: skillsByDev.get(d.id) ?? [],
      load: {
        pct,
        state: loadState(pct),
        hoursUsed: Math.round((hours * pct) / 100),
        // Nunca negativo: por encima del 100% lo que sobra no son horas libres, es deuda — y esa
        // la cuenta `state: 'saturada'`.
        hoursFree: Math.max(0, Math.round((hours * (100 - pct)) / 100)),
        maxPrincipal: cap,
        overAssigned: principal.length > cap,
      },
    };
  });

  const active = rows.filter((r) => r.active);
  return {
    devs: rows,
    projects: projectRows
      .filter((p) => p.active !== false)
      .map((p) => ({
        id: p.id,
        name: p.name,
        key: p.key,
        repos: repoRows.filter((r) => r.project_id === p.id).map((r) => ({ id: r.id, repo: r.repo })),
      })),
    totals: {
      people: active.length,
      hours: active.reduce((s, r) => s + r.weeklyHours, 0),
      hoursUsed: active.reduce((s, r) => s + r.load.hoursUsed, 0),
      saturated: active.filter((r) => r.load.state === 'saturada' || r.load.overAssigned).length,
      free: active.filter((r) => r.load.state === 'libre').length,
    },
  };
}

// ---------------------------------------------------------------- escritura

export interface DevCapacityPatch {
  role?: Role;
  commitment?: Commitment;
  profile?: string | null;
  weeklyHours?: number | null;
  continuousWork?: string | null;
  loadNote?: string | null;
}

/**
 * Edita el perfil de capacidad de un dev.
 *
 * Bajar a alguien de full_time a part_time con dos principales encima se RECHAZA en vez de
 * recortarle una asignación por su cuenta: cuál de las dos sobra es una decisión de quien reparte
 * el trabajo, y borrar la que el código elija sería perder información sin avisar.
 */
export async function updateDevCapacity(devId: string, patch: DevCapacityPatch): Promise<void> {
  const supabase = db();
  const row: Record<string, unknown> = {};
  if (patch.role !== undefined) row.role = patch.role;
  if (patch.commitment !== undefined) row.commitment = patch.commitment;
  if (patch.profile !== undefined) row.profile = patch.profile?.trim() || null;
  if (patch.weeklyHours !== undefined) row.weekly_hours = patch.weeklyHours ?? null;
  if (patch.continuousWork !== undefined) row.continuous_work = patch.continuousWork?.trim() || null;
  if (patch.loadNote !== undefined) row.load_note = patch.loadNote?.trim() || null;
  if (!Object.keys(row).length) return;

  if (patch.commitment) {
    const { count } = await supabase
      .from('dev_assignment')
      .select('id', { count: 'exact', head: true })
      .eq('dev_id', devId)
      .eq('kind', 'principal');
    const cap = maxPrincipal(patch.commitment);
    if ((count ?? 0) > cap) {
      throw new ValidationError(
        `No se puede pasar a ${patch.commitment === 'full_time' ? 'tiempo completo' : 'medio tiempo'}: ` +
        `tiene ${count} proyectos principales y ahí caben ${cap}. Quita uno primero.`,
      );
    }
  }

  row.updated_at = new Date().toISOString();
  const { error } = await supabase.from('dev').update(row).eq('id', devId);
  if (error) throw error;
}

export interface AssignmentInput {
  kind?: AssignmentKind;
  projectId?: string | null;
  repoId?: string | null;
  focus?: string | null;
  loadPct?: number;
  position?: number;
}

/** Cuántas principales tiene ya, sin contar una que se esté moviendo. */
async function principalCount(devId: string, exceptId?: string): Promise<number> {
  let q = db().from('dev_assignment').select('id', { count: 'exact', head: true })
    .eq('dev_id', devId).eq('kind', 'principal');
  if (exceptId) q = q.neq('id', exceptId);
  const { count } = await q;
  return count ?? 0;
}

async function commitmentOf(devId: string): Promise<Commitment> {
  const { data } = await db().from('dev').select('commitment').eq('id', devId).single();
  return (data as { commitment: string } | null)?.commitment === 'full_time' ? 'full_time' : 'part_time';
}

/** El tope de principales se comprueba ANTES de escribir: al crear y al convertir una secundaria. */
async function assertPrincipalFits(devId: string, exceptId?: string): Promise<void> {
  const commitment = await commitmentOf(devId);
  const cap = maxPrincipal(commitment);
  if ((await principalCount(devId, exceptId)) >= cap) {
    throw new ValidationError(
      cap === 1
        ? 'De medio tiempo solo cabe un proyecto principal. Ponlo como secundario o cambia el que ya tiene.'
        : `Ya tiene ${cap} proyectos principales, que es el máximo de tiempo completo.`,
    );
  }
}

export async function createAssignment(devId: string, input: AssignmentInput): Promise<string> {
  const kind: AssignmentKind = input.kind === 'secondary' ? 'secondary' : 'principal';
  if (kind === 'principal') await assertPrincipalFits(devId);

  const { data, error } = await db().from('dev_assignment').insert({
    dev_id: devId,
    kind,
    project_id: input.projectId ?? null,
    repo_id: input.repoId ?? null,
    focus: input.focus?.trim() || null,
    load_pct: input.loadPct ?? 0,
    sort_order: input.position ?? 0,
  }).select('id').single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function updateAssignment(id: string, input: AssignmentInput): Promise<void> {
  const supabase = db();
  const { data: current } = await supabase.from('dev_assignment').select('dev_id, kind').eq('id', id).single();
  const cur = current as { dev_id: string; kind: string } | null;
  if (!cur) throw new NotFoundError('La asignación ya no existe');

  // Pasar de secundaria a principal es lo único que puede rebasar el tope; al revés siempre cabe.
  if (input.kind === 'principal' && cur.kind !== 'principal') {
    await assertPrincipalFits(cur.dev_id, id);
  }

  const row: Record<string, unknown> = {};
  if (input.kind !== undefined) row.kind = input.kind;
  // `projectId` a null limpia también el repo: un repo sin su proyecto dejaría la fila apuntando a
  // algo que la tabla ya no enseña, y el trigger de la migración lo rechazaría de todos modos.
  if (input.projectId !== undefined) {
    row.project_id = input.projectId;
    if (input.projectId === null) row.repo_id = null;
  }
  if (input.repoId !== undefined) row.repo_id = input.repoId;
  if (input.focus !== undefined) row.focus = input.focus?.trim() || null;
  if (input.loadPct !== undefined) row.load_pct = input.loadPct;
  if (input.position !== undefined) row.sort_order = input.position;
  if (!Object.keys(row).length) return;

  row.updated_at = new Date().toISOString();
  const { error } = await supabase.from('dev_assignment').update(row).eq('id', id);
  if (error) throw error;
}

export async function deleteAssignment(id: string): Promise<void> {
  const { error } = await db().from('dev_assignment').delete().eq('id', id);
  if (error) throw error;
}
