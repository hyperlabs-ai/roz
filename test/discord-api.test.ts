import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  ANA,
  APP,
  BETO,
  G,
  GENERAL,
  HOOK,
  HOOK_NEW,
  SECRET,
  THREAD,
  U_ANA,
  U_BETO,
  U_CARLA,
  VOICE,
  createDiscordDb,
  fakeDiscord,
  msgRow,
  seedGuild,
  webhookMessage,
  type DiscordCall,
} from './discord-fixture.js';

// API de roz sobre Discord (contrato §B y §D) con la base y Discord simulados: permisos (404 a lo
// que no se ve), envío por webhook (nuevo, reutilizado, guardado, 10015 → recrear una vez), eco en
// cualquier orden, edición/borrado solo de lo propio, paginación y vistas.

const h = vi.hoisted(() => {
  // Mismas variables que discordTestEnv() (fixture): vi.hoisted corre antes de cualquier import.
  process.env.ROZ_DISCORD_CHAT = 'true';
  process.env.DISCORD_BOT_TOKEN = 'bot-token-SECRETO';
  process.env.DISCORD_GUILD_ID = '100000000000000001';
  process.env.DISCORD_CLIENT_ID = '900000000000000001';
  process.env.DISCORD_CLIENT_SECRET = 'client-secret';
  process.env.DISCORD_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/discord/callback';
  process.env.DISCORD_API_URL = 'https://discord.test/api/v10';
  process.env.ROZ_BRIDGE_SECRET = 'bridge-secret';
  process.env.ROZ_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  return {
    fake: null as any,
    broadcasts: [] as { devIds: string[]; event: string; payload: any }[],
    background: [] as Promise<unknown>[],
  };
});

vi.mock('../src/db/supabase.js', () => ({ db: () => h.fake, dbPublic: () => h.fake }));
vi.mock('../src/chat/realtime.js', () => ({
  devTopic: (id: string) => `chat:dev:${id}`,
  broadcastToDevs: async (devIds: string[], event: string, payload: any) => {
    h.broadcasts.push({ devIds: [...devIds].sort(), event, payload });
  },
}));
vi.mock('../src/utils/background.js', () => ({
  inBackground: (task: () => Promise<unknown>, onError?: (e: unknown) => void) => {
    h.background.push(Promise.resolve().then(task).catch((e) => onError?.(e)));
  },
}));
vi.mock('../src/dashboard/queries.js', () => ({
  createTask: async (input: { name: string }) => {
    h.fake.table('work_item').push({ id: 'wi-1', identifier: 'POR-7', name: input.name, status: 'planificada', url: null, discord_message_id: null });
    return { id: 'wi-1', identifier: 'POR-7' };
  },
  getTicketById: async (id: string) => ({ id, identifier: 'POR-7' }),
}));
vi.mock('../src/linear/issues.js', () => ({ createIssueFromTicket: async () => ({}) }));

import { encryptSecret, decryptSecret } from '../src/utils/crypto.js';
import { __resetDiscordRateLimits } from '../src/adapters/discord.js';
import { loadViewer } from '../src/discord/access.js';
import { deleteDiscordMessage, editDiscordMessage, listChannelMessages, sendDiscordMessage, rowFromSend } from '../src/discord/messages.js';
import { buildChannelTree, plainExcerpt } from '../src/discord/views.js';
import { normalizeApiMessage } from '../src/discord/normalize.js';
import { discordRoutes } from '../src/routes/discord.js';
import { config } from '../src/config.js';
import type { RozContext } from '../src/types/hono.js';

async function settle() {
  while (h.background.length) await Promise.all(h.background.splice(0));
}

beforeEach(() => {
  h.fake = createDiscordDb();
  h.broadcasts = [];
  h.background = [];
  seedGuild(h.fake);
  __resetDiscordRateLimits();
});
afterEach(() => vi.unstubAllGlobals());

