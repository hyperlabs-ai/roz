import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { useChat } from '@/chat/ChatContext';
import { newNonce } from '@/lib/chat-text';
import { discordApi, type DiscordMessageView, type DiscordReplyView } from '@/lib/api';
import { useDiscord } from './DiscordContext';
import {
  LOCAL_PREFIX, compareSnowflake, isLocal, mergePage, removeMessages, replaceRecent, sortMessages, upsertMessage,
  type UiMessage,
} from './model';

const PAGE = 50;

interface State {
  messages: UiMessage[];
  hasMore: boolean;
  backfillComplete: boolean;
  loading: boolean;
  loadingOlder: boolean;
  error: unknown;
  /**
   * Se saltó a un mensaje viejo (`around`): la lista no llega al presente. Los mensajes nuevos no se
   * pegan al final (dejarían un hueco); se ofrece "Volver al presente".
   */
  detached: boolean;
  /** Llegaron mensajes nuevos mientras la lista estaba desprendida. */
  missed: number;
}

const INITIAL: State = {
  messages: [], hasMore: false, backfillComplete: true, loading: true, loadingOlder: false, error: null, detached: false,
  missed: 0,
};

/**
 * Mensajes de un canal o hilo de Discord: primera página (o alrededor de un mensaje), scroll infinito
 * hacia arriba, tiempo real por upsert de id, envío optimista con `clientNonce` y re-sincronización
 * al reconectar o volver a la pestaña (contrato §B.3, §B.4, §C).
 */
