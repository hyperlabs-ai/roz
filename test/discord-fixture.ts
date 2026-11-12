// Mundo simulado para las pruebas de la API de roz sobre Discord: un servidor con categoría, canal
// general, canal secreto (solo staff), voz e hilo; dos devs ligados (Ana sin rol, Beto staff); base
// falsa (linear-fake-db) con Storage en memoria; y un Discord falso por `fetch` que registra cada
// llamada. Nada toca la red ni la base real.
import { vi } from 'vitest';
import { createFakeDb, type FakeDb, type Row } from './linear-fake-db.js';

export const G = '100000000000000001';
export const OWNER = '200000000000000099';
export const U_ANA = '200000000000000001';
export const U_BETO = '200000000000000002';
export const U_CARLA = '200000000000000003'; // miembro de Discord sin cuenta de roz
export const STAFF = '300000000000000001';
export const CAT = '400000000000000001';
export const GENERAL = '400000000000000002';
export const SECRET = '400000000000000003';
export const VOICE = '400000000000000004';
export const THREAD = '400000000000000005';
export const APP = '900000000000000001';
export const HOOK = '700000000000000001';
export const HOOK_NEW = '700000000000000002';
export const ANA = '11111111-1111-4111-8111-111111111111';
export const BETO = '22222222-2222-4222-8222-222222222222';
export const PROJECT = '33333333-3333-4333-8333-333333333333';

// VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | READ_MESSAGE_HISTORY | SEND_MESSAGES_IN_THREADS
export const EVERYONE_PERMS = String((1n << 10n) | (1n << 11n) | (1n << 15n) | (1n << 16n) | (1n << 38n));
export const VIEW = String(1n << 10n);

// Las variables de entorno (ROZ_DISCORD_CHAT=true, DISCORD_*, ROZ_BRIDGE_SECRET, ROZ_ENCRYPTION_KEY)
// se ponen en el vi.hoisted de cada archivo de pruebas: tienen que existir antes de importar
// src/config.ts, y vi.hoisted no puede usar imports.

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string | null;
}

/** Base falsa + Storage en memoria. */
export function createDiscordDb(): FakeDb & { storage: any; objects: Map<string, StoredObject> } {
  const fake = createFakeDb({ discord_link: ['discord_user_id'] });
  const objects = new Map<string, StoredObject>();
  const storage = {
    from: (bucket: string) => ({
      createSignedUploadUrl: async (path: string) => ({ data: { signedUrl: `https://storage.test/${bucket}/${path}?token=t`, token: 't', path }, error: null }),
      info: async (path: string) => {
        const o = objects.get(`${bucket}/${path}`);
        return o ? { data: { size: o.bytes.byteLength, contentType: o.contentType }, error: null } : { data: null, error: { message: 'not found' } };
      },
      download: async (path: string) => {
        const o = objects.get(`${bucket}/${path}`);
        return o ? { data: new Blob([o.bytes]), error: null } : { data: null, error: { message: 'not found' } };
      },
      remove: async (paths: string[]) => {
        for (const p of paths) objects.delete(`${bucket}/${p}`);
        return { data: null, error: null };
      },
    }),
  };
  return Object.assign(fake, { storage, objects });
}

const iso = (min: number) => new Date(Date.UTC(2026, 10, 11, 12, min)).toISOString();

export function msgRow(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    guild_id: G,
    channel_id: GENERAL,
    type: 0,
    author_id: U_CARLA,
    author_username: 'carla',
    author_global_name: 'Carla',
    author_avatar: null,
    author_bot: false,
    webhook_id: null,
    dev_id: null,
    client_nonce: null,
    content: 'hola',
    attachments: [],
    embeds: [],
    stickers: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    reactions: [],
    reply_to_id: null,
    thread_id: null,
    flags: 0,
    pinned: false,
    created_at: iso(0),
    edited_at: null,
    deleted_at: null,
    synced_at: iso(0),
    ...over,
  };
}

const channel = (id: string, type: number, over: Partial<Row> = {}): Row => ({
  id,
  guild_id: G,
  type,
  name: id,
  topic: null,
  position: 0,
  parent_id: null,
  nsfw: false,
  overwrites: [],
  rate_limit_per_user: 0,
  archived: false,
  locked: false,
  archived_at: null,
  owner_id: null,
  member_ids: [],
  starter_message_id: null,
  message_count: null,
  last_message_id: null,
  last_message_at: null,
  created_at: iso(0),
  updated_at: iso(0),
  deleted_at: null,
  ...over,
});

const member = (userId: string, username: string, roles: string[] = [], over: Partial<Row> = {}): Row => ({
  guild_id: G,
  user_id: userId,
  username,
  global_name: null,
  nick: null,
  avatar: null,
  guild_avatar: null,
  bot: false,
  roles,
  joined_at: iso(0),
  communication_disabled_until: null,
  pending: false,
  created_at: iso(0),
  updated_at: iso(0),
  left_at: null,
  ...over,
});

