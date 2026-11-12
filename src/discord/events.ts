// Avisos del puente → tiempo real (contrato §A.2). El puente ya escribió la base; el aviso solo dice
// "mira X". Aquí se RELEE la fila (fuente de verdad), se calcula quién la puede ver con el algoritmo
// de permisos y se transmite. Un aviso repetido, tardío o fuera de orden solo retransmite el estado
// ACTUAL: nunca pinta algo viejo.
//
// Servidor, roles, canales y devs ligados se cargan UNA vez por llamada (hasta 100 avisos).
import { z } from 'zod';
import type {
  DiscordBridgeEventsResult,
  DiscordBridgeNotice,
  DiscordMessageRow,
  DiscordStructureScope,
} from '../types/discord.js';
import { broadcastDeleted, broadcastMessage, broadcastToLinked } from './realtime.js';
import { MESSAGE_COLUMNS, loadLinkedMembers, loadSnapshot, selectIn } from './store.js';
import { buildMessageViews } from './views.js';

const snowflake = z.string().regex(/^\d{15,25}$/);
const SCOPES = ['guild', 'channels', 'roles', 'members', 'emojis', 'threads'] as const;

export const BridgeNoticeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message.created'), channelId: snowflake, messageId: snowflake }),
  z.object({ kind: z.literal('message.updated'), channelId: snowflake, messageId: snowflake }),
  z.object({ kind: z.literal('message.deleted'), channelId: snowflake, messageIds: z.array(snowflake).min(1).max(100) }),
  z.object({
    kind: z.literal('structure.changed'),
    scope: z.enum(SCOPES),
    channelIds: z.array(snowflake).max(500).optional(),
    userIds: z.array(snowflake).max(1000).optional(),
  }),
  z.object({ kind: z.literal('bridge.status'), status: z.enum(['connecting', 'backfilling', 'ready', 'disconnected']) }),
]);

export const BridgeEventsBodySchema = z.object({
  guildId: snowflake,
  notices: z.array(BridgeNoticeSchema).min(1).max(100),
});

type OnError = (err: unknown) => void;

/**
 * Procesa un lote de avisos. Quien llama ya validó el bearer, el flag y que `guildId` es el nuestro.
 * Una falla al transmitir un aviso no tumba los demás (se reporta con `onError`): el puente no debe
 * reintentar el lote entero por un broadcast que Realtime rechazó.
 */
export async function processBridgeNotices(guildId: string, notices: DiscordBridgeNotice[], onError?: OnError): Promise<DiscordBridgeEventsResult> {
  const [snap, linked] = await Promise.all([loadSnapshot(guildId), loadLinkedMembers(guildId)]);
  let processed = 0;
  let skipped = 0;

  // Mensajes del lote en UNA consulta y sus vistas en UN armado.
  const messageIds = notices.flatMap((n) => (n.kind === 'message.created' || n.kind === 'message.updated' ? [n.messageId] : []));
  const rows = messageIds.length ? await selectIn<DiscordMessageRow>('discord_message', MESSAGE_COLUMNS, 'id', messageIds) : [];
  const live = rows.filter((r) => !r.deleted_at && r.guild_id === guildId);
  const views = new Map((await buildMessageViews(live, snap, { refreshAttachments: false })).map((v) => [v.id, v]));

  const sentScopes = new Set<DiscordStructureScope>();
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      onError?.(err);
    }
  };

  for (const n of notices) {
    switch (n.kind) {
      case 'message.created':
      case 'message.updated': {
        const view = views.get(n.messageId);
        if (!view || !snap.channelRows.has(view.channelId)) {
          skipped++;
          break;
        }
        await run(() => broadcastMessage(snap, n.kind === 'message.created' ? 'discord.message.created' : 'discord.message.updated', view, linked));
        processed++;
        break;
      }
      case 'message.deleted': {
        if (!snap.channelRows.has(n.channelId)) {
          skipped++;
          break;
        }
        await run(() => broadcastDeleted(snap, n.channelId, [...new Set(n.messageIds)], linked));
        processed++;
        break;
      }
      case 'structure.changed': {
        // Un mismo alcance repetido en el lote basta con avisarlo una vez: el front recarga /channels.
        if (!sentScopes.has(n.scope)) {
          sentScopes.add(n.scope);
          await run(() => broadcastToLinked('discord.channels.changed', { reason: n.scope }, linked));
        }
        processed++;
        break;
      }
      case 'bridge.status': {
        await run(() => broadcastToLinked('discord.bridge.status', { status: n.status }, linked));
        processed++;
        break;
      }
      default:
        skipped++;
    }
  }
  return { ok: true, processed, skipped };
}
