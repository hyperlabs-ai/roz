import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useAuth } from '@/auth/AuthContext';
import { supabase } from '@/lib/supabase';
import { usePoll } from '@/lib/usePoll';
import {
  chatApi, chatBadge, type ChatConversation, type ChatDev, type ChatEvent, type ChatMessage,
} from '@/lib/chat';

/**
 * Estado GLOBAL del chat. Vive en el root (como la cola y la presencia) porque el badge del nav se
 * ve en TODAS las pantallas, y porque la conexión de tiempo real es una sola: abrirla en la página
 * del chat haría que los no leídos se congelaran en cuanto sales de ella.
 *
 * Tiempo real: un canal PRIVADO de Supabase Realtime por persona (`chat:dev:<devId>`, autorizado
 * por RLS en la migración 0030). El backend publica ahí cada mensaje ya completo. Si el socket no
 * está, el polling de `/chat/unread` mantiene los contadores y la vista abierta se re-sincroniza al
 * volver.
 *
 * Todo lo que cambia mensajes —eventos del socket y respuestas de la propia API— entra por el MISMO
 * `dispatch`. Así un mensaje enviado desde esta pestaña y su eco por el socket siguen un solo
 * camino, y las vistas solo tienen que deduplicar por id.
 */

type RealtimeStatus = 'off' | 'connecting' | 'live';

interface ChatState {
  ready: boolean;
  error: string | null;
  me: string | null;
  conversations: ChatConversation[];
  devs: ChatDev[];
  nameOf: (devId: string) => string | undefined;
  devOf: (devId: string) => ChatDev | undefined;
  realtime: RealtimeStatus;
  badge: { count: number; dot: boolean };
  /** La conversación que la persona tiene abierta (la marca la página del chat). */
  setActiveId: (id: string | null) => void;
  subscribe: (fn: (e: ChatEvent) => void) => () => void;
  /** Aplica un cambio local (respuesta de la API) por el mismo camino que el tiempo real. */
  dispatch: (e: ChatEvent) => void;
  upsertConversation: (c: ChatConversation) => void;
  removeConversation: (id: string) => void;
  reloadConversation: (id: string) => Promise<ChatConversation | null>;
  markRead: (id: string) => void;
  refresh: () => Promise<void>;
}

const noop = () => {};
const Ctx = createContext<ChatState>({
  ready: false, error: null, me: null, conversations: [], devs: [], nameOf: () => undefined, devOf: () => undefined,
  realtime: 'off', badge: { count: 0, dot: false }, setActiveId: noop, subscribe: () => noop, dispatch: noop,
  upsertConversation: noop, removeConversation: noop, reloadConversation: async () => null, markRead: noop,
  refresh: async () => {},
});

const SOCKET_EVENTS = [
  'message.created', 'message.updated', 'message.deleted', 'conversation.updated', 'conversation.removed', 'read',
] as const;

