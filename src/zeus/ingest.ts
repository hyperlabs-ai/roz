// Importación desde git: lee los ADR, OpenSpec y documentos de un repo y los da de alta como nodos
// de zeus. La base de zeus es la fuente de verdad; git solo IMPORTA:
//   · un documento que zeus no ha visto (por repo + ruta) entra como nodo nuevo, con sus aristas;
//   · uno que ya tiene nodo NO se toca: ni contenido, ni estado, ni aristas, y tampoco se archiva
//     si su archivo desaparece del repo. Un nodo archivado sigue ocupando su (repo, ruta), así que
//     lo que se retiró a propósito en zeus no vuelve en la siguiente lectura;
//   · la única forma de que git vuelva a pisar un nodo es pedirlo: `reimportNode`.
// Aquí nunca se escribe al repo.
//
// Cómo se mantiene barato: se pide el árbol completo de la rama por defecto UNA vez, y solo se bajan
// los blobs de los documentos nuevos. Un push que no agrega documentos no baja nada.
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import type { ZeusNodeDetail, ZeusSource } from '../types/zeus.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { actorActivity, logActivity, nodeRef, type ZeusActor } from './core.js';
import { getNodeDetail, getNodeRow, MAX_BODY_CHARS, saveRevision, slugify } from './nodes.js';
import { adrNumber, classifyPath, parseDoc, type Classified, type ParsedDoc } from './parse.js';

const API = 'https://api.github.com';
/** Tope de documentos por repo: protege de un repo que versiona miles de markdown generados. */
const MAX_DOCS_PER_REPO = 400;
/** Blobs más grandes que esto no son un documento de contexto. */
const MAX_BLOB_BYTES = 400_000;

async function gh<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${config.github.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} en ${path.split('?')[0]}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

const encRepo = (repo: string) => repo.split('/').map(encodeURIComponent).join('/');

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface RepoSnapshot {
  defaultBranch: string;
  commitSha: string;
  files: Array<{ path: string; sha: string; size: number }>;
  truncated: boolean;
}

/** Lo que zeus necesita de GitHub. Inyectable para probar la ingesta sin red. */
export interface GitSource {
  snapshot(repo: string): Promise<RepoSnapshot>;
  blob(repo: string, sha: string): Promise<string>;
}

export const githubSource: GitSource = {
  async snapshot(repo) {
    const meta = await gh<{ default_branch: string }>(`/repos/${encRepo(repo)}`);
    const branch = await gh<{ commit: { sha: string; commit: { tree: { sha: string } } } }>(
      `/repos/${encRepo(repo)}/branches/${encodeURIComponent(meta.default_branch)}`,
    );
    const tree = await gh<{ tree: TreeEntry[]; truncated: boolean }>(`/repos/${encRepo(repo)}/git/trees/${branch.commit.commit.tree.sha}?recursive=1`);
    return {
      defaultBranch: meta.default_branch,
      commitSha: branch.commit.sha,
      truncated: !!tree.truncated,
      files: tree.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 })),
    };
  },
  async blob(repo, sha) {
    const b = await gh<{ content: string; encoding: string }>(`/repos/${encRepo(repo)}/git/blobs/${sha}`);
    return b.encoding === 'base64' ? Buffer.from(b.content, 'base64').toString('utf8') : b.content;
  },
};

export interface IngestResult {
  repo: string;
  /** Documentos de contexto que hay hoy en el repo. */
  documents: number;
  /** Documentos nuevos: se importaron como nodos. */
  created: number;
  /** Documentos que ya tenían nodo: no se tocaron. */
  kept: number;
  /** Aristas iniciales de los nodos nuevos. */
  edges: number;
  truncated: boolean;
}

interface Group {
  key: string;
  cls: Classified;
  /** Ruta principal (la del part 0): con el repo, es de dónde se importó el nodo (`source_path`). */
  path: string;
  parts: Array<{ path: string; sha: string; part: number; partTitle: string | null }>;
}

