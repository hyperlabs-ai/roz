import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ANA, APP, G, GENERAL, U_ANA, U_CARLA, createDiscordDb, seedGuild } from './discord-fixture.js';

// Router de interacciones de Discord (docs/discord-commands-contract.md): servidor, identidad,
// despacho por tipo, presupuesto de 3 s (inmediato vs diferido), completar lo diferido con el token
// (con Discord simulado por `fetch`), followups, y la ruta POST /v1/internal/discord/interactions.

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
  process.env.DASHBOARD_URL = 'https://roz.example.com';
  return { fake: null as any, background: [] as Promise<unknown>[] };
});

vi.mock('../src/db/supabase.js', () => ({ db: () => h.fake, dbPublic: () => h.fake }));
vi.mock('../src/utils/background.js', () => ({
  inBackground: (task: () => Promise<unknown>, onError?: (e: unknown) => void) => {
    h.background.push(Promise.resolve().then(task).catch((e) => onError?.(e)));
  },
}));

const { routeInteraction, resolveActor, inlineBudgetMs, readSubcommand, INLINE_BUDGET_MS } = await import('../src/discord/commands/router.js');
const { buildRegistry } = await import('../src/discord/commands/registry.js');
const { buildCustomId } = await import('../src/discord/commands/custom-id.js');
const R = await import('../src/discord/commands/respond.js');
const { publicBaseUrl, rozBotImage, appLink } = await import('../src/discord/commands/links.js');
const { taskCardMessage, ROZ_ORANGE, planSteps } = await import('../src/discord/commands/embeds.js');
const { routeKey, __resetDiscordRateLimits } = await import('../src/adapters/discord.js');
const { AppError } = await import('../src/utils/errors.js');
const { internalRoutes } = await import('../src/routes/internal.js');
type Registry = import('../src/discord/commands/registry.js').Registry;
type CommandActor = import('../src/discord/commands/types.js').CommandActor;
type DiscordInteraction = import('../src/discord/commands/types.js').DiscordInteraction;

const { textOf, buttonsOf, ofType } = await import('./discord-v2-helpers.js');
/** IS_COMPONENTS_V2 y efímero + V2. */
const V2 = 1 << 15;
const EPH = V2 | 64;
const TOKEN = 'interaccion-token-SECRETO';
const UUID = '44444444-4444-4444-8444-444444444444';
const ACTOR: CommandActor = { devId: ANA, devName: 'Ana Pérez', githubLogin: 'anagh', authUserId: null, discordUserId: U_ANA };
const DISCORD_EPOCH = 1420070400000;

let seq = 0;
function snowflakeAt(ms: number): string {
  return ((BigInt(ms - DISCORD_EPOCH) << 22n) + BigInt(seq++)).toString();
}

function interaction(over: Partial<DiscordInteraction> = {}): DiscordInteraction {
  return {
    id: snowflakeAt(Date.now()),
    application_id: APP,
    type: 2,
    token: TOKEN,
    guild_id: G,
    channel_id: GENERAL,
    member: { user: { id: U_ANA, username: 'ana' } },
    ...over,
  };
}

const slash = (sub: string, options: { name: string; value: string; focused?: boolean }[] = []) => ({
  type: 1,
  name: 'roz',
  options: [{ type: 1, name: sub, options: options.map((o) => ({ type: 3, ...o })) }],
});

