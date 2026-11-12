// Permisos de Discord, calculados en roz con el algoritmo OFICIAL. Módulo PURO: sin base, sin red,
// sin config — recibe el servidor, el miembro y los canales, devuelve bits. Es lo que decide qué
// canales ve cada dev en roz y a quién le llega cada evento de tiempo real, así que tiene que
// coincidir con lo que Discord muestra a esa misma persona. Si no coincide, roz filtra mensajes que
// alguien no debería ver: por eso los tests (test/discord-permissions.test.ts) son exhaustivos.
//
// Referencia: https://discord.com/developers/docs/topics/permissions#permission-overwrites
//
//   base(miembro) =
//     dueño del servidor                  → TODO
//     permisos de @everyone | de cada rol → si incluye ADMINISTRATOR → TODO
//
//   canal(miembro, canal) =
//     base tiene ADMINISTRATOR → TODO
//     p = base
//     overwrite de @everyone (id = guild_id):   p &= ~deny; p |= allow
//     overwrites de los roles del miembro:      p &= ~(OR de deny); p |= (OR de allow)
//       ↑ se COMBINAN antes de aplicar: un rol que permite le gana a otro que niega
//     overwrite del miembro:                    p &= ~deny; p |= allow
//
//   Reglas implícitas (Discord las aplica aunque los bits digan otra cosa):
//     · sin VIEW_CHANNEL no queda ningún permiso del canal (resultado 0).
//     · sin SEND_MESSAGES en un canal de texto: tampoco MENTION_EVERYONE, SEND_TTS_MESSAGES,
//       ATTACH_FILES ni EMBED_LINKS.
//     · miembro aislado (timeout vigente): solo VIEW_CHANNEL y READ_MESSAGE_HISTORY (salvo dueño o
//       administrador, a quienes el timeout no aplica).
//
//   Hilos: NO tienen overwrites propios. Heredan los permisos del canal padre; además:
//     · ver un hilo exige ver el padre (VIEW_CHANNEL en el padre).
//     · hilo privado (type 12): exige ser miembro del hilo o tener MANAGE_THREADS en el padre.
//     · escribir en un hilo usa SEND_MESSAGES_IN_THREADS, no SEND_MESSAGES; uno bloqueado (locked)
//       exige MANAGE_THREADS, y uno archivado no admite mensajes nuevos... salvo que el envío lo
//       desarchive: Discord lo desarchiva solo si el hilo NO está bloqueado.
//
//   Categorías: los overwrites NO se heredan en tiempo de cálculo. Un canal "sincronizado" con su
//   categoría tiene una COPIA idéntica de los overwrites de ella; uno no sincronizado tiene los
//   suyos. Por eso el cálculo de un canal usa SOLO sus propios overwrites. Una categoría se muestra
//   en roz si tiene al menos un canal visible (como hace el cliente de Discord).

import { DISCORD_CHANNEL_TYPE, isThreadType, type DiscordPermissionOverwrite } from '../types/discord.js';

// ---------------------------------------------------------------- bits

/** Bits de permisos de Discord (los que roz usa más los que conviene tener a mano en tests). */
export const PERMISSIONS = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_AUDIT_LOG: 1n << 7n,
  PRIORITY_SPEAKER: 1n << 8n,
  STREAM: 1n << 9n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  SEND_TTS_MESSAGES: 1n << 12n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  VIEW_GUILD_INSIGHTS: 1n << 19n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_GUILD_EXPRESSIONS: 1n << 30n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  USE_EXTERNAL_STICKERS: 1n << 37n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  MODERATE_MEMBERS: 1n << 40n,
  SEND_VOICE_MESSAGES: 1n << 46n,
  SEND_POLLS: 1n << 49n,
} as const;

/**
 * "Todos los permisos". Discord devuelve el bitfield completo para dueño/administrador; aquí basta
 * con todos los bits encendidos en 64 bits: cualquier `has(ALL, X)` es true, existan o no hoy.
 */
export const ALL_PERMISSIONS = (1n << 64n) - 1n;

/** Lo único que conserva un miembro aislado (timeout). */
const TIMEOUT_ALLOWED = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.READ_MESSAGE_HISTORY;

/** Lo que se pierde implícitamente sin SEND_MESSAGES. */
const NEEDS_SEND = PERMISSIONS.MENTION_EVERYONE | PERMISSIONS.SEND_TTS_MESSAGES | PERMISSIONS.ATTACH_FILES | PERMISSIONS.EMBED_LINKS;

