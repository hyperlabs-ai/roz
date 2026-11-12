// Adjuntos al escribir en Discord desde roz (contrato §B.6). Mismo flujo que src/chat/attachments.ts
// para esquivar el tope de 4.5 MB de los cuerpos en Vercel: el navegador sube DIRECTO al bucket
// privado `roz-chat` con una URL firmada, confirma, y al enviar roz descarga el objeto y lo manda
// multipart al webhook. Discord lo hospeda desde ahí (cdn.discordapp.com) y la copia se borra.
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import type { DiscordFile } from '../adapters/discord.js';
import type { DiscordUploadRow, DiscordUploadView } from '../types/discord.js';
import { DISCORD_UPLOAD_TOO_LARGE } from './errors.js';

export const DISCORD_UPLOAD_BUCKET = 'roz-chat';
/** Tope de Discord por mensaje (todos los archivos juntos). */
export const DISCORD_MAX_TOTAL_UPLOAD_BYTES = 25 * 1024 * 1024;
export const DISCORD_MAX_FILES = 10;

const UPLOAD_COLUMNS = 'id, dev_id, channel_id, bucket, storage_path, name, content_type, size, completed_at, message_id, created_at';

const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);

/** Mismo texto que el compositor. */
export function uploadTooLargeMessage(name: string, size: number, max = config.discord.maxUploadBytes): string {
  return `${name} pesa ${mb(size)} MB y el límite es ${Math.round(max / (1024 * 1024))} MB`;
}

export function tooLarge(name: string, size: number): AppError {
  return new AppError(DISCORD_UPLOAD_TOO_LARGE, uploadTooLargeMessage(name, size), 413);
}

export function uploadView(row: Pick<DiscordUploadRow, 'id' | 'name' | 'content_type' | 'size'>): DiscordUploadView {
  return { id: row.id, name: row.name, contentType: row.content_type, size: row.size };
}

/** Nombre seguro para la ruta de Storage (el nombre visible se guarda aparte, intacto). */
export function safeFileName(name: string): string {
  return (name.replace(/[^\w.\-]+/g, '_') || 'archivo').slice(-80);
}

/** Paso 1: fila + URL firmada de SUBIDA. Quien llama ya validó que puede adjuntar en el canal. */
export async function requestDiscordUpload(
  devId: string,
  channelId: string,
  file: { name: string; contentType: string | null; size: number },
): Promise<{ upload: DiscordUploadView; uploadUrl: string; token: string; path: string }> {
  if (!Number.isFinite(file.size) || file.size <= 0) throw new ValidationError('el archivo está vacío');
  if (file.size > config.discord.maxUploadBytes) throw tooLarge(file.name, file.size);
  const id = randomUUID();
  const path = `discord/${devId}/${id}/${safeFileName(file.name)}`;
  const supabase = db();
  const { data: signed, error: signErr } = await supabase.storage.from(DISCORD_UPLOAD_BUCKET).createSignedUploadUrl(path);
  if (signErr || !signed) throw signErr ?? new Error('no se pudo preparar la subida');
  const row = {
    id,
    dev_id: devId,
    channel_id: channelId,
    bucket: DISCORD_UPLOAD_BUCKET,
    storage_path: path,
    name: file.name.slice(0, 200) || 'archivo',
    content_type: file.contentType || null,
    size: file.size,
  };
  const { error } = await supabase.from('discord_upload').insert(row);
  if (error) throw error;
  return { upload: uploadView(row), uploadUrl: signed.signedUrl, token: signed.token, path };
}

async function loadOwnUpload(devId: string, uploadId: string): Promise<DiscordUploadRow> {
  const { data, error } = await db().from('discord_upload').select(UPLOAD_COLUMNS).eq('id', uploadId).maybeSingle();
  if (error) throw error;
  const row = data as DiscordUploadRow | null;
  if (!row || row.dev_id.toLowerCase() !== devId.toLowerCase()) throw new NotFoundError('el archivo no existe');
  return row;
}

