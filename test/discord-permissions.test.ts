import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  PERMISSIONS as P,
  applyOverwrites,
  canViewChannel,
  channelAbilities,
  computeBasePermissions,
  computeChannelPermissions,
  devsWhoCanView,
  hasPermission,
  isSyncedWithCategory,
  parsePermissions,
  visibleChannelIds,
  type PermissionChannel,
  type PermissionContext,
  type PermissionGuild,
  type PermissionMember,
} from '../src/discord/permissions.js';
import { DISCORD_CHANNEL_TYPE as T, type DiscordPermissionOverwrite } from '../src/types/discord.js';

// Permisos de Discord calculados en roz. Lo que importa es que coincida con lo que Discord muestra:
// si roz es más generoso, filtra mensajes de canales privados; si es más estricto, esconde canales
// que la persona sí ve en Discord. Cada caso sigue un paso del algoritmo oficial.

const GUILD = '100000000000000001';
const OWNER = '200000000000000001';
const ANA = '200000000000000002';
const BETO = '200000000000000003';
const R_DEV = '300000000000000001';
const R_CLIENTE = '300000000000000002';
const R_ADMIN = '300000000000000003';
const R_MOD = '300000000000000004';
const CAT = '400000000000000001';
const GENERAL = '400000000000000002';
const PRIVADO = '400000000000000003';
const THREAD = '400000000000000004';
const PTHREAD = '400000000000000005';

const s = (b: bigint) => b.toString();
const BASIC = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.ATTACH_FILES | P.EMBED_LINKS | P.SEND_MESSAGES_IN_THREADS | P.ADD_REACTIONS;

function guild(over: Partial<Record<string, bigint>> = {}): PermissionGuild {
  return {
    id: GUILD,
    ownerId: OWNER,
    roles: [
      { id: GUILD, permissions: s(over.everyone ?? BASIC) },
      { id: R_DEV, permissions: s(over.dev ?? 0n) },
      { id: R_CLIENTE, permissions: s(over.cliente ?? 0n) },
      { id: R_ADMIN, permissions: s(over.admin ?? P.ADMINISTRATOR) },
      { id: R_MOD, permissions: s(over.mod ?? P.MANAGE_THREADS | P.MANAGE_MESSAGES) },
    ],
  };
}

const member = (userId: string, roles: string[] = [], until: string | null = null): PermissionMember => ({
  userId,
  roles,
  communicationDisabledUntil: until,
});

const role = (id: string, allow = 0n, deny = 0n): DiscordPermissionOverwrite => ({ id, type: 0, allow: s(allow), deny: s(deny) });
const user = (id: string, allow = 0n, deny = 0n): DiscordPermissionOverwrite => ({ id, type: 1, allow: s(allow), deny: s(deny) });

function channel(id: string, overwrites: DiscordPermissionOverwrite[] = [], over: Partial<PermissionChannel> = {}): PermissionChannel {
  return { id, type: T.GUILD_TEXT, parentId: null, overwrites, ...over };
}

function ctx(m: PermissionMember, channels: PermissionChannel[], g: PermissionGuild = guild(), now = new Date('2026-11-11T12:00:00Z')): PermissionContext {
  return { guild: g, member: m, channels, now };
}

const perms = (c: PermissionContext, id: string) => computeChannelPermissions(c, id);
const can = (c: PermissionContext, id: string, flag: bigint) => hasPermission(perms(c, id), flag);

describe('parsePermissions', () => {
  it('lee el bitfield decimal de Discord, incluidos bits por encima de 32', () => {
    expect(parsePermissions('1024')).toBe(P.VIEW_CHANNEL);
    expect(parsePermissions(s(P.SEND_MESSAGES_IN_THREADS))).toBe(1n << 38n);
    expect(parsePermissions(' 2048 ')).toBe(P.SEND_MESSAGES);
    expect(parsePermissions(2048n)).toBe(P.SEND_MESSAGES);
    expect(parsePermissions(1024)).toBe(P.VIEW_CHANNEL);
  });

  it('basura, vacío o negativos valen 0 (nunca lanza, nunca concede)', () => {
    for (const v of ['', 'abc', '-1', '1e3', '0x10', null, undefined, -5, 1.5, -1n, Number.MAX_VALUE]) {
      expect(parsePermissions(v as never)).toBe(0n);
    }
  });
});

