// Capa de datos de las ideas (schema `roz`, service_role). Vive fuera de queries.ts porque ese
// archivo ya pasa de 1900 líneas; el patrón interno es el mismo: cliente db(), mapeo manual
// snake_case → camelCase y una función por operación.
//
// La PRIVACIDAD se aplica aquí, no en RLS: el backend entra con service_role (que bypassa RLS), así
// que el único punto donde se sabe qué usuario preguntó es este. Toda ruta con :id pasa por
// assertIdeaAccess antes de tocar nada.
import { randomUUID } from 'node:crypto';
import { db } from '../db/supabase.js';
import { AppError, NotFoundError } from '../utils/errors.js';
import type { BlockKind, FeaturePriority, IdeaStatus } from '../ideas/model.js';

const ATTACH_BUCKET = 'idea-attachments';

// ---- Formas de respuesta (espejadas a mano en web/src/lib/api.ts) ----

/** Fila de la rejilla: la idea + los agregados que necesita el medidor de definición. */
export interface IdeaSummary {
  id: string;
  title: string;
  pitch: string | null;
  status: IdeaStatus;
  tags: string[];
  shared: boolean;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  /** Campos guiados: la tarjeta no muestra el texto, solo necesita saber si están llenos. */
  problem: string | null;
  audience: string | null;
  value: string | null;
  success: string | null;
  outOfScope: string | null;
  risks: string | null;
  nextStep: string | null;
  featureCount: number;
  mustCount: number;
  blockCount: number;
  openQuestions: number;
  /** ¿La sesión actual puede editarla? (false = de alguien más, compartida en solo lectura) */
  canEdit: boolean;
}

export interface IdeaFeature {
  id: string;
  title: string;
  detail: string | null;
  priority: FeaturePriority;
  position: number;
  createdAt: string;
}