const env = (i: DiscordInteraction) => ({ guildId: G, interaction: i });
const sleep = vi.fn(async () => {});
const actorFor = async (id: string) => (id === U_ANA ? ACTOR : null);
const deps = (registry: Registry, over: Record<string, unknown> = {}) => ({ registry, resolveActor: actorFor, budgetMs: 50, sleep, ...over });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Discord simulado
interface Call {
  method: string;
  path: string;
  body: any;
}
let calls: Call[] = [];
let failFirst = 0;
beforeEach(() => {
  calls = [];
  failFirst = 0;
  sleep.mockClear();
  h.background = [];
  __resetDiscordRateLimits();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const call = { method: String(init.method), path: u.pathname.replace('/api/v10', '') + u.search, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (failFirst > 0) {
      failFirst--;
      return new Response(JSON.stringify({ code: 10015, message: 'Unknown Webhook' }), { status: 404 });
    }
    return new Response(JSON.stringify({ id: '600000000000000001', channel_id: GENERAL, content: call.body?.content ?? '' }), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('registro de handlers', () => {
  it('cada subcomando, acción de mensaje y custom_id tiene exactamente un handler', () => {
    expect(buildRegistry().problems).toEqual([]);
  });

  it('detecta duplicados y dueños equivocados', () => {
    const { problems } = buildRegistry({
      a: { slash: { tarea: { defer: 'public', run: async () => R.ephemeral('x') } } },
      b: { slash: { tarea: { defer: 'public', run: async () => R.ephemeral('x') } }, components: { 'plan.aprobar': { defer: 'update', run: async () => R.ephemeral('x') } } },
    });
    expect(problems.join('\n')).toMatch(/subcomando tarea: definido dos veces/);
    expect(problems.join('\n')).toMatch(/plan.aprobar: su dueño es plan, no b/);
    expect(problems.join('\n')).toMatch(/subcomando status: sin handler/);
  });
});

describe('servidor e identidad', () => {
  const registry: Registry = { slash: { status: { defer: 'ephemeral', run: async () => R.publicMessage('hola') } }, message: {}, components: {}, modals: {} };

  it('PING → PONG', async () => {
    const out = await routeInteraction(env(interaction({ type: 1 })), deps(registry));
    expect(out.callback).toEqual({ type: 1 });
  });

  it('otro servidor u otra app: efímero, sin resolver identidad ni ejecutar', async () => {
    const resolve = vi.fn(actorFor);
    const a = await routeInteraction(env(interaction({ guild_id: '100000000000000999', data: slash('status') })), deps(registry, { resolveActor: resolve }));
    expect(a.callback.type).toBe(4);
    expect(a.callback.data!.flags).toBe(EPH);
    expect(textOf(a.callback.data as any)).toMatch(/servidor de la empresa/);
    const b = await routeInteraction(env(interaction({ application_id: '900000000000000777', data: slash('status') })), deps(registry, { resolveActor: resolve }));
    expect(b.callback.data!.flags).toBe(EPH);
    const c = await routeInteraction(env(interaction({ guild_id: undefined, data: slash('status') })), deps(registry, { resolveActor: resolve }));
    expect(c.callback.data!.flags).toBe(EPH);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('sin cuenta ligada: efímero con el botón a Configuración, nada se ejecuta', async () => {
    const run = vi.fn(async () => R.publicMessage('no debería'));
    const reg: Registry = { ...registry, slash: { status: { defer: 'ephemeral', run } } };
    const out = await routeInteraction(env(interaction({ member: { user: { id: U_CARLA, username: 'carla' } }, data: slash('status') })), deps(reg));
    expect(run).not.toHaveBeenCalled();
    expect(out.callback.type).toBe(4);
    expect(out.callback.data!.flags).toBe(EPH);
    expect(textOf(out.callback.data as any)).toMatch(/no está ligada a roz/);
    expect(JSON.stringify(out.callback.data!.components)).toContain('https://roz.example.com/app/settings');
  });

  it('sin cuenta ligada en autocompletado: un único choice que lo explica', async () => {
    const out = await routeInteraction(
      env(interaction({ type: 4, member: { user: { id: U_CARLA, username: 'carla' } }, data: slash('tarea', [{ name: 'buscar', value: 'lo', focused: true }]) })),
      deps(registry),
    );
    expect(out.callback.type).toBe(8);
    expect((out.callback.data!.choices as any[]).map((c) => c.value)).toEqual([R.NOT_LINKED_CHOICE_VALUE]);
  });

  it('resolveActor: dev ligado y activo; sin vínculo o inactivo → null', async () => {
    h.fake = createDiscordDb();
    seedGuild(h.fake);
    expect(await resolveActor(U_ANA)).toEqual({ devId: ANA, devName: 'Ana Pérez', githubLogin: 'anagh', authUserId: null, discordUserId: U_ANA });
    expect(await resolveActor(U_CARLA)).toBeNull();
    h.fake.table('dev').find((d: any) => d.id === ANA).active = false;
    expect(await resolveActor(U_ANA)).toBeNull();
  });
});

describe('comandos de barra', () => {
  it('rápido y público → type 4 sin flag, con allowed_mentions seguro y el contexto armado', async () => {
    let seen: any = null;
    const reg: Registry = {
      slash: {
        tarea: {
          defer: 'public',
          run: async (ctx) => {
            seen = { sub: ctx.subcommand, options: ctx.options, actor: ctx.actor.devId, channel: ctx.channelId };
            return R.publicMessage({ content: 'hola <@200000000000000002> @everyone', mentionUserIds: ['200000000000000002'] });
          },
        },
      },
      message: {},
      components: {},
      modals: {},
    };
    const out = await routeInteraction(env(interaction({ data: slash('tarea', [{ name: 'buscar', value: 'WAT-44' }, { name: 'persona', value: ANA }]) })), deps(reg));
    expect(seen).toEqual({ sub: 'tarea', options: { buscar: 'WAT-44', persona: ANA }, actor: ANA, channel: GENERAL });
    expect(out.callback.type).toBe(4);
    expect(out.callback.data!.flags).toBe(V2);
    expect(out.callback.data!.content).toBeUndefined();
    expect(textOf(out.callback.data as any)).toBe('hola <@200000000000000002> @everyone');
    expect(out.callback.data!.allowed_mentions).toEqual({ parse: [], users: ['200000000000000002'], roles: [], replied_user: false });
    expect(out.after).toBeNull();
  });

  it('lento con defer public → type 5 y después edita el original con el token', async () => {
    const reg: Registry = { slash: { tarea: { defer: 'public', run: async () => (await wait(80), R.publicMessage('ficha lista')) } }, message: {}, components: {}, modals: {} };
    const out = await routeInteraction(env(interaction({ data: slash('tarea', [{ name: 'buscar', value: 'x' }]) })), deps(reg));
    expect(out.callback).toEqual({ type: 5 });
    await out.after!();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.path).toMatch(new RegExp(`^/webhooks/${APP}/${TOKEN}/messages/@original`));
    expect(textOf(calls[0]!.body)).toBe('ficha lista');
    // Editar con IS_COMPONENTS_V2 exige vaciar content y embeds.
    expect(calls[0]!.body).toMatchObject({ flags: V2, content: null, embeds: [] });
    expect(calls[0]!.path).toContain('with_components=true');
  });

  it('lento con defer ephemeral → type 5 efímero', async () => {
    const reg: Registry = { slash: { pulso: { defer: 'ephemeral', run: async () => (await wait(80), R.ephemeral('pulso')) } }, message: {}, components: {}, modals: {} };
    const out = await routeInteraction(env(interaction({ data: slash('pulso') })), deps(reg));
    expect(out.callback).toEqual({ type: 5, data: { flags: 64 } });
  });

  it('defer calculado del contexto (plan con issue → público, sin issue → efímero)', async () => {
    const run = async () => (await wait(80), R.ephemeral('x'));
    const reg: Registry = { slash: { plan: { defer: (ctx) => (ctx.options.issue ? 'public' : 'ephemeral'), run } }, message: {}, components: {}, modals: {} };
    expect((await routeInteraction(env(interaction({ data: slash('plan', [{ name: 'issue', value: 'WAT-44' }]) })), deps(reg))).callback).toEqual({ type: 5 });
    expect((await routeInteraction(env(interaction({ data: slash('plan') })), deps(reg))).callback).toEqual({ type: 5, data: { flags: 64 } });
  });

  it('el PATCH diferido reintenta si llega antes que el callback del puente (10015)', async () => {
    const reg: Registry = { slash: { status: { defer: 'ephemeral', run: async () => (await wait(80), R.ephemeral('ok')) } }, message: {}, components: {}, modals: {} };
    const out = await routeInteraction(env(interaction({ data: slash('status') })), deps(reg));
    failFirst = 2;
    await out.after!();
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(3);
    // Diferido efímero: al editar se repite el bit efímero junto con IS_COMPONENTS_V2.
    expect(calls.at(-1)!.body.flags).toBe(EPH);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('modal: primera respuesta type 9 con su custom_id', async () => {
    const reg: Registry = {
      slash: {
        ticket: {
          defer: 'never',
          run: async () =>
            R.openModal(R.modal(buildCustomId('ticket.modal', null), 'Nuevo ticket', [R.textField({ customId: 'titulo', label: 'Título', maxLength: 200 })])),
        },
      },
      message: {},
      components: {},
      modals: {},
    };
    const out = await routeInteraction(env(interaction({ data: slash('ticket') })), deps(reg));
    expect(out.callback.type).toBe(9);
    expect(out.callback.data!.custom_id).toBe('roz1:ticket.modal:_');
    expect((out.callback.data!.components as any[])[0]).toMatchObject({ type: 18, label: 'Título', component: { type: 4, custom_id: 'titulo', max_length: 200 } });
  });

  it('defer never que se pasa del tiempo → efímero "tardó", sin diferir', async () => {
    const reg: Registry = { slash: { junta: { defer: 'never', run: async () => (await wait(80), R.ephemeral('tarde')) } }, message: {}, components: {}, modals: {} };
    const out = await routeInteraction(env(interaction({ data: slash('junta') })), deps(reg));
    expect(out.callback.type).toBe(4);
    expect(out.callback.data!.flags).toBe(EPH);
    expect(textOf(out.callback.data as any)).toMatch(/tardó/);
    expect(out.after).toBeNull();
  });

  it('errores: AppError < 500 muestra su mensaje; lo demás un texto genérico sin detalle', async () => {
    const reg = (err: unknown): Registry => ({ slash: { infra: { defer: 'ephemeral', run: async () => { throw err; } } }, message: {}, components: {}, modals: {} });
    const a = await routeInteraction(env(interaction({ data: slash('infra') })), deps(reg(new AppError('PLAN_FORBIDDEN', 'solo el dueño puede aprobar', 403))));
    expect(a.callback.data!.flags).toBe(EPH);
    expect(textOf(a.callback.data as any)).toBe('🔴 No se pudo: solo el dueño puede aprobar');
    const b = await routeInteraction(env(interaction({ data: slash('infra') })), deps(reg(new Error(`fallo con ${TOKEN}`))));
    expect(b.callback.data!.flags).toBe(EPH);
    expect(textOf(b.callback.data as any)).not.toContain(TOKEN);
  });

  it('subcomando desconocido o sin handler → efímero', async () => {
    const out = await routeInteraction(env(interaction({ data: slash('borrar-todo') })), deps({ slash: {}, message: {}, components: {}, modals: {} }));
    expect(out.callback.data!.flags).toBe(EPH);
  });

  it('followups de una respuesta inmediata salen después con el mismo token', async () => {
    const reg: Registry = {
      slash: { status: { defer: 'ephemeral', run: async () => R.ephemeral('listo', [R.followup('para el canal', { ephemeral: false }), R.followup('solo tú', { ephemeral: true })]) } },
      message: {},
      components: {},
      modals: {},
    };
    const out = await routeInteraction(env(interaction({ data: slash('status') })), deps(reg));
    expect(out.callback.data!.flags).toBe(EPH);
    expect(textOf(out.callback.data as any)).toBe('listo');
    await out.after!();
    expect(calls.map((c) => [c.method, c.path.split('?')[0], textOf(c.body), c.body.flags])).toEqual([
      ['POST', `/webhooks/${APP}/${TOKEN}`, 'para el canal', V2],
      ['POST', `/webhooks/${APP}/${TOKEN}`, 'solo tú', EPH],
    ]);
  });
});

describe('autocompletado', () => {
  it('pasa la opción enfocada y las demás; recorta a 25 y a 100 caracteres', async () => {
    let seen: any = null;
    const reg: Registry = {
      slash: {
        tarea: {
          defer: 'public',
          run: async () => R.ephemeral('x'),
          autocomplete: async (ctx) => {
            seen = { focused: ctx.focused, options: ctx.options };
            return Array.from({ length: 40 }, (_, n) => ({ name: `${'T'.repeat(120)}${n}`, value: `v${n}` }));
          },
        },
      },
      message: {},
      components: {},
      modals: {},
    };
    const out = await routeInteraction(
      env(interaction({ type: 4, data: slash('tarea', [{ name: 'buscar', value: 'log', focused: true }, { name: 'persona', value: ANA }]) })),
      deps(reg),
    );
    expect(seen).toEqual({ focused: { name: 'buscar', value: 'log' }, options: { persona: ANA } });
    const list = out.callback.data!.choices as { name: string; value: string }[];
    expect(out.callback.type).toBe(8);
    expect(list).toHaveLength(25);
    expect(list.every((c) => c.name.length <= 100)).toBe(true);
  });

  it('si tarda o falla, vuelve vacío (nunca deja colgado el desplegable)', async () => {
    const slow: Registry = { slash: { pulso: { defer: 'ephemeral', run: async () => R.ephemeral('x'), autocomplete: async () => (await wait(80), [{ name: 'a', value: 'a' }]) } }, message: {}, components: {}, modals: {} };
    const out = await routeInteraction(env(interaction({ type: 4, data: slash('pulso', [{ name: 'persona', value: '', focused: true }]) })), deps(slow));
    expect(out.callback).toEqual({ type: 8, data: { choices: [] } });
    const broken: Registry = { slash: { pulso: { defer: 'ephemeral', run: async () => R.ephemeral('x'), autocomplete: async () => { throw new Error('x'); } } }, message: {}, components: {}, modals: {} };
    const out2 = await routeInteraction(env(interaction({ type: 4, data: slash('pulso', [{ name: 'persona', value: '', focused: true }]) })), deps(broken));
    expect(out2.callback).toEqual({ type: 8, data: { choices: [] } });
  });
});

describe('componentes y modales', () => {
  const message = { id: '600000000000000001', channel_id: GENERAL } as any;

  it('botón: custom_id leído y `update` → type 7', async () => {
    let seen: any = null;
    const reg: Registry = {
      slash: {},
      message: {},
      components: { 'tarea.tomar': { defer: 'update', run: async (ctx) => ((seen = ctx.customId), R.updateMessage('tomada')) } },
      modals: {},
    };
    const out = await routeInteraction(env(interaction({ type: 3, message, data: { custom_id: buildCustomId('tarea.tomar', UUID), component_type: 2 } })), deps(reg));
    expect(seen).toEqual({ action: 'tarea.tomar', args: [UUID] });
    expect(out.callback.type).toBe(7);
    expect(textOf(out.callback.data as any)).toBe('tomada');
    // type 7 edita el mensaje: una ficha vieja con embeds se convierte a V2 vaciando content/embeds.
    expect(out.callback.data).toMatchObject({ flags: V2, content: null, embeds: [] });
  });

  it('select: values; lento con defer update → type 6 y edita el mensaje del componente', async () => {
    let values: string[] = [];
    const reg: Registry = {
      slash: {},
      message: {},
      components: { 'tarea.estado': { defer: 'update', run: async (ctx) => ((values = ctx.values), await wait(80), R.updateMessage('en curso')) } },
      modals: {},
    };
    const out = await routeInteraction(env(interaction({ type: 3, message, data: { custom_id: buildCustomId('tarea.estado', UUID), component_type: 3, values: ['en_progreso'] } })), deps(reg));
    expect(values).toEqual(['en_progreso']);
    expect(out.callback).toEqual({ type: 6 });
    await out.after!();
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { flags: V2, content: null, embeds: [] } });
    expect(textOf(calls[0]!.body)).toBe('en curso');
  });

  it('diferido como update pero el handler devuelve un mensaje nuevo → followup', async () => {
    const reg: Registry = {
      slash: {},
      message: {},
      components: { 'status.elegir': { defer: 'update', run: async () => (await wait(80), R.publicMessage('status publicado')) } },
      modals: {},
    };
    const out = await routeInteraction(env(interaction({ type: 3, message, data: { custom_id: buildCustomId('status.elegir'), values: [UUID] } })), deps(reg));
    await out.after!();
    expect(calls[0]!.method).toBe('POST');
    expect(textOf(calls[0]!.body)).toBe('status publicado');
    expect(calls[0]!.body.flags).toBe(V2);
  });

  it('custom_id de otra versión, ajeno o sin handler → efímero, no se ejecuta nada', async () => {
    const run = vi.fn(async () => R.updateMessage('x'));
    const reg: Registry = { slash: {}, message: {}, components: { 'tarea.tomar': { defer: 'update', run } }, modals: {} };
    const old = await routeInteraction(env(interaction({ type: 3, message, data: { custom_id: `roz0:tarea.tomar:${UUID}` } })), deps(reg));
    expect(textOf(old.callback.data as any)).toMatch(/versión anterior/);
    const foreign = await routeInteraction(env(interaction({ type: 3, message, data: { custom_id: 'otra:cosa' } })), deps(reg));
    expect(foreign.callback.data!.flags).toBe(EPH);
    const noHandler = await routeInteraction(env(interaction({ type: 3, message, data: { custom_id: buildCustomId('plan.aprobar', UUID) } })), deps(reg));
    expect(noHandler.callback.data!.flags).toBe(EPH);
    // Un custom_id de modal usado como botón tampoco se ejecuta.
    const wrongSurface = await routeInteraction(env(interaction({ type: 3, message, data: { custom_id: buildCustomId('ticket.modal', null) } })), deps(reg));
    expect(wrongSurface.callback.data!.flags).toBe(EPH);
    expect(run).not.toHaveBeenCalled();
  });

  it('modal: campos de la forma nueva (Label) y vieja (fila), selects como arreglo', async () => {
    let fields: any = null;
    const reg: Registry = {
      slash: {},
      message: {},
      components: {},
      modals: { 'ticket.modal': { defer: 'public', run: async (ctx) => ((fields = { f: ctx.fields, args: ctx.customId.args }), R.publicMessage('creado')) } },
    };
    const out = await routeInteraction(
      env(
        interaction({
          type: 5,
          data: {
            custom_id: buildCustomId('ticket.modal', UUID),
            components: [
              { type: 18, component: { type: 4, custom_id: 'titulo', value: 'Arreglar login' } },
              { type: 1, components: [{ type: 4, custom_id: 'descripcion', value: 'falla con Google' }] },
              { type: 18, component: { type: 3, custom_id: 'proyecto', values: [UUID] } },
            ],
          },
        }),
      ),
      deps(reg),
    );
    expect(fields).toEqual({ f: { titulo: 'Arreglar login', descripcion: 'falla con Google', proyecto: [UUID] }, args: [UUID] });
    expect(out.callback.type).toBe(4);
    expect(textOf(out.callback.data as any)).toBe('creado');
  });

  it('un modal no puede responder con otro modal', async () => {
    const reg: Registry = {
      slash: {},
      message: {},
      components: {},
      modals: { 'junta.modal': { defer: 'ephemeral', run: async () => R.openModal(R.modal(buildCustomId('junta.modal', null), 'x', [])) } },
    };
    const out = await routeInteraction(env(interaction({ type: 5, data: { custom_id: buildCustomId('junta.modal', null), components: [] } })), deps(reg));
    expect(out.callback.type).toBe(4);
    expect(out.callback.data!.flags).toBe(EPH);
  });
});

describe('acciones de mensaje', () => {
  const target = { id: '600000000000000077', channel_id: GENERAL, content: 'arreglen WAT-44 porfa' } as any;
  const data = (name: string, withTarget = true) => ({
    type: 3,
    name,
    target_id: target.id,
    resolved: withTarget ? { messages: { [target.id]: target } } : {},
  });

  it('despacha por el nombre visible con el mensaje resuelto', async () => {
    let seen: any = null;
    const reg: Registry = {
      slash: {},
      message: { 'citar-tareas': { defer: 'public', run: async (ctx) => ((seen = { cmd: ctx.command, text: ctx.target.content }), R.publicMessage('fichas')) } },
      components: {},
      modals: {},
    };
    const out = await routeInteraction(env(interaction({ data: data('Citar tareas') })), deps(reg));
    expect(seen).toEqual({ cmd: 'citar-tareas', text: 'arreglen WAT-44 porfa' });
    expect(out.callback.type).toBe(4);
  });

  it('sin mensaje resuelto o nombre desconocido → efímero', async () => {
    const reg: Registry = { slash: {}, message: { 'citar-tareas': { defer: 'public', run: async () => R.publicMessage('x') } }, components: {}, modals: {} };
    expect((await routeInteraction(env(interaction({ data: data('Citar tareas', false) })), deps(reg))).callback.data!.flags).toBe(EPH);
    expect((await routeInteraction(env(interaction({ data: data('Borrar todo') })), deps(reg))).callback.data!.flags).toBe(EPH);
  });
});

describe('presupuesto de tiempo', () => {
  it('descuenta lo que ya pasó desde que Discord creó la interacción', () => {
    const now = Date.now();
    expect(inlineBudgetMs(snowflakeAt(now - 500), now)).toBe(1700);
    expect(inlineBudgetMs(snowflakeAt(now - 2500), now)).toBe(0);
    expect(inlineBudgetMs(snowflakeAt(now - 50), now)).toBe(INLINE_BUDGET_MS);
    // Reloj no creíble (interacción "del futuro" o de hace horas): tope fijo.
    expect(inlineBudgetMs(snowflakeAt(now + 5000), now)).toBe(INLINE_BUDGET_MS);
    expect(inlineBudgetMs(snowflakeAt(now - 3_600_000), now)).toBe(INLINE_BUDGET_MS);
  });

  it('readSubcommand separa la opción enfocada', () => {
    expect(readSubcommand(slash('tarea', [{ name: 'buscar', value: 'x', focused: true }, { name: 'persona', value: 'y' }]).options as any)).toEqual({
      name: 'tarea',
      values: { persona: 'y' },
      focused: { name: 'buscar', value: 'x' },
    });
  });
});

describe('seguridad y enlaces', () => {
  it('el token de la interacción nunca queda en la llave de ruta (logs/errores)', () => {
    expect(routeKey(`/interactions/1300000000000000001/${TOKEN}/callback`).route).toBe('/interactions/:id/:token/callback');
    expect(routeKey(`/webhooks/${APP}/${TOKEN}/messages/@original`).route).toBe(`/webhooks/${APP}/:token/messages/@original`);
  });

  it('enlaces y miniaturas solo con URL pública', () => {
    expect(publicBaseUrl('http://localhost:3000')).toBeNull();
    expect(publicBaseUrl('http://127.0.0.1:5173')).toBeNull();
    expect(publicBaseUrl('')).toBeNull();
    expect(publicBaseUrl('https://roz.example.com/')).toBe('https://roz.example.com');
    expect(rozBotImage('alert', null)).toBeNull();
    expect(rozBotImage('happy')).toBe('https://roz.example.com/brand/roz-bot-happy.png');
    expect(appLink('/app/infra', null)).toBeNull();
  });

  it('ficha de tarea: color de roz, botones con custom_id válidos y menú de estados', () => {
    const msg = taskCardMessage({
      id: UUID,
      identifier: 'WAT-44',
      name: 'Arreglar login',
      status: 'en_progreso',
      priority: 'high',
      projectName: 'Portal',
      assignee: { name: 'Ana Pérez', avatarUrl: 'https://github.com/anagh.png?size=64' },
      linearUrl: 'https://linear.app/x/issue/WAT-44',
    });
    const [box] = ofType(msg, 17);
    expect(box.accent_color).toBe(ROZ_ORANGE);
    expect(msg.embeds).toBeUndefined();
    expect(textOf(msg)).toContain('**Arreglar login**');
    expect(textOf(msg)).toContain('`WAT-44` · 🟢 En curso · Prioridad alta · Ana Pérez');
    expect(textOf(msg)).toContain('-# Portal');
    expect(ofType(msg, 11)[0].media.url).toBe('https://github.com/anagh.png?size=64');
    expect(buttonsOf(msg).map((b) => b.label)).toEqual(['Tomar', 'Abrir', 'Linear']);
    expect(buttonsOf(msg)[1].url).toBe(`https://roz.example.com/app/tasks?task=${UUID}`);
    const json = JSON.stringify(msg.components);
    expect(json).toContain(`roz1:tarea.tomar:${UUID}`);
    expect(json).toContain(`roz1:tarea.estado:${UUID}`);
    expect(json).toContain('"default":true');
  });

  it('planSteps toma los renglones de lista del PLAN.md', () => {
    expect(planSteps('# Plan\n\n1. Leer el código\n2) Cambiar X\n- Probar\ntexto')).toEqual(['Leer el código', 'Cambiar X', 'Probar']);
  });
});

describe('POST /v1/internal/discord/interactions', () => {
  const app = new Hono();
  app.route('/v1/internal', internalRoutes);
  const post = (body: unknown, auth = 'Bearer bridge-secret') =>
    app.request('/v1/internal/discord/interactions', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(() => {
    h.fake = createDiscordDb();
    seedGuild(h.fake);
  });

  it('bearer malo → 403; cuerpo inválido → 400; otro servidor → 403', async () => {
    expect((await post(env(interaction({ data: slash('status') })), 'Bearer otra')).status).toBe(403);
    expect((await post(env(interaction({ data: slash('status') })), '')).status).toBe(403);
    expect((await post({ guildId: G, interaction: { type: 2 } })).status).toBe(400);
    expect((await post({ guildId: '100000000000000999', interaction: interaction({ data: slash('status') }) })).status).toBe(403);
  });

  it('responde el callback que el puente manda a Discord (handler de producción)', async () => {
    const res = await post(env(interaction({ data: slash('status') })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.callback.type).toBe(4);
    expect(body.callback.data.flags).toBe(EPH);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('sin cuenta ligada → efímero con el link a Configuración', async () => {
    const res = await post(env(interaction({ member: { user: { id: U_CARLA, username: 'carla' } }, data: slash('status') })));
    const body = (await res.json()) as any;
    expect(textOf(body.callback.data)).toMatch(/no está ligada a roz/);
  });
});
