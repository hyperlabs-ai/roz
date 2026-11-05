// Formas del chat: filas crudas de la base y lo que recibe el SPA. Un solo lugar para que las
// columnas que se piden y lo que se devuelve no diverjan entre módulos.
import { db } from '../db/supabase.js';
import { avatarFor } from '../dashboard/queries.js';
import type { ConversationKind, NotifyLevel } from './rules.js';
import type { LinkPreview } from './unfurl.js';

export const CONVERSATION_COLUMNS =
  'id, kind, name, topic, description, is_private, is_default, dm_key, created_by, last_message_at, created_at, updated_at';
export const MEMBER_COLUMNS = 'conversation_id, dev_id, role, notify_level, last_read_at, hidden, joined_at';
export const MESSAGE_COLUMNS =
  'id, conversation_id, author_dev_id, parent_id, kind, body, mentions, mention_channel, meta, client_nonce, reply_count, last_reply_at, edited_at, deleted_at, created_at, link_previews';

export interface ConversationRow {
  id: string;
  kind: ConversationKind;
  name: string | null;
  topic: string | null;
  description: string | null;
  is_private: boolean;
  is_default: boolean;
  dm_key: string | null;
  created_by: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemberRow {
  conversation_id: string;
  dev_id: string;
  role: 'owner' | 'member';
  notify_level: NotifyLevel;
  last_read_at: string;
  hidden: boolean;
  joined_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  author_dev_id: string | null;
  parent_id: string | null;
  kind: 'user' | 'system';
  body: string;
  mentions: string[] | null;
  mention_channel: boolean;
  meta: Record<string, unknown> | null;
  client_nonce: string | null;
  reply_count: number;
  last_reply_at: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
  /** Tarjetas de los links (src/chat/unfurl.ts). Null = sin links o aún no calculadas. */
  link_previews: LinkPreview[] | null;
}

export interface ChatMembership {
  role: 'owner' | 'member';
  notifyLevel: NotifyLevel;
  lastReadAt: string;
  hidden: boolean;
}

export interface ChatConversation {
  id: string;
  kind: ConversationKind;
  name: string | null;
  topic: string | null;
  description: string | null;
  isPrivate: boolean;
  isDefault: boolean;
  createdBy: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  memberIds: string[];
  ownerIds: string[];
  /** La membresía de quien consulta; null si ve un canal público sin ser miembro. */
  membership: ChatMembership | null;
  unread: number;
  mentions: number;
}

export interface ChatAttachment {
  id: string;
  name: string;
  contentType: string | null;
  size: number | null;
  url: string | null;
}

/** Una tarea tal como la pinta el chat: lo mismo que la tarjeta del kanban. */
export interface ChatTaskRef {
  id: string;
  identifier: string;
  name: string;
  status: string;
  statusLabel: string;
  priority: string | null;
  dueDate: string | null;
  overdue: boolean;
  labels: string[];
  projectName: string | null;
  assigneeDevIds: string[];
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  parentId: string | null;
  kind: 'user' | 'system';
  authorDevId: string | null;
  body: string;
  mentions: string[];
  mentionChannel: boolean;
  meta: Record<string, unknown> | null;
  clientNonce: string | null;
  replyCount: number;
  lastReplyAt: string | null;
  /** Quienes respondieron en el hilo (para los avatares del resumen). */
  replyDevIds: string[];
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  attachments: ChatAttachment[];
  /** Tareas creadas a partir de este mensaje, con su estado actual. */
  tasks: ChatTaskRef[];
  /** Tareas citadas en el texto (`#ROZ-12`), en orden de aparición. */
  citedTasks: ChatTaskRef[];
  /** Tareas del bloque Status (`meta.type = 'status'`), con su estado ACTUAL, en el orden elegido. */
  statusTasks: ChatTaskRef[];
  /** Tarjetas de los links del mensaje (YouTube, posts, artículos). */
  linkPreviews: LinkPreview[];
}

export interface ChatDev {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  active: boolean;
}

/** Todos los devs (activos e inactivos: un mensaje viejo de alguien que ya no está necesita su nombre). */
export async function loadChatDevs(): Promise<ChatDev[]> {
  const { data, error } = await db().from('dev').select('id, name, email, github_login, active').order('name');
  if (error) throw error;
  return ((data ?? []) as { id: string; name: string; email: string | null; github_login: string | null; active: boolean }[]).map(
    (d) => ({ id: d.id, name: d.name, email: d.email, avatarUrl: avatarFor(d.github_login), active: d.active }),
  );
}

export function toMembership(m: MemberRow): ChatMembership {
  return { role: m.role, notifyLevel: m.notify_level, lastReadAt: m.last_read_at, hidden: m.hidden };
}
