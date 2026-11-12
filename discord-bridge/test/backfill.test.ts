// Backfill con cursores, reconciliación tras una caída (nuevos, editados, borrados) y estructura.
import { beforeEach, describe, expect, it } from 'vitest';
import { fullSync, syncChannelMessages, syncStructure, writeMessages, type BackfillDeps } from '../src/backfill.js';
import { SupabaseMirrorStore } from '../src/store/supabase.js';
import { mapMessage } from '../src/map.js';
import { SerialQueue } from '../src/queue.js';
import type { DiscordApiMessage } from '../src/shared/api-types.js';
import type { DiscordBridgeNotice } from '../src/shared/types.js';
import { BASE_MS, FakeSource, GUILD, msg, textChannel, thread, user } from './fakes/discord.js';
import { MemoryStore } from './fakes/memory-store.js';

const CH = '300000000000000001';
const CH2 = '300000000000000002';

let store: MemoryStore;
let source: FakeSource;
let notices: DiscordBridgeNotice[];
let clock: number;

function deps(over: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    guildId: GUILD,
    store,
    source,
    lane: new SerialQueue(),
    notify: (...n) => notices.push(...n),
    backfillMessages: 150,
    catchupMaxPages: 50,
    now: () => clock,
    ...over,
  };
}

function series(channelId: string, from: number, count: number): DiscordApiMessage[] {
  return Array.from({ length: count }, (_, i) => msg(channelId, from + i));
}

beforeEach(() => {
  store = new MemoryStore();
  source = new FakeSource();
  notices = [];
  clock = BASE_MS + 10_000_000;
});

