// Nodos del grafo de contexto: alta, edición con historial, lectura, búsqueda y el índice corto que
// el agente carga antes de trabajar.
//
// La base de zeus es la fuente de verdad: todo documento se edita aquí (web o MCP), venga de donde
// venga. `source = 'git'` y las columnas `source_*` solo dicen de qué archivo se IMPORTÓ.
import { db } from '../db/supabase.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import {
  ZEUS_EDGE_KINDS,
  ZEUS_NODE_KINDS,
  ZEUS_NODE_STATUSES,
  type ZeusContextPack,
  type ZeusContextPackItem,
  type ZeusEdgeKind,
  type ZeusGraphEdge,
  type ZeusNodeDetail,
  type ZeusNodeInput,
  type ZeusNodeKind,
  type ZeusNodeStatus,
  type ZeusNodeSummary,
  type ZeusSearchHit,
} from '../types/zeus.js';
import { actorActivity, assertRefExists, describeRefs, isUuid, logActivity, mustParseRef, nodeRef, type ZeusActor } from './core.js';

/** Tope del cuerpo de un nodo. Un documento más grande que esto no es contexto, es un archivo. */
export const MAX_BODY_CHARS = 200_000;
export const MAX_SUMMARY_CHARS = 240;

export interface NodeRow {
  id: string;
  kind: ZeusNodeKind;
  slug: string;
  title: string;
  summary: string;
  body: string;
  project_id: string | null;
  status: ZeusNodeStatus;
  source: 'manual' | 'git';
  source_repo: string | null;
  source_path: string | null;
  source_sha: string | null;
  source_url: string | null;
  owner_dev_id: string | null;
  tags: string[];
  meta: Record<string, unknown>;
  pinned: boolean;
  review_after: string | null;
  version: number;
  updated_at: string;
}

const SUMMARY_COLS =
  'id, kind, slug, title, summary, project_id, status, source, source_url, owner_dev_id, tags, pinned, review_after, version, updated_at';
const ALL_COLS = `${SUMMARY_COLS}, body, source_repo, source_path, source_sha, meta`;

/** Slug legible a partir de un título: minúsculas, sin acentos, guiones. */
export function slugify(text: string): string {
  const s = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || 'nodo';
}

