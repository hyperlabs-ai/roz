// Adjuntos del chat. A diferencia de los de tareas (bucket público), una conversación privada no
// puede servir sus archivos por URL pública: el bucket `roz-chat` es PRIVADO y el backend firma
// URLs temporales cada vez que entrega mensajes.
//
// Cada fila guarda su bucket (migración 0035): los adjuntos anteriores viven en 'chat-attachments',
// un bucket PÚBLICO de otra app del mismo proyecto de Supabase que roz reutilizó por error, hasta
// que scripts/move-chat-files.ts los mueva. Los nuevos van siempre a CHAT_BUCKET.
//
// Flujo de subida (directa a Storage, sin pasar el archivo por la función de Vercel, que corta los
// cuerpos en 4.5 MB):
//   1. requestUpload  → valida membresía y tamaño, crea la fila (message_id = null) y una URL
//                       firmada de SUBIDA para esa ruta.
//   2. el navegador sube el archivo directo a Storage con esa URL (con barra de progreso).
//   3. completeUpload → comprueba que el objeto existe y guarda su tamaño REAL.
//   4. sendMessage ata los ids al mensaje.
// El tope real de 20 MB lo pone el bucket (migración 0034): aunque el cliente mienta sobre el
// tamaño en el paso 1, Storage rechaza el archivo en el paso 2.
import { randomUUID } from 'node:crypto';
import { db } from '../db/supabase.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { assertMember } from './access.js';
import type { ChatAttachment } from './model.js';

export const CHAT_BUCKET = 'roz-chat';
/** Bucket de los adjuntos anteriores a la 0035 (de otra app; ver arriba). */
export const LEGACY_CHAT_BUCKET = 'chat-attachments';
/** Debe coincidir con el file_size_limit del bucket (migración 0035) y con el SPA (lib/chat.ts). */
export const MAX_CHAT_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);

/** Mensaje del límite, igual que el que muestra el compositor. */
export function tooLargeMessage(name: string, size: number): string {
  return `${name} pesa ${mb(size)} MB y el límite es ${MAX_CHAT_ATTACHMENT_BYTES / (1024 * 1024)} MB`;
}
/** Vigencia de las URLs firmadas: holgada para una pestaña abierta un día de trabajo. */
const SIGNED_TTL_SECONDS = 6 * 3600;

interface AttachmentRow {
  id: string;
  message_id: string | null;
  bucket: string;
  storage_path: string;
  name: string;
  content_type: string | null;
  size: number | null;
}

const COLUMNS = 'id, message_id, bucket, storage_path, name, content_type, size';

/** Firma las URLs de todas las filas: UNA llamada por bucket. Una firma fallida deja `url: null`,
 *  no tumba la lista. */
async function sign(rows: AttachmentRow[]): Promise<Map<string, ChatAttachment>> {
  const out = new Map<string, ChatAttachment>();
  if (!rows.length) return out;
  const byBucket = new Map<string, AttachmentRow[]>();
  for (const r of rows) byBucket.set(r.bucket, [...(byBucket.get(r.bucket) ?? []), r]);
  const urls = new Map<string, string | null>(); // `${bucket}/${path}` → URL
  await Promise.all(
    [...byBucket].map(async ([bucket, list]) => {
      const { data } = await db().storage.from(bucket).createSignedUrls(list.map((r) => r.storage_path), SIGNED_TTL_SECONDS);
      for (const s of data ?? []) if (s.path) urls.set(`${bucket}/${s.path}`, s.signedUrl);
    }),
  );
  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      name: r.name,
      contentType: r.content_type,
      size: r.size,
      url: urls.get(`${r.bucket}/${r.storage_path}`) ?? null,
    });
  }
  return out;
}

