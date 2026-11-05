import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/lib/toast';
import { useChat } from './ChatContext';
import { chatApi, newNonce, type ChatAttachment, type ChatEvent, type ChatMessage, type ChatTaskRef } from '@/lib/chat';

/**
 * Mensajes de una conversación y de un hilo, vivos.
 *
 * Todo cambio entra por el bus del ChatContext (socket o respuesta de la API, mismo camino), así que
 * aquí solo se aplica: insertar por orden, reemplazar por id, y reconciliar el envío optimista con
 * el mensaje real por `clientNonce`. El eco del socket de algo que ya se aplicó es un no-op.
 */

/** Inserta o reemplaza. Un mensaje real reemplaza a su versión optimista (mismo clientNonce). */
export function upsertMessage(list: ChatMessage[], m: ChatMessage): ChatMessage[] {
  const byId = list.findIndex((x) => x.id === m.id);
  if (byId !== -1) {
    const next = list.slice();
    next[byId] = m;
    return next;
  }
  if (m.clientNonce) {
    const byNonce = list.findIndex((x) => x.clientNonce === m.clientNonce);
    if (byNonce !== -1) {
      const next = list.slice();
      next[byNonce] = m;
      return next;
    }
  }
  // Casi siempre va al final; si llega desordenado, se coloca por fecha.
  const at = list.findIndex((x) => !x.pending && x.createdAt > m.createdAt);
  if (at === -1) return [...list, m];
  return [...list.slice(0, at), m, ...list.slice(at)];
}

/** Aplica a las fichas de tarea de los mensajes un cambio hecho desde el diálogo de tarea. */
function patchTasks(list: ChatMessage[], e: Extract<ChatEvent, { type: 'task.updated' | 'task.deleted' }>): ChatMessage[] {
  const id = e.type === 'task.updated' ? e.task.id : e.taskId;
  const apply = (tasks: ChatTaskRef[]) =>
    e.type === 'task.updated' ? tasks.map((t) => (t.id === id ? e.task : t)) : tasks.filter((t) => t.id !== id);
  let changed = false;
  const next = list.map((m) => {
    const cited = m.citedTasks ?? [];
    const status = m.statusTasks ?? [];
    if (!m.tasks.some((t) => t.id === id) && !cited.some((t) => t.id === id) && !status.some((t) => t.id === id)) return m;
    changed = true;
    return { ...m, tasks: apply(m.tasks), citedTasks: apply(cited), statusTasks: apply(status) };
  });
  return changed ? next : list;
}

function markDeleted(m: ChatMessage): ChatMessage {
  return { ...m, deletedAt: m.deletedAt ?? new Date().toISOString(), body: '', mentions: [], mentionChannel: false, attachments: [] };
}

function tempMessage(input: {
  conversationId: string;
  parentId: string | null;
  authorDevId: string | null;
  body: string;
  attachments: ChatAttachment[];
  statusTasks: ChatTaskRef[];
  nonce: string;
}): ChatMessage {
  return {
    id: `tmp-${input.nonce}`,
    conversationId: input.conversationId,
    parentId: input.parentId,
    kind: 'user',
    authorDevId: input.authorDevId,
    body: input.body,
    mentions: [],
    mentionChannel: false,
    meta: input.statusTasks.length ? { type: 'status', taskIds: input.statusTasks.map((t) => t.id) } : null,
    clientNonce: input.nonce,
    replyCount: 0,
    lastReplyAt: null,
    replyDevIds: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    attachments: input.attachments,
    tasks: [],
    citedTasks: [],
    statusTasks: input.statusTasks,
    pending: true,
  };
}

/** Envío optimista compartido por la conversación y el hilo. */
function useSender(conversationId: string | null, parentId: string | null, apply: (fn: (l: ChatMessage[]) => ChatMessage[]) => void) {
  const chat = useChat();
  return useCallback(
    async (body: string, attachments: ChatAttachment[], statusTasks: ChatTaskRef[] = [], nonce = newNonce()) => {
      if (!conversationId) return;
      const temp = tempMessage({ conversationId, parentId, authorDevId: chat.me, body, attachments, statusTasks, nonce });
      apply((l) => upsertMessage(l, temp));
      try {
        const { message } = await chatApi.send(conversationId, {
          body,
          parentId,
          attachmentIds: attachments.map((a) => a.id),
          clientNonce: nonce,
          statusTaskIds: statusTasks.length ? statusTasks.map((t) => t.id) : undefined,
        });
        chat.dispatch({ type: 'message.created', message });
      } catch (e) {
        apply((l) => l.map((m) => (m.clientNonce === nonce && m.pending ? { ...m, pending: false, failed: true } : m)));
        toast.error('No se pudo enviar el mensaje', { description: e instanceof Error ? e.message : String(e) });
      }
    },
    [conversationId, parentId, chat, apply],
  );
}

