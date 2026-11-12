import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ANA, APP, BETO, G, GENERAL, HOOK_NEW, PROJECT, SECRET, U_ANA, U_BETO, VOICE, createDiscordDb, fakeDiscord, seedGuild, webhookMessage, type DiscordCall } from './discord-fixture.js';

// Paridad del compositor de roz con /roz (docs/discord-commands-contract.md §9): el menú "/" es el
// mismo que el de Discord, los subcomandos corren el MISMO handler del registro con un contexto
// sintético, lo público sale por el webhook (embeds + botones, menciones seguras) y lo efímero vuelve
// al front sin publicar. Base y Discord simulados: nunca la API real.

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
  return { fake: null as any, broadcasts: [] as { event: string; payload: any }[], background: [] as Promise<unknown>[] };
});

vi.mock('../src/db/supabase.js', () => ({ db: () => h.fake, dbPublic: () => h.fake }));
vi.mock('../src/chat/realtime.js', () => ({
  devTopic: (id: string) => `chat:dev:${id}`,
  broadcastToDevs: async (_devIds: string[], event: string, payload: any) => {
    h.broadcasts.push({ event, payload });
  },
}));
vi.mock('../src/utils/background.js', () => ({
  inBackground: (task: () => Promise<unknown>, onError?: (e: unknown) => void) => {
    h.background.push(Promise.resolve().then(task).catch((e) => onError?.(e)));
  },
}));

const { commandMenu } = await import('../src/discord/commands/definitions.js');
const { runCommandFromRoz, autocompleteFromRoz, cleanOptions, ephemeralView } = await import('../src/discord/commands/from-roz.js');
const { buildRegistry } = await import('../src/discord/commands/registry.js');
const R = await import('../src/discord/commands/respond.js');
const { taskCardMessage } = await import('../src/discord/commands/embeds.js');
const { textOf, buttonsOf } = await import('./discord-v2-helpers.js');
const { loadViewer } = await import('../src/discord/access.js');
const { __resetDiscordRateLimits } = await import('../src/adapters/discord.js');
const { AppError } = await import('../src/utils/errors.js');
const { discordRoutes } = await import('../src/routes/discord.js');
const { FALLBACK_MENU, matchSlash } = await import('../web/src/discord/commands.js');
type HandlerModule = import('../src/discord/commands/types.js').HandlerModule;
type CommandActor = import('../src/discord/commands/types.js').CommandActor;
type RozContext = import('../src/types/hono.js').RozContext;

const TASK = '55555555-5555-4555-8555-555555555555';
const TASK2 = '66666666-6666-4666-8666-666666666666';
const ACTOR: CommandActor = { devId: ANA, devName: 'Ana Pérez', githubLogin: 'anagh', authUserId: 'auth-ana', discordUserId: U_ANA };

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

function happyDiscord() {
  return fakeDiscord(
    (c) => (c.method === 'GET' && /^\/channels\/\d+\/webhooks$/.test(c.path) ? { status: 200, body: [] } : undefined),
    (c) =>
      c.method === 'POST' && /^\/channels\/\d+\/webhooks$/.test(c.path)
        ? { status: 200, body: { id: HOOK_NEW, type: 1, token: 'tok-new', name: 'roz', application_id: APP, channel_id: GENERAL } }
        : undefined,
    (c) => {
      const m = /^\/webhooks\/(\d+)\/[^/]+$/.exec(c.path);
      if (c.method !== 'POST' || !m) return undefined;
      return { status: 200, body: { ...webhookMessage(c, m[1]!), embeds: c.json?.embeds ?? [], flags: c.json?.flags ?? 0, components: c.json?.components ?? [] } };
    },
  );
}

const card = (title: string) => ({
  content: undefined,
  embeds: [{ title, color: 0xff5b23, author: { name: 'roz' } }],
  components: [
    R.row(R.button({ label: 'Tomar', customId: `roz1:tarea.tomar:${TASK}` } as any) as any, R.linkButton('Abrir', 'https://roz.example.com/app/tasks')!),
  ],
});