export interface IdeaBlock {
  id: string;
  kind: BlockKind;
  title: string | null;
  body: string | null;
  source: string | null;
  url: string | null;
  resolved: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface IdeaAttachment {
  id: string;
  url: string;
  name: string;
  contentType: string | null;
  size: number | null;
  createdAt: string;
}

const IDEA_COLS =
  'id, title, pitch, status, problem, audience, value, success, out_of_scope, risks, next_step, tags, shared, created_by, created_by_name, created_at, updated_at';

function mapIdea(r: any, userId: string, counts?: { features: number; musts: number; blocks: number; questions: number }): IdeaSummary {
  return {
    id: r.id,
    title: r.title,
    pitch: r.pitch ?? null,
    status: r.status,
    tags: r.tags ?? [],
    shared: !!r.shared,
    createdBy: r.created_by,
    createdByName: r.created_by_name ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    problem: r.problem ?? null,
    audience: r.audience ?? null,
    value: r.value ?? null,
    success: r.success ?? null,
    outOfScope: r.out_of_scope ?? null,
    risks: r.risks ?? null,
    nextStep: r.next_step ?? null,
    featureCount: counts?.features ?? 0,
    mustCount: counts?.musts ?? 0,
    blockCount: counts?.blocks ?? 0,
    openQuestions: counts?.questions ?? 0,
    canEdit: r.created_by === userId,
  };
}

function mapFeature(r: any): IdeaFeature {
  return {
    id: r.id,
    title: r.title,
    detail: r.detail ?? null,
    priority: r.priority,
    position: r.position ?? 0,
    createdAt: r.created_at,
  };
}

function mapBlock(r: any): IdeaBlock {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title ?? null,
    body: r.body ?? null,
    source: r.source ?? null,
    url: r.url ?? null,
    resolved: !!r.resolved,
    position: r.position ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapAttachment(a: any): IdeaAttachment {
  return { id: a.id, url: a.url, name: a.name, contentType: a.content_type ?? null, size: a.size ?? null, createdAt: a.created_at };
}

// ---- La puerta ----

export class ForbiddenIdeaError extends AppError {
  constructor(message = 'Esta idea no es tuya') {
    super('FORBIDDEN', message, 403);
  }
}

/**
 * Autoriza el acceso a una idea y devuelve su fila mínima.
 *
 * Lectura: pasa el dueño, o cualquiera si la idea está compartida.
 * Escritura: SOLO el dueño — compartir es de solo lectura.
 *
 * Es obligatorio llamarla antes de tocar features, bloques o adjuntos: esos se identifican por su
 * propio uuid, así que sin este chequeo adivinar un id permitiría editar la idea de otra persona.
 */
export async function assertIdeaAccess(
  ideaId: string,
  userId: string,
  mode: 'read' | 'write',
): Promise<{ id: string; createdBy: string; shared: boolean }> {
  const { data, error } = await db().from('idea').select('id, created_by, shared').eq('id', ideaId).maybeSingle();
  // Si la consulta falla no se puede afirmar que la persona tenga acceso → se cierra la puerta.
  if (error) throw error;
  if (!data) throw new NotFoundError('La idea no existe');
  const row = data as { id: string; created_by: string; shared: boolean };
  const owner = row.created_by === userId;
  if (mode === 'write' && !owner) throw new ForbiddenIdeaError('Solo quien creó la idea puede editarla');
  if (!owner && !row.shared) throw new NotFoundError('La idea no existe'); // no revelar que existe
  return { id: row.id, createdBy: row.created_by, shared: row.shared };
}

/** Igual que assertIdeaAccess pero resolviendo la idea desde un hijo (feature/bloque/adjunto). */
async function assertChildAccess(
  table: 'idea_feature' | 'idea_block' | 'idea_attachment',
  childId: string,
  ideaId: string,
  userId: string,
  mode: 'read' | 'write',
): Promise<void> {
  await assertIdeaAccess(ideaId, userId, mode);
  const { data, error } = await db().from(table).select('idea_id').eq('id', childId).maybeSingle();
  if (error) throw error;
  // El hijo debe pertenecer a la idea de la URL: si no, la autorización de arriba no aplicaba a él.
  if (!data || (data as { idea_id: string }).idea_id !== ideaId) throw new NotFoundError('No encontrado');
}

// ---- Ideas ----

export async function listIdeas(opts: {
  userId: string;
  status?: string;
  q?: string;
  onlyMine?: boolean;
}): Promise<IdeaSummary[]> {
  const supabase = db();
  let query = supabase.from('idea').select(IDEA_COLS).order('updated_at', { ascending: false });
  // Visibilidad: las mías + las compartidas por el resto.
  if (opts.onlyMine) query = query.eq('created_by', opts.userId);
  else query = query.or(`created_by.eq.${opts.userId},shared.is.true`);
  if (opts.status) query = query.eq('status', opts.status);

  const { data, error } = await query;
  if (error) throw error;
  let rows = (data ?? []) as any[];

  // La búsqueda se filtra en memoria: son decenas de ideas, y así no hay que escapar comas ni
  // paréntesis dentro del `or=` de PostgREST.
  const q = opts.q?.trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) =>
      [r.title, r.pitch, r.problem, r.audience, r.value].some((v: string | null) => v?.toLowerCase().includes(q)),
    );
  }
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const [{ data: feats }, { data: blocks }] = await Promise.all([
    supabase.from('idea_feature').select('idea_id, priority').in('idea_id', ids),
    supabase.from('idea_block').select('idea_id, kind, resolved').in('idea_id', ids),
  ]);

  const counts = new Map<string, { features: number; musts: number; blocks: number; questions: number }>();
  const bucket = (id: string) => {
    let c = counts.get(id);
    if (!c) counts.set(id, (c = { features: 0, musts: 0, blocks: 0, questions: 0 }));
    return c;
  };
  ((feats ?? []) as any[]).forEach((f) => {
    const c = bucket(f.idea_id);
    c.features++;
    if (f.priority === 'imprescindible') c.musts++;
  });
  ((blocks ?? []) as any[]).forEach((b) => {
    const c = bucket(b.idea_id);
    c.blocks++;
    if (b.kind === 'pregunta' && !b.resolved) c.questions++;
  });

  return rows.map((r) => mapIdea(r, opts.userId, counts.get(r.id)));
}

