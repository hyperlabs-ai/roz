// Eventos del gateway (payloads crudos) → espejo + avisos.
import { beforeEach, describe, expect, it } from 'vitest';
import { handleDispatch, type HandlerContext } from '../../src/bridge/handlers.js';
import { buildReplyPrefix } from '../../src/bridge/shared/reply.js';
import type { DiscordBridgeNotice } from '../../src/bridge/shared/types.js';
import { FakeSource, GUILD, msg, sf, textChannel, thread, user } from './fakes/discord.js';
import { MemoryStore } from './fakes/memory-store.js';

const CH = '300000000000000001';
const CAT = '300000000000000099';
const WEBHOOK = '700000000000000001';

let store: MemoryStore;
let source: FakeSource;
let notices: DiscordBridgeNotice[];
let ctx: HandlerContext;
const run = (t: string, d: unknown) => handleDispatch(ctx, t, d);

beforeEach(() => {
  store = new MemoryStore();
  source = new FakeSource();
  notices = [];
  ctx = {
    guildId: GUILD,
    store,
    source,
    notify: (...n) => {
      store.ops.push('notify');
      notices.push(...n);
    },
  };
});

describe('filtro de servidor', () => {
  it('ignora otros servidores, DMs y eventos desconocidos', async () => {
    expect(await run('MESSAGE_CREATE', { ...msg(CH, 1), guild_id: '999999999999999999' })).toBe(false);
    expect(await run('MESSAGE_CREATE', { ...msg(CH, 1), guild_id: undefined })).toBe(false);
    expect(await run('TYPING_START', { guild_id: GUILD })).toBe(false);
    expect(store.messages.size).toBe(0);
    expect(notices).toEqual([]);
  });
});