/** Registro de prueba: los stubs reales cubren lo que no se sobrescribe. */
function registryWith(over: HandlerModule) {
  const { registry } = buildRegistry({ prueba: {} });
  for (const [k, v] of Object.entries(over.slash ?? {})) (registry.slash as any)[k] = v;
  for (const [k, v] of Object.entries(over.components ?? {})) (registry.components as any)[k] = v;
  for (const [k, v] of Object.entries(over.modals ?? {})) (registry.modals as any)[k] = v;
  return registry;
}

const resolveAna = async (id: string) => (id === U_ANA ? ACTOR : null);

describe('menú "/" del compositor', () => {
  it('el respaldo del front es idéntico a commandMenu() (mismo orden y descripciones que Discord)', () => {
    expect(FALLBACK_MENU).toEqual(commandMenu());
    expect(FALLBACK_MENU.map((i) => i.subcommand)).toEqual(['tarea', 'ticket', 'status', 'plan', 'pulso', 'infra', 'junta']);
  });

  it('matchSlash: /, /roz, prefijos, subcomando elegido con texto y lo que no es comando', () => {
    const items = commandMenu() as any[];
    expect(matchSlash('/', items)!.items).toHaveLength(7);
    expect(matchSlash('/ro', items)!.items).toHaveLength(7);
    expect(matchSlash('/roz ', items)!.items).toHaveLength(7);
    expect(matchSlash('/p', items)!.items.map((i) => i.subcommand)).toEqual(['plan', 'pulso']);
    expect(matchSlash('/roz ta', items)!.items.map((i) => i.subcommand)).toEqual(['tarea']);
    expect(matchSlash('/roz tarea login roto', items)).toEqual({ items: [items[0]], rest: 'login roto' });
    expect(matchSlash('/ticket ', items)).toEqual({ items: [items[1]], rest: '' });
    expect(matchSlash('/shrug', items)).toBeNull();
    expect(matchSlash('/tareas algo', items)).toBeNull();
    expect(matchSlash('hola /roz', items)).toBeNull();
    expect(matchSlash('/roz tarea\notra línea', items)).toBeNull();
  });

  it('GET /commands devuelve el menú', async () => {
    const app = new Hono<RozContext>();
    app.use('*', async (c, next) => {
      c.set('user', { id: 'auth-ana', email: 'x@y', name: null, role: null, devId: ANA, devName: 'Ana', devActive: true } as any);
      await next();
    });
    app.route('/api/dashboard/discord', discordRoutes);
    const res = await app.request('/api/dashboard/discord/commands');
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual(commandMenu());
  });
});

