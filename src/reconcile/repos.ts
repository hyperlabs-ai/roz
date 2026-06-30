// Detección de repos nuevos. Disparado por el primer push de un repo que roz nunca había visto
// (evento 'repo.detected' del outbox). Flujo:
//  1. Si el repo YA es resoluble a un proyecto (mapeo directo o HyperOps) → no-op: ya trackeado.
//  2. Si es nuevo → intenta vincularlo a un proyecto existente por similitud de nombre:
//     primero similitud de texto (slug/Levenshtein) y, si no detecta, una pasada de Claude.
//  3. En cualquier caso (con o sin match) emite 'repo.notify' para avisar a TODOS los devs.
//     El evento se emite ANTES de vincular para que el aviso sobreviva un fallo posterior
//     (si vinculáramos primero y el envío fallara, el reintento vería el repo ya resoluble y
//     haría no-op sin notificar nunca). 'addProjectRepo' es idempotente (unique en repo).
import { db } from '../db/supabase.js';
import { complete } from '../adapters/anthropic.js';
import { getRepo, type RepoMeta } from '../adapters/github.js';
import { emit } from '../events/outbox.js';
import { resolveProjectByRepo } from '../projects/resolve.js';
import { addProjectRepo } from '../dashboard/queries.js';
import { enqueueRepoBackfill } from './backfill.js';

export interface RepoDetectedInput {
  repo: string; // "owner/name"
  /** Para pruebas: si se pasa, no se consulta la API de GitHub. */
  meta?: RepoMeta;
}

interface ProjectRow {
  id: string;
  key: string;
  name: string;
}

