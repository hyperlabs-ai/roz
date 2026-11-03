// Chat del equipo: tipos espejo del backend (src/chat/model.ts), llamadas a la API y utilidades
// PURAS de texto y agrupado (las prueba test/chat-web.test.ts, por eso este módulo no importa React).
import { apiGet, apiSend, apiUpload } from './api';

export type NotifyLevel = 'all' | 'mentions' | 'none';
export type ConversationKind = 'channel' | 'dm';

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
  replyDevIds: string[];
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  attachments: ChatAttachment[];
  /** Tareas creadas a partir de este mensaje. */
  tasks: ChatTaskRef[];
  /** Tareas citadas en el texto (`#ROZ-12`), en orden de aparición. */
  citedTasks: ChatTaskRef[];
  /** Solo cliente: envío optimista en vuelo / fallido. */
  pending?: boolean;
  failed?: boolean;
}

export interface ChatDev {
  id: string;
  name: string;
  avatarUrl: string | null;
  active: boolean;
}

export interface PublicChannel {
  id: string;
  name: string;
  topic: string | null;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  lastMessageAt: string | null;
  memberCount: number;
  joined: boolean;
}

export interface UnreadItem {
  conversationId: string;
  kind: ConversationKind;
  notifyLevel: NotifyLevel;
  unread: number;
  mentions: number;
}

/** Eventos que llegan por el buzón de tiempo real (src/chat/realtime.ts). */
export type ChatEvent =
  | { type: 'message.created'; message: ChatMessage }
  | { type: 'message.updated'; message: ChatMessage }
  | { type: 'message.deleted'; conversationId: string; id: string; parentId: string | null }
  | { type: 'conversation.removed'; conversationId: string }
  /** Se perdió (o pudo perderse) algo: la vista abierta debe volver a pedir sus mensajes. */
  | { type: 'resync' }
  /** Una tarea nacida del chat cambió (desde el diálogo de tarea): refrescar su ficha. */
  | { type: 'task.updated'; task: ChatTaskRef }
  | { type: 'task.deleted'; taskId: string };

// ---- API ----

const enc = encodeURIComponent;

export const chatApi = {
  bootstrap: () => apiGet<{ conversations: ChatConversation[]; devs: ChatDev[] }>('/chat/bootstrap'),
  unread: () => apiGet<{ items: UnreadItem[] }>('/chat/unread'),
  conversation: (id: string) => apiGet<{ conversation: ChatConversation }>(`/chat/conversations/${id}`),
  createChannel: (body: { name: string; topic?: string | null; description?: string | null; isPrivate?: boolean; memberDevIds?: string[] }) =>
    apiSend<{ conversation: ChatConversation }>('POST', '/chat/conversations', body),
  updateConversation: (id: string, patch: { name?: string; topic?: string | null; description?: string | null; isPrivate?: boolean }) =>
    apiSend<{ conversation: ChatConversation }>('PATCH', `/chat/conversations/${id}`, patch),
  deleteConversation: (id: string) => apiSend<{ ok: true }>('DELETE', `/chat/conversations/${id}`),
  openDm: (devIds: string[]) => apiSend<{ conversation: ChatConversation }>('POST', '/chat/dms', { devIds }),
  browse: () => apiGet<{ channels: PublicChannel[] }>('/chat/conversations/browse'),
  join: (id: string) => apiSend<{ conversation: ChatConversation }>('POST', `/chat/conversations/${id}/join`),
  leave: (id: string) => apiSend<{ ok: true }>('POST', `/chat/conversations/${id}/leave`),
  read: (id: string) => apiSend<{ lastReadAt: string | null }>('POST', `/chat/conversations/${id}/read`),
  updateMembership: (id: string, patch: { notifyLevel?: NotifyLevel; hidden?: boolean }) =>
    apiSend<{ membership: ChatMembership }>('PATCH', `/chat/conversations/${id}/membership`, patch),
  addMembers: (id: string, devIds: string[]) =>
    apiSend<{ conversation: ChatConversation }>('POST', `/chat/conversations/${id}/members`, { devIds }),
  removeMember: (id: string, devId: string) => apiSend<{ ok: true }>('DELETE', `/chat/conversations/${id}/members/${devId}`),
  messages: (id: string, before?: string) =>
    apiGet<{ messages: ChatMessage[]; hasMore: boolean }>(
      `/chat/conversations/${id}/messages${before ? `?before=${enc(before)}` : ''}`,
    ),
  send: (id: string, body: { body: string; parentId?: string | null; attachmentIds?: string[]; clientNonce: string }) =>
    apiSend<{ message: ChatMessage }>('POST', `/chat/conversations/${id}/messages`, body),
  edit: (messageId: string, body: string) => apiSend<{ message: ChatMessage }>('PATCH', `/chat/messages/${messageId}`, { body }),
  remove: (messageId: string) => apiSend<{ ok: true }>('DELETE', `/chat/messages/${messageId}`),
  thread: (messageId: string) => apiGet<{ root: ChatMessage; replies: ChatMessage[] }>(`/chat/messages/${messageId}/thread`),
  locate: (messageId: string) =>
    apiGet<{ conversationId: string; rootId: string; messageId: string }>(`/chat/messages/${messageId}/locate`),
  /** Autocompletado `@tarea <persona> <texto>`. */
  searchTasks: (q: string) => apiGet<{ tasks: ChatTaskRef[] }>(`/chat/tasks?q=${enc(q)}`),
  upload: (conversationId: string, file: File) =>
    apiUpload<{ attachment: ChatAttachment }>(`/chat/conversations/${conversationId}/attachments`, file),
};

/** Debe coincidir con el backend (src/chat/attachments.ts). */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_MESSAGE_LENGTH = 8000;

export * from './chat-text';