describe('mensajes', () => {
  beforeEach(async () => {
    await store.upsertChannels([{ id: CH, guild_id: GUILD, type: 0 }]);
    store.ops = [];
  });

  it('MESSAGE_CREATE escribe la fila, actualiza el canal y DESPUÉS avisa', async () => {
    const m = msg(CH, 10);
    expect(await run('MESSAGE_CREATE', m)).toBe(true);
    expect(store.messages.get(m.id)).toMatchObject({ content: 'mensaje 10', channel_id: CH, dev_id: null });
    expect(store.channels.get(CH)!.last_message_id).toBe(m.id);
    expect(notices).toEqual([{ kind: 'message.created', channelId: CH, messageId: m.id }]);
    expect(store.ops.indexOf('upsertMessages')).toBeLessThan(store.ops.indexOf('notify'));
  });

  it('eco del webhook de roz: si roz escribió primero, el puente no pisa dev_id ni client_nonce', async () => {
    const target = sf(1);
    const content = buildReplyPrefix({ guildId: GUILD, channelId: CH, messageId: target, authorId: '200000000000000001' }) + 'hola';
    const m = msg(CH, 10, { webhook_id: WEBHOOK, author: user(WEBHOOK, { username: 'Ana (roz)', bot: true }), content });
    // roz upsertea su fila con lo que solo él sabe.
    store.messages.set(m.id, { id: m.id, channel_id: CH, dev_id: 'dev-ana', client_nonce: 'n1', reply_to_id: target, reactions: [], deleted_at: null });
    await run('MESSAGE_CREATE', m);
    expect(store.messages.get(m.id)).toMatchObject({ dev_id: 'dev-ana', client_nonce: 'n1', reply_to_id: target, webhook_id: WEBHOOK, content });
    expect(notices[0]).toEqual({ kind: 'message.created', channelId: CH, messageId: m.id });
  });

  it('eco del webhook: si el puente llega primero, la fila queda lista para que roz agregue dev_id', async () => {
    const m = msg(CH, 10, { webhook_id: WEBHOOK, author: user(WEBHOOK, { bot: true }) });
    await run('MESSAGE_CREATE', m);
    expect(store.messages.get(m.id)).toMatchObject({ dev_id: null, client_nonce: null });
    // roz upsertea después con dev_id: el contenido del puente se mantiene.
    Object.assign(store.messages.get(m.id)!, { dev_id: 'dev-ana', client_nonce: 'n1' });
    expect(store.messages.get(m.id)).toMatchObject({ dev_id: 'dev-ana', content: 'mensaje 10' });
  });

  it('MESSAGE_UPDATE parcial no pisa contenido; completo sí actualiza', async () => {
    const m = msg(CH, 10);
    await run('MESSAGE_CREATE', m);
    notices = [];
    await run('MESSAGE_UPDATE', { id: m.id, channel_id: CH, guild_id: GUILD, embeds: [{ title: 'preview' }] });
    expect(store.messages.get(m.id)).toMatchObject({ content: 'mensaje 10' });
    expect(store.messages.get(m.id)!.embeds[0].title).toBe('preview');
    await run('MESSAGE_UPDATE', { ...m, content: 'editado', edited_timestamp: '2026-01-01T02:00:00.000Z' });
    expect(store.messages.get(m.id)).toMatchObject({ content: 'editado', edited_at: '2026-01-01T02:00:00.000Z' });
    expect(notices).toEqual([
      { kind: 'message.updated', channelId: CH, messageId: m.id },
      { kind: 'message.updated', channelId: CH, messageId: m.id },
    ]);
  });

  it('MESSAGE_UPDATE de un mensaje fuera del espejo lo trae por REST', async () => {
    const old = msg(CH, 1, { content: 'viejo editado' });
    source.addMessages(CH, [old]);
    await run('MESSAGE_UPDATE', { id: old.id, channel_id: CH, guild_id: GUILD, content: 'viejo editado' });
    expect(source.calls).toContain(`message:${old.id}`);
    expect(store.messages.get(old.id)).toMatchObject({ content: 'viejo editado' });
  });

  it('MESSAGE_DELETE y DELETE_BULK: borrado suave y aviso solo de lo que cambió', async () => {
    const a = msg(CH, 1);
    const b = msg(CH, 2);
    await run('MESSAGE_CREATE', a);
    await run('MESSAGE_CREATE', b);
    notices = [];
    await run('MESSAGE_DELETE', { id: a.id, channel_id: CH, guild_id: GUILD });
    expect(store.messages.get(a.id)!.deleted_at).not.toBeNull();
    await run('MESSAGE_DELETE_BULK', { ids: [a.id, b.id, '1'], channel_id: CH, guild_id: GUILD });
    expect(notices).toEqual([
      { kind: 'message.deleted', channelId: CH, messageIds: [a.id] },
      { kind: 'message.deleted', channelId: CH, messageIds: [b.id] },
    ]);
    // Repetido: ya no cambia nada → sin aviso.
    expect(await run('MESSAGE_DELETE', { id: a.id, channel_id: CH, guild_id: GUILD })).toBe(false);
  });

  it('respuesta en un hilo: suma message_count y avisa al mensaje de origen', async () => {
    const starter = msg(CH, 1);
    await run('MESSAGE_CREATE', starter);
    await run('THREAD_CREATE', thread(starter.id, CH));
    notices = [];
    await run('MESSAGE_CREATE', msg(starter.id, 5));
    expect(store.channels.get(starter.id)!.message_count).toBe(1);
    expect(notices).toContainEqual({ kind: 'message.updated', channelId: CH, messageId: starter.id });
  });
});

describe('reacciones', () => {
  const m = msg(CH, 10);
  beforeEach(async () => {
    await run('MESSAGE_CREATE', m);
    notices = [];
  });
  const ev = (userId: string, emoji = { id: null, name: '👍' }) => ({ guild_id: GUILD, channel_id: CH, message_id: m.id, user_id: userId, emoji });

  it('ADD/REMOVE llevan la cuenta y los usuarios', async () => {
    await run('MESSAGE_REACTION_ADD', ev('a'));
    await run('MESSAGE_REACTION_ADD', ev('b'));
    expect(store.messages.get(m.id)!.reactions[0]).toMatchObject({ count: 2, userIds: ['a', 'b'] });
    await run('MESSAGE_REACTION_REMOVE', ev('a'));
    expect(store.messages.get(m.id)!.reactions[0]).toMatchObject({ count: 1, userIds: ['b'] });
    expect(notices.every((n) => n.kind === 'message.updated')).toBe(true);
  });

  it('ADD repetido no escribe ni avisa', async () => {
    await run('MESSAGE_REACTION_ADD', ev('a'));
    notices = [];
    expect(await run('MESSAGE_REACTION_ADD', ev('a'))).toBe(false);
    expect(notices).toEqual([]);
  });

  it('REMOVE_ALL y REMOVE_EMOJI', async () => {
    await run('MESSAGE_REACTION_ADD', ev('a'));
    await run('MESSAGE_REACTION_ADD', ev('a', { id: '900000000000000001', name: 'party' } as never));
    await run('MESSAGE_REACTION_REMOVE_EMOJI', { guild_id: GUILD, channel_id: CH, message_id: m.id, emoji: { id: null, name: '👍' } });
    expect(store.messages.get(m.id)!.reactions).toHaveLength(1);
    await run('MESSAGE_REACTION_REMOVE_ALL', { guild_id: GUILD, channel_id: CH, message_id: m.id });
    expect(store.messages.get(m.id)!.reactions).toEqual([]);
  });

  it('reacción a un mensaje viejo (fuera del espejo): se trae entero y se anota el usuario', async () => {
    const old = msg(CH, 1, { reactions: [{ count: 3, emoji: { id: null, name: '🔥' } }] });
    source.addMessages(CH, [old]);
    await run('MESSAGE_REACTION_ADD', { guild_id: GUILD, channel_id: CH, message_id: old.id, user_id: 'z', emoji: { id: null, name: '🔥' } });
    expect(store.messages.get(old.id)!.reactions[0]).toMatchObject({ count: 3, userIds: ['z'] });
  });
});