/** Discord que acepta todo: lista vacía de webhooks, crea HOOK_NEW, ejecuta y devuelve el mensaje. */
function happyDiscord(extra: ((c: DiscordCall) => { status: number; body?: unknown } | undefined)[] = []) {
  return fakeDiscord(
    ...extra,
    (c) => (c.method === 'GET' && /^\/channels\/\d+\/webhooks$/.test(c.path) ? { status: 200, body: [] } : undefined),
    (c) =>
      c.method === 'POST' && /^\/channels\/\d+\/webhooks$/.test(c.path)
        ? { status: 200, body: { id: HOOK_NEW, type: 1, token: 'tok-new', name: 'roz', application_id: APP, channel_id: GENERAL } }
        : undefined,
    (c) => {
      const m = /^\/webhooks\/(\d+)\/[^/]+$/.exec(c.path);
      return c.method === 'POST' && m ? { status: 200, body: webhookMessage(c, m[1]!) } : undefined;
    },
  );
}

describe('permisos y vínculo (§B.0)', () => {
  it('sin cuenta ligada → 403 DISCORD_NOT_LINKED; miembro que se fue → 403 DISCORD_NOT_MEMBER', async () => {
    h.fake.tables.discord_link = h.fake.table('discord_link').filter((l: any) => l.dev_id !== ANA);
    await expect(loadViewer(ANA)).rejects.toMatchObject({ code: 'DISCORD_NOT_LINKED', status: 403 });
    (h.fake.table('discord_member').find((m: any) => m.user_id === U_BETO) as any).left_at = '2026-11-01T00:00:00Z';
    await expect(loadViewer(BETO)).rejects.toMatchObject({ code: 'DISCORD_NOT_MEMBER', status: 403 });
  });

  it('un canal que el dev no ve responde 404 (leer y escribir), aunque exista', async () => {
    const ana = await loadViewer(ANA);
    await expect(listChannelMessages(ana, SECRET)).rejects.toMatchObject({ status: 404 });
    await expect(sendDiscordMessage(ana, SECRET, { content: 'hola' })).rejects.toMatchObject({ status: 404 });
    const beto = await loadViewer(BETO);
    await expect(listChannelMessages(beto, SECRET)).resolves.toMatchObject({ messages: [] });
  });

  it('árbol: Ana no ve #secreto, Beto sí; voz listada como no soportada; hilos activos colgando del canal', async () => {
    const ana = await loadViewer(ANA);
    const tree = buildChannelTree(ana.snap, ana.ctx);
    expect(tree.uncategorized).toEqual([]);
    expect(tree.categories).toHaveLength(1);
    const ids = tree.categories[0]!.channels.map((c) => c.id);
    expect(ids).toEqual([GENERAL, VOICE]);
    const general = tree.categories[0]!.channels[0]!;
    expect(general.supported).toBe(true);
    expect(general.syncedWithCategory).toBe(true); // ambos sin overwrites
    expect(general.threads.map((t) => t.id)).toEqual([THREAD]);
    expect(general.abilities).toEqual({ send: true, attach: true, mentionEveryone: false, readHistory: true });
    expect(tree.categories[0]!.channels[1]!.supported).toBe(false);

    const beto = await loadViewer(BETO);
    expect(buildChannelTree(beto.snap, beto.ctx).categories[0]!.channels.map((c) => c.id)).toEqual([GENERAL, SECRET, VOICE]);
  });
});