/** Adjuntos (firmados) de un conjunto de mensajes, agrupados por mensaje. */
export async function attachmentsByMessage(messageIds: string[]): Promise<Map<string, ChatAttachment[]>> {
  const map = new Map<string, ChatAttachment[]>();
  if (!messageIds.length) return map;
  const { data, error } = await db()
    .from('chat_attachment')
    .select(COLUMNS)
    .in('message_id', messageIds)
    .order('created_at', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as AttachmentRow[];
  const signed = await sign(rows);
  for (const r of rows) {
    const list = map.get(r.message_id!) ?? [];
    list.push(signed.get(r.id)!);
    map.set(r.message_id!, list);
  }
  return map;
}

/** Paso 1: reserva la fila y entrega la URL firmada a la que el navegador sube el archivo. */
export async function requestUpload(
  devId: string,
  conversationId: string,
  file: { name: string; contentType: string | null; size: number },
): Promise<{ attachmentId: string; signedUrl: string }> {
  await assertMember(conversationId, devId);
  if (!Number.isFinite(file.size) || file.size <= 0) throw new ValidationError('el archivo está vacío');
  if (file.size > MAX_CHAT_ATTACHMENT_BYTES) throw new ValidationError(tooLargeMessage(file.name, file.size));

  const safe = (file.name.replace(/[^\w.\-]+/g, '_') || 'archivo').slice(-80);
  const path = `${conversationId}/${randomUUID()}-${safe}`;
  const supabase = db();
  const { data: signed, error: signErr } = await supabase.storage.from(CHAT_BUCKET).createSignedUploadUrl(path);
  if (signErr || !signed) throw signErr ?? new Error('no se pudo preparar la subida');

  const { data, error } = await supabase
    .from('chat_attachment')
    .insert({
      conversation_id: conversationId,
      uploader_dev_id: devId,
      bucket: CHAT_BUCKET,
      storage_path: path,
      name: file.name.slice(0, 200) || 'archivo',
      content_type: file.contentType || null,
      size: file.size, // lo declarado; completeUpload lo corrige con el real
    })
    .select('id')
    .single();
  if (error) throw error;
  return { attachmentId: (data as { id: string }).id, signedUrl: signed.signedUrl };
}

/** Paso 3: el objeto debe existir en Storage. Guarda su tamaño y tipo reales y lo entrega firmado. */
export async function completeUpload(devId: string, attachmentId: string): Promise<ChatAttachment> {
  const supabase = db();
  const { data, error } = await supabase
    .from('chat_attachment')
    .select(`${COLUMNS}, uploader_dev_id`)
    .eq('id', attachmentId)
    .maybeSingle();
  if (error) throw error;
  const row = data as (AttachmentRow & { uploader_dev_id: string | null }) | null;
  if (!row || row.uploader_dev_id?.toLowerCase() !== devId.toLowerCase()) throw new NotFoundError('el archivo no existe');

  const { data: info, error: infoErr } = await supabase.storage.from(row.bucket).info(row.storage_path);
  if (infoErr || !info) throw new ValidationError('el archivo no terminó de subirse');

  const size = typeof info.size === 'number' ? info.size : row.size;
  if (size && size > MAX_CHAT_ATTACHMENT_BYTES) {
    await removeRows([row]);
    throw new ValidationError(tooLargeMessage(row.name, size));
  }
  const contentType = row.content_type || info.contentType || null;
  if (size !== row.size || contentType !== row.content_type) {
    await supabase.from('chat_attachment').update({ size, content_type: contentType }).eq('id', row.id);
  }
  return (await sign([{ ...row, size, content_type: contentType }])).get(row.id)!;
}

/** Ata al mensaje los archivos que subió su autor en esa conversación. Devuelve cuántos ató. */
export async function linkAttachments(messageId: string, conversationId: string, devId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const { data, error } = await db()
    .from('chat_attachment')
    .update({ message_id: messageId })
    .in('id', ids)
    .eq('conversation_id', conversationId)
    .eq('uploader_dev_id', devId)
    .is('message_id', null)
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}

type StoredRow = { id: string; bucket: string; storage_path: string };

async function removeRows(rows: StoredRow[]): Promise<void> {
  if (!rows.length) return;
  const supabase = db();
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    // Best-effort en Storage: la fila manda. Un objeto huérfano en un bucket privado no se ve.
    for (const bucket of new Set(chunk.map((r) => r.bucket))) {
      const paths = chunk.filter((r) => r.bucket === bucket).map((r) => r.storage_path);
      await supabase.storage.from(bucket).remove(paths).then(() => {}, () => {});
    }
    await supabase.from('chat_attachment').delete().in('id', chunk.map((r) => r.id));
  }
}

/** Borra los archivos de un mensaje (al eliminarlo). */
export async function removeMessageFiles(messageId: string): Promise<void> {
  const { data } = await db().from('chat_attachment').select('id, bucket, storage_path').eq('message_id', messageId);
  await removeRows((data ?? []) as StoredRow[]);
}

/** Borra todos los archivos de una conversación (antes de eliminarla). */
export async function removeConversationFiles(conversationId: string): Promise<void> {
  const { data } = await db().from('chat_attachment').select('id, bucket, storage_path').eq('conversation_id', conversationId);
  await removeRows((data ?? []) as StoredRow[]);
}
