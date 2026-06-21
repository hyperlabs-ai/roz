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

  // 3. Vincular si hubo match (idempotente: tolera el unique sobre repo).
  if (match) await addProjectRepoIfAbsent(match.id, repo);
}

/** Inserta el mapeo repo→proyecto tolerando el unique (23505) para reintentos seguros del outbox. */
async function addProjectRepoIfAbsent(projectId: string, repo: string): Promise<void> {
  try {
    await addProjectRepo(projectId, repo);
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') return; // ya vinculado: no-op
    throw err;
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
