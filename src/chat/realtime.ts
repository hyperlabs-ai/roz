// Tiempo real del chat: Supabase Realtime Broadcast, un buzón PRIVADO por dev (`chat:dev:<devId>`).
//
// Por qué un buzón por persona y no un topic por conversación: el cliente abre UNA sola suscripción
// (para el badge del nav y para la conversación abierta), la autorización es trivial (cada quien
// escucha lo suyo, ver roz.chat_topic_allowed en 0030) y el backend decide a quién le llega cada
// evento — las conversaciones privadas nunca se filtran por adivinar un topic.
//
// Se publica por la API REST de Realtime con el service_role, en UNA sola petición para todos los
// destinatarios. Best-effort: si Realtime no responde, el cliente se pone al día por polling.
import { config } from '../config.js';
import type { DiscordRealtimeEvent } from '../types/discord.js';

export type ChatRealtimeEvent =
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'conversation.updated'
  | 'conversation.removed'
  | 'read';

export function devTopic(devId: string): string {
  return `chat:dev:${devId}`;
}

// Con ROZ_DISCORD_CHAT el mismo buzón lleva los eventos `discord.*` (src/types/discord.ts): una sola
// suscripción por pestaña, sea cual sea el chat activo.
export async function broadcastToDevs(
  devIds: string[],
  event: ChatRealtimeEvent | DiscordRealtimeEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const ids = [...new Set(devIds.filter(Boolean))];
  const { url, serviceRoleKey } = config.supabase;
  if (!ids.length || !url || !serviceRoleKey) return;
  const res = await fetch(`${url.replace(/\/$/, '')}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      messages: ids.map((id) => ({ topic: devTopic(id), event, payload, private: true })),
    }),
  });
  if (!res.ok) throw new Error(`realtime broadcast ${res.status}: ${await res.text().catch(() => '')}`);
}
