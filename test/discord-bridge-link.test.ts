import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ANA, BETO, G, GENERAL, PROJECT, SECRET, U_ANA, U_BETO, createDiscordDb, fakeDiscord, msgRow, seedGuild } from './discord-fixture.js';

// Puente → roz (contrato §A.2), ligar la cuenta por OAuth (§B.9) y el aviso de /ticket (§B.11), con
// la base y Discord simulados.

const h = vi.hoisted(() => {
  process.env.ROZ_DISCORD_CHAT = 'true';
  process.env.DISCORD_BOT_TOKEN = 'bot-token-SECRETO';
  process.env.DISCORD_GUILD_ID = '100000000000000001';
  process.env.DISCORD_CLIENT_ID = '900000000000000001';
  process.env.DISCORD_CLIENT_SECRET = 'client-secret';
  process.env.DISCORD_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/discord/callback';
  process.env.DISCORD_API_URL = 'https://discord.test/api/v10';
  process.env.ROZ_BRIDGE_SECRET = 'bridge-secret';
  process.env.ROZ_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  return { fake: null as any, broadcasts: [] as { devIds: string[]; event: string; payload: any }[] };
});

vi.mock('../src/db/supabase.js', () => ({ db: () => h.fake, dbPublic: () => h.fake }));
vi.mock('../src/chat/realtime.js', () => ({
  devTopic: (id: string) => `chat:dev:${id}`,
  broadcastToDevs: async (devIds: string[], event: string, payload: any) => {
    h.broadcasts.push({ devIds: [...devIds].sort(), event, payload });
  },
}));
vi.mock('../src/dashboard/queries.js', () => ({ createTask: async () => ({}), getTicketById: async () => null }));
vi.mock('../src/linear/issues.js', () => ({ createIssueFromTicket: async () => ({}) }));

import { __resetDiscordRateLimits } from '../src/adapters/discord.js';
import { config } from '../src/config.js';
import { discordBridgeRoutes } from '../src/routes/discord.js';
import { discordOauthRoutes } from '../src/routes/discord-oauth.js';
import { bridgeHealthy, DISCORD_OAUTH_COOKIE, startDiscordLink } from '../src/discord/link.js';
import { notifyTicketAssigneeOnDiscord, ticketNoticeContent } from '../src/discord/notify.js';
import { consumeOAuthState, createOAuthState } from '../src/calendar/accounts.js';
import type { RozContext } from '../src/types/hono.js';

beforeEach(() => {
  h.fake = createDiscordDb();
  h.broadcasts = [];
  seedGuild(h.fake);
  __resetDiscordRateLimits();
});
afterEach(() => vi.unstubAllGlobals());

function bridgeApp() {
  const a = new Hono<RozContext>();
  a.route('/v1/internal', discordBridgeRoutes);
  return a;
}

const post = (body: unknown, auth = 'Bearer bridge-secret') =>
  bridgeApp().request('/v1/internal/discord/events', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: auth },
  });

