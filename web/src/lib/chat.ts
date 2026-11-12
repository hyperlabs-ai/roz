// Chat del equipo: tipos espejo del backend (src/chat/model.ts), llamadas a la API y utilidades
// PURAS de texto y agrupado (las prueba test/chat-web.test.ts, por eso este módulo no importa React).
import { apiGet, apiSend } from './api';

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

/** Tarjeta de un link del mensaje (espejo de src/chat/unfurl.ts). */
export interface LinkPreview {
  url: string;
  kind: 'video' | 'post' | 'link';
  provider: string | null;
  siteName: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  icon: string | null;
  author: string | null;
  embed: { type: 'youtube' | 'vimeo' | 'tiktok'; id: string } | null;
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
  /** Tareas del bloque Status (`meta.type === 'status'`), con su estado actual. */
  statusTasks: ChatTaskRef[];
  /** Tarjetas de los links (llegan unos segundos después del mensaje, por message.updated). Opcional:
   *  un mensaje cacheado de antes de la migración 0034 no la trae. */
  linkPreviews?: LinkPreview[];
  /** Solo cliente: envío optimista en vuelo / fallido. */
  pending?: boolean;
  failed?: boolean;
}

export interface ChatDev {
  id: string;
  name: string;
  avatarUrl: string | null;
  /** El backend lo manda (semilla del avatar generado). */
  email?: string | null;
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
  send: (
    id: string,
    body: { body: string; parentId?: string | null; attachmentIds?: string[]; clientNonce: string; statusTaskIds?: string[] },
  ) =>
    apiSend<{ message: ChatMessage }>('POST', `/chat/conversations/${id}/messages`, body),
  edit: (messageId: string, body: string) => apiSend<{ message: ChatMessage }>('PATCH', `/chat/messages/${messageId}`, { body }),
  remove: (messageId: string) => apiSend<{ ok: true }>('DELETE', `/chat/messages/${messageId}`),
  thread: (messageId: string) => apiGet<{ root: ChatMessage; replies: ChatMessage[] }>(`/chat/messages/${messageId}/thread`),
  locate: (messageId: string) =>
    apiGet<{ conversationId: string; rootId: string; messageId: string }>(`/chat/messages/${messageId}/locate`),
  /** Autocompletado `@tarea <persona> <texto>`. */
  searchTasks: (q: string, limit?: number) =>
    apiGet<{ tasks: ChatTaskRef[] }>(`/chat/tasks?q=${enc(q)}${limit ? `&limit=${limit}` : ''}`),
  upload: uploadAttachment,
};

/** Debe coincidir con el backend (src/chat/attachments.ts) y el bucket (migración 0034). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * PUT directo a Storage con la URL firmada (mismo formato que `uploadToSignedUrl` de storage-js:
 * multipart con `cacheControl` y el archivo en el campo vacío). XHR y no fetch para tener progreso.
 */
function putToSignedUrl(signedUrl: string, file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signedUrl);
    xhr.setRequestHeader('x-upsert', 'false');
    const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
    if (anon) xhr.setRequestHeader('apikey', anon);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `Storage respondió ${xhr.status}`;
      try {
        const body = JSON.parse(xhr.responseText) as { message?: string; error?: string };
        message = body.message ?? body.error ?? message;
      } catch {
        /* cuerpo no JSON */
      }
      // El bucket rechaza lo que pasa de 20 MB aunque el cliente lo haya dejado pasar.
      if (xhr.status === 413 || /exceeded the maximum allowed size|too large/i.test(message)) {
        message = 'El archivo supera el límite de 20 MB';
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('Sin conexión con el almacenamiento'));
    xhr.onabort = () => reject(new DOMException('Subida cancelada', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    const form = new FormData();
    form.append('cacheControl', '3600');
    form.append('', file);
    xhr.send(form);
  });
}

// Las URLs de subida se piden EN FILA: el backend crea la fila del adjunto en ese momento y la
// galería se ordena por su created_at. En paralelo, 5 fotos elegidas en orden salían revueltas.
// Solo se encola ese paso (≈200 ms); las subidas en sí siguen en paralelo.
let uploadUrlQueue: Promise<unknown> = Promise.resolve();

/** Sube un adjunto: pide la URL firmada, sube directo a Storage (con progreso) y confirma. */
async function uploadAttachment(
  conversationId: string,
  file: File,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<{ attachment: ChatAttachment }> {
  const ticket = uploadUrlQueue.then(() =>
    apiSend<{ attachmentId: string; signedUrl: string }>(
      'POST',
      `/chat/conversations/${conversationId}/attachments/upload-url`,
      { name: file.name || 'archivo', contentType: file.type || null, size: file.size },
    ),
  );
  uploadUrlQueue = ticket.catch(() => {});
  const { attachmentId, signedUrl } = await ticket;
  await putToSignedUrl(signedUrl, file, opts.onProgress, opts.signal);
  return apiSend<{ attachment: ChatAttachment }>('POST', `/chat/attachments/${attachmentId}/complete`, {});
}
export const MAX_MESSAGE_LENGTH = 8000;
export const MAX_STATUS_TASKS = 30;

export * from './chat-text';