describe('enviar (§B.4)', () => {
  it('primer envío: crea el webhook, guarda el token CIFRADO, publica con nombre y foto del dev', async () => {
    const calls = happyDiscord();
    const ana = await loadViewer(ANA);
    const view = await sendDiscordMessage(ana, GENERAL, { content: 'hola <@200000000000000003> y <@200000000000000999>', clientNonce: 'n1' });
    await settle();

    const exec = calls.find((c) => c.method === 'POST' && c.path.startsWith('/webhooks/'))!;
    expect(exec.path).toBe(`/webhooks/${HOOK_NEW}/tok-new`);
    expect(exec.query.get('wait')).toBe('true');
    expect(exec.json.username).toBe('Ana Pérez');
    expect(exec.json.avatar_url).toBe('https://github.com/anagh.png?size=128');
    // Solo suena el miembro activo mencionado; el id desconocido y @everyone no.
    expect(exec.json.allowed_mentions).toEqual({ parse: [], users: [U_CARLA], roles: [], replied_user: false });

    const hook = h.fake.table('discord_webhook')[0] as any;
    expect(hook.webhook_id).toBe(HOOK_NEW);
    expect(hook.token_enc).not.toContain('tok-new');
    expect(decryptSecret(hook.token_enc)).toBe('tok-new');

    expect(view.fromRoz).toBe(true);
    expect(view.clientNonce).toBe('n1');
    expect(view.author).toMatchObject({ displayName: 'Ana Pérez', devId: ANA, webhook: true, avatarUrl: 'https://github.com/anagh.png?size=96' });
    const row = h.fake.table('discord_message').find((r: any) => r.id === view.id) as any;
    expect(row.dev_id).toBe(ANA);

    // Tiempo real solo a quien ve #general (ambos).
    expect(h.broadcasts).toEqual([{ devIds: [ANA, BETO].sort(), event: 'discord.message.created', payload: { channelId: GENERAL, message: view } }]);
  });

  it('reutiliza un webhook "roz" existente de nuestra app (no crea otro)', async () => {
    const calls = fakeDiscord(
      (c) =>
        c.method === 'GET' && c.path === `/channels/${GENERAL}/webhooks`
          ? {
              status: 200,
              body: [
                { id: '700000000000000009', type: 1, token: 'ajeno', name: 'roz', application_id: '999999999999999999', channel_id: GENERAL },
                { id: HOOK, type: 1, token: 'tok-viejo', name: 'roz', application_id: APP, channel_id: GENERAL },
              ],
            }
          : undefined,
      (c) => (c.method === 'POST' && c.path.startsWith(`/webhooks/${HOOK}/`) ? { status: 200, body: webhookMessage(c, HOOK) } : undefined),
    );
    const ana = await loadViewer(ANA);
    await sendDiscordMessage(ana, GENERAL, { content: 'hola' });
    expect(calls.some((c) => c.method === 'POST' && c.path === `/channels/${GENERAL}/webhooks`)).toBe(false);
    expect(calls.at(-1)!.path).toBe(`/webhooks/${HOOK}/tok-viejo`);
  });

  it('10015 (alguien borró el webhook en Discord): olvida, recrea UNA vez y reintenta', async () => {
    h.fake.table('discord_webhook').push({ channel_id: GENERAL, guild_id: G, webhook_id: HOOK, token_enc: encryptSecret('tok-borrado'), name: 'roz' });
    const calls = happyDiscord([
      (c) => (c.method === 'POST' && c.path.startsWith(`/webhooks/${HOOK}/`) ? { status: 404, body: { code: 10015, message: 'Unknown Webhook' } } : undefined),
    ]);
    const ana = await loadViewer(ANA);
    const view = await sendDiscordMessage(ana, GENERAL, { content: 'otra vez' });
    const execs = calls.filter((c) => c.method === 'POST' && c.path.startsWith('/webhooks/'));
    expect(execs.map((c) => c.path)).toEqual([`/webhooks/${HOOK}/tok-borrado`, `/webhooks/${HOOK_NEW}/tok-new`]);
    expect((h.fake.table('discord_webhook') as any[]).map((w) => w.webhook_id)).toEqual([HOOK_NEW]);
    expect(view.fromRoz).toBe(true);
  });

  it('sin Manage Webhooks → 502 DISCORD_BOT_PERMISSIONS; 429 largo → 503 DISCORD_UNAVAILABLE con retryAfterSec', async () => {
    fakeDiscord(() => ({ status: 403, body: { code: 50013, message: 'Missing Permissions' } }));
    const ana = await loadViewer(ANA);
    await expect(sendDiscordMessage(ana, GENERAL, { content: 'x' })).rejects.toMatchObject({ code: 'DISCORD_BOT_PERMISSIONS', status: 502 });

    h.fake.table('discord_webhook').push({ channel_id: GENERAL, guild_id: G, webhook_id: HOOK, token_enc: encryptSecret('t'), name: 'roz' });
    fakeDiscord(() => ({ status: 429, body: { retry_after: 30, global: false } }));
    await expect(sendDiscordMessage(ana, GENERAL, { content: 'x' })).rejects.toMatchObject({
      code: 'DISCORD_UNAVAILABLE',
      status: 503,
      details: { retryAfterSec: 30 },
    });
  });

  it('respuesta: antepone la línea de roz mencionando al autor citado, que sí suena; la vista la quita y cita', async () => {
    h.fake.table('discord_message').push(msgRow('500000000000000777', { content: 'pregunta **original**' }));
    const calls = happyDiscord();
    const ana = await loadViewer(ANA);
    const view = await sendDiscordMessage(ana, GENERAL, { content: 'respuesta', replyToId: '500000000000000777' });
    const exec = calls.find((c) => c.path.startsWith('/webhooks/'))!;
    expect(exec.json.content).toBe(`-# ↪ <@${U_CARLA}> · https://discord.com/channels/${G}/${GENERAL}/500000000000000777\nrespuesta`);
    expect(exec.json.allowed_mentions.users).toEqual([U_CARLA]);
    expect(view.content).toBe('respuesta');
    expect(view.replyTo).toMatchObject({ id: '500000000000000777', excerpt: 'pregunta original', deleted: false });
    expect(view.replyTo!.author!.displayName).toBe('Carla G');
  });

  it('en un hilo usa el webhook del PADRE con thread_id; canal de voz → 400; vacío → 400; >2000 → 400', async () => {
    const calls = happyDiscord();
    const ana = await loadViewer(ANA);
    const view = await sendDiscordMessage(ana, THREAD, { content: 'en el hilo' });
    const exec = calls.find((c) => c.path.startsWith('/webhooks/'))!;
    expect(exec.query.get('thread_id')).toBe(THREAD);
    expect(calls.find((c) => c.method === 'GET')!.path).toBe(`/channels/${GENERAL}/webhooks`);
    expect(view.channelId).toBe(THREAD);
    expect(view.fromRoz).toBe(true);

    await expect(sendDiscordMessage(ana, VOICE, { content: 'x' })).rejects.toMatchObject({ code: 'DISCORD_CHANNEL_UNSUPPORTED', status: 400 });
    await expect(sendDiscordMessage(ana, GENERAL, { content: '   ' })).rejects.toMatchObject({ status: 400 });
    await expect(sendDiscordMessage(ana, GENERAL, { content: 'x'.repeat(2001) })).rejects.toMatchObject({ status: 400 });
  });

  it('adjuntos: descarga de Storage, multipart, ata la subida al mensaje y borra la copia', async () => {
    const calls = happyDiscord();
    const ana = await loadViewer(ANA);
    h.fake.table('discord_upload').push({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      dev_id: ANA,
      channel_id: GENERAL,
      bucket: 'roz-chat',
      storage_path: `discord/${ANA}/u1/plano.png`,
      name: 'plano.png',
      content_type: 'image/png',
      size: 3,
      completed_at: '2026-11-11T12:00:00Z',
      message_id: null,
    });
    h.fake.objects.set(`roz-chat/discord/${ANA}/u1/plano.png`, { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' });
    const view = await sendDiscordMessage(ana, GENERAL, { content: '', uploadIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] });
    const exec = calls.find((c) => c.path.startsWith('/webhooks/'))!;
    expect(exec.form).toBeInstanceOf(FormData);
    expect((exec.form!.get('files[0]') as File).size).toBe(3);
    expect(view.attachments.map((a) => a.filename)).toEqual(['plano.png']);
    expect((h.fake.table('discord_upload')[0] as any).message_id).toBe(view.id);
    expect(h.fake.objects.size).toBe(0);

    // Una subida de OTRO dev no se puede mandar.
    h.fake.table('discord_upload').push({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', dev_id: BETO, channel_id: GENERAL, completed_at: 'x', message_id: null, bucket: 'roz-chat', storage_path: 'p', name: 'n' });
    await expect(sendDiscordMessage(ana, GENERAL, { content: '', uploadIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] })).rejects.toMatchObject({ status: 400 });
  });
});

describe('eco del webhook (§D): misma fila, llegue primero quien llegue', () => {
  const api = (over: Record<string, unknown> = {}) => ({
    id: '500000000000000555',
    channel_id: GENERAL,
    guild_id: G,
    type: 0,
    author: { id: HOOK, username: 'Ana Pérez', bot: true },
    content: 'hola',
    timestamp: '2026-11-11T13:00:00.000Z',
    edited_timestamp: null,
    webhook_id: HOOK,
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    pinned: false,
    ...over,
  });

  async function bridgeWrites() {
    // El puente: normalizeApiMessage SIN dev_id ni client_nonce.
    await h.fake.from('discord_message').upsert(normalizeApiMessage(api() as any, G), { onConflict: 'id' });
  }
  async function rozWrites() {
    await h.fake.from('discord_message').upsert(rowFromSend(api() as any, G, { devId: ANA, clientNonce: 'n9', replyToId: null }), { onConflict: 'id' });
  }

  it('puente primero, roz después → una fila con dev_id y nonce', async () => {
    await bridgeWrites();
    await rozWrites();
    const rows = h.fake.table('discord_message').filter((r: any) => r.id === '500000000000000555');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dev_id: ANA, client_nonce: 'n9', content: 'hola' });
  });

  it('roz primero, puente después → el puente no borra dev_id ni nonce', async () => {
    await rozWrites();
    await bridgeWrites();
    const rows = h.fake.table('discord_message').filter((r: any) => r.id === '500000000000000555');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dev_id: ANA, client_nonce: 'n9' });
  });
});