describe('permisos base (servidor)', () => {
  it('@everyone + la unión de los roles del miembro', () => {
    const g = guild({ everyone: P.VIEW_CHANNEL, dev: P.SEND_MESSAGES, cliente: P.ATTACH_FILES });
    expect(computeBasePermissions(g, member(ANA))).toBe(P.VIEW_CHANNEL);
    expect(computeBasePermissions(g, member(ANA, [R_DEV]))).toBe(P.VIEW_CHANNEL | P.SEND_MESSAGES);
    expect(computeBasePermissions(g, member(ANA, [R_DEV, R_CLIENTE]))).toBe(P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ATTACH_FILES);
  });

  it('el dueño del servidor tiene TODO, sin roles', () => {
    expect(computeBasePermissions(guild({ everyone: 0n }), member(OWNER))).toBe(ALL_PERMISSIONS);
  });

  it('un rol con ADMINISTRATOR da TODO', () => {
    expect(computeBasePermissions(guild(), member(ANA, [R_ADMIN]))).toBe(ALL_PERMISSIONS);
  });

  it('ADMINISTRATOR en @everyone da TODO a cualquiera', () => {
    expect(computeBasePermissions(guild({ everyone: P.ADMINISTRATOR }), member(ANA))).toBe(ALL_PERMISSIONS);
  });

  it('ignora roles que no existen (borrados) y el id de @everyone repetido en los roles', () => {
    const g = guild({ everyone: P.VIEW_CHANNEL });
    expect(computeBasePermissions(g, member(ANA, ['999999999999999999', GUILD]))).toBe(P.VIEW_CHANNEL);
  });
});

