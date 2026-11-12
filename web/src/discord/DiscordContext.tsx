import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { useChat, type DiscordSocketEvent } from '@/chat/ChatContext';
import { playSound } from '@/lib/sound';
import {
  discordApi,
  type DiscordBridgeStatus,
  type DiscordChannelTreeView,
  type DiscordEmojiView,
  type DiscordMemberView,
  type DiscordRoleView,
  type DiscordStatusView,
} from '@/lib/api';
import { compareSnowflake, indexChannels, loadSeen, mentionsMe, saveSeen, type ChannelEntry } from './model';

/**
 * Estado del chat de Discord mientras la página del chat está abierta: árbol de canales (con
 * permisos ya aplicados por el backend), roles, emojis, caché de miembros, estado del puente y lo
 * no leído. El tiempo real NO abre otro socket: escucha los eventos `discord.*` del buzón privado
 * que ya mantiene ChatContext (contrato §C).
 */

interface DiscordState {
  status: DiscordStatusView;
  guildId: string | null;
  /** Mi id de Discord (cuenta ligada). */
  me: string | null;
  myDevId: string | null;
  tree: DiscordChannelTreeView | null;
  treeError: unknown;
  channels: Map<string, ChannelEntry>;
  roles: Map<string, DiscordRoleView>;
  emojis: DiscordEmojiView[];
  members: Map<string, DiscordMemberView>;
  /** Estado del puente: el de /status, pisado por `discord.bridge.status` en vivo. */
  bridge: { status: DiscordBridgeStatus; healthy: boolean } | null;
  realtime: 'off' | 'connecting' | 'live';
  reloadTree: () => void;
  reloadStatus: () => void;
  searchMembers: (q: string) => Promise<DiscordMemberView[]>;
  rememberMembers: (list: DiscordMemberView[]) => void;
  /** Canal abierto (lo marca la vista): no cuenta como no leído. */
  setActive: (id: string | null) => void;
  markSeen: (channelId: string, messageId: string) => void;
  unread: (channelId: string) => { unread: boolean; mentions: number };
  subscribe: (fn: (e: DiscordSocketEvent) => void) => () => void;
}

const Ctx = createContext<DiscordState | null>(null);

export function useDiscord(): DiscordState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDiscord fuera de DiscordProvider');
  return v;
}

