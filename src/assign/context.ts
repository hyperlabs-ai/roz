// Carga de la base lo que necesitan la clasificación y la política. Aquí vive TODO el I/O de la
// asignación automática (salvo la llamada a Jev y el registro): policy.ts y classify.ts son puros.
import { db } from '../db/supabase.js';
import { weeklyHoursOf, type Commitment } from '../dashboard/capacity.js';
import { OPEN_STATES } from '../tasks/states.js';
import { AppError } from '../utils/errors.js';
import { projectTypeForJev } from '../projects/profile.js';
import type { CatalogSkill, ProjectOption, SolutionTypeDef, TaskInput } from './classify.js';
import { POLICY, type DevFacts, type OpenTaskFacts } from './policy.js';

export interface TaskRow {
  id: string;
  identifier: string;
  project_id: string | null;
  name: string;
  description: string | null;
  status: string;
  priority: string | null;
  estimate: number | null;
  due_date: string | null;
  source: string | null;
  assignee_dev_id: string | null;
  solution_type_id: string | null;
}

const TASK_COLUMNS = 'id, identifier, project_id, name, description, status, priority, estimate, due_date, source, assignee_dev_id, solution_type_id';

export async function loadTask(id: string): Promise<TaskRow | null> {
  const { data, error } = await db().from('work_item').select(TASK_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as unknown as TaskRow) ?? null;
}

/** ¿Tiene algún responsable (principal o de apoyo)? */
export async function hasAnyAssignee(task: TaskRow): Promise<boolean> {
  if (task.assignee_dev_id) return true;
  const { count } = await db().from('work_item_assignee').select('dev_id', { count: 'exact', head: true }).eq('work_item_id', task.id);
  return (count ?? 0) > 0;
}

/** Catálogo de skills SIN embeddings (Jev recibe tag + descripción, nada más). */
export async function loadCatalog(): Promise<CatalogSkill[]> {
  const { data, error } = await db().from('skill').select('id, tag, description').order('tag');
  if (error) throw error;
  return ((data ?? []) as CatalogSkill[]).filter((s) => !!s.tag);
}

const SOLUTION_TYPE_COLUMNS = 'id, slug, name, description, primary_skill_id, min_level, secondary_skill_id, size_min, size_max, active, sort_order';

/**
 * Todos los tipos de solución (activos e inactivos: una tarea puede citar uno ya retirado), en el
 * orden de la tabla. Las skills se resuelven contra el catálogo que se le pasa.
 */
export async function loadSolutionTypes(catalog: CatalogSkill[]): Promise<SolutionTypeDef[]> {
  const { data, error } = await db().from('solution_type').select(SOLUTION_TYPE_COLUMNS).order('sort_order').order('name');
  if (error) {
    // Sin la migración 0032 la tabla no existe: un mensaje que diga qué hacer, no un 500 críptico.
    if ((error as { code?: string }).code === 'PGRST205' || (error as { code?: string }).code === '42P01') {
      throw new AppError('MIGRATION_MISSING', 'Falta aplicar la migración 0032 (tipos de solución) en la base de datos', 503);
    }
    throw error;
  }
  const byId = new Map(catalog.map((s) => [s.id, { id: s.id, tag: s.tag }]));
  return ((data ?? []) as {
    id: string;
    slug: string;
    name: string;
    description: string;
    primary_skill_id: string | null;
    min_level: number;
    secondary_skill_id: string | null;
    size_min: number;
    size_max: number;
    active: boolean;
  }[]).map((t) => ({
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    primarySkill: t.primary_skill_id ? byId.get(t.primary_skill_id) ?? null : null,
    minLevel: t.min_level,
    secondarySkill: t.secondary_skill_id ? byId.get(t.secondary_skill_id) ?? null : null,
    sizeMin: t.size_min,
    sizeMax: t.size_max,
    active: t.active,
  }));
}

type ProjectRowLite = {
  id: string;
  key: string;
  name: string;
  kind: string | null;
  active?: boolean | null;
  project_type?: string | null;
  description?: string | null;
};

/** Con perfil (0033) si la columna existe; si no, sin él (la asignación no depende de la migración). */
async function selectProjects(filter: (q: any) => any): Promise<ProjectRowLite[]> {
  const full = await filter(db().from('project').select('id, key, name, kind, active, project_type, description'));
  if (!full.error) return (full.data ?? []) as ProjectRowLite[];
  const basic = await filter(db().from('project').select('id, key, name, kind, active'));
  if (basic.error) throw basic.error;
  return (basic.data ?? []) as ProjectRowLite[];
}

function toOption(p: ProjectRowLite): ProjectOption {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    kind: p.kind ?? null,
    type: projectTypeForJev(p.project_type),
    description: p.description?.trim() || null,
    typeKey: p.project_type ?? null,
  };
}

export async function loadActiveProjects(): Promise<ProjectOption[]> {
  const rows = await selectProjects((q) => q.order('name'));
  return rows.filter((p) => p.active !== false).map(toOption);
}

export async function loadProject(id: string): Promise<ProjectOption | null> {
  const rows = await selectProjects((q) => q.eq('id', id).limit(1));
  return rows[0] ? toOption(rows[0]) : null;
}