export function useChannelMessages(channelId: string, around: string | null) {
  const { user } = useAuth();
  const chat = useChat();
  const discord = useDiscord();
  const [state, setState] = useState<State>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;
  const alive = useRef(true);
  const gen = useRef(0);

  const load = useCallback(
    async (opts: { around?: string | null; soft?: boolean } = {}) => {
      const g = ++gen.current;
      if (!opts.soft) setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const page = await discordApi.messages(channelId, opts.around ? { around: opts.around, limit: PAGE } : { limit: PAGE });
        if (!alive.current || g !== gen.current) return;
        setState((s) => ({
          ...s,
          messages: opts.soft && !s.detached ? replaceRecent(s.messages, page.messages) : sortMessages(page.messages),
          hasMore: opts.soft && !s.detached ? s.hasMore || page.hasMore : page.hasMore,
          backfillComplete: page.backfillComplete,
          loading: false,
          error: null,
          detached: !!opts.around,
          missed: 0,
        }));
      } catch (e) {
        if (!alive.current || g !== gen.current) return;
        setState((s) => ({ ...s, loading: false, error: opts.soft && s.messages.length ? s.error : e }));
      }
    },
    [channelId],
  );

  useEffect(() => {
    alive.current = true;
    setState(INITIAL);
    void load({ around });
    return () => {
      alive.current = false;
    };
  }, [channelId, around, load]);

  const loadOlder = useCallback(async () => {
    const s = stateRef.current;
    if (s.loadingOlder || !s.hasMore) return;
    const oldest = s.messages.find((m) => !isLocal(m));
    if (!oldest) return;
    setState((x) => ({ ...x, loadingOlder: true }));
    try {
      const page = await discordApi.messages(channelId, { before: oldest.id, limit: PAGE });
      if (!alive.current) return;
      setState((x) => ({
        ...x,
        messages: mergePage(x.messages, page.messages),
        hasMore: page.hasMore,
        backfillComplete: page.backfillComplete,
        loadingOlder: false,
      }));
    } catch {
      if (alive.current) setState((x) => ({ ...x, loadingOlder: false }));
    }
  }, [channelId]);

  // ---- Tiempo real ----
  useEffect(
    () =>
      discord.subscribe((e) => {
        if (e.event === 'discord.message.created' || e.event === 'discord.message.updated') {
          if (e.payload.channelId !== channelId) return;
          const m = e.payload.message;
          setState((s) => {
            const known = s.messages.some((x) => x.id === m.id || (!!m.clientNonce && x.clientNonce === m.clientNonce));
            // Desprendida (viendo historial): solo se actualiza lo que ya está en pantalla.
            if (s.detached && !known) return e.event === 'discord.message.created' ? { ...s, missed: s.missed + 1 } : s;
            if (e.event === 'discord.message.updated' && !known) return s;
            return { ...s, messages: upsertMessage(s.messages, m) };
          });
        } else if (e.event === 'discord.message.deleted') {
          if (e.payload.channelId !== channelId) return;
          setState((s) => ({ ...s, messages: removeMessages(s.messages, e.payload.messageIds) }));
        }
      }),
    [discord.subscribe, channelId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // No hay replay de eventos perdidos: al reconectar o volver a la pestaña, la primera página otra vez.
  useEffect(
    () =>
      chat.subscribe((e) => {
        if (e.type === 'resync' && !stateRef.current.detached) void load({ soft: true });
      }),
    [chat.subscribe, load], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 5_000 && !stateRef.current.detached) void load({ soft: true });
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [load]);

  // ---- Envío ----
  const me = user?.devId ?? null;
  const myDev = me ? chat.devOf(me) : undefined;

  const post = useCallback(
    async (nonce: string, payload: { content: string; replyToId?: string; uploadIds?: string[] }) => {
      try {
        const { message } = await discordApi.send(channelId, { ...payload, clientNonce: nonce });
        if (!alive.current) return;
        setState((s) => ({ ...s, messages: upsertMessage(s.messages, message) }));
      } catch (e) {
        if (!alive.current) throw e;
        setState((s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.clientNonce === nonce && isLocal(m) ? { ...m, pending: false, failed: true, retry: payload } : m,
          ),
        }));
        throw e;
      }
    },
    [channelId],
  );

  /** Envío optimista: se pinta al instante y se reemplaza por el real con el mismo `clientNonce`. */
  const send = useCallback(
    (payload: { content: string; replyToId?: string; uploadIds?: string[]; replyTo?: DiscordReplyView | null; attachmentNames?: string[] }) => {
      const nonce = newNonce();
      const now = new Date().toISOString();
      const optimistic: UiMessage = {
        id: `${LOCAL_PREFIX}${nonce}`,
        channelId,
        guildId: discord.guildId ?? '',
        type: payload.replyToId ? 19 : 0,
        author: {
          discordUserId: discord.me ?? '',
          displayName: user?.devName ?? myDev?.name ?? 'Tú',
          username: user?.devName ?? '',
          avatarUrl: myDev?.avatarUrl ?? null,
          bot: false,
          webhook: true,
          devId: me,
        },
        content: payload.content,
        attachments: (payload.attachmentNames ?? []).map((name, i) => ({
          id: `${nonce}-${i}`, filename: name, contentType: null, size: 0, url: '', proxyUrl: null, width: null, height: null,
          description: null, durationSecs: null, spoiler: false,
        })),
        embeds: [],
        stickers: [],
        mentions: [],
        mentionRoles: [],
        mentionEveryone: false,
        reactions: [],
        replyTo: payload.replyTo ?? null,
        thread: null,
        tasks: [],
        pinned: false,
        createdAt: now,
        editedAt: null,
        fromRoz: true,
        clientNonce: nonce,
        pending: true,
      };
      setState((s) => ({ ...s, messages: sortMessages([...s.messages, optimistic]) }));
      const { content, replyToId, uploadIds } = payload;
      return post(nonce, { content, replyToId, uploadIds });
    },
    [channelId, discord.guildId, discord.me, user?.devName, myDev?.name, myDev?.avatarUrl, me, post],
  );

  const retry = useCallback(
    (m: UiMessage) => {
      if (!m.retry || !m.clientNonce) return Promise.resolve();
      const nonce = m.clientNonce;
      setState((s) => ({
        ...s,
        messages: s.messages.map((x) => (x.clientNonce === nonce && isLocal(x) ? { ...x, failed: false, pending: true } : x)),
      }));
      return post(nonce, m.retry);
    },
    [post],
  );

  const discard = useCallback((m: UiMessage) => {
    setState((s) => ({ ...s, messages: s.messages.filter((x) => x.id !== m.id) }));
  }, []);

  /** Aplica una respuesta de la API (edición, ficha de tarea) por el mismo camino que el tiempo real. */
  const apply = useCallback((m: DiscordMessageView) => {
    setState((s) => (s.messages.some((x) => x.id === m.id) ? { ...s, messages: upsertMessage(s.messages, m) } : s));
  }, []);

  const patch = useCallback((id: string, fn: (m: UiMessage) => UiMessage) => {
    setState((s) => ({ ...s, messages: s.messages.map((m) => (m.id === id ? fn(m) : m)) }));
  }, []);

  const drop = useCallback((ids: string[]) => {
    setState((s) => ({ ...s, messages: removeMessages(s.messages, ids) }));
  }, []);

  const newest = state.messages.filter((m) => !isLocal(m)).slice(-1)[0]?.id ?? null;

  return {
    ...state,
    newest,
    reload: () => load(),
    jumpToPresent: () => load(),
    jumpTo: (messageId: string) => {
      if (stateRef.current.messages.some((m) => m.id === messageId)) return true;
      void load({ around: messageId });
      return false;
    },
    loadOlder,
    send,
    retry,
    discard,
    apply,
    patch,
    drop,
  };
}

export type ChannelMessages = ReturnType<typeof useChannelMessages>;

/** ¿`a` es más nuevo que `b`? (para marcar visto). */
export const newerThan = (a: string, b: string | null | undefined) => !b || compareSnowflake(a, b) > 0;