export function DiscordProvider({
  status,
  reloadStatus,
  children,
}: {
  status: DiscordStatusView;
  reloadStatus: () => void;
  children: ReactNode;
}) {
  const { user } = useAuth();
  const chat = useChat();
  const me = status.link?.discordUserId ?? null;
  const ready = status.enabled && !status.unavailable;

  const [tree, setTree] = useState<DiscordChannelTreeView | null>(null);
  const [treeError, setTreeError] = useState<unknown>(null);
  const [roles, setRoles] = useState<Map<string, DiscordRoleView>>(new Map());
  const [emojis, setEmojis] = useState<DiscordEmojiView[]>([]);
  const [members, setMembers] = useState<Map<string, DiscordMemberView>>(new Map());
  const [liveBridge, setLiveBridge] = useState<DiscordBridgeStatus | null>(null);
  const [seen, setSeen] = useState<Record<string, string>>(() => loadSeen() ?? {});
  const [latest, setLatest] = useState<Record<string, string>>({});
  const [mentionCount, setMentionCount] = useState<Record<string, number>>({});
  const active = useRef<string | null>(null);
  const seeded = useRef(loadSeen() !== null);

  // ---- Carga ----
  const reloadTree = useCallback(() => {
    if (!ready) return;
    discordApi
      .channels()
      .then((t) => {
        setTree(t);
        setTreeError(null);
      })
      .catch((e) => setTreeError(e));
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    reloadTree();
    discordApi.roles().then(({ roles: list }) => setRoles(new Map(list.map((r) => [r.id, r])))).catch(() => {});
    discordApi.emojis().then(({ emojis: list }) => setEmojis(list)).catch(() => {});
    // Calienta la caché de nombres para pintar menciones sin esperar al autocompletado.
    discordApi
      .members('', 100)
      .then(({ members: list }) => setMembers((prev) => new Map([...prev, ...list.map((m) => [m.discordUserId, m] as const)])))
      .catch(() => {});
  }, [ready, reloadTree]);

  const channels = useMemo(() => indexChannels(tree), [tree]);

  // Canales que no tenían marca de "visto": se siembran con su último mensaje. Sin esto, la primera
  // vez (o un canal recién creado) todo saldría en negritas.
  useEffect(() => {
    if (!tree) return;
    setSeen((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, e] of channels) {
        const last = e.channel?.lastMessageId ?? null;
        if (!(id in next) && (last || !seeded.current)) {
          next[id] = last ?? '0';
          changed = true;
        }
      }
      seeded.current = true;
      if (changed) saveSeen(next);
      return changed ? next : prev;
    });
  }, [tree, channels]);

  const markSeen = useCallback((channelId: string, messageId: string) => {
    setSeen((prev) => {
      const cur = prev[channelId];
      if (cur && compareSnowflake(cur, messageId) >= 0) return prev;
      const next = { ...prev, [channelId]: messageId };
      saveSeen(next);
      return next;
    });
    setMentionCount((prev) => (prev[channelId] ? { ...prev, [channelId]: 0 } : prev));
  }, []);

  const unread = useCallback(
    (channelId: string) => {
      const e = channels.get(channelId);
      const candidates = [latest[channelId], e?.channel?.lastMessageId].filter((x): x is string => !!x);
      const newest = candidates.sort(compareSnowflake).pop();
      const s = seen[channelId];
      return {
        unread: !!newest && !!s && compareSnowflake(newest, s) > 0 && active.current !== channelId,
        mentions: active.current === channelId ? 0 : mentionCount[channelId] ?? 0,
      };
    },
    [channels, latest, seen, mentionCount],
  );

  // ---- Tiempo real ----
  const debounce = useRef<number | null>(null);
  useEffect(
    () =>
      chat.subscribeDiscord((e) => {
        switch (e.event) {
          case 'discord.channels.changed':
            // Ráfagas (backfill, cambios de permisos): una sola recarga cada ~500 ms.
            if (debounce.current) window.clearTimeout(debounce.current);
            debounce.current = window.setTimeout(() => {
              debounce.current = null;
              reloadTree();
            }, 500);
            break;
          case 'discord.link.changed':
            reloadStatus();
            break;
          case 'discord.bridge.status':
            setLiveBridge(e.payload.status);
            break;
          case 'discord.message.created': {
            const { channelId, message } = e.payload;
            const fromMe = (!!me && message.author.discordUserId === me) || (!!user?.devId && message.author.devId === user.devId);
            if (fromMe) break;
            setLatest((prev) => {
              const cur = prev[channelId];
              return cur && compareSnowflake(cur, message.id) >= 0 ? prev : { ...prev, [channelId]: message.id };
            });
            const viewing = active.current === channelId && document.visibilityState === 'visible';
            // Roles propios: /status no los trae, así que una mención de rol no cuenta aquí.
            if (!viewing && mentionsMe(message, me)) {
              setMentionCount((prev) => ({ ...prev, [channelId]: (prev[channelId] ?? 0) + 1 }));
              void playSound('notification', { key: `discord:${message.id}` });
            }
            break;
          }
          default:
            break;
        }
      }),
    [chat.subscribeDiscord, reloadTree, reloadStatus, me, user?.devId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => () => {
    if (debounce.current) window.clearTimeout(debounce.current);
  }, []);

  // Al reconectar el socket se perdieron eventos: estructura y estado otra vez.
  useEffect(
    () =>
      chat.subscribe((e) => {
        if (e.type === 'resync') {
          reloadTree();
          reloadStatus();
        }
      }),
    [chat.subscribe, reloadTree, reloadStatus], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const rememberMembers = useCallback((list: DiscordMemberView[]) => {
    if (!list.length) return;
    setMembers((prev) => {
      const next = new Map(prev);
      for (const m of list) next.set(m.discordUserId, m);
      return next;
    });
  }, []);

  const searchMembers = useCallback(
    async (q: string) => {
      const { members: list } = await discordApi.members(q, 20);
      rememberMembers(list);
      return list;
    },
    [rememberMembers],
  );

  const bridge = useMemo(() => {
    if (!status.bridge && !liveBridge) return null;
    const s = liveBridge ?? status.bridge!.status;
    // El latido lo calcula el backend; un aviso en vivo de "disconnected" manda sobre él.
    const healthy = liveBridge ? liveBridge === 'ready' || liveBridge === 'backfilling' : status.bridge!.healthy;
    return { status: s, healthy };
  }, [status.bridge, liveBridge]);

  const setActive = useCallback((id: string | null) => {
    active.current = id;
  }, []);

  const value = useMemo<DiscordState>(
    () => ({
      status,
      guildId: status.guild?.id ?? null,
      me,
      myDevId: user?.devId ?? null,
      tree,
      treeError,
      channels,
      roles,
      emojis,
      members,
      bridge,
      realtime: chat.realtime,
      reloadTree,
      reloadStatus,
      searchMembers,
      rememberMembers,
      setActive,
      markSeen,
      unread,
      subscribe: chat.subscribeDiscord,
    }),
    [status, me, user?.devId, tree, treeError, channels, roles, emojis, members, bridge, chat.realtime, reloadTree,
      reloadStatus, searchMembers, rememberMembers, setActive, markSeen, unread, chat.subscribeDiscord],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