/** Bitfield decimal de Discord (string) o ya bigint → bigint. Basura o vacío → 0 (nunca lanza). */
export function parsePermissions(value: string | bigint | number | null | undefined): bigint {
  if (typeof value === 'bigint') return value < 0n ? 0n : value;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : 0n;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return 0n;
  return BigInt(value.trim());
}

export function hasPermission(perms: bigint, flag: bigint): boolean {
  return (perms & flag) === flag;
}

// ---------------------------------------------------------------- entradas

export interface PermissionRole {
  id: string;
  permissions: string | bigint;
}

export interface PermissionGuild {
  id: string;
  ownerId: string;
  /** Todos los roles del servidor, INCLUIDO @everyone (id = guild id). Los borrados no van. */
  roles: ReadonlyArray<PermissionRole>;
}

export interface PermissionMember {
  userId: string;
  /** Roles del miembro. Si viene el de @everyone se ignora (se aplica aparte, una vez). */
  roles: ReadonlyArray<string>;
  /** ISO. Timeout vigente si es posterior a `now`. */
  communicationDisabledUntil?: string | null;
}

export interface PermissionChannel {
  id: string;
  type: number;
  parentId: string | null;
  overwrites: ReadonlyArray<DiscordPermissionOverwrite>;
  /** Solo hilos privados: miembros del hilo. */
  memberIds?: ReadonlyArray<string>;
  /** Solo hilos. */
  archived?: boolean;
  locked?: boolean;
}

// ---------------------------------------------------------------- algoritmo

function isTimedOut(member: PermissionMember, now: Date): boolean {
  const until = member.communicationDisabledUntil;
  if (!until) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > now.getTime();
}

/** Roles del miembro sin @everyone, sin repetidos y solo los que existen en el servidor. */
function memberRoleIds(guild: PermissionGuild, member: PermissionMember): string[] {
  const known = new Set(guild.roles.map((r) => r.id));
  const out = new Set<string>();
  for (const id of member.roles) if (id !== guild.id && known.has(id)) out.add(id);
  return [...out];
}

/** Permisos del miembro a nivel servidor (antes de canales). Paso 1 del algoritmo oficial. */
export function computeBasePermissions(guild: PermissionGuild, member: PermissionMember): bigint {
  if (member.userId === guild.ownerId) return ALL_PERMISSIONS;
  const byId = new Map(guild.roles.map((r) => [r.id, r]));
  let perms = parsePermissions(byId.get(guild.id)?.permissions);
  for (const id of memberRoleIds(guild, member)) perms |= parsePermissions(byId.get(id)?.permissions);
  if (hasPermission(perms, PERMISSIONS.ADMINISTRATOR)) return ALL_PERMISSIONS;
  return perms;
}

/**
 * Aplica los overwrites de UN canal (no hilo) sobre los permisos base. Paso 2 del algoritmo
 * oficial, sin las reglas implícitas (esas van en computeChannelPermissions).
 */
export function applyOverwrites(
  base: bigint,
  guild: PermissionGuild,
  member: PermissionMember,
  overwrites: ReadonlyArray<DiscordPermissionOverwrite>,
): bigint {
  if (hasPermission(base, PERMISSIONS.ADMINISTRATOR)) return ALL_PERMISSIONS;
  let perms = base;

  // Un id puede repetirse si el espejo trae basura; el último gana, como en un Map de Discord.
  const roleOw = new Map<string, DiscordPermissionOverwrite>();
  const memberOw = new Map<string, DiscordPermissionOverwrite>();
  for (const ow of overwrites) {
    if (Number(ow.type) === 1) memberOw.set(ow.id, ow);
    else roleOw.set(ow.id, ow);
  }

  // 1. @everyone
  const everyone = roleOw.get(guild.id);
  if (everyone) {
    perms &= ~parsePermissions(everyone.deny);
    perms |= parsePermissions(everyone.allow);
  }

  // 2. roles, combinados
  let allow = 0n;
  let deny = 0n;
  for (const id of memberRoleIds(guild, member)) {
    const ow = roleOw.get(id);
    if (!ow) continue;
    allow |= parsePermissions(ow.allow);
    deny |= parsePermissions(ow.deny);
  }
  perms &= ~deny;
  perms |= allow;

  // 3. el miembro
  const own = memberOw.get(member.userId);
  if (own) {
    perms &= ~parsePermissions(own.deny);
    perms |= parsePermissions(own.allow);
  }
  return perms;
}