function extractJson(s: string): any | null {
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

export async function handleRepoDetected(input: RepoDetectedInput): Promise<void> {
  const repo = input.repo;
  if (!repo) return;

  // 1. ¿Ya trackeado? (mapeo directo en roz.project_repo o fallback HyperOps). Si vinculamos
  //    nosotros en un intento previo, este guard cubre el reintento posterior al emit de notify.
  if (await resolveProjectByRepo(repo)) return;

  const meta = input.meta ?? (await getRepo(repo));
  const match = await matchProject(meta);

  // 2. Notificar SIEMPRE (idempotente por su propia llave) ANTES de vincular.
  await emit(
    'repo.notify',
    {
      repo,
      repoUrl: meta.url,
      projectId: match?.id ?? null,
      projectName: match?.name ?? null,
      linked: !!match,
    },
    { idempotencyKey: `repo-notify:${repo}` },
  );

  // 3. Vincular si hubo match (idempotente: tolera el unique sobre repo) y backfillear su historial
  //    (solo métricas): los commits previos a la vinculación no llegaron por webhook. Idempotente.
  //    Se sella el id numérico inmutable (meta.githubId) como ancla para sobrevivir renames futuros.
  if (match) {
    await addProjectRepoIfAbsent(match.id, repo, meta.githubId);
    await enqueueRepoBackfill(repo, match.id);
  }
}

/** Inserta el mapeo repo→proyecto tolerando el unique (23505) para reintentos seguros del outbox. */
async function addProjectRepoIfAbsent(projectId: string, repo: string, githubId?: number | null): Promise<void> {
  try {
    await addProjectRepo(projectId, repo, githubId);
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') return; // ya vinculado: no-op
    throw err;
  }
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

/**
 * Intenta resolver a qué proyecto pertenece el repo. Primero por similitud de texto (barato,
 * determinista); si no hay match confiable, una pasada de Claude sobre la lista de proyectos.
 */
export async function matchProject(meta: RepoMeta): Promise<ProjectRow | null> {
  const { data } = await db().from('project').select('id, key, name').eq('active', true);
  const projects = (data ?? []) as ProjectRow[];
  if (!projects.length) return null;

  const byText = matchByText(meta.name, projects);
  if (byText) return byText;

  return matchByClaude(meta, projects);
}

/** Normaliza a alfanumérico en minúsculas, sin separadores: "Hyper-Roz_Web" → "hyperrozweb". */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// Tokens genéricos de nombres de repo/proyecto: por sí solos NO son distintivos (dos proyectos
// no relacionados pueden compartirlos), así que no bastan para vincular. Se siguen vinculando por
// key, por ≥2 tokens compartidos, o por nombre≈key. Salvo que el token genérico SEA la key.
const GENERIC_TOKENS = new Set([
  'service', 'services', 'manager', 'management', 'app', 'apps', 'web', 'website', 'api', 'apis',
  'dashboard', 'platform', 'backend', 'frontend', 'portal', 'admin', 'mobile', 'server', 'client',
  'core', 'common', 'shared', 'main', 'site', 'tool', 'tools', 'system', 'engine', 'project',
  'front', 'back', 'landing', 'ecommerce', 'llm', 'test', 'deprecated',
]);

/** Tokens significativos (≥3 chars) de un texto: "Hyper-Roz Web" → ["hyper","roz","web"]. */
function tokenize(s: string): string[] {
  const toks = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  return [...new Set(toks)];
}

/**
 * Similitud de texto contra los proyectos. Hace match si el repo comparte un token DISTINTIVO con
 * el proyecto —igual a su key, un token largo (≥4), o un typo cercano (Levenshtein ≥ 0.85)— o si
 * el nombre completo del repo se parece mucho a la key. Conservador para no vincular por error;
 * lo ambiguo cae al fallback de Claude.
 */
export function matchByText(repoName: string, projects: ProjectRow[]): ProjectRow | null {
  const repoTokens = tokenize(repoName);
  const repoNorm = normalize(repoName);
  if (!repoTokens.length) return null;

  let best: { p: ProjectRow; score: number } | null = null;
  for (const p of projects) {
    const keyNorm = normalize(p.key);
    const pTokens = [...new Set([...tokenize(p.name), ...tokenize(p.key)])];

    let shared = 0;
    let strongest = 0;
    for (const rt of repoTokens) {
      for (const pt of pTokens) {
        if (rt === pt || similarity(rt, pt) >= 0.85) {
          shared++;
          // Un token es "fuerte" (basta solo) si es la key del proyecto o un token distintivo
          // de ≥4 chars. Los genéricos (service, manager, web…) valen como débiles aunque sean
          // largos: solo cuentan si además se comparte otro token o coincide la key.
          const isKey = pt === keyNorm;
          const distinctiveLong = pt.length >= 4 && !GENERIC_TOKENS.has(pt) && !GENERIC_TOKENS.has(rt);
          const strong = isKey || distinctiveLong ? 1 : 0.5;
          if (strong > strongest) strongest = strong;
        }
      }
    }
    // Señal: token distintivo compartido, ≥2 tokens compartidos, o nombre ~ key.
    const whole = similarity(repoNorm, keyNorm);
    const score = Math.max(shared >= 2 ? 1 : strongest, whole);
    if (score >= 0.8 && (!best || score > best.score)) best = { p, score };
  }
  return best ? best.p : null;
}

/** Ratio de similitud [0,1] basado en distancia de Levenshtein. */
function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** Fallback: Claude elige la key del proyecto que corresponde, o NONE si ninguno encaja. */
async function matchByClaude(meta: RepoMeta, projects: ProjectRow[]): Promise<ProjectRow | null> {
  const list = projects.map((p) => `- ${p.key}: ${p.name}`).join('\n');
  const raw = await complete({
    system:
      'Eres roz. Se detectó un repo nuevo de GitHub. Decide a cuál de los proyectos listados ' +
      'pertenece, basándote en el nombre y la descripción del repo. Sé conservador: solo elige un ' +
      'proyecto si hay una correspondencia clara; ante la duda devuelve NONE.\n' +
      'Responde SOLO JSON: {"key":"<key-del-proyecto-o-NONE>"}.',
    user:
      `Repo: ${meta.fullName}\nDescripción: ${meta.description ?? '(sin descripción)'}\n\n` +
      `Proyectos:\n${list}`,
    maxTokens: 200,
  });
  const key = (extractJson(raw) ?? {}).key as string | undefined;
  if (!key || key === 'NONE') return null;
  return projects.find((p) => p.key === key) ?? null;
}
