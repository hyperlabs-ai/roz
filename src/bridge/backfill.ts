// Backfill y reconciliación (contrato §A.4). Corre al arrancar y en cada READY que no sea RESUMED.
//
//   1. Estructura completa: guild, roles, canales/categorías, hilos activos (+ una página de
//      archivados públicos por canal), emojis, miembros. Lo que está en la base y ya no viene de
//      Discord se marca borrado (deleted_at / left_at). Aviso structure.changed { scope: 'guild' }.
//   2. Mensajes, canal por canal (texto, anuncios e hilos activos que el bot pueda leer):
//      · últimos 100 → upsert (trae ediciones y conteos de reacciones de lo que pasó estando caído);
//      · hueco desde `newest_message_id` hasta esos 100 → `after=` paginando;
//      · ids de la base dentro del rango de esos 100 que Discord ya no devolvió → deleted_at
//        (Discord no reenvía los borrados ocurridos mientras el puente estaba caído);
//      · si el backfill no está completo → `before=oldest` hasta juntar N en total o llegar al
//        principio del canal.
//      Al terminar cada canal: structure.changed { scope: 'channels', channelIds: [id] }.
//
// Las lecturas a Discord van fuera del carril serial; cada escritura entra al carril.
import { log, errorText } from './log.js';
import { mapChannel, mapEmoji, mapGuild, mapMember, mapMessage, mapRole } from './map.js';
import type { EmojiFields, MemberFields } from './map.js';
import type { SerialQueue } from './queue.js';
import { mergeReactions } from './reactions.js';
import type { DiscordApiChannel, DiscordApiMessage } from './shared/api-types.js';
import {
  DISCORD_CHANNEL_TYPE,
  TEXT_CHANNEL_TYPES,
  isThreadType,
  type DiscordBridgeNotice,
} from './shared/types.js';
import { compareSnowflakes, maxSnowflake, minSnowflake, snowflakeFromTime, snowflakeIso, snowflakeTime } from './snowflake.js';
import { isNoAccess, type DiscordSource } from './source/types.js';
import type { MirrorStore, SyncState } from './store/types.js';

export interface BackfillDeps {
  guildId: string;
  store: MirrorStore;
  source: DiscordSource;
  lane: SerialQueue;
  notify: (...notices: DiscordBridgeNotice[]) => void;
  /** Mensajes por canal a juntar en el backfill inicial (DISCORD_BACKFILL_MESSAGES). */
  backfillMessages: number;
  /** Tope de páginas de `after` al ponerse al día. */
  catchupMaxPages: number;
  now?: () => number;
  /** Para cortar a la mitad en un apagado. */
  shouldStop?: () => boolean;
  onProgress?: (p: { pending: number; done: number }) => void;
}

const PAGE = 100;
/** Margen contra desfase entre el reloj del puente y el de Discord al acotar la reconciliación. */
const CLOCK_SKEW_MS = 5000;
/** Hilos archivados públicos por canal que se guardan en el backfill (los demás, al verlos). */
const ARCHIVED_THREADS_PER_CHANNEL = 25;
/** Canales cuyos hilos (publicaciones) se miran: texto, anuncios, foro, media. */
const THREAD_PARENT_TYPES = new Set<number>([
  DISCORD_CHANNEL_TYPE.GUILD_TEXT,
  DISCORD_CHANNEL_TYPE.GUILD_ANNOUNCEMENT,
  DISCORD_CHANNEL_TYPE.GUILD_FORUM,
  DISCORD_CHANNEL_TYPE.GUILD_MEDIA,
]);

function sortAsc(list: DiscordApiMessage[]): DiscordApiMessage[] {
  return [...list].sort((a, b) => compareSnowflakes(a.id, b.id));
}

// ================================================================ 1. estructura

export interface StructureResult {
  /** Canales e hilos cuyos mensajes se sincronizan, en orden (canales por posición, luego hilos). */
  messageChannelIds: string[];
}