describe('overwrites de canal (orden oficial)', () => {
  it('sin overwrites el canal hereda la base', () => {
    const c = ctx(member(ANA), [channel(GENERAL)]);
    expect(perms(c, GENERAL)).toBe(BASIC);
  });

  it('@everyone niega VIEW_CHANNEL → nadie lo ve (salvo que un rol lo permita)', () => {
    const ch = channel(PRIVADO, [role(GUILD, 0n, P.VIEW_CHANNEL), role(R_DEV, P.VIEW_CHANNEL)]);
    expect(canViewChannel(ctx(member(ANA), [ch]), PRIVADO)).toBe(false);
    expect(canViewChannel(ctx(member(ANA, [R_DEV]), [ch]), PRIVADO)).toBe(true);
  });

  it('@everyone permite pero un rol niega → negado (los roles van después de @everyone)', () => {
    const g = guild({ everyone: 0n });
    const ch = channel(PRIVADO, [role(GUILD, P.VIEW_CHANNEL), role(R_CLIENTE, 0n, P.VIEW_CHANNEL)]);
    expect(canViewChannel(ctx(member(ANA), [ch], g), PRIVADO)).toBe(true);
    expect(canViewChannel(ctx(member(ANA, [R_CLIENTE]), [ch], g), PRIVADO)).toBe(false);
  });

  it('entre roles, permitir le gana a negar (allow y deny se combinan antes de aplicar)', () => {
    const ch = channel(PRIVADO, [role(R_CLIENTE, 0n, P.VIEW_CHANNEL), role(R_DEV, P.VIEW_CHANNEL)]);
    expect(canViewChannel(ctx(member(ANA, [R_CLIENTE, R_DEV]), [ch]), PRIVADO)).toBe(true);
    // El orden de los roles en el miembro no cambia nada.
    expect(canViewChannel(ctx(member(ANA, [R_DEV, R_CLIENTE]), [ch]), PRIVADO)).toBe(true);
  });

  it('el overwrite del miembro le gana a todo lo anterior, en ambos sentidos', () => {
    const deniedByMember = channel(GENERAL, [role(R_DEV, P.VIEW_CHANNEL), user(ANA, 0n, P.VIEW_CHANNEL)]);
    expect(canViewChannel(ctx(member(ANA, [R_DEV]), [deniedByMember]), GENERAL)).toBe(false);

    const allowedByMember = channel(PRIVADO, [role(GUILD, 0n, P.VIEW_CHANNEL), role(R_CLIENTE, 0n, P.VIEW_CHANNEL), user(ANA, P.VIEW_CHANNEL)]);
    expect(canViewChannel(ctx(member(ANA, [R_CLIENTE]), [allowedByMember]), PRIVADO)).toBe(true);
  });

  it('el overwrite de OTRO miembro no afecta', () => {
    const ch = channel(PRIVADO, [role(GUILD, 0n, P.VIEW_CHANNEL), user(BETO, P.VIEW_CHANNEL)]);
    expect(canViewChannel(ctx(member(ANA), [ch]), PRIVADO)).toBe(false);
    expect(canViewChannel(ctx(member(BETO), [ch]), PRIVADO)).toBe(true);
  });

  it('el overwrite de un rol que el miembro no tiene no afecta', () => {
    const ch = channel(GENERAL, [role(R_CLIENTE, 0n, P.VIEW_CHANNEL)]);
    expect(canViewChannel(ctx(member(ANA, [R_DEV]), [ch]), GENERAL)).toBe(true);
  });

  it('el rol @everyone listado en los roles del miembro NO cuenta dos veces', () => {
    // Si el overwrite de @everyone entrara también en la fase de roles, su allow le ganaría al deny
    // del rol cliente — y un cliente vería el canal privado.
    const ch = channel(PRIVADO, [role(GUILD, P.VIEW_CHANNEL), role(R_CLIENTE, 0n, P.VIEW_CHANNEL)]);
    expect(canViewChannel(ctx(member(ANA, [GUILD, R_CLIENTE]), [ch]), PRIVADO)).toBe(false);
  });

  it('un overwrite de miembro con el id de un ROL no se confunde (el tipo importa)', () => {
    const ch = channel(PRIVADO, [role(GUILD, 0n, P.VIEW_CHANNEL), user(R_DEV, P.VIEW_CHANNEL)]);
    expect(canViewChannel(ctx(member(ANA, [R_DEV]), [ch]), PRIVADO)).toBe(false);
  });

  it('acepta el tipo de overwrite como string ("1") como lo entregan algunos clientes', () => {
    const ow = { id: ANA, type: '1' as unknown as 1, allow: s(P.VIEW_CHANNEL), deny: '0' };
    const ch = channel(PRIVADO, [role(GUILD, 0n, P.VIEW_CHANNEL), ow]);
    expect(canViewChannel(ctx(member(ANA), [ch]), PRIVADO)).toBe(true);
  });

  it('ADMINISTRATOR ignora los overwrites que niegan', () => {
    const ch = channel(PRIVADO, [role(GUILD, 0n, P.VIEW_CHANNEL), user(ANA, 0n, BASIC)]);
    expect(perms(ctx(member(ANA, [R_ADMIN]), [ch]), PRIVADO)).toBe(ALL_PERMISSIONS);
  });

  it('el dueño ve todo aunque un overwrite lo niegue explícitamente', () => {
    const ch = channel(PRIVADO, [user(OWNER, 0n, P.VIEW_CHANNEL)]);
    expect(canViewChannel(ctx(member(OWNER), [ch]), PRIVADO)).toBe(true);
  });

  it('ADMINISTRATOR concedido por overwrite NO convierte en administrador (Discord lo ignora)', () => {
    const ch = channel(PRIVADO, [role(GUILD, 0n, P.VIEW_CHANNEL), user(ANA, P.ADMINISTRATOR)]);
    expect(canViewChannel(ctx(member(ANA), [ch]), PRIVADO)).toBe(false);
  });

  it('applyOverwrites con base administrador devuelve TODO', () => {
    expect(applyOverwrites(ALL_PERMISSIONS, guild(), member(ANA), [role(GUILD, 0n, P.VIEW_CHANNEL)])).toBe(ALL_PERMISSIONS);
  });

  it('un id de overwrite repetido: el último gana', () => {
    const ch = channel(PRIVADO, [role(GUILD, 0n, P.VIEW_CHANNEL), user(ANA, 0n, P.VIEW_CHANNEL), user(ANA, P.VIEW_CHANNEL)]);
    expect(canViewChannel(ctx(member(ANA), [ch]), PRIVADO)).toBe(true);
  });
});

