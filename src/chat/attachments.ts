// Adjuntos del chat. A diferencia de los de tareas (bucket público), una conversación privada no
// puede servir sus archivos por URL pública: el bucket `chat-attachments` es PRIVADO y el backend
// firma URLs temporales cada vez que entrega mensajes.
//
// Flujo: el compositor sube primero cada archivo (queda con message_id = null) y luego manda el
// mensaje con los ids; sendMessage los ata. Así el envío del texto no espera a una subida lenta y
// el usuario ve el progreso por archivo.
import { randomUUID } from 'node:crypto';
import { db } from '../db/supabase.js';
import { ValidationError } from '../utils/errors.js';
import { assertMember } from './access.js';
import type { ChatAttachment } from './model.js';

export const CHAT_BUCKET = 'chat-attachments';
/** Bajo el límite de body de las funciones de Vercel (4.5 MB), igual que los adjuntos de tareas. */
export const MAX_CHAT_ATTACHMENT_BYTES = 4 * 1024 * 1024;
/** Vigencia de las URLs firmadas: holgada para una pestaña abierta un día de trabajo. */
const SIGNED_TTL_SECONDS = 6 * 3600;

interface AttachmentRow {
  id: string;
  message_id: string | null;
  storage_path: string;
  name: string;
  content_type: string | null;
  size: number | null;
}

const COLUMNS = 'id, message_id, storage_path, name, content_type, size';

/** Firma en UNA llamada las URLs de todas las filas. Una firma fallida deja `url: null`, no tumba la lista. */
async function sign(rows: AttachmentRow[]): Promise<Map<string, ChatAttachment>> {
  const out = new Map<string, ChatAttachment>();
  if (!rows.length) return out;
  const { data } = await db()
    .storage.from(CHAT_BUCKET)
    .createSignedUrls(rows.map((r) => r.storage_path), SIGNED_TTL_SECONDS);
  const urlByPath = new Map((data ?? []).map((s) => [s.path, s.signedUrl]));
  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      name: r.name,
      contentType: r.content_type,
      size: r.size,
      url: urlByPath.get(r.storage_path) ?? null,
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

export async function uploadAttachment(
  devId: string,
  conversationId: string,
  file: { body: Buffer; name: string; contentType: string; size: number },
): Promise<ChatAttachment> {
  await assertMember(conversationId, devId);
  if (file.size > MAX_CHAT_ATTACHMENT_BYTES) throw new ValidationError('el archivo supera 4MB');

  const safe = (file.name.replace(/[^\w.\-]+/g, '_') || 'archivo').slice(-80);
  const path = `${conversationId}/${randomUUID()}-${safe}`;
  const supabase = db();
  const up = await supabase.storage
    .from(CHAT_BUCKET)
    .upload(path, file.body, { contentType: file.contentType || 'application/octet-stream', upsert: false });
  if (up.error) throw up.error;

  const { data, error } = await supabase
    .from('chat_attachment')
    .insert({
      conversation_id: conversationId,
      uploader_dev_id: devId,
      storage_path: path,
      name: file.name.slice(0, 200) || 'archivo',
      content_type: file.contentType || null,
      size: file.size,
    })
    .select(COLUMNS)
    .single();
  if (error) {
    await supabase.storage.from(CHAT_BUCKET).remove([path]).then(() => {}, () => {});
    throw error;
  }
  const row = data as AttachmentRow;
  return (await sign([row])).get(row.id)!;
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

async function removeRows(rows: { id: string; storage_path: string }[]): Promise<void> {
  if (!rows.length) return;
  const supabase = db();
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    // Best-effort en Storage: la fila manda. Un objeto huérfano en un bucket privado no se ve.
    await supabase.storage.from(CHAT_BUCKET).remove(chunk.map((r) => r.storage_path)).then(() => {}, () => {});
    await supabase.from('chat_attachment').delete().in('id', chunk.map((r) => r.id));
  }
}

/** Borra los archivos de un mensaje (al eliminarlo). */
export async function removeMessageFiles(messageId: string): Promise<void> {
  const { data } = await db().from('chat_attachment').select('id, storage_path').eq('message_id', messageId);
  await removeRows((data ?? []) as { id: string; storage_path: string }[]);
}

/** Borra todos los archivos de una conversación (antes de eliminarla). */
export async function removeConversationFiles(conversationId: string): Promise<void> {
  const { data } = await db().from('chat_attachment').select('id, storage_path').eq('conversation_id', conversationId);
  await removeRows((data ?? []) as { id: string; storage_path: string }[]);
}