/** Acciones sobre un mensaje propio, comunes a la conversación y el hilo. */
export function useMessageActions() {
  const chat = useChat();
  const edit = useCallback(
    async (id: string, body: string) => {
      const { message } = await chatApi.edit(id, body);
      chat.dispatch({ type: 'message.updated', message });
    },
    [chat],
  );
  const remove = useCallback(
    async (m: ChatMessage) => {
      await chatApi.remove(m.id);
      chat.dispatch({ type: 'message.deleted', conversationId: m.conversationId, id: m.id, parentId: m.parentId });
    },
    [chat],
  );
  /** Tras crear una tarea desde un mensaje: su ficha aparece sin esperar al socket. */
  const attachTask = useCallback(
    (m: ChatMessage, task: ChatTaskRef) => {
      if (m.tasks.some((t) => t.id === task.id)) return;
      chat.dispatch({ type: 'message.updated', message: { ...m, tasks: [...m.tasks, task] } });
    },
    [chat],
  );
  return { edit, remove, attachTask };
}

// Caché por conversación: volver a una conversación pinta al instante lo último que se vio
// mientras se pide lo nuevo. Se vacía al cambiar de cuenta.
const cache = new Map<string, { messages: ChatMessage[]; hasMore: boolean }>();
let cacheOwner: string | null = null;

