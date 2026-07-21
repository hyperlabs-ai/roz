// Resolución de proyectos: ancla el código (GitHub) al proyecto canónico de roz.
//
//  · repo → proyecto: mapeo directo en roz.project_repo (interno/cliente) y, como fallback,
//    full_name → public.github_repositories (HyperOps) → project_id → roz.project por
//    hyperops_project_id. Muchos repos → un proyecto. Resolución EN VIVO, así un repo nuevo en
//    github_repositories queda trackeado sin onboarding.
import { db, dbPublic } from '../db/supabase.js';
import { config } from '../config.js';
import { emit } from '../events/outbox.js';

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
 *  de cliente configurados explícitamente); como fallback, la tabla de repos de HyperOps.
 *  `githubId` (id numérico inmutable del repo) habilita la auto-sanación de renames/transfers:
 *  si el nombre ya no matchea pero el id sí, el vínculo se corrige solo (ver paso 1b). */
export async function resolveProjectByRepo(fullName: string, githubId?: number | null): Promise<RozProject | null> {
  const supabase = db();
  const repoN = fullName.toLowerCase();

  // 1. Mapeo directo roz.project_repo (interno o cliente). Los repos se guardan en minúsculas
  //    (ver normalizeRepo); el webhook puede traer otro casing ("owner/Mind-playground"), así que
  //    se compara contra la forma en minúsculas para no perder la vinculación.
  const { data: link } = await supabase
    .from('project_repo')
    .select('project_id, github_repo_id')
    .eq('repo', repoN)
    .maybeSingle();
  if (link?.project_id) {
    // Sella el id inmutable de forma oportunista: si la fila aún no lo tiene y este evento sí lo
    // trae, lo guardamos. Así los repos ya vinculados (pre-migración) quedan anclados en su próximo
    // push, sin un backfill manual → la auto-sanación (paso 1b) funciona aunque se pierda un webhook.
    if (githubId != null && link.github_repo_id == null) {
      await supabase.from('project_repo').update({ github_repo_id: githubId }).eq('repo', repoN).is('github_repo_id', null).then(() => {}, () => {});
    }
    const { data: project } = await supabase.from('project').select(PROJECT_COLS).eq('id', link.project_id).maybeSingle();
    if (project) return project as RozProject;
  }

  // 1b. Auto-sanación por id inmutable. El nombre no matcheó, pero si traemos el id de GitHub y hay
  //     una fila con ese id bajo OTRO nombre, el repo se renombró/transfirió (y nos perdimos o aún
  //     no procesamos el webhook `repository/renamed`). Encola la corrección del nombre + historial
  //     (idempotente; la procesa handleRepoRenamed) y resuelve ya por el id para no perder este
  //     evento. Misma idempotency key que el webhook → no se duplica el trabajo de rename.
  if (githubId != null) {
    const { data: byId } = await supabase
      .from('project_repo')
      .select('project_id, repo')
      .eq('github_repo_id', githubId)
      .maybeSingle();
    if (byId?.project_id) {
      if (byId.repo !== repoN) {
        await emit(
          'repo.renamed',
          { from: byId.repo, to: repoN, githubId },
          { idempotencyKey: `repo-renamed:${githubId}:${repoN}` },
        ).catch(() => {});
      }
      const { data: project } = await supabase.from('project').select(PROJECT_COLS).eq('id', byId.project_id).maybeSingle();
      if (project) return project as RozProject;
    }
  }

  // 2. Fallback opcional de HyperOps (solo si HYPEROPS_FALLBACK=true): repo → project_id en
  //    public.github_repositories → roz.project por hyperops_project_id. Defensivo: si el schema
  //    `public` no existe/expone en este deploy, no rompe la resolución.
  if (!config.hyperops.fallback) return null;
  try {
    const { data: repo } = await dbPublic()
      .from('github_repositories')
      .select('project_id')
      .eq('full_name', fullName)
      .eq('active', true)
      .maybeSingle();
    if (!repo?.project_id) return null;
    const { data: project } = await supabase.from('project').select(PROJECT_COLS).eq('hyperops_project_id', repo.project_id).maybeSingle();
    return (project as RozProject) ?? null;
  } catch {
    return null;
  }
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