export async function syncStructure(deps: BackfillDeps): Promise<StructureResult> {
  const { guildId, store, source, lane } = deps;

  const guild = await source.fetchGuild();
  await lane.run(() => store.upsertGuild(mapGuild(guild)));

  const roles = await source.fetchRoles();
  await lane.run(async () => {
    await store.upsertRoles(roles.map((r) => mapRole(r, guildId)));
    const keep = new Set(roles.map((r) => r.id));
    const gone = (await store.listRoleIds(guildId)).filter((id) => !keep.has(id));
    if (gone.length) await store.softDeleteRoles(gone);
  });

  const channels = (await source.fetchChannels()).filter((c) => !isThreadType(c.type));
  const active = await source.fetchActiveThreads();
  const archived: DiscordApiChannel[] = [];
  for (const c of channels) {
    if (deps.shouldStop?.()) break;
    if (THREAD_PARENT_TYPES.has(c.type)) archived.push(...(await source.fetchArchivedPublicThreads(c.id, ARCHIVED_THREADS_PER_CHANNEL)));
  }
  const seenThreads = new Map<string, DiscordApiChannel>();
  for (const t of [...archived, ...active]) seenThreads.set(t.id, t); // los activos ganan

  await lane.run(async () => {
    await store.upsertChannels([...channels, ...seenThreads.values()].map((c) => mapChannel(c, guildId)));
  });

  // Canales que ya no existen; hilos que la base cree activos pero Discord ya no lista: se pregunta
  // uno por uno (pudo archivarse o borrarse mientras el puente estaba caído).
  const live = await store.listChannels(guildId);
  const channelIds = new Set(channels.map((c) => c.id));
  const goneChannels = live.filter((c) => !isThreadType(c.type) && !channelIds.has(c.id)).map((c) => c.id);
  const staleThreads = live.filter((c) => isThreadType(c.type) && !c.archived && !seenThreads.has(c.id));
  const goneThreads: string[] = [];
  const refreshed: DiscordApiChannel[] = [];
  for (const t of staleThreads) {
    if (goneChannels.includes(t.parent_id ?? '')) {
      goneThreads.push(t.id);
      continue;
    }
    const fresh = await source.fetchChannel(t.id);
    if (fresh) refreshed.push(fresh);
    else goneThreads.push(t.id);
  }
  await lane.run(async () => {
    if (refreshed.length) await store.upsertChannels(refreshed.map((c) => mapChannel(c, guildId)));
    if (goneChannels.length || goneThreads.length) await store.softDeleteChannels([...goneChannels, ...goneThreads]);
  });

  // Hilos privados: quién está dentro decide quién los ve.
  for (const t of active) {
    if (t.type !== DISCORD_CHANNEL_TYPE.PRIVATE_THREAD) continue;
    const ids = await source.fetchThreadMemberIds(t.id);
    await lane.run(() => store.patchChannel(t.id, { member_ids: ids }).then(() => undefined));
  }

  const emojis = await source.fetchEmojis();
  await lane.run(async () => {
    const rows = emojis.map((e) => mapEmoji(e, guildId)).filter((r): r is EmojiFields => r !== null);
    await store.upsertEmojis(rows);
    const keep = new Set(rows.map((r) => r.id));
    const gone = (await store.listEmojiIds(guildId)).filter((id) => !keep.has(id));
    if (gone.length) await store.softDeleteEmojis(gone);
  });

  const members = await source.fetchMembers();
  await lane.run(async () => {
    const rows = members.map((m) => mapMember(m, guildId)).filter((r): r is MemberFields => r !== null);
    await store.upsertMembers(rows);
    const keep = new Set(rows.map((r) => r.user_id));
    const gone = (await store.listActiveMemberIds(guildId)).filter((id) => !keep.has(id));
    if (gone.length) await store.markMembersLeft(guildId, gone);
  });

  deps.notify({ kind: 'structure.changed', scope: 'guild' });

  const textChannels = channels
    .filter((c) => TEXT_CHANNEL_TYPES.has(c.type))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || compareSnowflakes(a.id, b.id));
  return { messageChannelIds: [...textChannels.map((c) => c.id), ...active.map((t) => t.id)] };
}

// ================================================================ 2. mensajes

/** Upsert de mensajes traídos por REST conservando los usuarios de reacciones ya conocidos. */
export async function writeMessages(deps: BackfillDeps, raws: DiscordApiMessage[]): Promise<number> {
  if (!raws.length) return 0;
  return deps.lane.run(async () => {
    const rows = raws.map((m) => mapMessage(m, deps.guildId));
    const existing = await deps.store.getMessages(rows.map((r) => r.id));
    let fresh = 0;
    for (const r of rows) {
      const prev = existing.get(r.id);
      if (!prev) fresh += 1;
      else r.reactions = mergeReactions(r.reactions, prev.reactions);
    }
    await deps.store.upsertMessages(rows);
    return fresh;
  });
}

export interface ChannelSyncResult {
  channelId: string;
  /** Mensajes nuevos para el espejo. */
  inserted: number;
  /** Mensajes marcados como borrados por la reconciliación. */
  deleted: number;
  complete: boolean;
  skipped?: 'no_access';
}