describe('reglas implícitas', () => {
  it('sin VIEW_CHANNEL no queda NINGÚN permiso, aunque se concedan otros', () => {
    const ch = channel(PRIVADO, [role(GUILD, P.SEND_MESSAGES | P.MANAGE_MESSAGES, P.VIEW_CHANNEL)]);
    expect(perms(ctx(member(ANA), [ch]), PRIVADO)).toBe(0n);
  });

  it('sin SEND_MESSAGES se pierden ATTACH_FILES, EMBED_LINKS, MENTION_EVERYONE y TTS (no la lectura)', () => {
    const g = guild({ everyone: BASIC | P.MENTION_EVERYONE | P.SEND_TTS_MESSAGES });
    const ch = channel(GENERAL, [role(GUILD, 0n, P.SEND_MESSAGES)]);
    const c = ctx(member(ANA), [ch], g);
    expect(can(c, GENERAL, P.VIEW_CHANNEL)).toBe(true);
    expect(can(c, GENERAL, P.READ_MESSAGE_HISTORY)).toBe(true);
    for (const f of [P.ATTACH_FILES, P.EMBED_LINKS, P.MENTION_EVERYONE, P.SEND_TTS_MESSAGES]) expect(can(c, GENERAL, f)).toBe(false);
    expect(channelAbilities(c, GENERAL)).toMatchObject({ view: true, send: false, attach: false, mentionEveryone: false, readHistory: true });
  });

  it('un canal que no existe en el espejo da 0', () => {
    expect(perms(ctx(member(ANA), [channel(GENERAL)]), '499999999999999999')).toBe(0n);
    expect(channelAbilities(ctx(member(ANA), []), GENERAL).view).toBe(false);
  });
});

describe('aislamiento (timeout)', () => {
  const future = '2026-11-11T13:00:00Z';
  const past = '2026-11-11T11:00:00Z';

  it('vigente: solo VIEW_CHANNEL y READ_MESSAGE_HISTORY', () => {
    const c = ctx(member(ANA, [R_DEV], future), [channel(GENERAL)]);
    expect(perms(c, GENERAL)).toBe(P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY);
    expect(channelAbilities(c, GENERAL).send).toBe(false);
  });

  it('vencido: no afecta', () => {
    expect(perms(ctx(member(ANA, [], past), [channel(GENERAL)]), GENERAL)).toBe(BASIC);
  });

  it('no aplica a administradores ni al dueño', () => {
    expect(perms(ctx(member(ANA, [R_ADMIN], future), [channel(GENERAL)]), GENERAL)).toBe(ALL_PERMISSIONS);
    expect(perms(ctx(member(OWNER, [], future), [channel(GENERAL)]), GENERAL)).toBe(ALL_PERMISSIONS);
  });

  it('no concede VIEW_CHANNEL a quien no lo tenía', () => {
    const ch = channel(PRIVADO, [role(GUILD, 0n, P.VIEW_CHANNEL)]);
    expect(perms(ctx(member(ANA, [], future), [ch]), PRIVADO)).toBe(0n);
  });

  it('una fecha inválida no aísla', () => {
    expect(perms(ctx(member(ANA, [], 'nunca'), [channel(GENERAL)]), GENERAL)).toBe(BASIC);
  });
});

