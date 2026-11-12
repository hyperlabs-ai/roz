// El webhook de roz de cada canal (contrato §B.4 paso 3). Es por donde sale TODO lo que se escribe
// desde roz: con el nombre y la foto del dev, sin que el bot tenga que hablar por él.
//
//   1. fila en roz.discord_webhook → se usa (token descifrado solo aquí, en memoria).
//   2. si no hay: se listan los webhooks del canal y se reutiliza uno incoming llamado 'roz' de
//      nuestra app (es el único tipo cuyo token vuelve en el listado); si no, se crea.
//   3. el token se guarda CIFRADO (src/utils/crypto.ts). Nunca en logs ni en errores.
//   4. si al usarlo Discord dice UNKNOWN_WEBHOOK (alguien lo borró en Discord): se borra la fila, se
//      recrea UNA vez y se reintenta.
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import {
  DISCORD_ERROR,
  createChannelWebhook,
  isDiscordError,
  listChannelWebhooks,
  type DiscordApiWebhook,
} from '../adapters/discord.js';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';
import { mapDiscordError } from './errors.js';
import { guildId } from './store.js';

export const ROZ_WEBHOOK_NAME = 'roz';

export interface RozWebhook {
  channelId: string;
  webhookId: string;
  token: string;
}

async function storedWebhook(channelId: string): Promise<RozWebhook | null> {
  const { data, error } = await db().from('discord_webhook').select('channel_id, webhook_id, token_enc').eq('channel_id', channelId).maybeSingle();
  if (error) throw error;
  const row = data as { channel_id: string; webhook_id: string; token_enc: string } | null;
  if (!row) return null;
  try {
    return { channelId, webhookId: row.webhook_id, token: decryptSecret(row.token_enc) };
  } catch {
    // Llave rotada o fila corrupta: se descarta y se consigue otro.
    await forgetWebhook(channelId);
    return null;
  }
}

export async function forgetWebhook(channelId: string): Promise<void> {
  await db().from('discord_webhook').delete().eq('channel_id', channelId);
}

/** ¿Es un webhook que roz puede reutilizar? Incoming, nuestro, con token y con el nombre de roz. */
export function isReusableRozWebhook(w: DiscordApiWebhook, applicationId = config.discord.clientId): boolean {
  return w.type === 1 && !!w.token && w.name === ROZ_WEBHOOK_NAME && !!applicationId && w.application_id === applicationId;
}

async function obtainWebhook(channelId: string): Promise<RozWebhook> {
  let hook: DiscordApiWebhook | undefined;
  try {
    hook = (await listChannelWebhooks(channelId)).find((w) => isReusableRozWebhook(w));
    if (!hook) hook = await createChannelWebhook(channelId, ROZ_WEBHOOK_NAME);
  } catch (err) {
    throw mapDiscordError(err);
  }
  if (!hook?.token) throw new Error('Discord devolvió un webhook sin token');
  const now = new Date().toISOString();
  const { error } = await db()
    .from('discord_webhook')
    .upsert(
      {
        channel_id: channelId,
        guild_id: guildId(),
        webhook_id: hook.id,
        token_enc: encryptSecret(hook.token),
        name: hook.name ?? ROZ_WEBHOOK_NAME,
        updated_at: now,
      },
      { onConflict: 'channel_id' },
    );
  if (error) throw error;
  return { channelId, webhookId: hook.id, token: hook.token };
}

/** Webhook de roz del canal (no hilo), creándolo si hace falta. */
export async function ensureWebhook(channelId: string): Promise<RozWebhook> {
  return (await storedWebhook(channelId)) ?? obtainWebhook(channelId);
}

/** Webhook de roz ya guardado, sin crearlo (editar/borrar solo tienen sentido con el que envió). */
export async function existingWebhook(channelId: string): Promise<RozWebhook | null> {
  return storedWebhook(channelId);
}

/**
 * Ejecuta `fn` con el webhook del canal. UNKNOWN_WEBHOOK → se olvida, se recrea una vez y se
 * reintenta. Cualquier otro error de Discord sale ya traducido a AppError.
 */
export async function withWebhook<T>(channelId: string, fn: (hook: RozWebhook) => Promise<T>): Promise<T> {
  const hook = await ensureWebhook(channelId);
  try {
    return await fn(hook);
  } catch (err) {
    if (!isDiscordError(err, DISCORD_ERROR.UNKNOWN_WEBHOOK)) throw mapDiscordError(err);
  }
  await forgetWebhook(channelId);
  const fresh = await obtainWebhook(channelId);
  try {
    return await fn(fresh);
  } catch (err) {
    throw mapDiscordError(err);
  }
}