export async function getIdea(
  ideaId: string,
  userId: string,
): Promise<{ idea: IdeaSummary; features: IdeaFeature[]; blocks: IdeaBlock[]; attachments: IdeaAttachment[] }> {
  await assertIdeaAccess(ideaId, userId, 'read');
  const supabase = db();
  const [{ data: row, error }, { data: feats }, { data: blocks }, attachments] = await Promise.all([
    supabase.from('idea').select(IDEA_COLS).eq('id', ideaId).single(),
    supabase.from('idea_feature').select('*').eq('idea_id', ideaId).order('position').order('created_at'),
    supabase.from('idea_block').select('*').eq('idea_id', ideaId).order('position').order('created_at'),
    listIdeaAttachments(ideaId),
  ]);
  if (error) throw error;

  const features = ((feats ?? []) as any[]).map(mapFeature);
  const blockList = ((blocks ?? []) as any[]).map(mapBlock);
  const idea = mapIdea(row, userId, {
    features: features.length,
    musts: features.filter((f) => f.priority === 'imprescindible').length,
    blocks: blockList.length,
    questions: blockList.filter((b) => b.kind === 'pregunta' && !b.resolved).length,
  });
  return { idea, features, blocks: blockList, attachments };
}

/** Alta de fricción cero: solo el título. Los campos guiados se llenan después, en el editor. */
export async function createIdea(input: {
  userId: string;
  userName: string | null;
  title: string;
  pitch?: string | null;
}): Promise<IdeaSummary> {
  const { data, error } = await db()
    .from('idea')
    .insert({
      title: input.title.trim().slice(0, 300),
      pitch: input.pitch?.trim() || null,
      created_by: input.userId,
      created_by_name: input.userName,
    })
    .select(IDEA_COLS)
    .single();
  if (error) throw error;
  return mapIdea(data, input.userId);
}

export interface IdeaPatch {
  title?: string;
  pitch?: string | null;
  status?: IdeaStatus;
  problem?: string | null;
  audience?: string | null;
  value?: string | null;
  success?: string | null;
  outOfScope?: string | null;
  risks?: string | null;
  nextStep?: string | null;
  tags?: string[];
  shared?: boolean;
}

export async function updateIdea(ideaId: string, userId: string, patch: IdeaPatch): Promise<IdeaSummary> {
  await assertIdeaAccess(ideaId, userId, 'write');
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  // Mapeo explícito camelCase → snake_case: solo pasan las claves conocidas.
  if (patch.title !== undefined) row.title = patch.title.trim().slice(0, 300);
  if (patch.pitch !== undefined) row.pitch = patch.pitch;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.problem !== undefined) row.problem = patch.problem;
  if (patch.audience !== undefined) row.audience = patch.audience;
  if (patch.value !== undefined) row.value = patch.value;
  if (patch.success !== undefined) row.success = patch.success;
  if (patch.outOfScope !== undefined) row.out_of_scope = patch.outOfScope;
  if (patch.risks !== undefined) row.risks = patch.risks;
  if (patch.nextStep !== undefined) row.next_step = patch.nextStep;
  if (patch.tags !== undefined) row.tags = patch.tags;
  if (patch.shared !== undefined) row.shared = patch.shared;

  const { data, error } = await db().from('idea').update(row).eq('id', ideaId).select(IDEA_COLS).single();
  if (error) throw error;
  return mapIdea(data, userId);
}

