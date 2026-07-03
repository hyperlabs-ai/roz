// Detección de repos nuevos. Disparado por el primer push de un repo que roz nunca había visto
// (evento 'repo.detected' del outbox). Flujo:
//  1. Si el repo YA es resoluble a un proyecto (mapeo directo o HyperOps) → no-op: ya trackeado.
//  2. Si es nuevo → emite 'repo.notify' para avisar a los devs que hay que vincularlo. roz ya NO
//     intenta adivinar a qué proyecto pertenece ni lo vincula solo: un admin lo vincula manualmente
//     desde el dashboard, y esa acción dispara el backfill del historial (ver dashboard.ts).
import { db } from '../db/supabase.js';
import { getRepo, type RepoMeta } from '../adapters/github.js';
import { emit } from '../events/outbox.js';
import { resolveProjectByRepo } from '../projects/resolve.js';

export interface RepoDetectedInput {
  repo: string; // "owner/name"
  /** Para pruebas: si se pasa, no se consulta la API de GitHub. */
  meta?: RepoMeta;
}

export async function handleRepoDetected(input: RepoDetectedInput): Promise<void> {
  const repo = input.repo;
  if (!repo) return;

  // ¿Ya trackeado? (mapeo directo en roz.project_repo o fallback HyperOps) → nada que avisar.
  if (await resolveProjectByRepo(repo)) return;

  const meta = input.meta ?? (await getRepo(repo));

  // Avisar a los devs que hay un repo sin vincular. Idempotente por su propia llave.
  await emit(
    'repo.notify',
    { repo, repoUrl: meta.url, projectId: null, projectName: null, linked: false },
    { idempotencyKey: `repo-notify:${repo}` },
  );
}

export interface RepoRenamedInput {
  from: string; // full_name viejo "owner/name" (puede venir vacío si solo tenemos el id)
  to: string; // full_name nuevo "owner/name"
  githubId?: number | null; // id numérico inmutable del repo (ancla preferente para ubicar el vínculo)
}

/**
 * Reconcilia el rename/transfer de un repo en GitHub (evento `repository` action renamed/transferred,
 * o auto-sanación desde resolveProjectByRepo). Mueve el vínculo repo→proyecto al nombre nuevo, sella
 * el id inmutable, y RE-ETIQUETA el historial (commits + work_items) al nombre nuevo para que las
 * dedup keys (`commit:repo:sha`, `pr:repo:number`) y el dashboard queden consistentes sin perder nada.
 * Idempotente: reprocesarlo no hace daño (los UPDATE por nombre viejo ya no encuentran filas).
 */
export async function handleRepoRenamed(input: RepoRenamedInput): Promise<void> {
  const supabase = db();
  const from = input.from?.toLowerCase() ?? '';
  const to = input.to?.toLowerCase() ?? '';
  if (!to) return;
  const githubId = input.githubId ?? null;

  // 1. Localiza el vínculo: por id inmutable (sobrevive cualquier rename) y, si no lo tenemos, por
  //    el nombre viejo. Si no existe, el repo no estaba trackeado: igual re-etiquetamos el historial
  //    por si quedó trabajo bajo el nombre viejo, pero no creamos un vínculo nuevo aquí.
  type Link = { id: string; project_id: string; repo: string };
  let link: Link | null = null;
  if (githubId != null) {
    const { data } = await supabase
      .from('project_repo')
      .select('id, project_id, repo')
      .eq('github_repo_id', githubId)
      .maybeSingle();
    link = (data as Link | null) ?? null;
  }
  if (!link && from) {
    const { data } = await supabase
      .from('project_repo')
      .select('id, project_id, repo')
      .eq('repo', from)
      .maybeSingle();
    link = (data as Link | null) ?? null;
  }

  if (link && link.repo !== to) {
    // 2. Si ya hay OTRA fila con el nombre nuevo (el repo se auto-onboardeó como "nuevo" tras el
    //    rename, antes de esta corrección), elimínala: choca con el unique(repo) y el vínculo
    //    histórico —con su id e historial— es el bueno.
    const { data: dup } = await supabase.from('project_repo').select('id').eq('repo', to).maybeSingle();
    if (dup && (dup as { id: string }).id !== link.id) {
      await supabase.from('project_repo').delete().eq('id', (dup as { id: string }).id);
    }
  }

  // 3. Mueve el vínculo al nombre nuevo y sella el id inmutable (si lo conocemos).
  if (link) {
    const patch: Record<string, unknown> = { repo: to };
    if (githubId != null) patch.github_repo_id = githubId;
    await supabase.from('project_repo').update(patch).eq('id', link.id);
  }

  // 4. Re-etiqueta el historial al nombre nuevo (dedup keys + dashboard consistentes). El
  //    unique(repo,sha) en commit solo chocaría si el mismo sha existiera bajo ambos nombres, lo
  //    que no ocurre en operación normal (un push tras el rename trae shas nuevos, no los viejos).
  if (from && from !== to) {
    await supabase.from('commit').update({ repo: to }).eq('repo', from);
    await supabase.from('work_item').update({ repo: to }).eq('repo', from);
  }

  // 5. Adopta los commits ya guardados bajo el nombre nuevo SIN proyecto: llegaron entre el rename y
  //    esta corrección, cuando el nombre aún no resolvía (project_id quedó null). Best-effort.
  if (link?.project_id) {
    await supabase.from('commit').update({ project_id: link.project_id }).eq('repo', to).is('project_id', null);
  }
}