describe('hilos', () => {
  const parentPrivate = channel(PRIVADO, [role(GUILD, 0n, P.VIEW_CHANNEL), role(R_DEV, P.VIEW_CHANNEL)]);
  const pub = (over: Partial<PermissionChannel> = {}) => channel(THREAD, [], { type: T.PUBLIC_THREAD, parentId: PRIVADO, ...over });
  const priv = (memberIds: string[] = []) => channel(PTHREAD, [], { type: T.PRIVATE_THREAD, parentId: PRIVADO, memberIds });

  it('un hilo público hereda la visibilidad del padre', () => {
    expect(canViewChannel(ctx(member(ANA, [R_DEV]), [parentPrivate, pub()]), THREAD)).toBe(true);
    expect(canViewChannel(ctx(member(ANA), [parentPrivate, pub()]), THREAD)).toBe(false);
  });

  it('los overwrites que traiga el hilo se ignoran (los hilos no tienen overwrites propios)', () => {
    const t = pub({ overwrites: [role(GUILD, P.VIEW_CHANNEL)] });
    expect(canViewChannel(ctx(member(ANA), [parentPrivate, t]), THREAD)).toBe(false);
  });

  it('un hilo privado exige ser miembro del hilo…', () => {
    expect(canViewChannel(ctx(member(ANA, [R_DEV]), [parentPrivate, priv()]), PTHREAD)).toBe(false);
    expect(canViewChannel(ctx(member(ANA, [R_DEV]), [parentPrivate, priv([ANA])]), PTHREAD)).toBe(true);
  });

  it('…o MANAGE_THREADS en el padre', () => {
    expect(canViewChannel(ctx(member(BETO, [R_DEV, R_MOD]), [parentPrivate, priv([ANA])]), PTHREAD)).toBe(true);
  });

  it('ser miembro de un hilo privado no sirve si no se ve el padre', () => {
    expect(canViewChannel(ctx(member(ANA), [parentPrivate, priv([ANA])]), PTHREAD)).toBe(false);
  });

  it('administrador ve hilos privados sin ser miembro', () => {
    expect(canViewChannel(ctx(member(ANA, [R_ADMIN]), [parentPrivate, priv()]), PTHREAD)).toBe(true);
  });

  it('un hilo sin padre en el espejo (o con un hilo como padre) no se ve', () => {
    expect(canViewChannel(ctx(member(OWNER), [pub()]), THREAD)).toBe(false);
    const nested = channel('400000000000000099', [], { type: T.PUBLIC_THREAD, parentId: THREAD });
    expect(canViewChannel(ctx(member(OWNER), [parentPrivate, pub(), nested]), '400000000000000099')).toBe(false);
    expect(canViewChannel(ctx(member(OWNER), [channel(THREAD, [], { type: T.PUBLIC_THREAD, parentId: null })]), THREAD)).toBe(false);
  });

  it('escribir en un hilo usa SEND_MESSAGES_IN_THREADS, no SEND_MESSAGES', () => {
    const parent = channel(GENERAL, [role(GUILD, P.SEND_MESSAGES_IN_THREADS, P.SEND_MESSAGES)]);
    const t = channel(THREAD, [], { type: T.PUBLIC_THREAD, parentId: GENERAL });
    const c = ctx(member(ANA), [parent, t]);
    expect(channelAbilities(c, GENERAL).send).toBe(false);
    expect(channelAbilities(c, THREAD).send).toBe(true);
    // Y dentro del hilo conserva adjuntos (la regla implícita usa el permiso de hilos).
    expect(channelAbilities(c, THREAD).attach).toBe(true);
    expect(channelAbilities(c, GENERAL).attach).toBe(false);

    const noThreads = channel(GENERAL, [role(GUILD, 0n, P.SEND_MESSAGES_IN_THREADS)]);
    const c2 = ctx(member(ANA), [noThreads, t]);
    expect(channelAbilities(c2, GENERAL).send).toBe(true);
    expect(channelAbilities(c2, THREAD)).toMatchObject({ view: true, send: false, attach: false });
  });

  it('un hilo bloqueado solo admite a quien tiene MANAGE_THREADS; uno archivado sin bloquear sí admite', () => {
    const parent = channel(GENERAL);
    const locked = channel(THREAD, [], { type: T.PUBLIC_THREAD, parentId: GENERAL, locked: true, archived: true });
    expect(channelAbilities(ctx(member(ANA), [parent, locked]), THREAD).send).toBe(false);
    expect(channelAbilities(ctx(member(ANA, [R_MOD]), [parent, locked]), THREAD).send).toBe(true);
    const archived = channel(THREAD, [], { type: T.PUBLIC_THREAD, parentId: GENERAL, archived: true });
    expect(channelAbilities(ctx(member(ANA), [parent, archived]), THREAD).send).toBe(true);
  });

  it('el timeout también aplica dentro de los hilos', () => {
    const parent = channel(GENERAL);
    const t = channel(THREAD, [], { type: T.PUBLIC_THREAD, parentId: GENERAL });
    const c = ctx(member(ANA, [], '2026-11-11T13:00:00Z'), [parent, t]);
    expect(perms(c, THREAD)).toBe(P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY);
  });

  it('los hilos de anuncios heredan igual que los públicos', () => {
    const t = channel(THREAD, [], { type: T.ANNOUNCEMENT_THREAD, parentId: PRIVADO });
    expect(canViewChannel(ctx(member(ANA, [R_DEV]), [parentPrivate, t]), THREAD)).toBe(true);
    expect(canViewChannel(ctx(member(ANA), [parentPrivate, t]), THREAD)).toBe(false);
  });
});

