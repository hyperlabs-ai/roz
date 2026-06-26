// Resolución de proyectos: el punto donde trabajo (Linear) y código (GitHub) se anclan al
// mismo proyecto canónico, sin mezclarse.
//
//  · repo → proyecto: full_name → public.github_repositories (HyperOps) → project_id →
//    roz.project por hyperops_project_id. Muchos repos → un proyecto. Resolución EN VIVO,
//    así un repo nuevo en github_repositories queda trackeado sin onboarding.
//  · Linear Project → roz.project: por linear_project_id (auto-onboarding desde webhook).
import { db, dbPublic } from '../db/supabase.js';
import { enqueueRepoBackfill } from '../reconcile/backfill.js';

export interface RozProject {
  id: string;
  key: string;
  name: string;
  linear_team_id: string | null;
  linear_project_id: string | null;
  hyperops_project_id: string | null;
}

const PROJECT_COLS = 'id, key, name, linear_team_id, linear_project_id, hyperops_project_id';

/** Resuelve el roz.project de un repo. Primero el mapeo directo en roz (cubre repos internos y
 *  de cliente configurados explícitamente); como fallback, la tabla de repos de HyperOps. */
export async function resolveProjectByRepo(fullName: string): Promise<RozProject | null> {
  const supabase = db();

  // 1. Mapeo directo roz.project_repo (interno o cliente). Los repos se guardan en minúsculas
  //    (ver normalizeRepo); el webhook puede traer otro casing ("owner/Mind-playground"), así que
  //    se compara contra la forma en minúsculas para no perder la vinculación.
  const { data: link } = await supabase
    .from('project_repo')
    .select('project_id')
    .eq('repo', fullName.toLowerCase())
    .maybeSingle();
  if (link?.project_id) {
    const { data: project } = await supabase.from('project').select(PROJECT_COLS).eq('id', link.project_id).maybeSingle();
    if (project) return project as RozProject;
  }

  // 2. Fallback: repo → project_id (HyperOps) → roz.project por hyperops_project_id.
  const { data: repo } = await dbPublic()
    .from('github_repositories')
    .select('project_id')
    .eq('full_name', fullName)
    .eq('active', true)
    .maybeSingle();
  if (!repo?.project_id) return null;
  const { data: project } = await supabase.from('project').select(PROJECT_COLS).eq('hyperops_project_id', repo.project_id).maybeSingle();
  return (project as RozProject) ?? null;
}

/** Resuelve el roz.project de un issue de Linear por su Linear Project (fallback: team). */
export async function resolveProjectByLinear(
  linearProjectId: string | null,
  linearTeamId: string | null,
): Promise<RozProject | null> {
  const supabase = db();
  if (linearProjectId) {
    const { data } = await supabase
      .from('project')
      .select('id, key, name, linear_team_id, linear_project_id, hyperops_project_id')
      .eq('linear_project_id', linearProjectId)
      .maybeSingle();
    if (data) return data as RozProject;
  }
  if (linearTeamId) {
    const { data } = await supabase
      .from('project')
      .select('id, key, name, linear_team_id, linear_project_id, hyperops_project_id')
      .eq('linear_team_id', linearTeamId)
      .is('linear_project_id', null)
      .maybeSingle();
    if (data) return data as RozProject;
  }
  return null;
}

/**
 * Auto-onboarding: upsert de un roz.project desde un evento de Linear Project. Genera una
 * `key` a partir del nombre si es nuevo. Intenta enlazar el hyperops_project_id por nombre
 * (best-effort) para que la reconciliación de commits encuentre el mismo proyecto.
 */
export async function upsertLinearProject(data: {
  id: string;
  name?: string;
  teamId?: string | null;
}): Promise<{ created: boolean; projectId: string } | null> {
  if (!data.id) return null;
  const supabase = db();
  const name = data.name ?? '(proyecto sin nombre)';

  const { data: existing } = await supabase
    .from('project')
    .select('id')
    .eq('linear_project_id', data.id)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('project')
      .update({ name, linear_team_id: data.teamId ?? null })
      .eq('id', existing.id);
    return { created: false, projectId: existing.id };
  }

  // Best-effort: enlazar con un proyecto de HyperOps por nombre (case-insensitive).
  let hyperopsId: string | null = null;
  const { data: hop } = await dbPublic()
    .from('projects')
    .select('id')
    .ilike('name', name)
    .maybeSingle();
  hyperopsId = hop?.id ?? null;

  const key = slugKey(name);
  const { data: ins, error } = await supabase
    .from('project')
    .insert({
      key,
      name,
      linear_project_id: data.id,
      linear_team_id: data.teamId ?? null,
      hyperops_project_id: hyperopsId,
    })
    .select('id')
    .single();
  if (error) throw error;

  // Backfill del historial de los repos YA asociados al proyecto recién onboardeado: si un repo
  // existía en github_repositories antes que roz, nunca disparó `repo.detected`, así que su trabajo
  // previo es invisible. Best-effort: un fallo aquí no debe tumbar el onboarding (es reintenable).
  await enqueueProjectRepoBackfills(ins.id, hyperopsId).catch(() => {});
  return { created: true, projectId: ins.id };
}

/**
 * Encola el backfill del historial de todos los repos resolubles a un proyecto: los del mapeo
 * directo (roz.project_repo) y los del fallback de HyperOps (github_repositories activos con el
 * mismo hyperops_project_id). Deduplica por full_name. Idempotente aguas abajo (llave por repo).
 */
async function enqueueProjectRepoBackfills(projectId: string, hyperopsId: string | null): Promise<void> {
  const repos = new Set<string>();

  const { data: links } = await db().from('project_repo').select('repo').eq('project_id', projectId);
  for (const l of (links ?? []) as { repo: string }[]) if (l.repo) repos.add(l.repo);

  if (hyperopsId) {
    const { data: ghRepos } = await dbPublic()
      .from('github_repositories')
      .select('full_name')
      .eq('project_id', hyperopsId)
      .eq('active', true);
    for (const r of (ghRepos ?? []) as { full_name: string }[]) if (r.full_name) repos.add(r.full_name);
  }

  for (const repo of repos) await enqueueRepoBackfill(repo, projectId);
}

export function slugKey(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
  return base || `PROJ-${Date.now().toString(36).toUpperCase()}`;
}