export async function syncChannelMessages(deps: BackfillDeps, channelId: string): Promise<ChannelSyncResult> {
  const { store, source, guildId } = deps;
  const now = deps.now ?? Date.now;
  const state: SyncState | null = await store.getSyncState(channelId);
  const startedAt = now();

  let latest: DiscordApiMessage[];
  try {
    latest = sortAsc(await source.fetchMessages(channelId, { limit: PAGE }));
  } catch (err) {
    if (!isNoAccess(err)) throw err;
    await deps.lane.run(() =>
      store.upsertSyncState({ channel_id: channelId, guild_id: guildId, last_error: 'el bot no puede leer este canal' }),
    );
    return { channelId, inserted: 0, deleted: 0, complete: state?.backfill_complete ?? false, skipped: 'no_access' };
  }

  let inserted = await writeMessages(deps, latest);
  const latestMin = latest.length ? latest[0]!.id : null;
  const latestMax = latest.length ? latest[latest.length - 1]!.id : null;

  // Hueco: lo que pasó entre el último visto y los 100 más nuevos (caída larga).
  if (state?.newest_message_id && latest.length === PAGE && latestMin && compareSnowflakes(latestMin, state.newest_message_id) > 0) {
    let cursor = state.newest_message_id;
    for (let pages = 0; ; pages++) {
      if (pages >= deps.catchupMaxPages) {
        log.warn('ponerse al día: se alcanzó el tope de páginas; queda un hueco en el espejo', { channelId, pages });
        break;
      }
      if (deps.shouldStop?.()) break;
      const page = sortAsc(await source.fetchMessages(channelId, { after: cursor, limit: PAGE }));
      const inGap = page.filter((m) => compareSnowflakes(m.id, latestMin) < 0);
      inserted += await writeMessages(deps, inGap);
      if (page.length < PAGE || inGap.length < page.length) break;
      cursor = page[page.length - 1]!.id;
    }
  }

  // Borrados mientras estuvo caído: ids de la base dentro del rango de los 100 más nuevos que Discord
  // ya no devolvió. Con menos de 100 el rango es TODO el canal. La cota de arriba es el instante del
  // pedido (menos un margen por desfase de reloj): lo que llegó en vivo después no se toca, y un
  // mensaje borrado que era el más nuevo del canal sí se detecta.
  const cutoff = snowflakeFromTime(startedAt - CLOCK_SKEW_MS);
  const upper = latestMax && compareSnowflakes(latestMax, cutoff) > 0 ? latestMax : cutoff;
  const fromIso = latest.length === PAGE && latestMin ? snowflakeIso(latestMin) : null;
  const returned = new Set(latest.map((m) => m.id));
  const candidates = await store.listMessageIdsBetween(channelId, fromIso, new Date(snowflakeTime(upper)).toISOString());
  const vanished = candidates.filter(
    (id) =>
      !returned.has(id) &&
      compareSnowflakes(id, upper) <= 0 &&
      (fromIso === null || compareSnowflakes(id, latestMin!) >= 0),
  );
  let deleted = 0;
  if (vanished.length) {
    const changed = await deps.lane.run(() => store.softDeleteMessages(vanished));
    deleted = changed.length;
  }

  // Backfill hacia atrás hasta juntar N.
  let oldest = state?.oldest_message_id ?? latestMin;
  let newest = maxSnowflake([state?.newest_message_id, latestMax].filter((x): x is string => !!x));
  let complete = state?.backfill_complete ?? false;
  if (!complete) {
    if (!state && latest.length < PAGE) complete = true; // canal con menos de 100: ya está todo
    let count = await store.countMessages(channelId);
    while (!complete && oldest && count < deps.backfillMessages) {
      if (deps.shouldStop?.()) break;
      const want = Math.min(PAGE, deps.backfillMessages - count);
      const page = sortAsc(await source.fetchMessages(channelId, { before: oldest, limit: want }));
      inserted += await writeMessages(deps, page);
      count += page.length;
      if (page.length) oldest = minSnowflake([oldest, page[0]!.id]);
      if (page.length < want) complete = true; // llegó al principio del canal
    }
    if (count >= deps.backfillMessages) complete = true;
    if (!oldest) complete = true; // canal vacío
  }

  await deps.lane.run(() =>
    store.upsertSyncState({
      channel_id: channelId,
      guild_id: guildId,
      oldest_message_id: oldest ?? null,
      newest_message_id: newest ?? null,
      backfill_complete: complete,
      last_synced_at: new Date(now()).toISOString(),
      last_error: null,
    }),
  );

  // Contrato §A.4: un solo aviso por canal al terminar (no uno por mensaje).
  if (inserted || deleted || latest.length) {
    deps.notify({ kind: 'structure.changed', scope: 'channels', channelIds: [channelId] });
  }
  return { channelId, inserted, deleted, complete };
}

// ================================================================ todo junto

export interface FullSyncResult {
  channels: number;
  failed: number;
  stopped: boolean;
}

export async function fullSync(deps: BackfillDeps): Promise<FullSyncResult> {
  const { messageChannelIds } = await syncStructure(deps);
  let done = 0;
  let failed = 0;
  deps.onProgress?.({ pending: messageChannelIds.length, done });
  for (const id of messageChannelIds) {
    if (deps.shouldStop?.()) return { channels: done, failed, stopped: true };
    try {
      await syncChannelMessages(deps, id);
    } catch (err) {
      failed += 1;
      log.warn('backfill: falló un canal; se sigue con el resto', { channelId: id, err });
      await deps.lane
        .run(() => deps.store.upsertSyncState({ channel_id: id, guild_id: deps.guildId, last_error: errorText(err) }))
        .catch(() => undefined);
    }
    done += 1;
    deps.onProgress?.({ pending: messageChannelIds.length - done, done });
  }
  return { channels: done, failed, stopped: false };
}