/**
 * Reglas implícitas de Discord sobre un resultado ya calculado (no se aplican a TODO). `sendFlag` es
 * el permiso que cuenta como "escribir" en ese lugar: SEND_MESSAGES en un canal,
 * SEND_MESSAGES_IN_THREADS en un hilo.
 */
function applyImplicit(perms: bigint, timedOut: boolean, sendFlag: bigint): bigint {
  if (perms === ALL_PERMISSIONS) return perms;
  let p = perms;
  if (timedOut) p &= TIMEOUT_ALLOWED;
  if (!hasPermission(p, PERMISSIONS.VIEW_CHANNEL)) return 0n;
  if (!hasPermission(p, sendFlag)) p &= ~NEEDS_SEND;
  return p;
}

export interface PermissionContext {
  guild: PermissionGuild;
  member: PermissionMember;
  /** Todos los canales conocidos (para resolver el padre de un hilo). */
  channels: ReadonlyMap<string, PermissionChannel> | ReadonlyArray<PermissionChannel>;
  now?: Date;
}

function channelMap(ctx: PermissionContext): ReadonlyMap<string, PermissionChannel> {
  return ctx.channels instanceof Map
    ? (ctx.channels as ReadonlyMap<string, PermissionChannel>)
    : new Map((ctx.channels as ReadonlyArray<PermissionChannel>).map((c) => [c.id, c]));
}

/**
 * Permisos efectivos del miembro en un canal, categoría o hilo, con TODAS las reglas: dueño,
 * administrador, overwrites, timeout, implícitas y herencia de hilos. 0n = no lo ve.
 * Un hilo cuyo padre no está en `channels` da 0n (no se puede saber, así que no se muestra).
 */
export function computeChannelPermissions(ctx: PermissionContext, channelId: string): bigint {
  const map = channelMap(ctx);
  return computeIn(ctx, map, channelId);
}

function computeIn(ctx: PermissionContext, map: ReadonlyMap<string, PermissionChannel>, channelId: string): bigint {
  const channel = map.get(channelId);
  if (!channel) return 0n;
  const now = ctx.now ?? new Date();
  const base = computeBasePermissions(ctx.guild, ctx.member);
  // El timeout no aplica a dueño ni administradores.
  const timedOut = base !== ALL_PERMISSIONS && isTimedOut(ctx.member, now);

  if (!isThreadType(channel.type)) {
    return applyImplicit(applyOverwrites(base, ctx.guild, ctx.member, channel.overwrites), timedOut, PERMISSIONS.SEND_MESSAGES);
  }

  // Hilo: hereda los overwrites del padre (un hilo nunca es padre de otro hilo), pero las reglas
  // implícitas se evalúan con SEND_MESSAGES_IN_THREADS: alguien sin SEND_MESSAGES en el canal que sí
  // puede escribir en hilos conserva ATTACH_FILES/EMBED_LINKS dentro del hilo.
  if (!channel.parentId) return 0n;
  const parent = map.get(channel.parentId);
  if (!parent || isThreadType(parent.type)) return 0n;
  const raw = applyOverwrites(base, ctx.guild, ctx.member, parent.overwrites);
  const perms = applyImplicit(raw, timedOut, PERMISSIONS.SEND_MESSAGES_IN_THREADS);
  if (perms === 0n) return 0n;
  if (perms === ALL_PERMISSIONS) return ALL_PERMISSIONS;

  if (channel.type === DISCORD_CHANNEL_TYPE.PRIVATE_THREAD) {
    const isMember = (channel.memberIds ?? []).includes(ctx.member.userId);
    if (!isMember && !hasPermission(perms, PERMISSIONS.MANAGE_THREADS)) return 0n;
  }
  return perms;
}

export function canViewChannel(ctx: PermissionContext, channelId: string): boolean {
  return hasPermission(computeChannelPermissions(ctx, channelId), PERMISSIONS.VIEW_CHANNEL);
}

export interface ChannelAbilities {
  view: boolean;
  readHistory: boolean;
  send: boolean;
  attach: boolean;
  mentionEveryone: boolean;
  manageMessages: boolean;
}