export async function deleteIdea(ideaId: string, userId: string): Promise<void> {
  await assertIdeaAccess(ideaId, userId, 'write');
  // Los adjuntos se borran en cascada en la tabla; los objetos del bucket se limpian aquí para no
  // dejar basura en Storage. Best-effort: si falla, la idea se borra igual.
  const { data: files } = await db().from('idea_attachment').select('storage_path').eq('idea_id', ideaId);
  const paths = ((files ?? []) as { storage_path: string }[]).map((f) => f.storage_path);
  if (paths.length) await db().storage.from(ATTACH_BUCKET).remove(paths).then(() => {}, () => {});
  const { error } = await db().from('idea').delete().eq('id', ideaId);
  if (error) throw error;
}

/** Marca la idea como tocada. Los hijos viven en otras tablas, pero la lista ordena por esto. */
async function touch(ideaId: string): Promise<void> {
  await db().from('idea').update({ updated_at: new Date().toISOString() }).eq('id', ideaId);
}

// ---- Features (alcance) ----

export async function addFeature(
  ideaId: string,
  userId: string,
  input: { title: string; detail?: string | null; priority?: FeaturePriority },
): Promise<IdeaFeature> {
  await assertIdeaAccess(ideaId, userId, 'write');
  const { data: last } = await db()
    .from('idea_feature')
    .select('position')
    .eq('idea_id', ideaId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();
  const position = ((last as { position?: number } | null)?.position ?? -1) + 1;
  const { data, error } = await db()
    .from('idea_feature')
    .insert({
      idea_id: ideaId,
      title: input.title.trim().slice(0, 300),
      detail: input.detail ?? null,
      priority: input.priority ?? 'deseable',
      position,
    })
    .select('*')
    .single();
  if (error) throw error;
  await touch(ideaId);
  return mapFeature(data);
}

export async function updateFeature(
  ideaId: string,
  featureId: string,
  userId: string,
  patch: { title?: string; detail?: string | null; priority?: FeaturePriority },
): Promise<IdeaFeature> {
  await assertChildAccess('idea_feature', featureId, ideaId, userId, 'write');
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) row.title = patch.title.trim().slice(0, 300);
  if (patch.detail !== undefined) row.detail = patch.detail;
  if (patch.priority !== undefined) row.priority = patch.priority;
  const { data, error } = await db().from('idea_feature').update(row).eq('id', featureId).select('*').single();
  if (error) throw error;
  await touch(ideaId);
  return mapFeature(data);
}

export async function deleteFeature(ideaId: string, featureId: string, userId: string): Promise<void> {
  await assertChildAccess('idea_feature', featureId, ideaId, userId, 'write');
  const { error } = await db().from('idea_feature').delete().eq('id', featureId);
  if (error) throw error;
  await touch(ideaId);
}

/** Reordena por la lista completa de ids: una llamada en vez de un PATCH por fila al arrastrar. */
export async function reorderFeatures(ideaId: string, userId: string, ids: string[]): Promise<IdeaFeature[]> {
  await assertIdeaAccess(ideaId, userId, 'write');
  const { data: owned } = await db().from('idea_feature').select('id').eq('idea_id', ideaId);
  const valid = new Set(((owned ?? []) as { id: string }[]).map((r) => r.id));
  // Solo se reordena lo que pertenece a esta idea; ids ajenos se ignoran en silencio.
  const seq = ids.filter((id) => valid.has(id));
  for (let i = 0; i < seq.length; i++) {
    await db().from('idea_feature').update({ position: i }).eq('id', seq[i]!);
  }
  await touch(ideaId);
  const { data } = await db().from('idea_feature').select('*').eq('idea_id', ideaId).order('position').order('created_at');
  return ((data ?? []) as any[]).map(mapFeature);
}

// ---- Bloques libres ----