describe('categorías', () => {
  const cat = (overwrites: DiscordPermissionOverwrite[] = []) => channel(CAT, overwrites, { type: T.GUILD_CATEGORY });

  it('los overwrites de la categoría NO se heredan en tiempo de cálculo: manda el canal', () => {
    // Categoría privada, canal NO sincronizado sin overwrites → visible.
    const c1 = ctx(member(ANA), [cat([role(GUILD, 0n, P.VIEW_CHANNEL)]), channel(GENERAL, [], { parentId: CAT })]);
    expect(canViewChannel(c1, GENERAL)).toBe(true);
    // Categoría abierta, canal que niega → oculto.
    const c2 = ctx(member(ANA), [cat(), channel(GENERAL, [role(GUILD, 0n, P.VIEW_CHANNEL)], { parentId: CAT })]);
    expect(canViewChannel(c2, GENERAL)).toBe(false);
  });

  it('una categoría se muestra solo si tiene al menos un canal visible', () => {
    const hidden = [role(GUILD, 0n, P.VIEW_CHANNEL)];
    const withVisible = ctx(member(ANA), [cat(), channel(GENERAL, [], { parentId: CAT }), channel(PRIVADO, hidden, { parentId: CAT })]);
    expect([...visibleChannelIds(withVisible)].sort()).toEqual([CAT, GENERAL].sort());

    const empty = ctx(member(ANA), [cat(), channel(PRIVADO, hidden, { parentId: CAT })]);
    expect(visibleChannelIds(empty).has(CAT)).toBe(false);

    const noChildren = ctx(member(ANA), [cat()]);
    expect(visibleChannelIds(noChildren).size).toBe(0);
  });

  it('un hilo visible no basta para mostrar una categoría (cuenta su canal padre)', () => {
    const parent = channel(GENERAL, [role(GUILD, 0n, P.VIEW_CHANNEL)], { parentId: CAT });
    const t = channel(THREAD, [], { type: T.PUBLIC_THREAD, parentId: GENERAL });
    const ids = visibleChannelIds(ctx(member(ANA), [cat(), parent, t]));
    expect(ids.size).toBe(0);
  });

  it('visibleChannelIds incluye hilos visibles y excluye los ocultos', () => {
    const parentPrivate = channel(PRIVADO, [role(GUILD, 0n, P.VIEW_CHANNEL), role(R_DEV, P.VIEW_CHANNEL)], { parentId: CAT });
    const t = channel(THREAD, [], { type: T.PUBLIC_THREAD, parentId: PRIVADO });
    const p = channel(PTHREAD, [], { type: T.PRIVATE_THREAD, parentId: PRIVADO, memberIds: [BETO] });
    const all = [cat(), channel(GENERAL, [], { parentId: CAT }), parentPrivate, t, p];
    expect([...visibleChannelIds(ctx(member(ANA), all))].sort()).toEqual([CAT, GENERAL].sort());
    expect([...visibleChannelIds(ctx(member(ANA, [R_DEV]), all))].sort()).toEqual([CAT, GENERAL, PRIVADO, THREAD].sort());
    expect([...visibleChannelIds(ctx(member(BETO, [R_DEV]), all))].sort()).toEqual([CAT, GENERAL, PRIVADO, THREAD, PTHREAD].sort());
  });

  it('acepta los canales como Map o como arreglo', () => {
    const list = [cat(), channel(GENERAL, [], { parentId: CAT })];
    const asMap = new Map(list.map((c) => [c.id, c]));
    expect(visibleChannelIds({ guild: guild(), member: member(ANA), channels: asMap })).toEqual(
      visibleChannelIds({ guild: guild(), member: member(ANA), channels: list }),
    );
  });
});