describe('POST /v1/internal/discord/events', () => {
  it('bearer malo → 403; guild ajena → 403; cuerpo inválido → 400; flag apagado → 404', async () => {
    const body = { guildId: G, notices: [{ kind: 'bridge.status', status: 'ready' }] };
    expect((await post(body, 'Bearer otro')).status).toBe(403);
    expect((await post(body, '')).status).toBe(403);
    expect((await post({ ...body, guildId: '100000000000000999' })).status).toBe(403);
    expect((await post({ guildId: G, notices: [] })).status).toBe(400);
    (config.discord as any).chatEnabled = false;
    try {
      const res = await post(body);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('DISCORD_CHAT_DISABLED');
    } finally {
      (config.discord as any).chatEnabled = true;
    }
  });

  it('secreto vacío en roz → 403 siempre (fail-closed)', async () => {
    const prev = config.discord.bridgeSecret;
    (config.discord as any).bridgeSecret = '';
    try {
      expect((await post({ guildId: G, notices: [{ kind: 'bridge.status', status: 'ready' }] }, 'Bearer ')).status).toBe(403);
    } finally {
      (config.discord as any).bridgeSecret = prev;
    }
  });

  it('mensaje de #secreto solo le llega a Beto (staff); de #general a ambos; un id desconocido cuenta como skipped', async () => {
    h.fake.table('discord_message').push(
      msgRow('500000000000000001', { channel_id: SECRET, content: 'solo staff' }),
      msgRow('500000000000000002', { channel_id: GENERAL, content: 'para todos' }),
    );
    const res = await post({
      guildId: G,
      notices: [
        { kind: 'message.created', channelId: SECRET, messageId: '500000000000000001' },
        { kind: 'message.updated', channelId: GENERAL, messageId: '500000000000000002' },
        { kind: 'message.created', channelId: GENERAL, messageId: '500000000000000404' },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, processed: 2, skipped: 1 });
    expect(h.broadcasts.map((b) => [b.event, b.devIds, b.payload.message.content])).toEqual([
      ['discord.message.created', [BETO], 'solo staff'],
      ['discord.message.updated', [ANA, BETO].sort(), 'para todos'],
    ]);
  });

  it('borrado en un canal ya borrado: los destinatarios se calculan con la fila (borrado suave)', async () => {
    (h.fake.table('discord_channel').find((c: any) => c.id === SECRET) as any).deleted_at = '2026-11-11T12:00:00Z';
    await post({ guildId: G, notices: [{ kind: 'message.deleted', channelId: SECRET, messageIds: ['500000000000000001'] }] });
    expect(h.broadcasts).toEqual([{ devIds: [BETO], event: 'discord.message.deleted', payload: { channelId: SECRET, messageIds: ['500000000000000001'] } }]);
  });

  it('estructura y estado del puente van a TODOS los ligados; el mismo alcance repetido se avisa una vez', async () => {
    const res = await post({
      guildId: G,
      notices: [
        { kind: 'structure.changed', scope: 'channels', channelIds: [GENERAL] },
        { kind: 'structure.changed', scope: 'channels', channelIds: [SECRET] },
        { kind: 'structure.changed', scope: 'roles' },
        { kind: 'bridge.status', status: 'disconnected' },
      ],
    });
    expect(await res.json()).toEqual({ ok: true, processed: 4, skipped: 0 });
    expect(h.broadcasts).toEqual([
      { devIds: [ANA, BETO].sort(), event: 'discord.channels.changed', payload: { reason: 'channels' } },
      { devIds: [ANA, BETO].sort(), event: 'discord.channels.changed', payload: { reason: 'roles' } },
      { devIds: [ANA, BETO].sort(), event: 'discord.bridge.status', payload: { status: 'disconnected' } },
    ]);
  });
});

describe('OAuth para ligar la cuenta (§B.9)', () => {
  function oauthApp() {
    const a = new Hono<RozContext>();
    a.route('/api/discord', discordOauthRoutes);
    return a;
  }
  /** Vuelta de Discord desde el MISMO navegador: lleva la cookie con el state (salvo `cookie: null`). */
  const callback = async (q: string, opts: { cookie?: string | null } = {}) => {
    const state = new URLSearchParams(q).get('state');
    const cookie = opts.cookie === undefined ? state : opts.cookie;
    const res = await oauthApp().request(`/api/discord/callback?${q}`, {
      headers: cookie ? { cookie: `${DISCORD_OAUTH_COOKIE}=${cookie}` } : {},
    });
    return res.headers.get('location');
  };

  function discordOAuth(userId: string, opts: { member?: boolean } = {}) {
    return fakeDiscord(
      (c) => (c.path === '/oauth2/token' ? { status: 200, body: { access_token: 'at', token_type: 'Bearer', scope: 'identify', expires_in: 600 } } : undefined),
      (c) => (c.path === '/users/@me' ? { status: 200, body: { id: userId, username: 'nuevo', global_name: 'Nuevo', avatar: 'h' } } : undefined),
      (c) => (c.path === '/oauth2/token/revoke' ? { status: 200, body: {} } : undefined),
      (c) =>
        c.path.startsWith(`/guilds/${G}/members/`)
          ? opts.member === false
            ? { status: 404, body: { code: 10007, message: 'Unknown Member' } }
            : { status: 200, body: { roles: [], joined_at: 'x' } }
          : undefined,
    );
  }

  it('start crea un state provider=discord y la URL de Discord con scope identify', async () => {
    const { url } = await startDiscordLink(ANA, 'auth-ana');
    const u = new URL(url);
    expect(u.searchParams.get('scope')).toBe('identify');
    const state = u.searchParams.get('state')!;
    expect(h.fake.table('oauth_state').find((s: any) => s.state === state)).toMatchObject({ provider: 'discord', dev_id: ANA });
  });

  it('un state de Google no sirve para Discord (ni al revés)', async () => {
    const google = await createOAuthState(ANA, null);
    discordOAuth('200000000000000050');
    expect(await callback(`code=c&state=${google}`)).toBe('/app/settings?discord=state');
    const discord = await createOAuthState(ANA, null, 'discord');
    expect((await consumeOAuthState(discord)).ok).toBe(false); // el callback de Google lo rechaza
  });

  it('liga la cuenta, revoca el token, avisa al dev; el state no se puede reusar', async () => {
    h.fake.tables.discord_link = h.fake.table('discord_link').filter((l: any) => l.dev_id !== ANA);
    const calls = discordOAuth('200000000000000050');
    const state = await createOAuthState(ANA, null, 'discord');
    expect(await callback(`code=c&state=${state}`)).toBe('/app/settings?discord=ok');
    expect(h.fake.table('discord_link').find((l: any) => l.dev_id === ANA)).toMatchObject({ discord_user_id: '200000000000000050', username: 'nuevo' });
    expect(calls.some((c) => c.path === '/oauth2/token/revoke')).toBe(true);
    expect(h.broadcasts).toEqual([{ devIds: [ANA], event: 'discord.link.changed', payload: { linked: true } }]);
    expect(await callback(`code=c&state=${state}`)).toBe('/app/settings?discord=state');
  });

  it('el state sin la cookie de ESE navegador no liga nada (ni se consume)', async () => {
    h.fake.tables.discord_link = h.fake.table('discord_link').filter((l: any) => l.dev_id !== ANA);
    const calls = discordOAuth('200000000000000052');
    const state = await createOAuthState(ANA, null, 'discord');
    // La víctima abre la URL del atacante: su navegador no tiene la cookie (o tiene otra).
    expect(await callback(`code=c&state=${state}`, { cookie: null })).toBe('/app/settings?discord=state');
    expect(await callback(`code=c&state=${state}`, { cookie: 'otro-state' })).toBe('/app/settings?discord=state');
    expect(calls).toHaveLength(0);
    expect(h.fake.table('discord_link').find((l: any) => l.dev_id === ANA)).toBeUndefined();
    // El navegador correcto todavía puede terminar.
    expect(await callback(`code=c&state=${state}`)).toBe('/app/settings?discord=ok');
  });

  it('cuenta ya ligada a OTRO dev → taken (no se roba); no miembro → not_member; cancelar → denied', async () => {
    discordOAuth(U_BETO);
    expect(await callback(`code=c&state=${await createOAuthState(ANA, null, 'discord')}`)).toBe('/app/settings?discord=taken');
    expect(h.fake.table('discord_link').find((l: any) => l.dev_id === BETO).discord_user_id).toBe(U_BETO);

    discordOAuth('200000000000000051', { member: false });
    expect(await callback(`code=c&state=${await createOAuthState(ANA, null, 'discord')}`)).toBe('/app/settings?discord=not_member');
    expect(await callback('error=access_denied')).toBe('/app/settings?discord=denied');
  });
});

describe('aviso de /ticket por Discord (§B.11)', () => {
  const input = { assigneeDevId: BETO, projectId: PROJECT, identifier: 'HYP-45', title: 'Arreglar @everyone el login' };

  it('con canal del proyecto: mensaje del bot mencionando SOLO al responsable', async () => {
    h.fake.table('discord_project_channel').push({ project_id: PROJECT, channel_id: GENERAL });
    const calls = fakeDiscord((c) => (c.method === 'POST' && c.path === `/channels/${GENERAL}/messages` ? { status: 200, body: { id: '500000000000009001' } } : undefined));
    const r = await notifyTicketAssigneeOnDiscord(input);
    expect(r).toEqual({ messageSent: true, via: 'channel', channelId: GENERAL, messageId: '500000000000009001' });
    expect(calls[0]!.json.content).toBe(`<@${U_BETO}> te asigné HYP-45 · Arreglar @​everyone el login`);
    expect(calls[0]!.json.allowed_mentions).toEqual({ parse: [], users: [U_BETO], roles: [], replied_user: false });
    expect(calls[0]!.headers.authorization).toBe('Bot bot-token-SECRETO');
  });

  it('canal del proyecto que el responsable NO ve → DM del bot (no se menciona donde no llega)', async () => {
    h.fake.table('discord_project_channel').push({ project_id: PROJECT, channel_id: SECRET });
    const calls = fakeDiscord(
      (c) => (c.path === '/users/@me/channels' ? { status: 200, body: { id: '600000000000000001', type: 1 } } : undefined),
      (c) => (c.path === '/channels/600000000000000001/messages' ? { status: 200, body: { id: '500000000000009003' } } : undefined),
    );
    // Ana no tiene el rol staff: no ve #secreto.
    const r = await notifyTicketAssigneeOnDiscord({ ...input, assigneeDevId: ANA });
    expect(r).toMatchObject({ messageSent: true, via: 'dm' });
    expect(calls.some((c) => c.path === `/channels/${SECRET}/messages`)).toBe(false);
  });

  it('sin canal: DM del bot; DMs cerrados → cannot_dm; sin cuenta ligada → not_linked (nunca lanza)', async () => {
    let calls = fakeDiscord(
      (c) => (c.path === '/users/@me/channels' ? { status: 200, body: { id: '600000000000000001', type: 1 } } : undefined),
      (c) => (c.path === '/channels/600000000000000001/messages' ? { status: 200, body: { id: '500000000000009002' } } : undefined),
    );
    expect(await notifyTicketAssigneeOnDiscord(input)).toMatchObject({ messageSent: true, via: 'dm' });
    expect(calls[0]!.json).toEqual({ recipient_id: U_BETO });

    calls = fakeDiscord(
      (c) => (c.path === '/users/@me/channels' ? { status: 200, body: { id: '600000000000000001', type: 1 } } : undefined),
      () => ({ status: 403, body: { code: 50007, message: 'Cannot send messages to this user' } }),
    );
    expect(await notifyTicketAssigneeOnDiscord(input)).toMatchObject({ messageSent: false, via: 'cannot_dm' });

    h.fake.tables.discord_link = [];
    expect(await notifyTicketAssigneeOnDiscord(input)).toMatchObject({ messageSent: false, via: 'not_linked' });
  });

  it('texto: título corto, sin menciones ni backticks colados', () => {
    expect(ticketNoticeContent(U_ANA, 'POR-1', 'usa `rm` con <@123456789012345678> ' + 'x'.repeat(300)).length).toBeLessThan(260);
    expect(ticketNoticeContent(U_ANA, 'POR-1', 'usa `rm` con <@123456789012345678>')).toMatch(new RegExp(`^<@${U_ANA}> (te asigné POR-1|POR-1 va contigo) · usa 'rm' con$`));
  });
});

describe('salud del puente (§B.1)', () => {
  it('ready o backfilling con latido reciente; viejo o desconectado → no sano', () => {
    const now = Date.parse('2026-11-11T12:00:00Z');
    expect(bridgeHealthy({ status: 'ready', last_heartbeat_at: '2026-11-11T11:59:30Z' }, now)).toBe(true);
    expect(bridgeHealthy({ status: 'backfilling', last_heartbeat_at: '2026-11-11T11:59:30Z' }, now)).toBe(true);
    expect(bridgeHealthy({ status: 'ready', last_heartbeat_at: '2026-11-11T11:58:00Z' }, now)).toBe(false);
    expect(bridgeHealthy({ status: 'disconnected', last_heartbeat_at: '2026-11-11T11:59:59Z' }, now)).toBe(false);
  });
});