/**
 * Lo que el miembro puede hacer en un canal o hilo, ya traducido a acciones de roz. En hilos
 * "escribir" usa SEND_MESSAGES_IN_THREADS; uno bloqueado exige MANAGE_THREADS (un archivado no
 * bloqueado sí admite: Discord lo desarchiva al recibir el mensaje).
 */
export function channelAbilities(ctx: PermissionContext, channelId: string): ChannelAbilities {
  const map = channelMap(ctx);
  const channel = map.get(channelId);
  const perms = computeIn(ctx, map, channelId);
  const view = hasPermission(perms, PERMISSIONS.VIEW_CHANNEL);
  if (!channel || !view) {
    return { view: false, readHistory: false, send: false, attach: false, mentionEveryone: false, manageMessages: false };
  }
  const thread = isThreadType(channel.type);
  let send = thread ? hasPermission(perms, PERMISSIONS.SEND_MESSAGES_IN_THREADS) : hasPermission(perms, PERMISSIONS.SEND_MESSAGES);
  if (thread && channel.locked && !hasPermission(perms, PERMISSIONS.MANAGE_THREADS)) send = false;
  return {
    view,
    readHistory: hasPermission(perms, PERMISSIONS.READ_MESSAGE_HISTORY),
    send,
    attach: send && hasPermission(perms, PERMISSIONS.ATTACH_FILES),
    mentionEveryone: send && hasPermission(perms, PERMISSIONS.MENTION_EVERYONE),
    manageMessages: hasPermission(perms, PERMISSIONS.MANAGE_MESSAGES),
  };
}

/**
 * Ids visibles para el miembro entre `channels` (canales, hilos y categorías). Una categoría entra
 * solo si tiene al menos un canal hijo visible — aunque el miembro tenga VIEW_CHANNEL sobre ella,
 * una categoría vacía no se muestra (igual que en el cliente de Discord).
 */
export function visibleChannelIds(ctx: PermissionContext): Set<string> {
  const map = channelMap(ctx);
  const out = new Set<string>();
  for (const ch of map.values()) {
    if (ch.type === DISCORD_CHANNEL_TYPE.GUILD_CATEGORY) continue;
    if (hasPermission(computeIn(ctx, map, ch.id), PERMISSIONS.VIEW_CHANNEL)) out.add(ch.id);
  }
  for (const ch of map.values()) {
    if (ch.type !== DISCORD_CHANNEL_TYPE.GUILD_CATEGORY) continue;
    const hasVisibleChild = [...map.values()].some(
      (c) => c.parentId === ch.id && !isThreadType(c.type) && out.has(c.id),
    );
    if (hasVisibleChild) out.add(ch.id);
  }
  return out;
}

/** Normaliza un overwrite para comparar (ids y bits, sin importar el orden ni "0" vs "00"). */
function overwriteKey(ow: DiscordPermissionOverwrite): string {
  return `${Number(ow.type)}:${ow.id}:${parsePermissions(ow.allow)}:${parsePermissions(ow.deny)}`;
}

/**
 * ¿El canal está "sincronizado" con su categoría? (mismos overwrites, en cualquier orden). Igual
 * que el candado de "Sincronizado" de Discord. Sin categoría → false.
 */
export function isSyncedWithCategory(channel: PermissionChannel, category: PermissionChannel | null | undefined): boolean {
  if (!category || channel.parentId !== category.id) return false;
  const a = channel.overwrites.map(overwriteKey).sort();
  const b = category.overwrites.map(overwriteKey).sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

// ---------------------------------------------------------------- muchos miembros

export interface MemberWithUser extends PermissionMember {
  /** Dev de roz ligado a este usuario de Discord. */
  devId: string;
}

/**
 * Devs (de los ligados) que pueden ver un canal/hilo. Es lo que decide a quién se le transmite un
 * evento de tiempo real. Puro: recibe miembros ya cargados.
 */
export function devsWhoCanView(
  guild: PermissionGuild,
  channels: ReadonlyMap<string, PermissionChannel> | ReadonlyArray<PermissionChannel>,
  members: ReadonlyArray<MemberWithUser>,
  channelId: string,
  now: Date = new Date(),
): string[] {
  const map =
    channels instanceof Map
      ? (channels as ReadonlyMap<string, PermissionChannel>)
      : new Map((channels as ReadonlyArray<PermissionChannel>).map((c) => [c.id, c]));
  const out: string[] = [];
  for (const m of members) {
    if (canViewChannel({ guild, member: m, channels: map, now }, channelId)) out.push(m.devId);
  }
  return out;
}