describe('isSyncedWithCategory', () => {
  const catOw = [role(GUILD, 0n, P.VIEW_CHANNEL), role(R_DEV, P.VIEW_CHANNEL)];
  const cat = channel(CAT, catOw, { type: T.GUILD_CATEGORY });

  it('mismos overwrites en cualquier orden → sincronizado', () => {
    expect(isSyncedWithCategory(channel(GENERAL, [...catOw].reverse(), { parentId: CAT }), cat)).toBe(true);
  });

  it('bits iguales escritos distinto ("0" vs "00") siguen sincronizados', () => {
    const ow = catOw.map((o) => ({ ...o, allow: o.allow === '0' ? '00' : o.allow }));
    expect(isSyncedWithCategory(channel(GENERAL, ow, { parentId: CAT }), cat)).toBe(true);
  });

  it('un overwrite de más, de menos o distinto → no sincronizado', () => {
    expect(isSyncedWithCategory(channel(GENERAL, [...catOw, user(ANA, P.VIEW_CHANNEL)], { parentId: CAT }), cat)).toBe(false);
    expect(isSyncedWithCategory(channel(GENERAL, [catOw[0]!], { parentId: CAT }), cat)).toBe(false);
    expect(isSyncedWithCategory(channel(GENERAL, [catOw[0]!, role(R_DEV, P.VIEW_CHANNEL | P.SEND_MESSAGES)], { parentId: CAT }), cat)).toBe(false);
  });

  it('sin categoría, o con otra categoría → false', () => {
    expect(isSyncedWithCategory(channel(GENERAL, catOw), cat)).toBe(false);
    expect(isSyncedWithCategory(channel(GENERAL, catOw, { parentId: CAT }), null)).toBe(false);
    expect(isSyncedWithCategory(channel(GENERAL, catOw, { parentId: '499999999999999999' }), cat)).toBe(false);
  });
});

describe('devsWhoCanView (destinatarios del tiempo real)', () => {
  const ch = channel(PRIVADO, [role(GUILD, 0n, P.VIEW_CHANNEL), role(R_DEV, P.VIEW_CHANNEL), user(BETO, 0n, P.VIEW_CHANNEL)]);
  const members = [
    { devId: 'dev-ana', userId: ANA, roles: [R_DEV] },
    { devId: 'dev-beto', userId: BETO, roles: [R_DEV] },
    { devId: 'dev-owner', userId: OWNER, roles: [] },
    { devId: 'dev-cliente', userId: '200000000000000009', roles: [R_CLIENTE] },
  ];

  it('solo los devs ligados que ven el canal', () => {
    expect(devsWhoCanView(guild(), [ch], members, PRIVADO).sort()).toEqual(['dev-ana', 'dev-owner']);
  });

  it('un canal desconocido no le llega a nadie (ni al dueño)', () => {
    expect(devsWhoCanView(guild(), [ch], members, '499999999999999999')).toEqual([]);
  });
});