export function toTaskInput(task: TaskRow, project: ProjectOption | null, prioritySource: 'humano' | 'intake'): TaskInput {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    projectId: task.project_id,
    projectName: project?.name ?? null,
    projectKind: project?.kind ?? null,
    projectType: project?.type ?? null,
    projectDescription: project?.description ?? null,
    projectTypeKey: project?.typeKey ?? null,
    priority: task.priority,
    prioritySource,
    dueDate: task.due_date,
    estimate: task.estimate,
    solutionTypeId: task.solution_type_id,
  };
}

/** Todas las tareas abiertas con responsable principal, paginadas (PostgREST corta en 1000 filas). */
async function openTasksByDev(excludeTaskId: string | null): Promise<Map<string, OpenTaskFacts[]>> {
  const out = new Map<string, OpenTaskFacts[]>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db()
      .from('work_item')
      .select('id, identifier, project_id, status, priority, estimate, due_date, assignee_dev_id')
      .in('status', OPEN_STATES)
      .not('assignee_dev_id', 'is', null)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as {
      id: string;
      identifier: string;
      project_id: string | null;
      status: string;
      priority: string | null;
      estimate: number | null;
      due_date: string | null;
      assignee_dev_id: string;
    }[];
    for (const r of rows) {
      if (r.id === excludeTaskId) continue;
      const list = out.get(r.assignee_dev_id) ?? [];
      list.push({
        id: r.id,
        identifier: r.identifier,
        projectId: r.project_id,
        status: r.status,
        priority: r.priority,
        estimate: r.estimate,
        dueDate: r.due_date,
      });
      out.set(r.assignee_dev_id, list);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * ¿Trabajó en el proyecto en los últimos 90 días? (commit propio o tarea completada como
 * responsable). Una consulta `limit(1)` por persona y fuente: el equipo es chico y así no topamos
 * con el corte de 1000 filas que tendría traer todo el historial.
 */
async function historyOn(devIds: string[], projectId: string): Promise<Set<string>> {
  const since = new Date(Date.now() - POLICY.HISTORY_DAYS * 86_400_000).toISOString();
  const checks = await Promise.all(
    devIds.map(async (devId) => {
      const [commit, done] = await Promise.all([
        db().from('commit').select('id').eq('dev_id', devId).eq('project_id', projectId).gte('committed_at', since).limit(1),
        db()
          .from('work_item')
          .select('id')
          .eq('assignee_dev_id', devId)
          .eq('project_id', projectId)
          .eq('status', 'completada')
          .gte('completed_at', since)
          .limit(1),
      ]);
      return (commit.data?.length ?? 0) > 0 || (done.data?.length ?? 0) > 0 ? devId : null;
    }),
  );
  return new Set(checks.filter((x): x is string => !!x));
}

/**
 * Las personas como las ve la política. Solo activas: un inactivo no es candidato ni revisor, y
 * listarlo como "descartado" en cada decisión solo ensucia el log.
 */
export async function loadDevFacts(projectId: string | null, excludeTaskId: string | null): Promise<DevFacts[]> {
  const { data: devRows, error } = await db()
    .from('dev')
    .select('id, name, active, availability, role, commitment, weekly_hours')
    .eq('active', true)
    .order('name');
  if (error) throw error;
  const devs = (devRows ?? []) as {
    id: string;
    name: string;
    active: boolean;
    availability: number | null;
    role: string | null;
    commitment: Commitment | null;
    weekly_hours: number | null;
  }[];
  if (!devs.length) return [];
  const ids = devs.map((d) => d.id);

  const [skills, assignments, openTasks, history] = await Promise.all([
    db().from('dev_skill').select('dev_id, skill_id, level').in('dev_id', ids),
    projectId
      ? db().from('dev_assignment').select('dev_id, kind, load_pct, sort_order').eq('project_id', projectId)
      : Promise.resolve({ data: [], error: null }),
    openTasksByDev(excludeTaskId),
    projectId ? historyOn(ids, projectId) : Promise.resolve(new Set<string>()),
  ]);
  if (skills.error) throw skills.error;
  if (assignments.error) throw assignments.error;

  const levels = new Map<string, Record<string, number>>();
  for (const s of (skills.data ?? []) as { dev_id: string; skill_id: string; level: number | null }[]) {
    const m = levels.get(s.dev_id) ?? {};
    m[s.skill_id] = s.level ?? 3;
    levels.set(s.dev_id, m);
  }

  // Si alguien tiene principal Y secundaria en el mismo proyecto, cuenta la principal.
  const assignment = new Map<string, DevFacts['projectAssignment']>();
  for (const a of (assignments.data ?? []) as { dev_id: string; kind: 'principal' | 'secondary'; load_pct: number | null; sort_order: number | null }[]) {
    const prev = assignment.get(a.dev_id);
    if (prev?.kind === 'principal' && a.kind !== 'principal') continue;
    if (prev && prev.kind === a.kind && prev.loadPct >= (a.load_pct ?? 0)) continue;
    assignment.set(a.dev_id, { kind: a.kind, loadPct: a.load_pct ?? 0, sortOrder: a.sort_order ?? 0 });
  }

  return devs.map((d) => ({
    id: d.id,
    name: d.name,
    active: d.active,
    role: d.role ?? 'dev',
    availability: d.availability ?? 1,
    weeklyHours: weeklyHoursOf(d.commitment ?? 'part_time', d.weekly_hours),
    skillLevels: levels.get(d.id) ?? {},
    projectAssignment: assignment.get(d.id) ?? null,
    hasProjectHistory: history.has(d.id),
    openTasks: openTasks.get(d.id) ?? [],
  }));
}