/** Junta los archivos que forman un mismo documento y fija cuál es su ruta principal. */
export function groupFiles(files: Array<{ path: string; sha: string; size: number }>): Group[] {
  const groups = new Map<string, Group>();
  for (const f of files) {
    if (f.size > MAX_BLOB_BYTES) continue;
    const cls = classifyPath(f.path);
    if (!cls) continue;
    const g = groups.get(cls.group) ?? { key: cls.group, cls, path: f.path, parts: [] };
    g.parts.push({ path: f.path, sha: f.sha, part: cls.part, partTitle: cls.partTitle });
    groups.set(cls.group, g);
  }
  for (const g of groups.values()) {
    g.parts.sort((a, b) => a.part - b.part);
    g.path = g.parts[0]!.path;
    g.cls = classifyPath(g.path)!;
  }
  return [...groups.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_DOCS_PER_REPO);
}

/** sha del documento completo: cambia si cambia cualquiera de sus partes (o su composición). */
const groupSha = (g: Group) => g.parts.map((p) => `${p.part}:${p.sha}`).join(',');

const blobUrl = (repo: string, branch: string, path: string) => `https://github.com/${repo}/blob/${branch}/${path.split('/').map(encodeURIComponent).join('/')}`;

/** Baja las partes de un documento y arma lo que zeus guarda de él. */
async function readGroup(repo: string, g: Group, source: GitSource): Promise<{ main: ParsedDoc; body: string; links: string[] }> {
  const texts = await Promise.all(g.parts.map((p) => source.blob(repo, p.sha)));
  const main = parseDoc(g.path, texts[0]!);
  // Un documento = el archivo principal + sus secciones (design/tasks de un cambio de OpenSpec).
  const body = texts
    .map((t, i) => (i === 0 ? t : `\n\n---\n\n## ${g.parts[i]!.partTitle ?? g.parts[i]!.path.split('/').pop()}\n\n${t.replace(/^#\s+.+\n/, '')}`))
    .join('')
    .slice(0, MAX_BODY_CHARS);
  const links = [...new Set(texts.flatMap((t, i) => parseDoc(g.parts[i]!.path, t).links))];
  return { main, body, links };
}

/**
 * Rutas del repo que un nodo importado ocupa: su ruta principal y los archivos que lo formaron (un
 * cambio de OpenSpec son varios). Si cualquiera sigue en el repo, ese documento ya está en zeus.
 */
function occupiedPaths(node: { source_path: string | null; meta: Record<string, unknown> | null }): string[] {
  const files = Array.isArray(node.meta?.files) ? (node.meta!.files as unknown[]).filter((f): f is string => typeof f === 'string') : [];
  return [...new Set([...(node.source_path ? [node.source_path] : []), ...files])];
}