export function ChatProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const me = user?.devId ?? null;

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [devs, setDevs] = useState<ChatDev[]>([]);
  const [realtime, setRealtime] = useState<RealtimeStatus>('off');

  const listeners = useRef(new Set<(e: ChatEvent) => void>());
  const activeId = useRef<string | null>(null);
  const meRef = useRef(me);
  meRef.current = me;
  const convsRef = useRef(conversations);
  convsRef.current = conversations;

  const devById = useMemo(() => new Map(devs.map((d) => [d.id.toLowerCase(), d])), [devs]);
  const devOf = useCallback((id: string) => devById.get(id.toLowerCase()), [devById]);
  const nameOf = useCallback((id: string) => devById.get(id.toLowerCase())?.name, [devById]);

  const emit = useCallback((e: ChatEvent) => {
    for (const fn of listeners.current) {
      try {
        fn(e);
      } catch (err) {
        console.error('[chat] listener', err);
      }
    }
  }, []);

  const upsertConversation = useCallback((c: ChatConversation) => {
    setConversations((list) => {
      const i = list.findIndex((x) => x.id === c.id);
      if (i === -1) return [...list, c];
      const next = list.slice();
      next[i] = c;
      return next;
    });
  }, []);

  const removeConversation = useCallback((id: string) => {
    setConversations((list) => list.filter((c) => c.id !== id));
  }, []);

  const patchConversation = useCallback((id: string, fn: (c: ChatConversation) => ChatConversation) => {
    setConversations((list) => list.map((c) => (c.id === id ? fn(c) : c)));
  }, []);

  const inflight = useRef(new Map<string, Promise<ChatConversation | null>>());
  const reloadConversation = useCallback(
    (id: string) => {
      const running = inflight.current.get(id);
      if (running) return running;
      const p = chatApi
        .conversation(id)
        .then(({ conversation }) => {
          // Solo conversaciones en las que estoy (o la que tengo abierta, aunque sea pública ajena).
          if (conversation.membership || activeId.current === id) upsertConversation(conversation);
          else removeConversation(id);
          return conversation;
        })
        .catch(() => {
          removeConversation(id);
          return null;
        })
        .finally(() => inflight.current.delete(id));
      inflight.current.set(id, p);
      return p;
    },
    [upsertConversation, removeConversation],
  );

  const refresh = useCallback(async () => {
    if (!meRef.current) return;
    try {
      const data = await chatApi.bootstrap();
      setConversations((prev) => {
        // La conversación abierta sin membresía (canal público que se está leyendo) no viene en el
        // bootstrap; se conserva para no sacar a la persona de lo que está viendo.
        const keep = prev.filter((c) => !c.membership && c.id === activeId.current);
        return [...data.conversations, ...keep.filter((k) => !data.conversations.some((c) => c.id === k.id))];
      });
      setDevs(data.devs);
      setError(null);
      setReady(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReady(true);
    }
  }, []);

  /** ¿La persona está mirando esa conversación ahora mismo? Entonces no cuenta como no leído. */
  const isViewing = (id: string) =>
    activeId.current === id && document.visibilityState === 'visible' && document.hasFocus();

  const dispatch = useCallback(
    (e: ChatEvent) => {
      if (e.type === 'message.created') {
        const m: ChatMessage = e.message;
        const known = convsRef.current.some((c) => c.id === m.conversationId);
        if (!known) {
          void reloadConversation(m.conversationId);
        } else {
          const mine = meRef.current;
          const fromOther = m.kind === 'user' && m.authorDevId !== mine;
          const viewing = isViewing(m.conversationId);
          patchConversation(m.conversationId, (c) => {
            const mentioned =
              !!mine && (m.mentions.some((id) => id.toLowerCase() === mine.toLowerCase()) || (m.mentionChannel && !m.parentId));
            return {
              ...c,
              lastMessageAt: m.parentId ? c.lastMessageAt : m.createdAt,
              unread: fromOther && !viewing && !m.parentId ? c.unread + 1 : c.unread,
              mentions: fromOther && !viewing && mentioned ? c.mentions + 1 : c.mentions,
              // Un MD cerrado reaparece con el mensaje nuevo (el backend ya lo des-ocultó).
              membership: c.membership && c.kind === 'dm' ? { ...c.membership, hidden: false } : c.membership,
            };
          });
        }
      } else if (e.type === 'conversation.removed') {
        removeConversation(e.conversationId);
      }
      emit(e);
    },
    [emit, patchConversation, reloadConversation, removeConversation],
  );

  const markRead = useCallback(
    (id: string) => {
      const conv = convsRef.current.find((c) => c.id === id);
      if (!conv?.membership) return;
      // Ya al día (nada pendiente y nada posterior a la última lectura): no hace falta ir al backend.
      // Sin esto, cada foco de ventana o mensaje propio disparaba un POST /read.
      const upToDate =
        conv.unread === 0 && conv.mentions === 0 && (!conv.lastMessageAt || conv.membership.lastReadAt >= conv.lastMessageAt);
      if (upToDate) return;
      const now = new Date().toISOString();
      patchConversation(id, (c) => ({
        ...c,
        unread: 0,
        mentions: 0,
        membership: c.membership ? { ...c.membership, lastReadAt: now } : c.membership,
      }));
      chatApi.read(id).catch(() => {});
    },
    [patchConversation],
  );

  // ---- Arranque / cambio de cuenta ----
  useEffect(() => {
    setConversations([]);
    setDevs([]);
    setReady(false);
    setError(null);
    if (me) void refresh();
  }, [me, refresh]);

  // ---- Socket ----
  const wasLive = useRef(false);
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    setRealtime('connecting');

    const onSocket = (event: (typeof SOCKET_EVENTS)[number], payload: Record<string, unknown>) => {
      switch (event) {
        case 'message.created':
        case 'message.updated':
          dispatch({ type: event, message: payload.message as ChatMessage });
          break;
        case 'message.deleted':
          dispatch({
            type: 'message.deleted',
            conversationId: String(payload.conversationId),
            id: String(payload.id),
            parentId: (payload.parentId as string | null) ?? null,
          });
          break;
        case 'conversation.updated':
          void reloadConversation(String(payload.conversationId));
          break;
        case 'conversation.removed':
          dispatch({ type: 'conversation.removed', conversationId: String(payload.conversationId) });
          break;
        case 'read':
          patchConversation(String(payload.conversationId), (c) => ({
            ...c,
            unread: 0,
            mentions: 0,
            membership: c.membership ? { ...c.membership, lastReadAt: String(payload.lastReadAt) } : c.membership,
          }));
          break;
      }
    };

    (async () => {
      // El canal es privado: el JWT de la sesión es lo que la policy de realtime.messages revisa.
      try {
        await supabase.realtime.setAuth();
      } catch {
        /* sin token aún: el subscribe fallará y quedamos en polling */
      }
      if (cancelled) return;
      channel = supabase.channel(`chat:dev:${me}`, { config: { private: true } });
      for (const ev of SOCKET_EVENTS) {
        channel.on('broadcast', { event: ev }, (msg) => onSocket(ev, (msg.payload ?? {}) as Record<string, unknown>));
      }
      channel.subscribe((status) => {
        if (cancelled) return;
        if (status === 'SUBSCRIBED') {
          setRealtime('live');
          // Reconexión: lo que pasó mientras el socket estuvo caído no llegó. La vista abierta se
          // vuelve a pedir y los contadores se recalculan.
          if (wasLive.current) {
            emit({ type: 'resync' });
            void refresh();
          }
          wasLive.current = true;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtime('off');
        }
      });
    })();

    return () => {
      cancelled = true;
      wasLive.current = false;
      if (channel) void supabase.removeChannel(channel);
      setRealtime('off');
    };
  }, [me, dispatch, emit, patchConversation, refresh, reloadConversation]);

  // ---- Polling de respaldo (contadores) ----
  const syncUnread = useCallback(async () => {
    if (!meRef.current) return;
    try {
      const { items } = await chatApi.unread();
      const byId = new Map(items.map((i) => [i.conversationId, i]));
      if (items.some((i) => !convsRef.current.some((c) => c.id === i.conversationId))) {
        await refresh();
        return;
      }
      setConversations((list) =>
        list
          .filter((c) => !c.membership || byId.has(c.id) || c.id === activeId.current)
          .map((c) => {
            const i = byId.get(c.id);
            if (!i || (i.unread === c.unread && i.mentions === c.mentions)) return c;
            if (isViewing(c.id)) return c;
            return { ...c, unread: i.unread, mentions: i.mentions };
          }),
      );
    } catch {
      /* el siguiente ciclo lo intenta otra vez */
    }
  }, [refresh]);

  usePoll(syncUnread, me ? (realtime === 'live' ? 60_000 : 15_000) : null);

  // Sin socket, volver a la pestaña re-sincroniza la vista abierta (pudo haber mensajes nuevos).
  useEffect(() => {
    if (!me) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible' && realtime !== 'live') emit({ type: 'resync' });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [me, realtime, emit]);

  // El service worker avisa cuando se saltó una notificación porque la conversación estaba abierta.
  useEffect(() => {
    if (!me || !('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'chat-push' && realtime !== 'live') {
        emit({ type: 'resync' });
        void syncUnread();
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [me, realtime, emit, syncUnread]);

  // ---- Badge ----
  const badge = useMemo(() => chatBadge(conversations), [conversations]);
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    try {
      if (badge.count > 0) void nav.setAppBadge?.(badge.count).catch(() => {});
      else void nav.clearAppBadge?.().catch(() => {});
    } catch {
      /* navegador sin Badging API */
    }
  }, [badge.count]);

  const setActiveId = useCallback((id: string | null) => {
    activeId.current = id;
  }, []);

  const subscribe = useCallback((fn: (e: ChatEvent) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const value = useMemo<ChatState>(
    () => ({
      ready, error, me, conversations, devs, nameOf, devOf, realtime, badge, setActiveId, subscribe, dispatch,
      upsertConversation, removeConversation, reloadConversation, markRead, refresh,
    }),
    [ready, error, me, conversations, devs, nameOf, devOf, realtime, badge, setActiveId, subscribe, dispatch,
      upsertConversation, removeConversation, reloadConversation, markRead, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useChat = () => useContext(Ctx);
