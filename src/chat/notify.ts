// Push de la PWA por mensajes del chat. Sale directo (no por el outbox, que se drena cada minuto:
// un chat que avisa un minuto tarde no sirve) y después de responder (ver utils/background.ts).
// Pasa por pushToDev, así que respeta los interruptores de Configuración y limpia suscripciones
// caducadas igual que el resto de avisos.
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { pushToDev } from '../notify/push.js';
import type { ChatDev, ConversationRow, MemberRow, MessageRow } from './model.js';
import { chatPushRecipients } from './rules.js';
import { previewText, statusTaskIds } from './text.js';

function chatUrl(conversationId: string, threadId?: string | null): string {
  const path = `/app/chat/${conversationId}${threadId ? `?thread=${threadId}` : ''}`;
  return config.dashboard.url ? `${config.dashboard.url}${path}` : path;
}

/** Quienes escribieron en el hilo (el raíz y las respuestas previas). */
async function threadParticipants(rootId: string): Promise<string[]> {
  const [{ data: root }, { data: replies }] = await Promise.all([
    db().from('chat_message').select('author_dev_id').eq('id', rootId).maybeSingle(),
    db().from('chat_message').select('author_dev_id').eq('parent_id', rootId).eq('kind', 'user'),
  ]);
  const ids = [
    (root as { author_dev_id: string | null } | null)?.author_dev_id,
    ...((replies ?? []) as { author_dev_id: string | null }[]).map((r) => r.author_dev_id),
  ];
  return [...new Set(ids.filter((x): x is string => !!x))];
}

export async function notifyChatMessage(input: {
  conversation: ConversationRow;
  message: MessageRow;
  members: MemberRow[];
  devs: ChatDev[];
  attachmentCount: number;
}): Promise<void> {
  const { conversation: conv, message: msg, members, devs } = input;
  if (msg.kind !== 'user' || !msg.author_dev_id) return;

  const isReply = !!msg.parent_id;
  const recipients = chatPushRecipients({
    kind: conv.kind,
    authorDevId: msg.author_dev_id,
    members: members.map((m) => ({ devId: m.dev_id, notifyLevel: m.notify_level })),
    mentions: msg.mentions ?? [],
    mentionChannel: msg.mention_channel,
    isReply,
    threadParticipants: isReply ? await threadParticipants(msg.parent_id!) : undefined,
  });
  if (!recipients.length) return;

  const devById = new Map(devs.map((d) => [d.id, d]));
  const nameOf = (id: string) => devById.get(id)?.name;
  const author = nameOf(msg.author_dev_id) ?? 'Alguien';

  let preview = previewText(msg.body, nameOf);
  const statusCount = statusTaskIds(msg.meta).length;
  if (statusCount) {
    const label = `📋 Status · ${statusCount === 1 ? '1 tarea' : `${statusCount} tareas`}`;
    preview = preview ? `${label} — ${preview}` : label;
  }
  if (!preview && input.attachmentCount) {
    preview = input.attachmentCount === 1 ? '📎 Envió un archivo' : `📎 Envió ${input.attachmentCount} archivos`;
  }

  let title: string;
  let body: string;
  if (conv.kind === 'dm') {
    const others = members.map((m) => m.dev_id).filter((d) => d !== msg.author_dev_id);
    title = others.length > 1 ? `${author} · grupo` : author;
    body = preview;
  } else {
    title = isReply ? `Hilo en #${conv.name}` : `#${conv.name}`;
    body = `${author}: ${preview}`;
  }
  if (isReply && conv.kind === 'dm') title = `${title} (hilo)`;

  const payload = {
    title,
    body,
    url: chatUrl(conv.id, msg.parent_id),
    // Una notificación por conversación: la nueva reemplaza a la anterior en vez de apilar 20.
    tag: `chat:${conv.id}`,
    // `messageId`: la app abierta usa la misma llave para el sonido que dispara por tiempo real, así
    // el mensaje suena UNA vez aunque llegue por los dos caminos (socket y push).
    data: { kind: 'chat', conversationId: conv.id, threadId: msg.parent_id, messageId: msg.id },
  };

  await Promise.all(
    recipients.map((devId) =>
      // `high`: un chat que llega al teléfono cuando éste sale del reposo no sirve.
      pushToDev(devId, devById.get(devId)?.email ?? null, payload, 'chat_message', { logSent: false, urgency: 'high' }),
    ),
  );
}