export async function ingestRepo(repo: string, source: GitSource = githubSource): Promise<IngestResult> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ValidationError('repo inválido (usa owner/name)');
  const supabase = db();
  const { data: link, error: linkErr } = await supabase.from('project_repo').select('project_id').eq('repo', repo).maybeSingle();
  if (linkErr) throw linkErr;
  const projectId = (link as { project_id: string } | null)?.project_id ?? null;
  if (!projectId) throw new NotFoundError(`el repo ${repo} no está vinculado a ningún proyecto`);

  const snap = await source.snapshot(repo);
  const groups = groupFiles(snap.files);

  // Todo lo que ya se importó de este repo, en cualquier estado: también lo archivado ocupa su ruta.
  const { data: existingData, error: exErr } = await supabase.from('zeus_node').select('id, source_path, meta').eq('source', 'git').eq('source_repo', repo);
  if (exErr) throw exErr;
  type Existing = { id: string; source_path: string | null; meta: Record<string, unknown> | null };
  /** ruta (cualquier parte) → id del nodo, para saber qué ya está y resolver enlaces entre documentos. */
  const idByPath = new Map<string, string>();
  for (const e of (existingData ?? []) as Existing[]) for (const path of occupiedPaths(e)) idByPath.set(path, e.id);

  const result: IngestResult = { repo, documents: groups.length, created: 0, kept: 0, edges: 0, truncated: snap.truncated };
  const imported = new Map<string, { supersedes: string[]; links: string[] }>();

  for (const g of groups) {
    const known = g.parts.map((p) => idByPath.get(p.path)).find((id) => !!id);
    if (known) {
      // Ya está en zeus: manda lo que diga la base, aunque el archivo haya cambiado en el repo.
      result.kept++;
      for (const p of g.parts) if (!idByPath.has(p.path)) idByPath.set(p.path, known);
      continue;
    }
    const { main, body, links } = await readGroup(repo, g, source);
    const row = {
      kind: g.cls.kind,
      title: main.title,
      summary: main.summary,
      body,
      project_id: projectId,
      status: main.status,
      source: 'git',
      source_repo: repo,
      source_path: g.path,
      source_sha: groupSha(g),
      source_url: blobUrl(repo, snap.defaultBranch, g.path),
      meta: { nativeStatus: main.nativeStatus, files: g.parts.map((p) => p.path) },
      pinned: g.cls.pinned,
      updated_at: new Date().toISOString(),
    };
    // El slug es único por proyecto y tipo, pero un proyecto puede tener varios repos y cada uno
    // su CLAUDE.md o su ADR-0001. Ante un choque el documento lleva el nombre de su repo (y, si
    // aun así choca con algo, un contador).
    const repoSlug = slugify(repo.split('/')[1] ?? repo);
    const candidates = [g.cls.slug, `${g.cls.slug}-${repoSlug}`.slice(0, 96), ...[2, 3, 4].map((n) => `${g.cls.slug}-${repoSlug}`.slice(0, 94) + `-${n}`)];
    let id: string | null = null;
    let lastError: unknown = null;
    for (const slug of candidates) {
      const { data, error } = await supabase.from('zeus_node').insert({ ...row, slug }).select('id').single();
      if (!error) {
        id = (data as { id: string }).id;
        break;
      }
      lastError = error;
      if ((error as { code?: string }).code !== '23505') break;
    }
    if (!id) throw lastError;
    result.created++;
    await saveRevision({ id, version: 1, title: main.title, summary: main.summary, body }, null, 'git');
    for (const p of g.parts) idByPath.set(p.path, id);
    imported.set(id, { supersedes: main.supersedes, links });
    logActivity({ devId: null, actor: 'git' }, 'ingest', nodeRef(id), { repo, path: g.path, title: main.title });
  }

  // Aristas iniciales de lo recién importado. Las de los nodos que ya existían no se tocan: se
  // editan en zeus como cualquier otra.
  if (imported.size) {
    const { data: adrs, error: adrErr } = await supabase.from('zeus_node').select('id, slug').eq('source_repo', repo).eq('kind', 'adr');
    if (adrErr) throw adrErr;
    const adrRows = (adrs ?? []) as Array<{ id: string; slug: string }>;
    const rows: Array<{ src_ref: string; dst_ref: string; kind: string; source: string }> = [];
    for (const [id, p] of imported) {
      for (const target of p.supersedes) {
        const num = adrNumber(target);
        const hit = adrRows.find((a) => a.id !== id && (a.slug === target.toLowerCase() || (num !== null && adrNumber(a.slug) === num)));
        if (hit) rows.push({ src_ref: nodeRef(id), dst_ref: nodeRef(hit.id), kind: 'supersedes', source: 'git' });
      }
      for (const link of p.links) {
        const dst = idByPath.get(link);
        if (dst && dst !== id) rows.push({ src_ref: nodeRef(id), dst_ref: nodeRef(dst), kind: 'relates_to', source: 'git' });
      }
    }
    const uniq = [...new Map(rows.map((r) => [`${r.src_ref}|${r.dst_ref}|${r.kind}`, r])).values()];
    if (uniq.length) {
      const { error } = await supabase.from('zeus_edge').upsert(uniq, { onConflict: 'src_ref,dst_ref,kind', ignoreDuplicates: true });
      if (error) throw error;
      result.edges = uniq.length;
      // Mismo efecto que conectar a mano "A reemplaza a B": B deja de estar vigente. Es lo único que
      // importar un documento nuevo cambia en otro, y solo si ese otro seguía activo.
      const superseded = uniq.filter((r) => r.kind === 'supersedes').map((r) => r.dst_ref.slice(5));
      if (superseded.length) await supabase.from('zeus_node').update({ status: 'superseded' }).in('id', superseded).eq('status', 'active');
    }
  }

  const { error: srcErr } = await supabase.from('zeus_source').upsert(
    {
      repo,
      project_id: projectId,
      default_branch: snap.defaultBranch,
      last_sha: snap.commitSha,
      last_synced_at: new Date().toISOString(),
      last_error: snap.truncated ? 'el árbol del repo es demasiado grande: GitHub lo devolvió truncado y puede faltar algún documento' : null,
      node_count: groups.length,
      dirty: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'repo' },
  );
  if (srcErr) throw srcErr;
  return result;
}