describe('editar y borrar (§B.5): solo lo propio salido de roz', () => {
  function seedOwn(over: Record<string, unknown> = {}) {
    h.fake.table('discord_webhook').push({ channel_id: GENERAL, guild_id: G, webhook_id: HOOK, token_enc: encryptSecret('tok'), name: 'roz' });
    h.fake.table('discord_message').push(
      msgRow('500000000000000888', { webhook_id: HOOK, author_id: HOOK, author_username: 'Ana Pérez', author_bot: true, dev_id: ANA, content: 'antes', ...over }),
    );
  }

  it('edita el propio conservando la línea de respuesta', async () => {
    const prefix = `-# ↪ <@${U_CARLA}> · https://discord.com/channels/${G}/${GENERAL}/500000000000000777\n`;
    seedOwn({ content: `${prefix}antes`, reply_to_id: '500000000000000777' });
    const calls = fakeDiscord((c) =>
      c.method === 'PATCH' ? { status: 200, body: { ...webhookMessage(c, HOOK, '500000000000000888'), channel_id: GENERAL } } : undefined,
    );
    const ana = await loadViewer(ANA);
    const view = await editDiscordMessage(ana, '500000000000000888', 'después');
    await settle();
    expect(calls[0]!.path).toBe(`/webhooks/${HOOK}/tok/messages/500000000000000888`);
    expect(calls[0]!.json.content).toBe(`${prefix}después`);
    expect(calls[0]!.json.allowed_mentions.users).toEqual([U_CARLA]);
    expect(view.content).toBe('después');
    expect(view.editedAt).not.toBeNull();
    expect(h.broadcasts.map((b) => b.event)).toEqual(['discord.message.updated']);
  });

  it('el mensaje de otro dev, o de un webhook que no es el de roz → 403 DISCORD_NOT_OWN_MESSAGE', async () => {
    seedOwn();
    fakeDiscord(() => ({ status: 200, body: {} }));
    const beto = await loadViewer(BETO);
    await expect(editDiscordMessage(beto, '500000000000000888', 'x')).rejects.toMatchObject({ code: 'DISCORD_NOT_OWN_MESSAGE', status: 403 });
    (h.fake.table('discord_message')[0] as any).webhook_id = '700000000000000123';
    const ana = await loadViewer(ANA);
    await expect(deleteDiscordMessage(ana, '500000000000000888')).rejects.toMatchObject({ code: 'DISCORD_NOT_OWN_MESSAGE' });
  });

  it('borra: DELETE al webhook, borrado suave y aviso; un mensaje ya borrado → 404', async () => {
    seedOwn();
    const calls = fakeDiscord((c) => (c.method === 'DELETE' ? { status: 204 } : undefined));
    const ana = await loadViewer(ANA);
    await deleteDiscordMessage(ana, '500000000000000888');
    await settle();
    expect(calls[0]!.method).toBe('DELETE');
    expect((h.fake.table('discord_message')[0] as any).deleted_at).not.toBeNull();
    expect(h.broadcasts).toEqual([{ devIds: [ANA, BETO].sort(), event: 'discord.message.deleted', payload: { channelId: GENERAL, messageIds: ['500000000000000888'] } }]);
    await expect(deleteDiscordMessage(ana, '500000000000000888')).rejects.toMatchObject({ status: 404 });
  });
});

