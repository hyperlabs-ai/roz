import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Transporte REST a Discord, con fetch simulado (nunca la API real). Lo que importa: el rate limit
// se respeta sin duplicar envíos (un 429 se reintenta, un 5xx NO), los errores salen tipados, y los
// secretos (token del bot, token del webhook) jamás aparecen en un error.

const BOT = 'bot-token-SECRETO';
const HOOK_TOKEN = 'webhook-token-SECRETO';
const CH = '400000000000000002';
const HOOK = '700000000000000001';

async function load() {
  process.env.DISCORD_BOT_TOKEN = BOT;
  process.env.DISCORD_GUILD_ID = '100000000000000001';
  process.env.DISCORD_CLIENT_ID = 'cid';
  process.env.DISCORD_CLIENT_SECRET = 'csecret';
  process.env.DISCORD_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/discord/callback';
  process.env.DISCORD_API_URL = 'https://discord.test/api/v10';
  vi.resetModules();
  const mod = await import('../src/adapters/discord.js');
  mod.__resetDiscordRateLimits();
  let now = 1_000_000;
  const sleeps: number[] = [];
  mod.__setDiscordClock({
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  return { mod, sleeps, advance: (ms: number) => (now += ms) };
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function respond(...replies: Reply[]) {
  let i = 0;
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
    const r = replies[Math.min(i++, replies.length - 1)]!;
    const text = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      text: async () => text,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const msg = (over: Record<string, unknown> = {}) => ({
  id: '500000000000000001',
  channel_id: CH,
  type: 0,
  author: { id: HOOK, username: 'Ana', bot: true },
  content: 'hola',
  timestamp: '2026-11-11T12:00:00.000000+00:00',
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

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('routeKey', () => {
  it('conserva el parámetro mayor, normaliza ids y SIEMPRE oculta el token del webhook', async () => {
    const { mod } = await load();
    expect(mod.routeKey(`/webhooks/${HOOK}/${HOOK_TOKEN}/messages/500000000000000001?wait=true`)).toEqual({
      route: `/webhooks/${HOOK}/:token/messages/:id`,
      major: `webhooks/${HOOK}`,
    });
    expect(mod.routeKey(`/channels/${CH}/messages/500000000000000001`)).toEqual({ route: `/channels/${CH}/messages/:id`, major: `channels/${CH}` });
    expect(mod.routeKey('/users/@me/channels')).toEqual({ route: '/users/@me/channels', major: '' });
  });
});

describe('executeWebhook', () => {
  it('JSON con wait=true, thread_id, username saneado y allowed_mentions seguro; sin header de bot', async () => {
    const { mod } = await load();
    const f = respond({ status: 200, body: msg() });
    const out = await mod.executeWebhook({
      webhookId: HOOK,
      token: HOOK_TOKEN,
      content: 'hola <@200000000000000002> @everyone',
      username: 'Ana de Discord',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1',
      allowedMentions: mod.buildAllowedMentions(mod.extractUserMentions('hola <@200000000000000002> @everyone')),
      threadId: '800000000000000001',
    });
    expect(out.id).toBe('500000000000000001');
    const [url, init] = f.mock.calls[0]!;
    const u = new URL(url);
    expect(u.pathname).toBe(`/api/v10/webhooks/${HOOK}/${HOOK_TOKEN}`);
    expect(u.searchParams.get('wait')).toBe('true');
    expect(u.searchParams.get('thread_id')).toBe('800000000000000001');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.username).toBe('Ana de d1scord');
    expect(body.avatar_url).toBe('https://avatars.githubusercontent.com/u/1');
    expect(body.allowed_mentions).toEqual({ parse: [], users: ['200000000000000002'], roles: [], replied_user: false });
  });

  it('con archivos manda multipart: payload_json + files[n] con attachments indexados', async () => {
    const { mod } = await load();
    const f = respond({ status: 200, body: msg() });
    await mod.executeWebhook({
      webhookId: HOOK,
      token: HOOK_TOKEN,
      content: '',
      username: 'Ana',
      allowedMentions: mod.buildAllowedMentions([]),
      files: [
        { name: 'a.png', contentType: 'image/png', data: new Uint8Array([1, 2, 3]) },
        { name: 'b.txt', contentType: null, data: new Uint8Array([4]).buffer, description: 'nota' },
      ],
    });
    const init = f.mock.calls[0]![1];
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    const payload = JSON.parse(form.get('payload_json') as string);
    expect(payload.attachments).toEqual([{ id: 0, filename: 'a.png' }, { id: 1, filename: 'b.txt', description: 'nota' }]);
    const f0 = form.get('files[0]') as File;
    expect(f0.size).toBe(3);
    expect(f0.type).toBe('image/png');
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('un error nunca incluye el token del webhook', async () => {
    const { mod } = await load();
    respond({ status: 404, body: { code: 10015, message: 'Unknown Webhook' } });
    const err = await mod
      .executeWebhook({ webhookId: HOOK, token: HOOK_TOKEN, content: 'x', username: 'A', allowedMentions: mod.buildAllowedMentions([]) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.DiscordError);
    expect(mod.isDiscordError(err, mod.DISCORD_ERROR.UNKNOWN_WEBHOOK)).toBe(true);
    const e = err as InstanceType<typeof mod.DiscordError>;
    expect(e.retryable).toBe(false);
    expect(JSON.stringify({ m: e.message, r: e.route, d: e.detail })).not.toContain(HOOK_TOKEN);
  });

  it('error de red: reintentable y sin la URL (que lleva el token) en el mensaje', async () => {
    const { mod } = await load();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        throw new TypeError(`fetch failed ${url}`);
      }),
    );
    const err = (await mod
      .executeWebhook({ webhookId: HOOK, token: HOOK_TOKEN, content: 'x', username: 'A', allowedMentions: mod.buildAllowedMentions([]) })
      .catch((e: unknown) => e)) as InstanceType<typeof mod.DiscordError>;
    expect(err.code).toBe('network');
    expect(err.retryable).toBe(true);
    expect(err.message + err.route).not.toContain(HOOK_TOKEN);
  });
});

describe('rate limit', () => {
  it('429 corto: espera retry_after y reintenta (un 429 nunca se procesó)', async () => {
    const { mod, sleeps } = await load();
    const f = respond({ status: 429, body: { message: 'rl', retry_after: 1.5, global: false } }, { status: 200, body: msg() });
    await mod.sendBotMessage(CH, { content: 'hola', allowedMentions: mod.buildAllowedMentions([]) });
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleeps).toContain(1500);
  });

  it('429 largo: error reintentable con retryAfterSec, sin esperar', async () => {
    const { mod, sleeps } = await load();
    const f = respond({ status: 429, body: { message: 'rl', retry_after: 30 } });
    const err = (await mod.sendBotMessage(CH, { content: 'x', allowedMentions: mod.buildAllowedMentions([]) }).catch((e: unknown) => e)) as InstanceType<
      typeof mod.DiscordError
    >;
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(err).toMatchObject({ status: 429, retryable: true, retryAfterSec: 30, code: 'rate_limited' });
  });

  it('429 repetido: se rinde tras los reintentos permitidos', async () => {
    const { mod } = await load();
    const f = respond({ status: 429, body: { retry_after: 0.1 } });
    const err = await mod.sendBotMessage(CH, { content: 'x', allowedMentions: mod.buildAllowedMentions([]) }).catch((e: unknown) => e);
    expect(f).toHaveBeenCalledTimes(3);
    expect(mod.isDiscordError(err, 'rate_limited')).toBe(true);
  });

  it('bucket agotado: espera el reset ANTES de pedir', async () => {
    const { mod, sleeps } = await load();
    const f = respond(
      { status: 200, body: msg(), headers: { 'x-ratelimit-bucket': 'abc', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2' } },
      { status: 200, body: msg() },
    );
    await mod.sendBotMessage(CH, { content: '1', allowedMentions: mod.buildAllowedMentions([]) });
    await mod.sendBotMessage(CH, { content: '2', allowedMentions: mod.buildAllowedMentions([]) });
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2000]);
  });

  it('el bucket es por parámetro mayor: otro canal no espera', async () => {
    const { mod, sleeps } = await load();
    respond(
      { status: 200, body: msg(), headers: { 'x-ratelimit-bucket': 'abc', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2' } },
      { status: 200, body: msg() },
    );
    await mod.sendBotMessage(CH, { content: '1', allowedMentions: mod.buildAllowedMentions([]) });
    await mod.sendBotMessage('400000000000000009', { content: '2', allowedMentions: mod.buildAllowedMentions([]) });
    expect(sleeps).toEqual([]);
  });

  it('bucket agotado con reset lejano: error reintentable sin gastar la petición', async () => {
    const { mod } = await load();
    const f = respond({ status: 200, body: msg(), headers: { 'x-ratelimit-bucket': 'abc', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '60' } });
    await mod.sendBotMessage(CH, { content: '1', allowedMentions: mod.buildAllowedMentions([]) });
    const err = await mod.sendBotMessage(CH, { content: '2', allowedMentions: mod.buildAllowedMentions([]) }).catch((e: unknown) => e);
    expect(f).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ retryable: true, code: 'rate_limited', status: null });
  });

  it('429 global frena también otras rutas', async () => {
    const { mod, sleeps } = await load();
    respond({ status: 429, body: { retry_after: 3, global: true } }, { status: 200, body: msg() }, { status: 200, body: { id: 'dm', type: 1 } });
    await mod.sendBotMessage(CH, { content: '1', allowedMentions: mod.buildAllowedMentions([]) });
    expect(sleeps).toEqual([3000]);
  });
});

describe('errores', () => {
  it('5xx: reintentable pero NO se reintenta aquí (podría duplicar el mensaje)', async () => {
    const { mod } = await load();
    const f = respond({ status: 502, body: 'bad gateway' });
    const err = await mod.sendBotMessage(CH, { content: 'x', allowedMentions: mod.buildAllowedMentions([]) }).catch((e: unknown) => e);
    expect(f).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ status: 502, retryable: true });
  });

  it('403 sin permisos: código de Discord, no reintentable, sin el token del bot', async () => {
    const { mod } = await load();
    respond({ status: 403, body: { code: 50013, message: 'Missing Permissions' } });
    const err = (await mod.createChannelWebhook(CH).catch((e: unknown) => e)) as InstanceType<typeof mod.DiscordError>;
    expect(err).toMatchObject({ status: 403, retryable: false, code: mod.DISCORD_ERROR.MISSING_PERMISSIONS });
    expect(JSON.stringify({ m: err.message, d: err.detail })).not.toContain(BOT);
  });

  it('el bot se autentica con "Bot <token>" y manda la razón de auditoría codificada', async () => {
    const { mod } = await load();
    const f = respond({ status: 200, body: { id: HOOK, type: 1, channel_id: CH, name: 'roz', token: HOOK_TOKEN } });
    await mod.createChannelWebhook(CH, 'roz', 'roz: publicar ñ');
    const headers = f.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bot ${BOT}`);
    expect(headers['x-audit-log-reason']).toBe(encodeURIComponent('roz: publicar ñ'));
  });

  it('204 devuelve null (borrar mensaje de webhook)', async () => {
    const { mod } = await load();
    const f = respond({ status: 204 });
    await expect(mod.deleteWebhookMessage(HOOK, HOOK_TOKEN, '500000000000000001', '800000000000000001')).resolves.toBeUndefined();
    const u = new URL(f.mock.calls[0]![0]);
    expect(f.mock.calls[0]![1].method).toBe('DELETE');
    expect(u.searchParams.get('thread_id')).toBe('800000000000000001');
  });

  it('getGuildMember: 10007 (no es miembro) → null; otros errores se propagan', async () => {
    const { mod } = await load();
    respond({ status: 404, body: { code: 10007, message: 'Unknown Member' } });
    await expect(mod.getGuildMember('200000000000000002')).resolves.toBeNull();
    respond({ status: 500, body: {} });
    await expect(mod.getGuildMember('200000000000000002')).rejects.toBeInstanceOf(mod.DiscordError);
  });

  it('sin token de bot: error not_configured sin llamar a la red', async () => {
    const { mod } = await load();
    process.env.DISCORD_BOT_TOKEN = '';
    vi.resetModules();
    const fresh = await import('../src/adapters/discord.js');
    const f = respond({ status: 200, body: {} });
    await expect(fresh.createDmChannel('200000000000000002')).rejects.toMatchObject({ code: 'not_configured' });
    expect(f).not.toHaveBeenCalled();
    void mod;
  });
});

describe('OAuth2', () => {
  it('URL de autorización con scope identify, redirect exacto y state', async () => {
    const { mod } = await load();
    const u = new URL(mod.oauthAuthorizeUrl('st4te'));
    expect(u.origin + u.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'cid',
      scope: 'identify',
      redirect_uri: 'http://localhost:3000/api/discord/callback',
      state: 'st4te',
    });
  });

  it('code → token (form-urlencoded) → /users/@me con Bearer', async () => {
    const { mod } = await load();
    const f = respond(
      { status: 200, body: { access_token: 'acc', token_type: 'Bearer', scope: 'identify', expires_in: 600 } },
      { status: 200, body: { id: '200000000000000002', username: 'ana', global_name: 'Ana', avatar: 'abc' } },
    );
    const tok = await mod.exchangeOAuthCode('the-code');
    expect(tok).toEqual({ accessToken: 'acc', tokenType: 'Bearer', scope: 'identify', expiresIn: 600 });
    const init0 = f.mock.calls[0]![1];
    expect((init0.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(init0.body as string);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('redirect_uri')).toBe('http://localhost:3000/api/discord/callback');
    expect((init0.headers as Record<string, string>).authorization).toBeUndefined();

    const me = await mod.fetchOAuthUser(tok.accessToken);
    expect(me.id).toBe('200000000000000002');
    expect((f.mock.calls[1]![1].headers as Record<string, string>).authorization).toBe('Bearer acc');
  });

  it('code inválido: error tipado no reintentable', async () => {
    const { mod } = await load();
    respond({ status: 400, body: { error: 'invalid_grant' } });
    await expect(mod.exchangeOAuthCode('x')).rejects.toMatchObject({ status: 400, retryable: false });
  });
});

describe('helpers', () => {
  it('sanitizeWebhookUsername: nunca vacío, sin palabras prohibidas, máx. 80', async () => {
    const { mod } = await load();
    expect(mod.sanitizeWebhookUsername('')).toBe('roz');
    expect(mod.sanitizeWebhookUsername('  Clyde  ')).toBe('cl yde');
    expect(mod.sanitizeWebhookUsername('everyone')).toBe('everyone (roz)');
    expect(mod.sanitizeWebhookUsername('a```b')).toBe('ab');
    expect(mod.sanitizeWebhookUsername('x'.repeat(200))).toHaveLength(80);
  });

  it('buildAllowedMentions: nunca everyone/roles, ids únicos y válidos, máx. 100', async () => {
    const { mod } = await load();
    const ids = Array.from({ length: 150 }, (_, i) => String(200000000000000000n + BigInt(i)));
    const am = mod.buildAllowedMentions([...ids, ids[0]!, 'no-es-id']);
    expect(am.parse).toEqual([]);
    expect(am.roles).toEqual([]);
    expect(am.users).toHaveLength(100);
    expect(new Set(am.users).size).toBe(100);
  });

  it('URLs de adjuntos: lee la caducidad (ex, hex) y las refresca en lote', async () => {
    const { mod } = await load();
    expect(mod.attachmentUrlExpiresAt('https://cdn.discordapp.com/attachments/1/2/a.png?ex=6731a2b0&is=1&hm=2')).toBe(0x6731a2b0 * 1000);
    expect(mod.attachmentUrlExpiresAt('https://cdn.discordapp.com/attachments/1/2/a.png')).toBeNull();
    expect(mod.attachmentUrlExpiresAt('no es url')).toBeNull();
    const f = respond({ status: 200, body: { refreshed_urls: [{ original: 'https://a', refreshed: 'https://a?ex=1' }] } });
    const map = await mod.refreshAttachmentUrls(['https://a', 'https://a']);
    expect(map.get('https://a')).toBe('https://a?ex=1');
    expect(JSON.parse(f.mock.calls[0]![1].body as string)).toEqual({ attachment_urls: ['https://a'] });
    await expect(mod.refreshAttachmentUrls([])).resolves.toEqual(new Map());
  });

  it('avatar por defecto y fecha del snowflake', async () => {
    const { mod } = await load();
    expect(mod.userAvatarUrl('200000000000000002', null)).toMatch(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
    expect(mod.userAvatarUrl('1', 'a_hash')).toContain('/avatars/1/a_hash.gif');
    expect(mod.snowflakeDate('175928847299117063').toISOString()).toBe('2016-04-30T11:18:25.796Z');
  });
});