export function useConversationMessages(conversationId: string | null) {
  const chat = useChat();
  if (cacheOwner !== chat.me) {
    cache.clear();
    cacheOwner = chat.me;
  }
  const cached = conversationId ? cache.get(conversationId) : undefined;
  const [messages, setMessages] = useState<ChatMessage[]>(cached?.messages ?? []);
  const [hasMore, setHasMore] = useState(cached?.hasMore ?? false);
  const [loading, setLoading] = useState(!cached);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(conversationId);
  idRef.current = conversationId;
  // Respuestas ya sumadas al contador de su hilo (el eco del socket no debe sumar dos veces).
  const countedReplies = useRef(new Set<string>());

  const apply = useCallback((fn: (l: ChatMessage[]) => ChatMessage[]) => setMessages((l) => fn(l)), []);

  // Mantener la caché al día.
  useEffect(() => {
    if (conversationId && !loading) cache.set(conversationId, { messages: messages.filter((m) => !m.pending), hasMore });
  }, [conversationId, messages, hasMore, loading]);

  const load = useCallback(async () => {
    const id = idRef.current;
    if (!id) return;
    try {
      const res = await chatApi.messages(id);
      if (idRef.current !== id) return;
      setMessages((prev) => {
        // Lo optimista en vuelo sobrevive a la recarga.
        let next = res.messages;
        for (const p of prev.filter((m) => m.pending || m.failed)) next = upsertMessage(next, p);
        return next;
      });
      setHasMore(res.hasMore);
      setError(null);
    } catch (e) {
      if (idRef.current === id) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (idRef.current === id) setLoading(false);
    }
  }, []);

  useEffect(() => {
    countedReplies.current = new Set();
    const c = conversationId ? cache.get(conversationId) : undefined;
    setMessages(c?.messages ?? []);
    setHasMore(c?.hasMore ?? false);
    setLoading(!c);
    setError(null);
    if (conversationId) void load();
  }, [conversationId, load]);

  const loadOlder = useCallback(async () => {
    const id = idRef.current;
    const oldest = messages.find((m) => !m.pending);
    if (!id || !oldest || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    try {
      const res = await chatApi.messages(id, oldest.createdAt);
      if (idRef.current !== id) return;
      setMessages((l) => [...res.messages.filter((m) => !l.some((x) => x.id === m.id)), ...l]);
      setHasMore(res.hasMore);
    } catch (e) {
      toast.error('No se pudieron cargar mensajes anteriores', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoadingOlder(false);
    }
  }, [messages, loadingOlder, hasMore]);

  useEffect(
    () =>
      chat.subscribe((e: ChatEvent) => {
        const id = idRef.current;
        if (!id) return;
        if (e.type === 'resync') {
          void load();
          return;
        }
        if (e.type === 'conversation.removed') return;
        if (e.type === 'task.updated' || e.type === 'task.deleted') {
          setMessages((l) => patchTasks(l, e));
          return;
        }
        const convId = e.type === 'message.deleted' ? e.conversationId : e.message.conversationId;
        if (convId !== id) return;

        if (e.type === 'message.created') {
          const m = e.message;
          if (!m.parentId) {
            setMessages((l) => upsertMessage(l, m));
          } else if (!countedReplies.current.has(m.id)) {
            // Respuesta en hilo: no se lista en el canal; actualiza el resumen del mensaje raíz.
            countedReplies.current.add(m.id);
            setMessages((l) =>
              l.map((r) =>
                r.id === m.parentId
                  ? {
                      ...r,
                      replyCount: r.replyCount + 1,
                      lastReplyAt: m.createdAt,
                      replyDevIds:
                        m.kind === 'user' && m.authorDevId && !r.replyDevIds.includes(m.authorDevId)
                          ? [m.authorDevId, ...r.replyDevIds]
                          : r.replyDevIds,
                    }
                  : r,
              ),
            );
          }
        } else if (e.type === 'message.updated') {
          const m = e.message;
          if (!m.parentId) setMessages((l) => (l.some((x) => x.id === m.id) ? upsertMessage(l, m) : l));
        } else if (e.type === 'message.deleted') {
          if (e.parentId) return;
          // Sin respuestas, el mensaje desaparece; con hilo, queda la marca para no dejarlo huérfano.
          setMessages((l) =>
            l.flatMap((m) => (m.id !== e.id ? [m] : m.replyCount > 0 ? [markDeleted(m)] : [])),
          );
        }
      }),
    [chat, load],
  );

  const send = useSender(conversationId, null, apply);
  const discard = useCallback((nonce: string) => apply((l) => l.filter((m) => m.clientNonce !== nonce || !m.failed)), [apply]);

  return { messages, hasMore, loading, loadingOlder, error, loadOlder, reload: load, send, discard };
}

export function useThread(rootId: string | null, conversationId: string | null) {
  const chat = useChat();
  const [root, setRoot] = useState<ChatMessage | null>(null);
  const [replies, setReplies] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(rootId);
  idRef.current = rootId;

  const load = useCallback(async () => {
    const id = idRef.current;
    if (!id) return;
    try {
      const res = await chatApi.thread(id);
      if (idRef.current !== id) return;
      setRoot(res.root);
      setReplies((prev) => {
        let next = res.replies;
        for (const p of prev.filter((m) => m.pending || m.failed)) next = upsertMessage(next, p);
        return next;
      });
      setError(null);
    } catch (e) {
      if (idRef.current === id) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (idRef.current === id) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setRoot(null);
    setReplies([]);
    setLoading(true);
    setError(null);
    if (rootId) void load();
  }, [rootId, load]);

  useEffect(
    () =>
      chat.subscribe((e) => {
        const id = idRef.current;
        if (!id) return;
        if (e.type === 'resync') {
          void load();
          return;
        }
        if (e.type === 'conversation.removed') return;
        if (e.type === 'task.updated' || e.type === 'task.deleted') {
          setRoot((r) => (r ? patchTasks([r], e)[0]! : r));
          setReplies((l) => patchTasks(l, e));
          return;
        }
        if (e.type === 'message.deleted') {
          if (e.id === id) setRoot((r) => (r ? markDeleted(r) : r));
          else if (e.parentId === id) setReplies((l) => l.map((m) => (m.id === e.id ? markDeleted(m) : m)));
          return;
        }
        // El panel cuenta las respuestas que muestra; el contador del raíz no hace falta aquí.
        const m = e.message;
        if (m.id === id) setRoot(m);
        else if (m.parentId === id) setReplies((l) => upsertMessage(l, m));
      }),
    [chat, load],
  );

  const apply = useCallback((fn: (l: ChatMessage[]) => ChatMessage[]) => setReplies((l) => fn(l)), []);
  const send = useSender(conversationId, rootId, apply);
  const discard = useCallback((nonce: string) => apply((l) => l.filter((m) => m.clientNonce !== nonce || !m.failed)), [apply]);

  return { root, replies, loading, error, send, discard, reload: load };
}