describe('leer (§B.3)', () => {
  function seedMany(n: number) {
    for (let i = 1; i <= n; i++) {
      const id = String(500000000000001000n + BigInt(i));
      h.fake.table('discord_message').push(msgRow(id, { content: `m${i}`, created_at: new Date(Date.UTC(2026, 10, 11, 10, i)).toISOString() }));
    }
  }

  it('descendente, `before` pagina hacia atrás y `hasMore` se apaga al final; excluye borrados', async () => {
    seedMany(5);
    (h.fake.table('discord_message')[2] as any).deleted_at = '2026-11-11T12:00:00Z'; // m3
    const ana = await loadViewer(ANA);
    const p1 = await listChannelMessages(ana, GENERAL, { limit: 2 });
    expect(p1.messages.map((m) => m.content)).toEqual(['m5', 'm4']);
    expect(p1.hasMore).toBe(true);
    const p2 = await listChannelMessages(ana, GENERAL, { limit: 2, before: p1.messages[1]!.id });
    expect(p2.messages.map((m) => m.content)).toEqual(['m2', 'm1']);
    expect(p2.hasMore).toBe(false);
    expect(p2.backfillComplete).toBe(true);
  });

  it('`around` trae el mensaje con sus vecinos; un canal sin backfill completo siempre dice hasMore', async () => {
    seedMany(5);
    const ana = await loadViewer(ANA);
    const page = await listChannelMessages(ana, GENERAL, { around: '500000000000001003' });
    expect(page.messages.map((m) => m.content)).toEqual(['m5', 'm4', 'm3', 'm2', 'm1']);
    h.fake.tables.discord_sync_state = [];
    expect((await listChannelMessages(ana, GENERAL, {})).hasMore).toBe(true);
  });

  it('vista: autor ligado con foto de GitHub, miembro sin roz con su apodo, fichas de tarea por identificador, viejo (legacy) y por origen', async () => {
    h.fake.table('discord_message').push(
      msgRow('500000000000002001', { author_id: U_ANA, author_username: 'ana', content: 'mira #POR-1 y #ROZ-9' }),
      msgRow('500000000000002002', { author_id: U_BETO, author_username: 'beto', created_at: '2026-11-11T12:01:00.000Z' }),
    );
    h.fake.table('work_item').push(
      { id: 'w1', identifier: 'POR-1', name: 'Uno', status: 'pendiente', url: null, discord_message_id: null, legacy_identifier: null },
      { id: 'w2', identifier: 'HYP-45', name: 'Migrada', status: 'en_progreso', url: 'https://linear.app/x/HYP-45', discord_message_id: '500000000000002002', legacy_identifier: 'ROZ-9' },
    );
    const ana = await loadViewer(ANA);
    const { messages } = await listChannelMessages(ana, GENERAL);
    const [beto, mine] = messages;
    expect(mine!.author).toMatchObject({ displayName: 'ana', devId: ANA, avatarUrl: 'https://github.com/anagh.png?size=96', webhook: false });
    expect(mine!.tasks.map((t) => t.identifier)).toEqual(['POR-1', 'HYP-45']);
    expect(beto!.author).toMatchObject({ displayName: 'Beto Staff', devId: BETO });
    expect(beto!.tasks).toEqual([{ identifier: 'HYP-45', workItemId: 'w2', name: 'Migrada', status: 'en_progreso', url: 'https://linear.app/x/HYP-45' }]);
    expect(mine!.fromRoz).toBe(false);
  });

  it('una "respuesta" que apunta a un mensaje de OTRO canal no muestra su texto (no filtra #secreto)', async () => {
    h.fake.table('discord_message').push(
      msgRow('500000000000002101', { channel_id: SECRET, author_id: U_BETO, content: 'contraseña del staff' }),
      msgRow('500000000000002102', { reply_to_id: '500000000000002101', content: 'cita colada', created_at: '2026-11-11T12:02:00.000Z' }),
    );
    const ana = await loadViewer(ANA);
    const { messages } = await listChannelMessages(ana, GENERAL);
    const m = messages.find((x) => x.id === '500000000000002102')!;
    expect(m.replyTo).toBeNull();
    expect(JSON.stringify(messages)).not.toContain('contraseña');
  });

  it('refresca las URLs de adjuntos que caducan pronto y las guarda en la fila', async () => {
    const expSoon = Math.floor(Date.now() / 1000 + 60).toString(16);
    const oldUrl = `https://cdn.discordapp.com/attachments/1/2/a.png?ex=${expSoon}&is=0&hm=x`;
    h.fake.table('discord_message').push(
      msgRow('500000000000003001', { attachments: [{ id: '1', filename: 'a.png', contentType: null, size: 1, url: oldUrl, proxyUrl: null, width: null, height: null, description: null, durationSecs: null, spoiler: false }] }),
    );
    const calls = fakeDiscord((c) =>
      c.path === '/attachments/refresh-urls' ? { status: 200, body: { refreshed_urls: [{ original: oldUrl, refreshed: 'https://cdn.discordapp.com/new.png?ex=fffffff0' }] } } : undefined,
    );
    const ana = await loadViewer(ANA);
    const { messages } = await listChannelMessages(ana, GENERAL);
    expect(calls).toHaveLength(1);
    expect(messages[0]!.attachments[0]!.url).toBe('https://cdn.discordapp.com/new.png?ex=fffffff0');
    expect((h.fake.table('discord_message')[0] as any).attachments[0].url).toBe('https://cdn.discordapp.com/new.png?ex=fffffff0');
  });

  it('plainExcerpt: menciones con nombre, canales, emojis y sin markdown', () => {
    const out = plainExcerpt('**hola** <@1234567890123456789> en <#1234567890123456780> <:party:1234567890123456781>', {
      user: () => 'Ana',
      channel: () => 'general',
    });
    expect(out).toBe('hola @Ana en #general :party:');
  });
});