/** Primera línea útil de un markdown, sin sintaxis, recortada. Para cuando no dieron resumen. */
export function summarize(body: string, max = MAX_SUMMARY_CHARS): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('---') || line.startsWith('|') || line.startsWith('```') || line.startsWith('<')) continue;
    if (/^[\w-]+:\s/.test(line) && line.length < 80) continue; // cabeceras tipo "Status: accepted"
    const text = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`>]/g, '')
      .replace(/^[-+]\s+/, '')
      .trim();
    if (text.length < 12) continue;
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  }
  return '';
}

async function projectKeys(ids: Array<string | null>): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  const { data, error } = await db().from('project').select('id, key').in('id', uniq);
  if (error) throw error;
  return new Map(((data ?? []) as Array<{ id: string; key: string }>).map((p) => [p.id, p.key]));
}

function toSummary(r: NodeRow, keys: Map<string, string>): ZeusNodeSummary {
  return {
    id: r.id,
    ref: nodeRef(r.id),
    kind: r.kind,
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    projectId: r.project_id,
    projectKey: r.project_id ? (keys.get(r.project_id) ?? null) : null,
    status: r.status,
    source: r.source,
    sourceUrl: r.source_url,
    ownerDevId: r.owner_dev_id,
    tags: r.tags ?? [],
    pinned: r.pinned,
    reviewAfter: r.review_after,
    version: r.version,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------- lectura

export interface ListNodesInput {
  projectId?: string | null;
  kind?: ZeusNodeKind;
  status?: ZeusNodeStatus;
  /** Filtro simple por título (la búsqueda de verdad es searchNodes). */
  q?: string;
  limit?: number;
}

export async function listNodes(input: ListNodesInput = {}): Promise<ZeusNodeSummary[]> {
  let q = db().from('zeus_node').select(SUMMARY_COLS);
  if (input.projectId) q = q.eq('project_id', input.projectId);
  if (input.kind) q = q.eq('kind', input.kind);
  if (input.status) q = q.eq('status', input.status);
  else q = q.neq('status', 'archived');
  if (input.q?.trim()) q = q.ilike('title', `%${input.q.trim().replace(/[%_]/g, '')}%`);
  const { data, error } = await q.order('pinned', { ascending: false }).order('updated_at', { ascending: false }).limit(Math.min(input.limit ?? 500, 1000));
  if (error) throw error;
  const rows = (data ?? []) as unknown as NodeRow[];
  const keys = await projectKeys(rows.map((r) => r.project_id));
  return rows.map((r) => toSummary(r, keys));
}

export async function getNodeRow(id: string): Promise<NodeRow> {
  if (!isUuid(id)) throw new ValidationError('id de nodo inválido');
  const { data, error } = await db().from('zeus_node').select(ALL_COLS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('ese documento no existe en zeus');
  return data as unknown as NodeRow;
}

/** Aristas guardadas que tocan una referencia, con el otro extremo ya descrito. */
export async function edgesOf(ref: string): Promise<ZeusNodeDetail['edges']> {
  const supabase = db();
  const [out, inc] = await Promise.all([
    supabase.from('zeus_edge').select('id, src_ref, dst_ref, kind, note, source').eq('src_ref', ref),
    supabase.from('zeus_edge').select('id, src_ref, dst_ref, kind, note, source').eq('dst_ref', ref),
  ]);
  if (out.error) throw out.error;
  if (inc.error) throw inc.error;
  type E = { id: string; src_ref: string; dst_ref: string; kind: ZeusEdgeKind; note: string | null; source: 'manual' | 'git' };
  const rows = [...((out.data ?? []) as E[]).map((e) => ({ e, direction: 'out' as const })), ...((inc.data ?? []) as E[]).map((e) => ({ e, direction: 'in' as const }))];
  const others = await describeRefs(rows.map(({ e, direction }) => (direction === 'out' ? e.dst_ref : e.src_ref)));
  return rows.flatMap(({ e, direction }) => {
    const otherRef = direction === 'out' ? e.dst_ref : e.src_ref;
    const other = others.get(otherRef);
    if (!other) return []; // el otro extremo ya no existe
    return [{ id: e.id, src: e.src_ref, dst: e.dst_ref, kind: e.kind, derived: false, source: e.source, note: e.note, otherRef, otherTitle: other.title, otherKind: other.kind, direction }];
  });
}

export async function getNodeDetail(id: string): Promise<ZeusNodeDetail> {
  const row = await getNodeRow(id);
  const [keys, edges, revs] = await Promise.all([
    projectKeys([row.project_id]),
    edgesOf(nodeRef(row.id)),
    db().from('zeus_node_revision').select('version, title, edited_by, edited_via, created_at').eq('node_id', row.id).order('version', { ascending: false }).limit(30),
  ]);
  if (revs.error) throw revs.error;
  type R = { version: number; title: string; edited_by: string | null; edited_via: 'web' | 'mcp' | 'git'; created_at: string };
  const revRows = (revs.data ?? []) as R[];
  const editors = await describeRefs(revRows.filter((r) => r.edited_by).map((r) => `dev:${r.edited_by}`));
  return {
    ...toSummary(row, keys),
    body: row.body,
    sourceRepo: row.source_repo,
    sourcePath: row.source_path,
    meta: row.meta ?? {},
    edges,
    revisions: revRows.map((r) => ({
      version: r.version,
      title: r.title,
      editedBy: r.edited_by,
      editedByName: r.edited_by ? (editors.get(`dev:${r.edited_by}`)?.title ?? null) : null,
      editedVia: r.edited_via,
      createdAt: r.created_at,
    })),
  };
}

// ---------------------------------------------------------------- escritura

function cleanTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) return undefined;
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}

function validateInput(i: Partial<ZeusNodeInput>, creating: boolean): void {
  if (creating || i.kind !== undefined) {
    if (!i.kind || !ZEUS_NODE_KINDS.includes(i.kind)) throw new ValidationError(`tipo inválido (usa: ${ZEUS_NODE_KINDS.join(', ')})`);
  }
  if (creating || i.title !== undefined) {
    if (!i.title?.trim()) throw new ValidationError('falta el título');
    if (i.title.length > 200) throw new ValidationError('el título no puede pasar de 200 caracteres');
  }
  if (i.status !== undefined && !ZEUS_NODE_STATUSES.includes(i.status)) throw new ValidationError('estado inválido');
  if (i.body !== undefined && i.body.length > MAX_BODY_CHARS) {
    throw new ValidationError(`el documento pasa de ${MAX_BODY_CHARS} caracteres: divídelo en varios`);
  }
  if (i.summary !== undefined && i.summary.length > MAX_SUMMARY_CHARS) {
    throw new ValidationError(`el resumen es UNA línea (máx ${MAX_SUMMARY_CHARS} caracteres): es lo que entra al índice del agente`);
  }
  if (i.projectId && !isUuid(i.projectId)) throw new ValidationError('projectId inválido');
  if (i.ownerDevId && !isUuid(i.ownerDevId)) throw new ValidationError('ownerDevId inválido');
  if (i.reviewAfter && !/^\d{4}-\d{2}-\d{2}$/.test(i.reviewAfter)) throw new ValidationError('reviewAfter debe ser AAAA-MM-DD');
}

export async function saveRevision(row: Pick<NodeRow, 'id' | 'version' | 'title' | 'summary' | 'body'>, editedBy: string | null, via: 'web' | 'mcp' | 'git'): Promise<void> {
  const { error } = await db()
    .from('zeus_node_revision')
    .upsert(
      { node_id: row.id, version: row.version, title: row.title, summary: row.summary, body: row.body, edited_by: editedBy, edited_via: via },
      { onConflict: 'node_id,version' },
    );
  if (error) throw error;
}

const editVia = (a: ZeusActor): 'web' | 'mcp' => (a.via === 'web' ? 'web' : 'mcp');

export async function createNode(input: ZeusNodeInput, actor: ZeusActor): Promise<ZeusNodeDetail> {
  validateInput(input, true);
  const body = input.body ?? '';
  const base = slugify(input.slug?.trim() || input.title);
  const row = {
    kind: input.kind,
    title: input.title.trim(),
    summary: (input.summary ?? '').trim() || summarize(body),
    body,
    project_id: input.projectId ?? null,
    status: input.status ?? 'active',
    source: 'manual',
    owner_dev_id: input.ownerDevId === undefined ? actor.devId : input.ownerDevId,
    tags: cleanTags(input.tags) ?? [],
    meta: input.meta ?? {},
    pinned: !!input.pinned,
    review_after: input.reviewAfter ?? null,
    created_by: actor.devId,
    updated_by: actor.devId,
  };
  // El slug es único por alcance y tipo: ante choque se le agrega un sufijo en vez de fallar.
  for (let n = 0; n < 6; n++) {
    const slug = n === 0 ? base : `${base}-${n + 1}`;
    const { data, error } = await db().from('zeus_node').insert({ ...row, slug }).select(ALL_COLS).single();
    if (error) {
      if ((error as { code?: string }).code === '23505') continue;
      throw error;
    }
    const created = data as unknown as NodeRow;
    await saveRevision(created, actor.devId, editVia(actor));
    logActivity(actorActivity(actor), 'write', nodeRef(created.id), { title: created.title, created: true });
    return getNodeDetail(created.id);
  }
  throw new AppError('ZEUS_SLUG_TAKEN', 'ya hay varios documentos con ese nombre: usa otro título o slug', 409);
}

export async function updateNode(id: string, patch: Partial<ZeusNodeInput>, actor: ZeusActor): Promise<ZeusNodeDetail> {
  validateInput(patch, false);
  // Un documento importado de un repo se edita igual que cualquiera: la procedencia no es candado.
  const row = await getNodeRow(id);
  const contentChanged =
    (patch.title !== undefined && patch.title.trim() !== row.title) ||
    (patch.body !== undefined && patch.body !== row.body) ||
    (patch.summary !== undefined && patch.summary.trim() !== row.summary);
  const next: Record<string, unknown> = { updated_by: actor.devId, updated_at: new Date().toISOString() };
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.title !== undefined) next.title = patch.title.trim();
  if (patch.body !== undefined) next.body = patch.body;
  if (patch.summary !== undefined) next.summary = patch.summary.trim() || summarize(patch.body ?? row.body);
  if (patch.projectId !== undefined) next.project_id = patch.projectId;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.ownerDevId !== undefined) next.owner_dev_id = patch.ownerDevId;
  if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
  if (patch.meta !== undefined) next.meta = patch.meta;
  if (patch.pinned !== undefined) next.pinned = patch.pinned;
  if (patch.reviewAfter !== undefined) next.review_after = patch.reviewAfter;
  if (patch.slug !== undefined && patch.slug.trim()) next.slug = slugify(patch.slug);
  if (contentChanged) next.version = row.version + 1;

  // Bloqueo optimista por versión: dos ediciones a la vez no se pisan en silencio.
  const { data, error } = await db().from('zeus_node').update(next).eq('id', id).eq('version', row.version).select(ALL_COLS).maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === '23505') throw new AppError('ZEUS_SLUG_TAKEN', 'ya existe un documento con ese slug en ese alcance', 409);
    throw error;
  }
  if (!data) throw new AppError('ZEUS_CONFLICT', 'alguien más editó este documento: vuelve a abrirlo', 409);
  const saved = data as unknown as NodeRow;
  if (contentChanged) await saveRevision(saved, actor.devId, editVia(actor));
  logActivity(actorActivity(actor), 'write', nodeRef(id), { title: saved.title });
  return getNodeDetail(id);
}

/**
 * Archivar, no borrar: un ADR retirado sigue siendo historia. Además, el nodo archivado de un
 * documento importado sigue ocupando su (repo, ruta): por eso la ingesta no lo vuelve a traer.
 */
export async function archiveNode(id: string, actor: ZeusActor): Promise<void> {
  const row = await getNodeRow(id);
  const { error } = await db().from('zeus_node').update({ status: 'archived', pinned: false, updated_by: actor.devId, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
  logActivity(actorActivity(actor), 'archive', nodeRef(id), { title: row.title });
}

// ---------------------------------------------------------------- aristas

export async function createEdge(input: { src: string; dst: string; kind: string; note?: string | null }, actor: ZeusActor): Promise<ZeusGraphEdge> {
  if (!ZEUS_EDGE_KINDS.includes(input.kind as ZeusEdgeKind)) throw new ValidationError(`tipo de conexión inválido (usa: ${ZEUS_EDGE_KINDS.join(', ')})`);
  if (input.src === input.dst) throw new ValidationError('un nodo no se conecta consigo mismo');
  mustParseRef(input.src);
  mustParseRef(input.dst);
  await Promise.all([assertRefExists(input.src), assertRefExists(input.dst)]);
  const { data, error } = await db()
    .from('zeus_edge')
    .upsert({ src_ref: input.src, dst_ref: input.dst, kind: input.kind, note: input.note?.trim() || null, source: 'manual', created_by: actor.devId }, { onConflict: 'src_ref,dst_ref,kind' })
    .select('id, src_ref, dst_ref, kind, note')
    .single();
  if (error) throw error;
  const e = data as { id: string; src_ref: string; dst_ref: string; kind: ZeusEdgeKind; note: string | null };
  // "A reemplaza a B" implica que B dejó de estar vigente.
  if (e.kind === 'supersedes' && e.dst_ref.startsWith('node:')) {
    await db().from('zeus_node').update({ status: 'superseded', updated_at: new Date().toISOString() }).eq('id', e.dst_ref.slice(5)).eq('status', 'active');
  }
  logActivity(actorActivity(actor), 'link', e.src_ref, { dst: e.dst_ref, kind: e.kind });
  return { id: e.id, src: e.src_ref, dst: e.dst_ref, kind: e.kind, derived: false, source: 'manual', note: e.note };
}

export async function deleteEdge(input: { id?: string; src?: string; dst?: string; kind?: string }, actor: ZeusActor): Promise<void> {
  let find = db().from('zeus_edge').select('id, src_ref');
  if (input.id) {
    if (!isUuid(input.id)) throw new ValidationError('id de conexión inválido');
    find = find.eq('id', input.id);
  } else if (input.src && input.dst && input.kind) {
    find = find.eq('src_ref', input.src).eq('dst_ref', input.dst).eq('kind', input.kind);
  } else {
    throw new ValidationError('indica el id de la conexión, o src + dst + kind');
  }
  const { data, error } = await find.maybeSingle();
  if (error) throw error;
  const edge = data as { id: string; src_ref: string } | null;
  if (!edge) throw new NotFoundError('esa conexión no existe');
  // También las que salieron del texto de un documento importado (source = 'git'): la ingesta solo
  // crea aristas al importar un documento nuevo, así que una borrada aquí no regresa.
  const { error: delErr } = await db().from('zeus_edge').delete().eq('id', edge.id);
  if (delErr) throw delErr;
  logActivity(actorActivity(actor), 'unlink', edge.src_ref);
}

// ---------------------------------------------------------------- búsqueda

export interface SearchInput {
  query: string;
  projectId?: string | null;
  kinds?: ZeusNodeKind[];
  /** Incluir lo de la organización además de lo del proyecto (default: sí). */
  includeOrg?: boolean;
  limit?: number;
}

export async function searchNodes(input: SearchInput): Promise<ZeusSearchHit[]> {
  const query = input.query.trim().slice(0, 300);
  if (query.length < 2) return [];
  const { data, error } = await db().rpc('zeus_search', {
    p_query: query,
    p_project_id: input.projectId ?? null,
    p_kinds: input.kinds?.length ? input.kinds : null,
    p_include_org: input.includeOrg ?? true,
    p_limit: input.limit ?? 12,
  });
  if (error) throw error;
  type Row = Omit<ZeusSearchHit, 'ref' | 'projectId' | 'sourceUrl' | 'updatedAt'> & { project_id: string | null; source_url: string | null; updated_at: string };
  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    ref: nodeRef(r.id),
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    projectId: r.project_id,
    status: r.status,
    source: r.source,
    sourceUrl: r.source_url,
    pinned: r.pinned,
    updatedAt: r.updated_at,
    rank: Number(r.rank),
    snippet: (r.snippet ?? '').replace(/\s+/g, ' ').trim(),
  }));
}

// ---------------------------------------------------------------- índice y paquete de contexto

/** Orden en que aparece cada tipo en el índice: primero lo que restringe, después lo que informa. */
const INDEX_ORDER: ZeusNodeKind[] = ['rule', 'adr', 'spec', 'design', 'change', 'doc', 'resource', 'team'];

export interface ContextIndexEntry {
  ref: string;
  kind: ZeusNodeKind;
  title: string;
  summary: string;
  scope: 'proyecto' | 'organización';
  pinned: boolean;
  updatedAt: string;
}

export interface ContextIndex {
  project: { id: string; key: string; name: string } | null;
  entries: ContextIndexEntry[];
  /** Cuántas entradas quedaron fuera por el tope (se llega a ellas con zeus_search). */
  omitted: number;
  howToUse: string;
}

/** Tope del índice: es lo que se carga SIEMPRE, así que tiene que ser barato. */
export const INDEX_MAX_ENTRIES = 80;

/**
 * El índice corto de un proyecto: una línea por documento vigente, lo fijado primero. Es el único
 * contexto que se carga sin que nadie lo pida; todo lo demás se trae por id cuando hace falta.
 */
export async function contextIndex(project: { id: string; key: string; name: string } | null, max = INDEX_MAX_ENTRIES): Promise<ContextIndex> {
  let q = db().from('zeus_node').select('id, kind, title, summary, project_id, pinned, updated_at').eq('status', 'active');
  q = project ? q.or(`project_id.eq.${project.id},project_id.is.null`) : q.is('project_id', null);
  const { data, error } = await q.order('updated_at', { ascending: false }).limit(1000);
  if (error) throw error;
  type Row = { id: string; kind: ZeusNodeKind; title: string; summary: string; project_id: string | null; pinned: boolean; updated_at: string };
  const rows = ((data ?? []) as Row[]).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const k = INDEX_ORDER.indexOf(a.kind) - INDEX_ORDER.indexOf(b.kind);
    if (k !== 0) return k;
    // Lo del proyecto antes que lo de la organización: es más específico.
    if (!!a.project_id !== !!b.project_id) return a.project_id ? -1 : 1;
    return b.updated_at.localeCompare(a.updated_at);
  });
  return {
    project,
    entries: rows.slice(0, max).map((r) => ({
      ref: nodeRef(r.id),
      kind: r.kind,
      title: r.title,
      summary: r.summary,
      scope: r.project_id ? 'proyecto' : 'organización',
      pinned: r.pinned,
      updatedAt: r.updated_at,
    })),
    omitted: Math.max(0, rows.length - max),
    howToUse:
      'Esto es solo el índice. Trae el texto completo de lo que aplique con zeus_get (por ref) y busca lo que no veas aquí con zeus_search. ' +
      'Las reglas (rule) y decisiones (adr) vigentes se respetan; si tu tarea las contradice, dilo antes de seguir.',
  };
}

/** Cuántos documentos por búsqueda entran al paquete de un plan. */
const PACK_MATCHES = 6;

/**
 * Paquete de contexto de una tarea: referencias (no texto) de lo fijado + lo que coincide con el
 * título y la descripción. Se calcula una vez al encolar el plan y viaja con él.
 */
export async function buildContextPack(projectId: string | null, text: string): Promise<ZeusContextPack> {
  const query = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  const items = new Map<string, ZeusContextPackItem>();

  let pinnedQ = db().from('zeus_node').select('id, kind, title, summary, project_id').eq('status', 'active').eq('pinned', true);
  pinnedQ = projectId ? pinnedQ.or(`project_id.eq.${projectId},project_id.is.null`) : pinnedQ.is('project_id', null);
  const { data: pinned, error } = await pinnedQ.limit(20);
  if (error) throw error;
  for (const p of (pinned ?? []) as Array<{ id: string; kind: ZeusNodeKind; title: string; summary: string }>) {
    items.set(p.id, { ref: nodeRef(p.id), kind: p.kind, title: p.title, summary: p.summary, why: 'fijado' });
  }
  if (query.length >= 2) {
    // websearch_to_tsquery junta los términos con AND: con el título entero casi nunca coincide
    // nada. Se buscan las palabras con peso, unidas con OR.
    const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((w) => w.length >= 4))].slice(0, 12);
    if (terms.length) {
      const hits = await searchNodes({ query: terms.join(' OR '), projectId, limit: PACK_MATCHES });
      for (const h of hits) {
        if (!items.has(h.id)) items.set(h.id, { ref: h.ref, kind: h.kind, title: h.title, summary: h.summary, why: 'coincide' });
      }
    }
  }
  return { generatedAt: new Date().toISOString(), query, items: [...items.values()] };
}