describe('mensajes por canal', () => {
  it('primer backfill: junta N hacia atrás y deja los cursores', async () => {
    const all = series(CH, 1, 250);
    source.addMessages(CH, all);
    const res = await syncChannelMessages(deps(), CH);
    expect(store.aliveIn(CH)).toHaveLength(150);
    expect(store.aliveIn(CH)[0]!.id).toBe(all[100]!.id); // los 150 más nuevos
    expect(res).toMatchObject({ inserted: 150, deleted: 0, complete: true });
    expect(store.sync.get(CH)).toMatchObject({
      newest_message_id: all[249]!.id,
      oldest_message_id: all[100]!.id,
      backfill_complete: true,
      last_error: null,
    });
    expect(notices).toEqual([{ kind: 'structure.changed', scope: 'channels', channelIds: [CH] }]);
  });

  it('canal con menos de 100 mensajes: completo en una página', async () => {
    source.addMessages(CH, series(CH, 1, 30));
    const res = await syncChannelMessages(deps(), CH);
    expect(res.complete).toBe(true);
    expect(source.calls.filter((c) => c.startsWith('messages:'))).toEqual([`messages:${CH}:latest`]);
  });

  it('backfill incremental: si se cortó a la mitad, sigue desde oldest sin repetir', async () => {
    const all = series(CH, 1, 400);
    source.addMessages(CH, all);
    // Primera corrida corta (se apaga tras la primera página hacia atrás).
    let stops = 0;
    await syncChannelMessages(deps({ backfillMessages: 300, shouldStop: () => stops++ > 0 }), CH);
    expect(store.sync.get(CH)!.backfill_complete).toBe(false);
    const firstOldest = store.sync.get(CH)!.oldest_message_id;
    expect(store.aliveIn(CH)).toHaveLength(200);
    source.calls = [];
    await syncChannelMessages(deps({ backfillMessages: 300 }), CH);
    expect(store.aliveIn(CH)).toHaveLength(300);
    expect(store.sync.get(CH)!.backfill_complete).toBe(true);
    expect(store.sync.get(CH)!.oldest_message_id).toBe(all[100]!.id);
    expect(firstOldest).toBe(all[200]!.id);
    // Pidió `before` (siguió el cursor), no volvió a bajar desde el principio.
    expect(source.calls).toContain(`messages:${CH}:before`);
  });

  it('caída corta: trae lo nuevo, las ediciones y los borrados', async () => {
    const first = series(CH, 1, 50);
    source.addMessages(CH, first);
    await syncChannelMessages(deps(), CH);
    expect(store.aliveIn(CH)).toHaveLength(50);

    // Mientras el puente estuvo caído: 20 nuevos, uno editado, uno borrado.
    source.addMessages(CH, series(CH, 1000, 20));
    const edited = { ...first[49]!, content: 'editado', edited_timestamp: '2026-01-01T05:00:00.000Z' };
    source.removeMessages(CH, [first[49]!.id, first[10]!.id]);
    source.addMessages(CH, [edited]);
    const res = await syncChannelMessages(deps(), CH);

    expect(store.aliveIn(CH)).toHaveLength(50 - 1 + 20);
    expect(store.messages.get(first[10]!.id)!.deleted_at).not.toBeNull();
    expect(store.messages.get(edited.id)).toMatchObject({ content: 'editado', edited_at: '2026-01-01T05:00:00.000Z', deleted_at: null });
    expect(res).toMatchObject({ inserted: 20, deleted: 1 });
  });

  it('caída larga: llena el hueco de más de 100 con `after` paginando', async () => {
    source.addMessages(CH, series(CH, 1, 50));
    await syncChannelMessages(deps(), CH);
    const later = series(CH, 1000, 250);
    source.addMessages(CH, later);
    source.calls = [];
    const res = await syncChannelMessages(deps(), CH);
    expect(store.aliveIn(CH)).toHaveLength(300);
    expect(res.inserted).toBe(250);
    expect(source.calls.filter((c) => c.endsWith(':after')).length).toBe(2);
    expect(store.sync.get(CH)!.newest_message_id).toBe(later[249]!.id);
  });

  it('caída larga: respeta el tope de páginas', async () => {
    source.addMessages(CH, series(CH, 1, 50));
    await syncChannelMessages(deps(), CH);
    source.addMessages(CH, series(CH, 1000, 450));
    await syncChannelMessages(deps({ catchupMaxPages: 1 }), CH);
    // 50 + 100 del hueco + los 100 más nuevos; quedan 250 sin traer (se registra en el log).
    expect(store.aliveIn(CH)).toHaveLength(250);
  });

  it('borrados mientras estuvo caído en un canal grande: solo dentro del rango de los últimos 100', async () => {
    const all = series(CH, 1, 300);
    source.addMessages(CH, all);
    await syncChannelMessages(deps({ backfillMessages: 300 }), CH);
    source.removeMessages(CH, [all[299]!.id, all[50]!.id]);
    const res = await syncChannelMessages(deps({ backfillMessages: 300 }), CH);
    expect(store.messages.get(all[299]!.id)!.deleted_at).not.toBeNull();
    // all[50] está fuera del rango de los 100 más nuevos: no se puede saber, no se toca.
    expect(store.messages.get(all[50]!.id)!.deleted_at).toBeNull();
    expect(res.deleted).toBe(1);
  });

  it('un mensaje que llegó en vivo después del pedido no se marca borrado', async () => {
    source.addMessages(CH, series(CH, 1, 10));
    // El pedido REST sale en `clock`; mientras tanto el gateway escribe un mensaje posterior que la
    // respuesta (ya armada) no incluye.
    clock = BASE_MS + 20_000_000;
    const live = msg(CH, 30_000);
    await store.upsertMessages([mapMessage(live, GUILD)]);
    await syncChannelMessages(deps(), CH);
    expect(store.messages.get(live.id)!.deleted_at).toBeNull();
  });

  it('conserva los usuarios de reacciones al re-escribir desde la REST', async () => {
    const m = msg(CH, 1, { reactions: [{ count: 1, emoji: { id: null, name: '👍' } }] });
    source.addMessages(CH, [m]);
    await syncChannelMessages(deps(), CH);
    store.messages.get(m.id)!.reactions[0].userIds = ['a'];
    await syncChannelMessages(deps(), CH);
    expect(store.messages.get(m.id)!.reactions[0].userIds).toEqual(['a']);
  });

  it('canal sin acceso: se registra y se sigue', async () => {
    source.noAccess.add(CH);
    const res = await syncChannelMessages(deps(), CH);
    expect(res.skipped).toBe('no_access');
    expect(store.sync.get(CH)!.last_error).toMatch(/no puede leer/);
  });

  it('nunca escribe dev_id: un mensaje de roz ya en el espejo lo conserva', async () => {
    const m = msg(CH, 1, { webhook_id: '700000000000000001', author: user('700000000000000001', { bot: true }) });
    source.addMessages(CH, [m]);
    store.messages.set(m.id, { id: m.id, channel_id: CH, dev_id: 'dev-ana', client_nonce: 'n', reactions: [], deleted_at: null, created_at: m.timestamp });
    await syncChannelMessages(deps(), CH);
    expect(store.messages.get(m.id)).toMatchObject({ dev_id: 'dev-ana', client_nonce: 'n', webhook_id: '700000000000000001' });
  });

  it('una página pedida antes de un MESSAGE_DELETE no revive el mensaje al escribirse después', async () => {
    const m = msg(CH, 1);
    // El borrado en vivo ya entró al carril; la página (vieja) del backfill llega detrás.
    store.messages.set(m.id, { id: m.id, channel_id: CH, reactions: [], deleted_at: '2026-01-01T00:00:00.000Z', created_at: m.timestamp });
    await writeMessages(deps(), [m]);
    expect(store.messages.get(m.id)!.deleted_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('SupabaseMirrorStore.upsertMessages nunca manda deleted_at, dev_id ni client_nonce', async () => {
    const sent: object[][] = [];
    const client = {
      from: () => ({
        upsert: async (rows: object[]) => {
          sent.push(rows);
          return { error: null };
        },
      }),
    };
    const real = new SupabaseMirrorStore('http://x', 'k', client as never);
    await real.upsertMessages([mapMessage(msg(CH, 1), GUILD)]);
    expect(sent[0]![0]).not.toHaveProperty('deleted_at');
    expect(sent[0]![0]).not.toHaveProperty('dev_id');
    expect(sent[0]![0]).not.toHaveProperty('client_nonce');
  });
});

describe('estructura', () => {
  beforeEach(() => {
    source.channels = [
      { id: '300000000000000090', type: 4, guild_id: GUILD, name: 'Trabajo', position: 0 },
      textChannel(CH, { position: 1, parent_id: '300000000000000090' }),
      textChannel(CH2, { position: 0 }),
      { id: '300000000000000091', type: 2, guild_id: GUILD, name: 'voz', position: 0 },
    ];
    source.roles.push({ id: '500000000000000001', name: 'dev', permissions: '1024' });
    source.members = [
      { user: user('200000000000000001'), roles: [GUILD, '500000000000000001'], joined_at: '2025-01-01T00:00:00Z' },
      { user: user('200000000000000002'), roles: [], joined_at: '2025-01-01T00:00:00Z' },
    ];
    source.emojis = [{ id: '900000000000000001', name: 'party' }];
  });

  it('espeja todo y devuelve los canales de texto + hilos activos a sincronizar', async () => {
    source.activeThreads = [thread('300000000000000010', CH), thread('300000000000000011', CH, { type: 12 })];
    source.threadMembers.set('300000000000000011', ['200000000000000001']);
    const res = await syncStructure(deps());
    expect(store.guilds.get(GUILD)).toMatchObject({ owner_id: '200000000000000009' });
    expect(store.roles.size).toBe(2);
    expect(store.channels.size).toBe(6);
    expect(store.members.get(`${GUILD}:200000000000000001`)!.roles).toEqual(['500000000000000001']);
    expect(store.emojis.size).toBe(1);
    expect(store.channels.get('300000000000000011')!.member_ids).toEqual(['200000000000000001']);
    // Texto por posición, luego hilos; la voz y la categoría no.
    expect(res.messageChannelIds).toEqual([CH2, CH, '300000000000000010', '300000000000000011']);
    expect(notices).toEqual([{ kind: 'structure.changed', scope: 'guild' }]);
  });

  it('reconcilia lo que cambió mientras estuvo caído', async () => {
    source.activeThreads = [thread('300000000000000010', CH), thread('300000000000000012', CH)];
    await syncStructure(deps());

    // Caído: se borra CH2, un rol, un emoji, se va un miembro; un hilo se archiva y otro se borra.
    source.channels = source.channels.filter((c) => c.id !== CH2);
    source.roles = source.roles.filter((r) => r.id !== '500000000000000001');
    source.emojis = [];
    source.members = source.members.slice(0, 1);
    source.activeThreads = [];
    source.archivedThreads.set(CH, [
      thread('300000000000000010', CH, { thread_metadata: { archived: true, locked: false, archive_timestamp: '2026-02-01T00:00:00.000Z' } }),
    ]);
    await syncStructure(deps());

    expect(store.channels.get(CH2)!.deleted_at).not.toBeNull();
    expect(store.roles.get('500000000000000001')!.deleted_at).not.toBeNull();
    expect(store.emojis.get('900000000000000001')!.deleted_at).not.toBeNull();
    expect(store.members.get(`${GUILD}:200000000000000002`)!.left_at).not.toBeNull();
    expect(store.members.get(`${GUILD}:200000000000000001`)!.left_at).toBeNull();
    expect(store.channels.get('300000000000000010')).toMatchObject({ archived: true, deleted_at: null });
    expect(store.channels.get('300000000000000012')!.deleted_at).not.toBeNull();
  });

  it('fullSync: estructura + mensajes de cada canal, con progreso', async () => {
    source.addMessages(CH, series(CH, 1, 5));
    source.addMessages(CH2, series(CH2, 1, 5));
    source.noAccess.add(CH2);
    const progress: Array<{ pending: number; done: number }> = [];
    const res = await fullSync(deps({ onProgress: (p) => progress.push(p) }));
    expect(res).toEqual({ channels: 2, failed: 0, stopped: false });
    expect(store.aliveIn(CH)).toHaveLength(5);
    expect(store.aliveIn(CH2)).toHaveLength(0);
    expect(progress.at(-1)).toEqual({ pending: 0, done: 2 });
  });
});