describe('rutas /api/dashboard/discord', () => {
  function app(devId = ANA) {
    const a = new Hono<RozContext>();
    a.use('*', async (c, next) => {
      c.set('user', { id: `auth-${devId}`, email: 'x@y', name: null, role: null, devId, devName: 'X', devActive: true });
      await next();
    });
    a.route('/api/dashboard/discord', discordRoutes);
    return a;
  }

  it('flag apagado: todo 404 DISCORD_CHAT_DISABLED salvo GET /status (enabled:false)', async () => {
    (config.discord as any).chatEnabled = false;
    try {
      const res = await app().request('/api/dashboard/discord/channels');
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('DISCORD_CHAT_DISABLED');
      const st = await app().request('/api/dashboard/discord/status');
      expect(st.status).toBe(200);
      expect(await st.json()).toMatchObject({ enabled: false, unavailable: 'disabled', limits: expect.any(Array) });
    } finally {
      (config.discord as any).chatEnabled = true;
    }
  });

  it('GET /status con flag encendido: vínculo y estado del puente', async () => {
    h.fake.table('discord_bridge_state').push({ guild_id: G, status: 'ready', last_heartbeat_at: new Date().toISOString(), last_ready_at: null });
    const res = await app().request('/api/dashboard/discord/status');
    const body = await res.json();
    expect(body).toMatchObject({ enabled: true, unavailable: null, link: { discordUserId: U_ANA }, guild: { id: G, name: 'Hyper' }, bridge: { status: 'ready', healthy: true } });
    expect(body.limits).toHaveLength(5);
  });

  it('POST /link/start deja el state en una cookie HttpOnly (atada a este navegador)', async () => {
    const res = await app().request('/api/dashboard/discord/link/start', { method: 'POST' });
    expect(res.status).toBe(200);
    const { url } = await res.json();
    const state = new URL(url).searchParams.get('state')!;
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`roz_discord_oauth=${state}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toContain('Path=/api/discord');
  });

  it('POST mensajes valida el cuerpo y responde 201 con el mensaje', async () => {
    happyDiscord();
    const bad = await app().request(`/api/dashboard/discord/channels/${GENERAL}/messages`, { method: 'POST', body: JSON.stringify({ replyToId: 'x' }), headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);
    const ok = await app().request(`/api/dashboard/discord/channels/${GENERAL}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'hola', clientNonce: 'abc' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(ok.status).toBe(201);
    expect((await ok.json()).message).toMatchObject({ content: 'hola', clientNonce: 'abc', fromRoz: true });
    const hidden = await app().request(`/api/dashboard/discord/channels/${SECRET}/messages`);
    expect(hidden.status).toBe(404);
  });

  it('subida: tope por archivo → 413 DISCORD_UPLOAD_TOO_LARGE; dentro del tope → URL firmada', async () => {
    const big = await app().request(`/api/dashboard/discord/channels/${GENERAL}/uploads`, {
      method: 'POST',
      body: JSON.stringify({ name: 'video.mp4', size: config.discord.maxUploadBytes + 1 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(big.status).toBe(413);
    expect((await big.json()).error.code).toBe('DISCORD_UPLOAD_TOO_LARGE');
    const ok = await app().request(`/api/dashboard/discord/channels/${GENERAL}/uploads`, {
      method: 'POST',
      body: JSON.stringify({ name: 'nota.txt', size: 10, contentType: 'text/plain' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(ok.status).toBe(201);
    const body = await ok.json();
    expect(body.path).toMatch(new RegExp(`^discord/${ANA}/[0-9a-f-]+/nota\\.txt$`));
    h.fake.objects.set(`roz-chat/${body.path}`, { bytes: new Uint8Array(10), contentType: 'text/plain' });
    const done = await app().request(`/api/dashboard/discord/uploads/${body.upload.id}/complete`, { method: 'POST' });
    expect(done.status).toBe(200);
    expect((await done.json()).upload).toMatchObject({ name: 'nota.txt', size: 10 });
  });

  it('crear tarea desde un mensaje: liga discord_message_id, el bot responde nativo y se retransmite el original', async () => {
    h.fake.table('discord_message').push(msgRow('500000000000004001', { content: 'hay un bug' }));
    const calls = fakeDiscord((c) => (c.method === 'POST' && c.path === `/channels/${GENERAL}/messages` ? { status: 200, body: { id: '500000000000004002' } } : undefined));
    const res = await app().request('/api/dashboard/discord/messages/500000000000004001/task', {
      method: 'POST',
      body: JSON.stringify({ projectId: '33333333-3333-4333-8333-333333333333', name: 'Arreglar bug' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(201);
    await settle();
    expect((h.fake.table('work_item')[0] as any).discord_message_id).toBe('500000000000004001');
    expect(calls[0]!.json).toMatchObject({
      content: '↪ Se creó POR-7 a partir de este mensaje',
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
      message_reference: { message_id: '500000000000004001' },
    });
    const upd = h.broadcasts.find((b) => b.event === 'discord.message.updated')!;
    expect(upd.payload.message.tasks.map((t: any) => t.identifier)).toEqual(['POR-7']);
  });

  it('proyecto ↔ canal: lista, asigna un canal de texto visible y rechaza voz', async () => {
    const put = (body: unknown) =>
      app().request('/api/dashboard/discord/project-channels/33333333-3333-4333-8333-333333333333', {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
    expect((await put({ channelId: VOICE })).status).toBe(400);
    expect((await put({ channelId: SECRET })).status).toBe(404); // Ana no lo ve
    const ok = await put({ channelId: GENERAL });
    expect(await ok.json()).toEqual({ item: { projectId: '33333333-3333-4333-8333-333333333333', projectName: 'Portal', channelId: GENERAL, channelName: 'general' } });
    const list = await (await app().request('/api/dashboard/discord/project-channels')).json();
    expect(list.items).toEqual([{ projectId: '33333333-3333-4333-8333-333333333333', projectName: 'Portal', channelId: GENERAL, channelName: 'general' }]);
    expect(await (await put({ channelId: null })).json()).toMatchObject({ item: { channelId: null } });
  });

  it('proyecto ↔ canal: el nombre de un canal privado no se filtra a quien no lo ve', async () => {
    const res = await app(BETO).request('/api/dashboard/discord/project-channels/33333333-3333-4333-8333-333333333333', {
      method: 'PUT',
      body: JSON.stringify({ channelId: SECRET }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const asBeto = await (await app(BETO).request('/api/dashboard/discord/project-channels')).json();
    expect(asBeto.items[0]).toMatchObject({ channelId: SECRET, channelName: 'secreto' });
    const asAna = await (await app(ANA).request('/api/dashboard/discord/project-channels')).json();
    expect(asAna.items[0]).toMatchObject({ channelId: SECRET, channelName: null });
  });

  it('miembros: busca por apodo y por nombre del dev ligado', async () => {
    const r1 = await (await app().request('/api/dashboard/discord/members?q=staff')).json();
    expect(r1.members.map((m: any) => m.discordUserId)).toEqual([U_BETO]);
    const r2 = await (await app().request('/api/dashboard/discord/members?q=perez')).json();
    expect(r2.members).toEqual([{ discordUserId: U_ANA, displayName: 'ana', username: 'ana', avatarUrl: 'https://github.com/anagh.png?size=96', bot: false, devId: ANA }]);
  });
});
