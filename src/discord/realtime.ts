// Tiempo real del chat de Discord (contrato §C): mismo buzón privado `chat:dev:<devId>` que el chat
// interno (src/chat/realtime.ts), eventos con prefijo `discord.`. A quién le llega cada evento lo
// decide el algoritmo de permisos sobre los devs LIGADOS: nunca se filtra un mensaje a quien no ve
// el canal en Discord.
import { broadcastToDevs } from '../chat/realtime.js';
import type { DiscordMessageView, DiscordRealtimeEvent, DiscordRealtimePayloads } from '../types/discord.js';
import { loadLinkedMembers, recipientsFor, type GuildSnapshot, type LinkedMember } from './store.js';

/** Envío tipado: el payload tiene que calzar con el evento. */
export async function sendDiscordEvent<E extends DiscordRealtimeEvent>(devIds: string[], event: E, payload: DiscordRealtimePayloads[E]): Promise<void> {
  await broadcastToDevs(devIds, event, payload as unknown as Record<string, unknown>);
}

/** `discord.message.created|updated` a quien ve el canal/hilo del mensaje. */
export async function broadcastMessage(
  snap: GuildSnapshot,
  event: 'discord.message.created' | 'discord.message.updated',
  message: DiscordMessageView,
  linked?: LinkedMember[],
): Promise<string[]> {
  const devs = recipientsFor(snap, linked ?? (await loadLinkedMembers(snap.guildId)), message.channelId);
  await sendDiscordEvent(devs, event, { channelId: message.channelId, message });
  return devs;
}

export async function broadcastDeleted(snap: GuildSnapshot, channelId: string, messageIds: string[], linked?: LinkedMember[]): Promise<string[]> {
  const devs = recipientsFor(snap, linked ?? (await loadLinkedMembers(snap.guildId)), channelId);
  await sendDiscordEvent(devs, 'discord.message.deleted', { channelId, messageIds });
  return devs;
}

/** A TODOS los devs ligados (estructura, estado del puente): incluye a quien acaba de perder acceso. */
export async function broadcastToLinked<E extends 'discord.channels.changed' | 'discord.bridge.status'>(
  event: E,
  payload: DiscordRealtimePayloads[E],
  linked?: LinkedMember[],
): Promise<void> {
  const list = linked ?? (await loadLinkedMembers());
  await sendDiscordEvent(list.map((l) => l.devId), event, payload);
}