describe('ejecutar desde roz', () => {
  it('/roz tarea: corre el handler con el actor y publica la ficha por el webhook (embeds, botones, menciones seguras)', async () => {
    const calls = happyDiscord();
    const run = vi.fn(async (ctx: any) => {
      expect(ctx.actor).toEqual(ACTOR);
      expect(ctx.options).toEqual({ buscar: TASK });
      expect(ctx.channelId).toBe(GENERAL);
      expect(ctx.interaction.token).toBe('');
      expect(ctx.interaction.member.user.id).toBe(U_ANA);
      const ficha = taskCardMessage({
        id: TASK,
        identifier: 'WAT-44',
        name: 'Login',
        status: 'en_progreso',
        priority: null,
        projectName: 'Portal',
        assignee: { name: 'Ana Pérez', avatarUrl: 'https://github.com/anagh.png?size=96' },
      });
      return R.publicMessage({ ...ficha, content: `<@${U_BETO}> @everyone`, mentionUserIds: [U_BETO] });
    });
    const registry = registryWith({ slash: { tarea: { defer: 'public', run } } });
    const viewer = await loadViewer(ANA);
    const res = await runCommandFromRoz(viewer, GENERAL, { subcommand: 'tarea', options: { buscar: TASK, extra: 'x' } }, { registry, resolveActor: resolveAna });
    await settle();
    expect(run).toHaveBeenCalledOnce();
    expect(res.ephemeral).toEqual([]);
    expect(res.published).toHaveLength(1);
    // En el espejo, la ficha V2 queda aplanada en UN embed (lo que pinta el chat de roz).
    expect(res.published[0]!.embeds[0]).toMatchObject({ color: 0xff5b23, thumbnail: { url: 'https://github.com/anagh.png?size=96' } });
    expect(res.published[0]!.embeds[0]!.description).toContain('**Login**\n`WAT-44` · 🟢 En curso');

    const post = calls.find((c: DiscordCall) => c.method === 'POST' && c.path.startsWith('/webhooks/'))!;
    expect(post.query.get('with_components')).toBe('true');
    expect(post.json.username).toBe('Ana Pérez');
    // Components V2: sin content ni embeds; el texto suelto va como primer texto del Container.
    expect(post.json.flags).toBe(1 << 15);
    expect(post.json.content).toBeUndefined();
    expect(post.json.embeds).toBeUndefined();
    expect(post.json.components[0].type).toBe(17);
    expect(textOf(post.json)).toMatch(new RegExp(`^<@${U_BETO}> @everyone\\n\\n\\*\\*Login\\*\\*`));
    // Sin DASHBOARD_URL pública en esta prueba: sin botón "Abrir" (solo Tomar).
    expect(buttonsOf(post.json).map((b: any) => b.label)).toEqual(['Tomar']);
    expect(post.json.allowed_mentions).toMatchObject({ parse: [], roles: [], users: [U_BETO] });
    // Quedó en el espejo como mensaje del dev y se emitió.
    expect(h.fake.table('discord_message').find((m: any) => m.id === res.published[0]!.id)).toMatchObject({ dev_id: ANA });
    expect(h.broadcasts.some((b) => b.event === 'discord.message.created')).toBe(true);
  });

  it('/roz pulso: efímero → vuelve al front sin publicar nada (links de botones incluidos)', async () => {
    const calls = happyDiscord();
    const registry = registryWith({
      slash: { pulso: { defer: 'ephemeral', run: async () => R.ephemeral({ ...card('Equipo'), content: 'Pulso' }) } },
    });
    const res = await runCommandFromRoz(await loadViewer(ANA), GENERAL, { subcommand: 'pulso' }, { registry, resolveActor: resolveAna });
    expect(res.published).toEqual([]);
    expect(res.ephemeral).toEqual([
      { content: 'Pulso', embeds: [expect.objectContaining({ title: 'Equipo' })], links: [{ label: 'Abrir', url: 'https://roz.example.com/app/tasks' }] },
    ]);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('/roz status: status.elegir con los ids; la nota va como texto del followup público; el update queda efímero', async () => {
    const calls = happyDiscord();
    const run = vi.fn(async (ctx: any) => {
      expect(ctx.values).toEqual([TASK, TASK2]);
      expect(ctx.customId).toEqual({ action: 'status.elegir', args: [] });
      return R.updateMessage('Publicado en el canal', [R.followup({ embeds: [{ title: 'Status de Ana' }] }, { ephemeral: false })]);
    });
    const registry = registryWith({ components: { 'status.elegir': { defer: 'update', run } } });
    const res = await runCommandFromRoz(
      await loadViewer(ANA),
      GENERAL,
      { subcommand: 'status', fields: { tareas: [TASK, TASK2, TASK], nota: 'Bloqueada por QA' } },
      { registry, resolveActor: resolveAna },
    );
    expect(res.published).toHaveLength(1);
    expect(res.ephemeral.map((e) => e.content)).toEqual(['Publicado en el canal']);
    const post = calls.find((c) => c.method === 'POST' && c.path.startsWith('/webhooks/'))!;
    expect(post.json.content).toBeUndefined();
    expect(post.json.flags).toBe(1 << 15);
    expect(textOf(post.json)).toBe('Bloqueada por QA\n\n**Status de Ana**');
  });

  it('/roz status valida: sin tareas, más de 25 o ids raros → 400 sin correr el handler', async () => {
    const run = vi.fn();
    const registry = registryWith({ components: { 'status.elegir': { defer: 'update', run } } });
    const viewer = await loadViewer(ANA);
    const opts = { registry, resolveActor: resolveAna };
    await expect(runCommandFromRoz(viewer, GENERAL, { subcommand: 'status', fields: { tareas: [] } }, opts)).rejects.toMatchObject({ status: 400 });
    const many = Array.from({ length: 26 }, (_, i) => `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`);
    await expect(runCommandFromRoz(viewer, GENERAL, { subcommand: 'status', fields: { tareas: many } }, opts)).rejects.toMatchObject({ status: 400 });
    await expect(runCommandFromRoz(viewer, GENERAL, { subcommand: 'status', fields: { tareas: ['x'] } }, opts)).rejects.toMatchObject({ status: 400 });
    expect(run).not.toHaveBeenCalled();
  });

  it('/roz ticket: ticket.modal con titulo/descripcion y el proyecto como argumento; responde público', async () => {
    happyDiscord();
    const run = vi.fn(async (ctx: any) => {
      expect(ctx.customId).toEqual({ action: 'ticket.modal', args: [PROJECT] });
      expect(ctx.fields).toEqual({ titulo: 'Login roto', descripcion: 'No entra', proyecto: PROJECT });
      expect(ctx.interaction.type).toBe(5);
      return R.publicMessage({ content: 'Asignado a Beto', ...card('POR-7 · Login roto') });
    });
    const registry = registryWith({ modals: { 'ticket.modal': { defer: 'public', run } } });
    const res = await runCommandFromRoz(
      await loadViewer(ANA),
      GENERAL,
      { subcommand: 'ticket', options: { proyecto: PROJECT }, fields: { titulo: ' Login roto ', descripcion: 'No entra' } },
      { registry, resolveActor: resolveAna },
    );
    expect(res.published).toHaveLength(1);
    expect(run).toHaveBeenCalledOnce();
  });

  it('/roz ticket sin título o con proyecto que no es de la lista → 400', async () => {
    const registry = registryWith({ modals: { 'ticket.modal': { defer: 'public', run: vi.fn() } } });
    const viewer = await loadViewer(ANA);
    const opts = { registry, resolveActor: resolveAna };
    await expect(runCommandFromRoz(viewer, GENERAL, { subcommand: 'ticket', fields: { titulo: '  ' } }, opts)).rejects.toMatchObject({ status: 400 });
    await expect(runCommandFromRoz(viewer, GENERAL, { subcommand: 'ticket', options: { proyecto: 'Portal' }, fields: { titulo: 'x' } }, opts)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('/roz junta: junta.modal sin proyecto → arg null; la confirmación es efímera', async () => {
    const calls = happyDiscord();
    const run = vi.fn(async (ctx: any) => {
      expect(ctx.customId).toEqual({ action: 'junta.modal', args: [null] });
      expect(ctx.fields).toEqual({ titulo: 'Kickoff', notas: 'Notas' });
      return R.ephemeral('Lista en la bandeja de Juntas');
    });
    const registry = registryWith({ modals: { 'junta.modal': { defer: 'ephemeral', run } } });
    // Junta no publica: funciona aunque el canal no admita escribir (p. ej. voz).
    const res = await runCommandFromRoz(await loadViewer(ANA), VOICE, { subcommand: 'junta', fields: { titulo: 'Kickoff', notas: 'Notas' } }, { registry, resolveActor: resolveAna });
    expect(res).toEqual({ published: [], ephemeral: [{ content: 'Lista en la bandeja de Juntas', embeds: [], links: [] }] });
    expect(calls).toEqual([]);
  });

  it('opción requerida faltante → 400; canal que no ve → 404; canal donde no se puede publicar → error ANTES del handler', async () => {
    const run = vi.fn(async () => R.publicMessage('x'));
    const registry = registryWith({ slash: { tarea: { defer: 'public', run } } });
    const viewer = await loadViewer(ANA);
    const opts = { registry, resolveActor: resolveAna };
    await expect(runCommandFromRoz(viewer, GENERAL, { subcommand: 'tarea', options: {} }, opts)).rejects.toMatchObject({ status: 400 });
    await expect(runCommandFromRoz(viewer, SECRET, { subcommand: 'tarea', options: { buscar: 'x' } }, opts)).rejects.toMatchObject({ status: 404 });
    await expect(runCommandFromRoz(viewer, VOICE, { subcommand: 'tarea', options: { buscar: 'x' } }, opts)).rejects.toMatchObject({
      code: 'DISCORD_CHANNEL_UNSUPPORTED',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('identidad: sin vínculo resoluble → DISCORD_NOT_LINKED; vínculo de otra persona → 403', async () => {
    const registry = registryWith({ slash: { pulso: { defer: 'ephemeral', run: vi.fn() } } });
    const viewer = await loadViewer(ANA);
    await expect(runCommandFromRoz(viewer, GENERAL, { subcommand: 'pulso' }, { registry, resolveActor: async () => null })).rejects.toMatchObject({
      code: 'DISCORD_NOT_LINKED',
    });
    await expect(
      runCommandFromRoz(viewer, GENERAL, { subcommand: 'pulso' }, { registry, resolveActor: async () => ({ ...ACTOR, devId: BETO }) }),
    ).rejects.toMatchObject({ code: 'DISCORD_COMMAND_IDENTITY', status: 403 });
  });

  it('un handler que pide otro modal no se puede completar desde roz; los AppError del handler pasan tal cual', async () => {
    const viewer = await loadViewer(ANA);
    const modalReg = registryWith({ slash: { plan: { defer: 'ephemeral', run: async () => R.openModal(R.modal('roz1:junta.modal:_', 'x', [])) } } });
    await expect(runCommandFromRoz(viewer, GENERAL, { subcommand: 'plan' }, { registry: modalReg, resolveActor: resolveAna })).rejects.toMatchObject({
      code: 'DISCORD_COMMAND_UNSUPPORTED',
    });
    const errReg = registryWith({
      slash: { plan: { defer: 'ephemeral', run: async () => { throw new AppError('FORBIDDEN', 'Solo el dueño puede aprobar', 403); } } },
    });
    await expect(runCommandFromRoz(viewer, GENERAL, { subcommand: 'plan' }, { registry: errReg, resolveActor: resolveAna })).rejects.toMatchObject({
      message: 'Solo el dueño puede aprobar',
    });
  });

  it('/roz plan con issue publica; sin issue solo efímero aunque el handler devuelva público', async () => {
    happyDiscord();
    const registry = registryWith({ slash: { plan: { defer: 'public', run: async () => R.publicMessage({ embeds: [{ title: 'Plan' }] }) } } });
    const viewer = await loadViewer(ANA);
    const withIssue = await runCommandFromRoz(viewer, GENERAL, { subcommand: 'plan', options: { issue: 'WAT-44' } }, { registry, resolveActor: resolveAna });
    expect(withIssue.published).toHaveLength(1);
    const mine = await runCommandFromRoz(viewer, GENERAL, { subcommand: 'plan' }, { registry, resolveActor: resolveAna });
    expect(mine.published).toEqual([]);
    expect(mine.ephemeral[0]!.embeds[0]).toMatchObject({ title: 'Plan' });
  });

  it('ruta POST /channels/:id/commands: cuerpo inválido 400; validación del servicio 400 con su mensaje; canal ajeno 404', async () => {
    const app = new Hono<RozContext>();
    app.use('*', async (c, next) => {
      c.set('user', { id: 'auth-ana', email: 'x@y', name: null, role: null, devId: ANA, devName: 'Ana', devActive: true } as any);
      await next();
    });
    app.route('/api/dashboard/discord', discordRoutes);
    const bad = await app.request(`/api/dashboard/discord/channels/${GENERAL}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subcommand: 'nada' }),
    });
    expect(bad.status).toBe(400);
    const ok = await app.request(`/api/dashboard/discord/channels/${GENERAL}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subcommand: 'status', fields: { tareas: [] } }),
    });
    expect(ok.status).toBe(400);
    expect((await ok.json()).error.message).toMatch(/al menos una tarea/);
    const hidden = await app.request(`/api/dashboard/discord/channels/${SECRET}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subcommand: 'pulso' }) });
    expect(hidden.status).toBe(404);
  });
});

describe('autocompletado desde roz', () => {
  it('usa el autocomplete del handler con el actor y las demás opciones; recorta y quita el choice de "liga tu cuenta"', async () => {
    const autocomplete = vi.fn(async (ctx: any) => {
      expect(ctx.focused).toEqual({ name: 'buscar', value: 'login' });
      expect(ctx.options).toEqual({ persona: BETO });
      return [
        { name: 'WAT-44 · Login', value: TASK },
        { name: 'x', value: R.NOT_LINKED_CHOICE_VALUE },
        ...Array.from({ length: 30 }, (_, i) => ({ name: `t${i}`, value: `v${i}` })),
      ];
    });
    const registry = registryWith({ slash: { tarea: { defer: 'public', run: vi.fn(), autocomplete } } });
    const choices = await autocompleteFromRoz(
      await loadViewer(ANA),
      GENERAL,
      { subcommand: 'tarea', option: 'buscar', value: 'login', options: { persona: BETO, buscar: 'ignorado' } },
      { registry, resolveActor: resolveAna },
    );
    expect(choices[0]).toEqual({ name: 'WAT-44 · Login', value: TASK });
    expect(choices.some((c) => c.value === R.NOT_LINKED_CHOICE_VALUE)).toBe(false);
    expect(choices.length).toBeLessThanOrEqual(25);
  });

  it('opción sin autocompletado o handler sin autocomplete → []', async () => {
    const registry = registryWith({ slash: { tarea: { defer: 'public', run: vi.fn() } } });
    const viewer = await loadViewer(ANA);
    expect(await autocompleteFromRoz(viewer, GENERAL, { subcommand: 'tarea', option: 'buscar', value: 'x' }, { registry, resolveActor: resolveAna })).toEqual([]);
    expect(await autocompleteFromRoz(viewer, GENERAL, { subcommand: 'status', option: 'nada', value: 'x' }, { registry, resolveActor: resolveAna })).toEqual([]);
  });
});

describe('piezas', () => {
  it('cleanOptions: solo las definidas, recortadas a max_length', () => {
    expect(cleanOptions('pulso', { persona: '  Ana ', otra: 'x' })).toEqual({ persona: 'Ana' });
    expect(cleanOptions('tarea', { buscar: 'a'.repeat(300) }).buscar).toHaveLength(100);
    expect(() => cleanOptions('tarea', {})).toThrow();
  });

  it('ephemeralView: solo links http(s) de los botones de enlace', () => {
    const v = ephemeralView({
      content: 'hola',
      components: [R.row(R.button({ label: 'Tomar', customId: `roz1:tarea.tomar:${TASK}` } as any) as any, { type: 2, style: 5, label: 'Mal', url: 'javascript:x' } as any)],
    });
    expect(v).toEqual({ content: 'hola', embeds: [], links: [] });
    expect(G).toBeTruthy();
  });

  it('ephemeralView de un mensaje V2: un embed aplanado ("### Título" → título) y sus enlaces', () => {
    const v = ephemeralView({
      components: [
        {
          type: 17,
          accent_color: 0xff5b23,
          components: [
            { type: 10, content: '### Infraestructura\n-# 2 servicios · 2 en línea' },
            { type: 10, content: '## 🟢 Todo en línea' },
            { type: 1, components: [{ type: 2, style: 5, label: 'Abrir infraestructura', url: 'https://roz.example.com/app/infra' }] },
          ],
        } as any,
      ],
    });
    expect(v.content).toBe('');
    expect(v.embeds).toHaveLength(1);
    expect(v.embeds[0]).toMatchObject({ title: 'Infraestructura', color: 0xff5b23 });
    expect(v.embeds[0]!.description).toBe('2 servicios · 2 en línea\n\n**🟢 Todo en línea**');
    expect(v.links).toEqual([{ label: 'Abrir infraestructura', url: 'https://roz.example.com/app/infra' }]);
  });
});