/** Llena la base con el servidor de pruebas. */
export function seedGuild(fake: FakeDb): void {
  fake.table('discord_guild').push({ id: G, name: 'Hyper', icon: null, owner_id: OWNER, description: null, created_at: iso(0), updated_at: iso(0), deleted_at: null });
  fake.table('discord_role').push(
    { id: G, guild_id: G, name: '@everyone', color: 0, position: 0, permissions: EVERYONE_PERMS, deleted_at: null },
    { id: STAFF, guild_id: G, name: 'staff', color: 0xff0000, position: 1, permissions: '0', deleted_at: null },
  );
  fake.table('discord_channel').push(
    channel(CAT, 4, { name: 'equipo', position: 0 }),
    channel(GENERAL, 0, { name: 'general', parent_id: CAT, position: 1 }),
    channel(SECRET, 0, {
      name: 'secreto',
      parent_id: CAT,
      position: 2,
      overwrites: [
        { id: G, type: 0, allow: '0', deny: VIEW },
        { id: STAFF, type: 0, allow: VIEW, deny: '0' },
      ],
    }),
    channel(VOICE, 2, { name: 'voz', parent_id: CAT, position: 3 }),
    channel(THREAD, 11, { name: 'hilo', parent_id: GENERAL, message_count: 3, last_message_at: iso(5) }),
  );
  fake.table('discord_member').push(
    member(U_ANA, 'ana'),
    member(U_BETO, 'beto', [STAFF], { nick: 'Beto Staff' }),
    member(U_CARLA, 'carla', [], { global_name: 'Carla G' }),
  );
  fake.table('dev').push({ id: ANA, name: 'Ana Pérez', github_login: 'anagh', active: true }, { id: BETO, name: 'Beto Ruiz', github_login: null, active: true });
  fake.table('discord_link').push(
    { dev_id: ANA, discord_user_id: U_ANA, username: 'ana', global_name: 'Ana', avatar: null, linked_at: iso(0), updated_at: iso(0) },
    { dev_id: BETO, discord_user_id: U_BETO, username: 'beto', global_name: null, avatar: 'abc', linked_at: iso(0), updated_at: iso(0) },
  );
  fake.table('discord_sync_state').push({ channel_id: GENERAL, guild_id: G, backfill_complete: true });
  fake.table('project').push({ id: PROJECT, name: 'Portal', key: 'POR', active: true });
}

// ---------------------------------------------------------------- Discord falso

export interface DiscordCall {
  method: string;
  path: string;
  query: URLSearchParams;
  json: any;
  form: FormData | null;
  headers: Record<string, string>;
}

type Handler = (call: DiscordCall) => { status: number; body?: unknown } | undefined;

let seq = 0;
export function nextSnowflake(): string {
  seq += 1;
  return String(500000000000000000n + BigInt(seq));
}

/** Respuesta de executeWebhook/editWebhookMessage a partir del cuerpo enviado. */
export function webhookMessage(call: DiscordCall, webhookId: string, id = nextSnowflake()): Record<string, unknown> {
  const payload = call.form ? JSON.parse(call.form.get('payload_json') as string) : call.json;
  const files: { id: number; filename: string }[] = payload.attachments ?? [];
  return {
    id,
    channel_id: call.query.get('thread_id') ?? GENERAL,
    guild_id: G,
    type: 0,
    author: { id: webhookId, username: payload.username ?? 'roz', bot: true },
    content: payload.content,
    timestamp: new Date(Date.UTC(2026, 10, 11, 13, 0)).toISOString(),
    edited_timestamp: call.method === 'PATCH' ? new Date(Date.UTC(2026, 10, 11, 13, 5)).toISOString() : null,
    webhook_id: webhookId,
    attachments: files.map((f) => ({
      id: nextSnowflake(),
      filename: f.filename,
      size: 3,
      url: `https://cdn.discordapp.com/attachments/1/2/${f.filename}?ex=ffffffff&is=0&hm=x`,
    })),
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    pinned: false,
  };
}

/** Instala un `fetch` que enruta a `handlers` (el primero que responda gana). */
export function fakeDiscord(...handlers: Handler[]) {
  const calls: DiscordCall[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v10/, '');
    let json: any = null;
    let form: FormData | null = null;
    if (init.body instanceof FormData) form = init.body;
    else if (typeof init.body === 'string') {
      try {
        json = JSON.parse(init.body);
      } catch {
        json = Object.fromEntries(new URLSearchParams(init.body));
      }
    }
    const call: DiscordCall = { method: init.method ?? 'GET', path, query: u.searchParams, json, form, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(call);
    let reply: { status: number; body?: unknown } | undefined;
    for (const h of handlers) {
      reply = h(call);
      if (reply) break;
    }
    reply ??= { status: 404, body: { code: 0, message: `sin handler para ${call.method} ${path}` } };
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: () => null },
      text: async () => text,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}