export async function addBlock(
  ideaId: string,
  userId: string,
  input: { kind: BlockKind; title?: string | null; body?: string | null; source?: string | null; url?: string | null },
): Promise<IdeaBlock> {
  await assertIdeaAccess(ideaId, userId, 'write');
  const { data: last } = await db()
    .from('idea_block')
    .select('position')
    .eq('idea_id', ideaId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();
  const position = ((last as { position?: number } | null)?.position ?? -1) + 1;
  const { data, error } = await db()
    .from('idea_block')
    .insert({
      idea_id: ideaId,
      kind: input.kind,
      title: input.title ?? null,
      body: input.body ?? null,
      source: input.source ?? null,
      url: input.url ?? null,
      position,
    })
    .select('*')
    .single();
  if (error) throw error;
  await touch(ideaId);
  return mapBlock(data);
}

export async function updateBlock(
  ideaId: string,
  blockId: string,
  userId: string,
  patch: { title?: string | null; body?: string | null; source?: string | null; url?: string | null; resolved?: boolean },
): Promise<IdeaBlock> {
  await assertChildAccess('idea_block', blockId, ideaId, userId, 'write');
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.body !== undefined) row.body = patch.body;
  if (patch.source !== undefined) row.source = patch.source;
  if (patch.url !== undefined) row.url = patch.url;
  if (patch.resolved !== undefined) row.resolved = patch.resolved;
  const { data, error } = await db().from('idea_block').update(row).eq('id', blockId).select('*').single();
  if (error) throw error;
  await touch(ideaId);
  return mapBlock(data);
}

export async function deleteBlock(ideaId: string, blockId: string, userId: string): Promise<void> {
  await assertChildAccess('idea_block', blockId, ideaId, userId, 'write');
  const { error } = await db().from('idea_block').delete().eq('id', blockId);
  if (error) throw error;
  await touch(ideaId);
}

// ---- Adjuntos (mismo mecanismo que los de tareas: bucket público, subida por el backend) ----

export async function listIdeaAttachments(ideaId: string): Promise<IdeaAttachment[]> {
  const { data } = await db()
    .from('idea_attachment')
    .select('id, url, name, content_type, size, created_at')
    .eq('idea_id', ideaId)
    .order('created_at', { ascending: true });
  return ((data ?? []) as any[]).map(mapAttachment);
}

export async function addIdeaAttachment(
  ideaId: string,
  userId: string,
  file: { body: Buffer; name: string; contentType: string; size: number },
): Promise<IdeaAttachment> {
  await assertIdeaAccess(ideaId, userId, 'write');
  const supabase = db();
  const safe = (file.name.replace(/[^\w.\-]+/g, '_') || 'imagen').slice(-80);
  const path = `${ideaId}/${randomUUID()}-${safe}`;
  const up = await supabase.storage.from(ATTACH_BUCKET).upload(path, file.body, { contentType: file.contentType, upsert: false });
  if (up.error) throw up.error;
  const { data: pub } = supabase.storage.from(ATTACH_BUCKET).getPublicUrl(path);
  const { data, error } = await supabase
    .from('idea_attachment')
    .insert({
      idea_id: ideaId,
      storage_path: path,
      url: pub.publicUrl,
      name: file.name.slice(0, 200),
      content_type: file.contentType,
      size: file.size,
      uploaded_by: userId,
    })
    .select('id, url, name, content_type, size, created_at')
    .single();
  if (error) throw error;
  await touch(ideaId);
  return mapAttachment(data);
}

export async function deleteIdeaAttachment(ideaId: string, attachmentId: string, userId: string): Promise<void> {
  await assertChildAccess('idea_attachment', attachmentId, ideaId, userId, 'write');
  const supabase = db();
  const { data } = await supabase.from('idea_attachment').select('storage_path').eq('id', attachmentId).maybeSingle();
  const path = (data as { storage_path?: string } | null)?.storage_path;
  if (path) await supabase.storage.from(ATTACH_BUCKET).remove([path]).then(() => {}, () => {}); // best-effort: la fila manda
  const { error } = await supabase.from('idea_attachment').delete().eq('id', attachmentId);
  if (error) throw error;
  await touch(ideaId);
}