/**
 * "Traer la versión del repo": vuelve a leer el archivo del que se importó un nodo y la aplica como
 * una edición más (sube versión y deja revisión `git` a nombre de quien lo pidió). Es la ÚNICA forma
 * en que git pisa un nodo que ya existe. Solo trae contenido (título, resumen, cuerpo): el estado, el
 * dueño, las etiquetas y las conexiones siguen siendo los de zeus.
 */
export async function reimportNode(id: string, actor: ZeusActor, source: GitSource = githubSource): Promise<{ node: ZeusNodeDetail; changed: boolean }> {
  const row = await getNodeRow(id);
  if (row.source !== 'git' || !row.source_repo || !row.source_path) {
    throw new AppError('ZEUS_NOT_IMPORTED', 'este documento se creó en zeus: no tiene un archivo de origen del que traer otra versión', 409);
  }
  if (source === githubSource && !config.github.token) throw new AppError('ZEUS_GITHUB_OFF', 'zeus no tiene GITHUB_TOKEN: no puede leer el repo', 503);
  const repo = row.source_repo;
  const snap = await source.snapshot(repo);
  const paths = new Set(occupiedPaths(row));
  const groups = groupFiles(snap.files);
  const g = groups.find((x) => x.path === row.source_path) ?? groups.find((x) => x.parts.some((p) => paths.has(p.path)));
  if (!g) {
    const details = { repo, path: row.source_path, branch: snap.defaultBranch };
    if (snap.truncated) {
      throw new AppError('ZEUS_SOURCE_TRUNCATED', `GitHub devolvió incompleto el árbol de ${repo}: no se pudo ubicar ${row.source_path}. El documento en zeus queda como está`, 409, details);
    }
    throw new AppError(
      'ZEUS_SOURCE_GONE',
      `${row.source_path} ya no existe en ${repo} (rama ${snap.defaultBranch}): no hay versión del repo que traer. El documento en zeus queda como está`,
      404,
      details,
    );
  }
  const { main, body } = await readGroup(repo, g, source);
  const changed = main.title !== row.title || main.summary !== row.summary || body !== row.body;
  const next = {
    title: main.title,
    summary: main.summary,
    body,
    // `source_path` es la identidad de la importación y no se mueve; lo demás describe lo que se leyó.
    source_sha: groupSha(g),
    source_url: blobUrl(repo, snap.defaultBranch, g.path),
    meta: { ...(row.meta ?? {}), nativeStatus: main.nativeStatus, files: g.parts.map((p) => p.path) },
    updated_by: actor.devId,
    updated_at: new Date().toISOString(),
    ...(changed ? { version: row.version + 1 } : {}),
  };
  // Mismo bloqueo optimista que una edición a mano: no pisa lo que alguien guardó mientras tanto.
  const { data, error } = await db().from('zeus_node').update(next).eq('id', id).eq('version', row.version).select('id, version, title, summary, body').maybeSingle();
  if (error) throw error;
  if (!data) throw new AppError('ZEUS_CONFLICT', 'alguien más editó este documento: vuelve a abrirlo', 409);
  if (changed) await saveRevision(data as { id: string; version: number; title: string; summary: string; body: string }, actor.devId, 'git');
  logActivity(actorActivity(actor), 'reimport', nodeRef(id), { repo, path: g.path, title: main.title, changed });
  return { node: await getNodeDetail(id), changed };
}

/** Mensaje legible de cualquier error (Error, o el objeto plano que devuelve PostgREST). */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as { message?: string; details?: string; code?: string };
    const text = [e.message, e.details].filter(Boolean).join(' — ');
    if (text) return e.code ? `${text} (${e.code})` : text;
  }
  return String(err);
}

// ---------------------------------------------------------------- fuentes y barrida