async function removeUploads(rows: Pick<DiscordUploadRow, 'id' | 'bucket' | 'storage_path'>[], dropRows: boolean): Promise<void> {
  if (!rows.length) return;
  const supabase = db();
  for (const bucket of new Set(rows.map((r) => r.bucket))) {
    await supabase.storage
      .from(bucket)
      .remove(rows.filter((r) => r.bucket === bucket).map((r) => r.storage_path))
      .then(() => {}, () => {});
  }
  if (dropRows) await supabase.from('discord_upload').delete().in('id', rows.map((r) => r.id));
}

/** Paso 3: el objeto existe; guarda su tamaño REAL. Si pasa del tope, se borra y 413. */
export async function completeDiscordUpload(devId: string, uploadId: string): Promise<DiscordUploadView> {
  const row = await loadOwnUpload(devId, uploadId);
  if (row.message_id) throw new ValidationError('el archivo ya se envió');
  const { data: info, error: infoErr } = await db().storage.from(row.bucket).info(row.storage_path);
  if (infoErr || !info) throw new ValidationError('el archivo no terminó de subirse');
  const size = typeof info.size === 'number' ? info.size : row.size;
  if (size && size > config.discord.maxUploadBytes) {
    await removeUploads([row], true);
    throw tooLarge(row.name, size);
  }
  const contentType = row.content_type || info.contentType || null;
  const patch = { size, content_type: contentType, completed_at: new Date().toISOString() };
  const { error } = await db().from('discord_upload').update(patch).eq('id', row.id);
  if (error) throw error;
  return uploadView({ ...row, ...patch });
}

/**
 * Para enviar: las subidas completas, del dev, del canal/hilo, sin enviar. Todas o error (un id que
 * no calza no se ignora en silencio: el dev creería que mandó el archivo).
 */
export async function loadUploadsForSend(devId: string, channelId: string, ids: string[]): Promise<DiscordUploadRow[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  if (unique.length > DISCORD_MAX_FILES) throw new ValidationError(`máximo ${DISCORD_MAX_FILES} archivos por mensaje`);
  const { data, error } = await db().from('discord_upload').select(UPLOAD_COLUMNS).in('id', unique);
  if (error) throw error;
  const rows = ((data ?? []) as DiscordUploadRow[]).filter(
    (r) => r.dev_id.toLowerCase() === devId.toLowerCase() && r.channel_id === channelId && !!r.completed_at && !r.message_id,
  );
  if (rows.length !== unique.length) throw new ValidationError('algún archivo no existe, no terminó de subirse o ya se envió');
  const byId = new Map(rows.map((r) => [r.id, r]));
  return unique.map((id) => byId.get(id)!);
}

/** Descarga los objetos para el multipart, revisando topes por archivo y total. */
export async function downloadUploads(rows: DiscordUploadRow[]): Promise<DiscordFile[]> {
  const files: DiscordFile[] = [];
  let total = 0;
  for (const r of rows) {
    const { data, error } = await db().storage.from(r.bucket).download(r.storage_path);
    if (error || !data) throw new ValidationError(`no se pudo leer ${r.name}; vuelve a adjuntarlo`);
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength > config.discord.maxUploadBytes) throw tooLarge(r.name, bytes.byteLength);
    total += bytes.byteLength;
    if (total > DISCORD_MAX_TOTAL_UPLOAD_BYTES) {
      throw new AppError(DISCORD_UPLOAD_TOO_LARGE, `Los archivos juntos pasan de ${DISCORD_MAX_TOTAL_UPLOAD_BYTES / (1024 * 1024)} MB`, 413);
    }
    files.push({ name: r.name, contentType: r.content_type, data: bytes });
  }
  return files;
}

/** Tras enviar: ata las filas al mensaje y borra las copias de Storage (best-effort). */
export async function settleUploads(rows: DiscordUploadRow[], messageId: string): Promise<void> {
  if (!rows.length) return;
  await db().from('discord_upload').update({ message_id: messageId }).in('id', rows.map((r) => r.id)).then(() => {}, () => {});
  await removeUploads(rows, false);
}