describe('estructura en tiempo real', () => {
  it('canal creado / renombrado / movido / con permisos nuevos', async () => {
    await run('CHANNEL_CREATE', textChannel(CH, { name: 'general', parent_id: CAT }));
    expect(store.sync.get(CH)).toMatchObject({ backfill_complete: true });
    await run('CHANNEL_UPDATE', textChannel(CH, { name: 'anuncios', position: 2, parent_id: null, permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: '1024' }] }));
    expect(store.channels.get(CH)).toMatchObject({ name: 'anuncios', position: 2, parent_id: null });
    expect(store.channels.get(CH)!.overwrites).toEqual([{ id: GUILD, type: 0, allow: '0', deny: '1024' }]);
    expect(notices).toEqual([
      { kind: 'structure.changed', scope: 'channels', channelIds: [CH] },
      { kind: 'structure.changed', scope: 'channels', channelIds: [CH] },
    ]);
  });

  it('categoría borrada → deleted_at; canal borrado arrastra sus hilos', async () => {
    await run('CHANNEL_CREATE', { id: CAT, type: 4, guild_id: GUILD, name: 'Trabajo' });
    await run('CHANNEL_CREATE', textChannel(CH));
    await run('THREAD_CREATE', thread('300000000000000002', CH));
    notices = [];
    await run('CHANNEL_DELETE', { id: CH, type: 0, guild_id: GUILD });
    expect(store.channels.get(CH)!.deleted_at).not.toBeNull();
    expect(store.channels.get('300000000000000002')!.deleted_at).not.toBeNull();
    expect(notices).toEqual([{ kind: 'structure.changed', scope: 'channels', channelIds: [CH, '300000000000000002'] }]);
    await run('CHANNEL_DELETE', { id: CAT, type: 4, guild_id: GUILD });
    expect(store.channels.get(CAT)!.deleted_at).not.toBeNull();
  });

  it('hilo creado desde un mensaje enlaza el mensaje (thread_id) y el hilo (starter)', async () => {
    await run('CHANNEL_CREATE', textChannel(CH));
    const m = msg(CH, 1);
    await run('MESSAGE_CREATE', m);
    notices = [];
    await run('THREAD_CREATE', { ...thread(m.id, CH), newly_created: true });
    expect(store.messages.get(m.id)!.thread_id).toBe(m.id);
    expect(store.channels.get(m.id)).toMatchObject({ starter_message_id: m.id, parent_id: CH });
    expect(notices).toContainEqual({ kind: 'message.updated', channelId: CH, messageId: m.id });
    expect(notices).toContainEqual({ kind: 'structure.changed', scope: 'threads', channelIds: [m.id, CH] });
    // Borrar el hilo desenlaza el mensaje.
    notices = [];
    await run('THREAD_DELETE', { id: m.id, guild_id: GUILD, parent_id: CH, type: 11 });
    expect(store.messages.get(m.id)!.thread_id).toBeNull();
    expect(notices).toContainEqual({ kind: 'message.updated', channelId: CH, messageId: m.id });
  });

  it('hilo privado: miembros al descubrirlo y con THREAD_MEMBERS_UPDATE', async () => {
    const T = '300000000000000003';
    source.threadMembers.set(T, ['a', 'b']);
    await run('THREAD_CREATE', thread(T, CH, { type: 12 }));
    expect(store.channels.get(T)!.member_ids).toEqual(['a', 'b']);
    await run('THREAD_MEMBERS_UPDATE', { id: T, guild_id: GUILD, added_members: [{ user_id: 'c' }], removed_member_ids: ['a'] });
    expect(store.channels.get(T)!.member_ids).toEqual(['b', 'c']);
  });

  it('hilo archivado por THREAD_UPDATE', async () => {
    const T = '300000000000000004';
    await run('THREAD_CREATE', thread(T, CH));
    await run('THREAD_UPDATE', thread(T, CH, { thread_metadata: { archived: true, locked: false, archive_timestamp: '2026-03-01T00:00:00.000Z' } }));
    expect(store.channels.get(T)).toMatchObject({ archived: true, archived_at: '2026-03-01T00:00:00.000Z' });
  });

  it('THREAD_LIST_SYNC guarda todos los hilos', async () => {
    await run('THREAD_LIST_SYNC', { guild_id: GUILD, threads: [thread('300000000000000005', CH), thread('300000000000000006', CH)] });
    expect(store.channels.size).toBe(2);
  });

  it('roles: crear, editar permisos, borrar', async () => {
    await run('GUILD_ROLE_CREATE', { guild_id: GUILD, role: { id: '500000000000000001', name: 'dev', permissions: '0' } });
    await run('GUILD_ROLE_UPDATE', { guild_id: GUILD, role: { id: '500000000000000001', name: 'dev', permissions: '1024' } });
    expect(store.roles.get('500000000000000001')!.permissions).toBe('1024');
    await run('GUILD_ROLE_DELETE', { guild_id: GUILD, role_id: '500000000000000001' });
    expect(store.roles.get('500000000000000001')!.deleted_at).not.toBeNull();
    expect(notices.every((n) => n.kind === 'structure.changed' && n.scope === 'roles')).toBe(true);
  });

  it('miembros: alta, cambio de roles, baja y reingreso', async () => {
    const member = { guild_id: GUILD, user: user('200000000000000001'), roles: ['500000000000000001'], joined_at: '2025-01-01T00:00:00Z' };
    await run('GUILD_MEMBER_ADD', member);
    await run('GUILD_MEMBER_UPDATE', { ...member, roles: [] });
    expect(store.members.get(`${GUILD}:200000000000000001`)!.roles).toEqual([]);
    await run('GUILD_MEMBER_REMOVE', { guild_id: GUILD, user: user('200000000000000001') });
    expect(store.members.get(`${GUILD}:200000000000000001`)!.left_at).not.toBeNull();
    await run('GUILD_MEMBER_ADD', member);
    expect(store.members.get(`${GUILD}:200000000000000001`)!.left_at).toBeNull();
    expect(notices[0]).toEqual({ kind: 'structure.changed', scope: 'members', userIds: ['200000000000000001'] });
  });

  it('emojis: lo que ya no viene en la lista se borra', async () => {
    await run('GUILD_EMOJIS_UPDATE', { guild_id: GUILD, emojis: [{ id: '1', name: 'a' }, { id: '2', name: 'b' }] });
    await run('GUILD_EMOJIS_UPDATE', { guild_id: GUILD, emojis: [{ id: '2', name: 'b2' }] });
    expect(store.emojis.get('1')!.deleted_at).not.toBeNull();
    expect(store.emojis.get('2')).toMatchObject({ name: 'b2', deleted_at: null });
  });

  it('guild: cambio de dueño se refleja; caída (unavailable) no borra', async () => {
    await run('GUILD_UPDATE', { id: GUILD, name: 'Hyper', owner_id: '1', icon: null });
    await run('GUILD_UPDATE', { id: GUILD, name: 'Hyper', owner_id: '2', icon: null });
    expect(store.guilds.get(GUILD)!.owner_id).toBe('2');
    expect(await run('GUILD_DELETE', { id: GUILD, unavailable: true })).toBe(false);
    expect(store.guilds.get(GUILD)!.deleted_at).toBeNull();
    await run('GUILD_DELETE', { id: GUILD });
    expect(store.guilds.get(GUILD)!.deleted_at).not.toBeNull();
  });
});