/** Marca un repo para volver a leerlo e importar lo nuevo (webhook de push a la rama por defecto, o el botón del dashboard). */
export async function markSourceDirty(repo: string): Promise<boolean> {
  const supabase = db();
  const { data: link, error: linkErr } = await supabase.from('project_repo').select('project_id').eq('repo', repo).maybeSingle();
  if (linkErr) throw linkErr;
  const projectId = (link as { project_id: string } | null)?.project_id;
  if (!projectId) return false;
  const { error } = await supabase.from('zeus_source').upsert({ repo, project_id: projectId, dirty: true, updated_at: new Date().toISOString() }, { onConflict: 'repo' });
  if (error) throw error;
  return true;
}

export async function listSources(): Promise<ZeusSource[]> {
  const supabase = db();
  const [repos, sources, projects] = await Promise.all([
    supabase.from('project_repo').select('repo, project_id').order('repo'),
    supabase.from('zeus_source').select('repo, default_branch, last_synced_at, last_error, node_count, dirty'),
    supabase.from('project').select('id, key'),
  ]);
  for (const r of [repos, sources, projects]) if (r.error) throw r.error;
  type S = { repo: string; default_branch: string | null; last_synced_at: string | null; last_error: string | null; node_count: number; dirty: boolean };
  const byRepo = new Map(((sources.data ?? []) as S[]).map((s) => [s.repo, s]));
  const keys = new Map(((projects.data ?? []) as Array<{ id: string; key: string }>).map((p) => [p.id, p.key]));
  return ((repos.data ?? []) as Array<{ repo: string; project_id: string }>).map((r) => {
    const s = byRepo.get(r.repo);
    return {
      repo: r.repo,
      projectId: r.project_id,
      projectKey: keys.get(r.project_id) ?? null,
      defaultBranch: s?.default_branch ?? null,
      lastSyncedAt: s?.last_synced_at ?? null,
      lastError: s?.last_error ?? null,
      nodeCount: s?.node_count ?? 0,
      // Un repo vinculado que nunca se ha leído también está pendiente.
      pending: s ? s.dirty : true,
    };
  });
}

/** Cuántos repos atiende una barrida: acota las llamadas a GitHub por ciclo. */
const SWEEP_BATCH = 4;
/** Aunque nadie haga push, cada repo se relee una vez al día (por si se perdió un webhook). */
const RESYNC_AFTER_MS = 24 * 60 * 60 * 1000;

export interface SweepResult {
  ingested: IngestResult[];
  failed: Array<{ repo: string; error: string }>;
  skipped?: string;
}

export async function zeusSweep(source: GitSource = githubSource, now: Date = new Date()): Promise<SweepResult> {
  if (!config.github.token) return { ingested: [], failed: [], skipped: 'sin GITHUB_TOKEN' };
  const sources = await listSources();
  const stale = (s: ZeusSource) => !s.lastSyncedAt || now.getTime() - Date.parse(s.lastSyncedAt) > RESYNC_AFTER_MS;
  const due = sources
    .filter((s) => s.pending || stale(s))
    // Primero lo pedido explícitamente, después lo más viejo.
    .sort((a, b) => Number(b.pending) - Number(a.pending) || (a.lastSyncedAt ?? '').localeCompare(b.lastSyncedAt ?? ''))
    .slice(0, SWEEP_BATCH);
  const out: SweepResult = { ingested: [], failed: [] };
  for (const s of due) {
    try {
      out.ingested.push(await ingestRepo(s.repo, source));
    } catch (err) {
      // Los errores de Supabase son objetos planos: String(err) daría "[object Object]".
      const message = errorText(err);
      out.failed.push({ repo: s.repo, error: message });
      // Se limpia `dirty` y se sella la fecha para no reintentar el mismo repo roto cada 10 minutos;
      // el error queda a la vista y se reintenta en el siguiente push o al día siguiente.
      await db()
        .from('zeus_source')
        .upsert({ repo: s.repo, project_id: s.projectId, last_error: message.slice(0, 500), last_synced_at: now.toISOString(), dirty: false, updated_at: now.toISOString() }, { onConflict: 'repo' });
    }
  }
  return out;
}
