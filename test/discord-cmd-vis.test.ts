import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ANA, APP, BETO, G, GENERAL, PROJECT, SECRET, THREAD, U_ANA, createDiscordDb, msgRow, seedGuild } from './discord-fixture.js';

// Handlers de visibilidad y agentes de /roz (docs/discord-commands-contract.md §5.4-5.7 y §6.2):
// plan, pulso, infra, junta y "Guardar como decisión". Base falsa (discord-fixture) y servicios de
// planes/pulso/juntas simulados; nada toca Discord ni la base real.

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
  process.env.OPENAI_API_KEY = '';
  return { fake: null as any };
});

vi.mock('../src/db/supabase.js', () => ({ db: () => h.fake, dbPublic: () => h.fake }));

const plans = vi.hoisted(() => ({
  listPlans: vi.fn(),
  getPlanDetail: vi.fn(),
  planByIdentifier: vi.fn(),
  approvePlan: vi.fn(),
  requestChanges: vi.fn(),
}));
vi.mock('../src/plans/service.js', () => ({ ...plans, FEEDBACK_MAX: 4000 }));

const pulse = vi.hoisted(() => ({ getPulse: vi.fn() }));
vi.mock('../src/dashboard/pulse.js', () => pulse);

// Emojis de la app: sin Discord. Solo existe el de Railway (los demás caen a texto plano).
const emojiMap = vi.hoisted(() => new Map([['roz_railway', '<:roz_railway:111111111111111111>']]));
vi.mock('../src/discord/commands/emojis.js', async (orig) => ({ ...(await orig<typeof import('../src/discord/commands/emojis.js')>()), appEmojis: async () => emojiMap }));

const meetings = vi.hoisted(() => ({ createMeeting: vi.fn() }));
vi.mock('../src/meetings/service.js', () => meetings);

const { handlers: planH, planChoices } = await import('../src/discord/commands/handlers/plan.js');
const { handlers: pulsoH, findPerson } = await import('../src/discord/commands/handlers/pulso.js');
const { handlers: infraH, scrubError, isNewDeploy } = await import('../src/discord/commands/handlers/infra.js');
const { textOf, rowsOf, buttonsOf, ofType } = await import('./discord-v2-helpers.js');
const { countComponents, textLength, V2_LIMITS } = await import('../src/discord/commands/v2.js');
const { handlers: juntaH } = await import('../src/discord/commands/handlers/junta.js');
const { handlers: decisionH, decisionAtomFromMessage } = await import('../src/discord/commands/handlers/mensaje-decision.js');
const { buildCustomId, parseCustomId } = await import('../src/discord/commands/custom-id.js');
const { routeInteraction } = await import('../src/discord/commands/router.js');
const { buildRegistry } = await import('../src/discord/commands/registry.js');
const { AppError } = await import('../src/utils/errors.js');
type CommandActor = import('../src/discord/commands/types.js').CommandActor;
type AgentPlanDetail = import('../src/types/roz-v2.js').AgentPlanDetail;
type PulsePerson = import('../src/types/roz-v2.js').PulsePerson;

const AUTH_ANA = '55555555-5555-4555-8555-555555555555';
const PLAN_ID = '66666666-6666-4666-8666-666666666666';
const PROJECT_B = '77777777-7777-4777-8777-777777777777';
const MSG = '600000000000000123';
const ACTOR: CommandActor = { devId: ANA, devName: 'Ana Pérez', githubLogin: 'anagh', authUserId: AUTH_ANA, discordUserId: U_ANA };
const log = vi.fn();

const base = (over: Record<string, unknown> = {}) => ({
  interaction: { id: '1', application_id: APP, type: 2, token: 'tok', guild_id: G, channel_id: GENERAL } as any,
  actor: ACTOR,
  guildId: G,
  channelId: GENERAL,
  log,
  ...over,
});

function plan(over: Partial<AgentPlanDetail> = {}): AgentPlanDetail {
  return {
    id: PLAN_ID,
    workItemId: 'wi-1',
    identifier: 'WAT-44',
    linearIssueId: null,
    issue: { name: 'Login con Google', url: null, status: 'en_curso' as any, projectId: PROJECT, projectName: 'Portal' },
    owner: { id: ANA, name: 'Ana Pérez', githubLogin: 'anagh', avatarUrl: null },
    status: 'esperando_aprobacion',
    phase: 'plan' as any,
    risk: 1 as any,
    riskReasons: [],
    repo: null,
    branch: null,
    prNumber: null,
    prUrl: null,
    progress: null,
    runner: null,
    heartbeatAt: null,
    attempts: 0,
    error: null,
    claimable: false,
    claimableReason: null,
    pulledBy: null,
    enqueuedAt: '2026-11-11T10:00:00.000Z',
    updatedAt: '2026-11-11T11:00:00.000Z',
    actions: ['aprobar', 'pedir_cambios'],
    planMd: '1. Agregar el botón\n2. Probar el callback',
    planVersion: 1,
    feedback: null,
    baseBranch: null,
    events: [],
    ...over,
  };
}

function person(over: Partial<PulsePerson> = {}): PulsePerson {
  return {
    devId: ANA,
    name: 'Ana Pérez',
    githubLogin: 'anagh',
    avatarUrl: null,
    state: 'activo',
    stateDetail: null,
    currentIssue: { workItemId: 'wi-1', identifier: 'WAT-44', name: 'Login con Google', status: 'en_curso' as any, linearStateName: null, url: null, projectId: PROJECT },
    agentPlan: null,
    cycle: null,
    week: { commits: 3, lines: 10, prsOpened: 1, prsMerged: 1, issuesClosed: 0 },
    projects: [{ id: PROJECT, name: 'Portal', color: null }],
    lastActivityAt: null,
    ...over,
  };
}

beforeEach(() => {
  h.fake = createDiscordDb();
  seedGuild(h.fake);
  log.mockClear();
  for (const f of [...Object.values(plans), pulse.getPulse, meetings.createMeeting]) f.mockReset();
});

describe('registro', () => {
  it('los handlers llenos no rompen el registro (un dueño por acción)', () => {
    expect(buildRegistry().problems).toEqual([]);
  });
});

// ================================================================ /roz plan

describe('/roz plan', () => {
  const slash = planH.slash!.plan!;

  it('difiere público con issue y efímero sin issue', () => {
    const d = slash.defer as (c: any) => string;
    expect(d({ options: { issue: 'WAT-44' } })).toBe('public');
    expect(d({ options: {} })).toBe('ephemeral');
  });

  it('autocompletado: identificador como value, lo que espera aprobación primero, ≤ 25', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      plan({ id: `p${i}`, identifier: `WAT-${i}`, actions: [], status: 'en_cola', owner: { id: BETO, name: 'Beto', githubLogin: null, avatarUrl: null } }),
    );
    const list = [...many, plan({ identifier: 'WAT-99' })];
    const out = planChoices(list, '', ANA);
    expect(out).toHaveLength(25);
    expect(out[0]).toEqual({ name: 'WAT-99 · Login con Google — Esperando aprobación', value: 'WAT-99' });
    expect(planChoices(list, 'wat-9', ANA).map((c) => c.value)).toEqual(['WAT-99', 'WAT-9']);

    plans.listPlans.mockResolvedValue({ plans: list, counts: {} });
    const viaHandler = await slash.autocomplete!({ ...base(), subcommand: 'plan', focused: { name: 'issue', value: 'login' }, options: {} } as any);
    expect(plans.listPlans).toHaveBeenCalledWith({ viewerDevId: ANA, scope: 'team' });
    expect(viaHandler[0]!.value).toBe('WAT-99');
  });

  it('con issue: ficha pública con pasos y botones del dueño', async () => {
    plans.planByIdentifier.mockResolvedValue({ id: PLAN_ID });
    plans.getPlanDetail.mockResolvedValue(plan());
    const reply = await slash.run({ ...base(), subcommand: 'plan', options: { issue: 'wat-44' } } as any);
    expect(plans.getPlanDetail).toHaveBeenCalledWith(PLAN_ID, ANA);
    expect(reply.kind).toBe('message');
    if (reply.kind !== 'message') return;
    expect(reply.ephemeral).toBe(false);
    expect(ofType(reply.message, 17)[0].accent_color).toBe(0xff5b23);
    const [head] = ofType(reply.message, 9);
    // Encabezado: el issue, estado con emoji (esperando → 🟡) y riesgo/dueño/proyecto tenues; foto del dueño.
    expect(head.components[0].content).toBe(
      '### `WAT-44` Login con Google\n🟡 Esperando aprobación\n-# Riesgo medio: planea y espera aprobación · Ana Pérez · Portal',
    );
    expect(head.accessory.media.url).toBe('https://github.com/anagh.png?size=96');
    expect(textOf(reply.message)).toContain('1. Agregar el botón\n2. Probar el callback');
    const ids = buttonsOf(reply.message).map((c: any) => c.custom_id).filter(Boolean);
    expect(ids).toEqual([buildCustomId('plan.aprobar', PLAN_ID), buildCustomId('plan.cambios', PLAN_ID)]);
  });

  it('con issue de otra persona: sin botones de aprobar (actions vacías)', async () => {
    plans.planByIdentifier.mockResolvedValue({ id: PLAN_ID });
    plans.getPlanDetail.mockResolvedValue(plan({ actions: [] }));
    const reply = await slash.run({ ...base(), subcommand: 'plan', options: { issue: 'WAT-44' } } as any);
    if (reply.kind !== 'message') throw new Error('esperaba mensaje');
    const ids = buttonsOf(reply.message).map((c: any) => c.custom_id).filter(Boolean);
    expect(ids).toEqual([]);
  });

  it('issue terminado: lo busca entre los recientes; sin plan → AppError 404', async () => {
    plans.planByIdentifier.mockResolvedValue(null);
    plans.listPlans.mockResolvedValue({ plans: [plan({ status: 'hecho', actions: [] })], counts: {} });
    plans.getPlanDetail.mockResolvedValue(plan({ status: 'hecho', actions: [] }));
    const reply = await slash.run({ ...base(), subcommand: 'plan', options: { issue: 'WAT-44' } } as any);
    expect(reply.kind).toBe('message');

    plans.listPlans.mockResolvedValue({ plans: [], counts: {} });
    await expect(slash.run({ ...base(), subcommand: 'plan', options: { issue: 'XYZ-1' } } as any)).rejects.toMatchObject({ status: 404 });
  });

  it('sin issue: tus planes en efímero con botones para los que esperan tu aprobación', async () => {
    plans.listPlans.mockResolvedValue({
      plans: [plan({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', identifier: 'WAT-1', status: 'implementando', actions: [] }), plan()],
      counts: {},
    });
    const reply = await slash.run({ ...base(), subcommand: 'plan', options: {} } as any);
    expect(plans.listPlans).toHaveBeenCalledWith({ viewerDevId: ANA, scope: 'mine' });
    if (reply.kind !== 'message') throw new Error('esperaba mensaje');
    expect(reply.ephemeral).toBe(true);
    const desc = textOf(reply.message);
    expect(desc).toMatch(/^### Tus planes del agente\n-# 2 planes · 1 esperan tu decisión/);
    expect(desc.indexOf('`WAT-44`')).toBeLessThan(desc.indexOf('`WAT-1`'));
    expect(desc).toContain('🟣 `WAT-1`');
    const labels = buttonsOf(reply.message).map((c: any) => c.label);
    expect(labels).toEqual(['Aprobar WAT-44', 'Pedir cambios WAT-44']);
  });

  it('Aprobar: approvePlan con el usuario de acceso y la ficha nueva como update', async () => {
    plans.approvePlan.mockResolvedValue(plan({ status: 'implementando' }));
    plans.getPlanDetail.mockResolvedValue(plan({ status: 'implementando', actions: [] }));
    const ctx = { ...base(), customId: { action: 'plan.aprobar', args: [PLAN_ID] }, values: [], message: null } as any;
    const reply = await planH.components!['plan.aprobar']!.run(ctx);
    expect(plans.approvePlan).toHaveBeenCalledWith(PLAN_ID, { userId: AUTH_ANA, devId: ANA });
    expect(reply.kind).toBe('update');
    if (reply.kind === 'update') expect(textOf(reply.message)).toContain('\n🟣 Implementando\n');
  });

  it('Aprobar sin usuario de acceso: 403 sin tocar el plan', async () => {
    const ctx = { ...base({ actor: { ...ACTOR, authUserId: null } }), customId: { action: 'plan.aprobar', args: [PLAN_ID] }, values: [], message: null } as any;
    await expect(planH.components!['plan.aprobar']!.run(ctx)).rejects.toMatchObject({ status: 403 });
    expect(plans.approvePlan).not.toHaveBeenCalled();
  });

  it('Pedir cambios: abre el modal con el plan en el custom_id', async () => {
    const reply = await planH.components!['plan.cambios']!.run({ ...base(), customId: { action: 'plan.cambios', args: [PLAN_ID] }, values: [], message: null } as any);
    expect(reply.kind).toBe('modal');
    if (reply.kind !== 'modal') return;
    expect(parseCustomId(reply.modal.custom_id)).toEqual({ ok: true, id: { action: 'plan.cambios.modal', args: [PLAN_ID] } });
    const field = reply.modal.components[0] as any;
    expect(field.component).toMatchObject({ custom_id: 'comentario', style: 2, max_length: 4000 });
  });

  it('modal de cambios: requestChanges con el comentario y update de la ficha', async () => {
    plans.requestChanges.mockResolvedValue(plan({ status: 'en_cola' }));
    plans.getPlanDetail.mockResolvedValue(plan({ status: 'en_cola', actions: [] }));
    const ctx = { ...base(), customId: { action: 'plan.cambios.modal', args: [PLAN_ID] }, fields: { comentario: '  usa el endpoint viejo  ' }, message: null } as any;
    const reply = await planH.modals!['plan.cambios.modal']!.run(ctx);
    expect(plans.requestChanges).toHaveBeenCalledWith(PLAN_ID, { userId: AUTH_ANA, devId: ANA }, 'usa el endpoint viejo');
    expect(reply.kind).toBe('update');
  });

  it('por el router: un no-dueño que aprieta Aprobar recibe el 403 efímero del servicio', async () => {
    plans.approvePlan.mockRejectedValue(new AppError('PLAN_FORBIDDEN', 'solo el dueño puede aprobar', 403));
    const out = await routeInteraction(
      {
        guildId: G,
        interaction: {
          id: String((BigInt(Date.now() - 1420070400000) << 22n)),
          application_id: APP,
          type: 3,
          token: 'tok',
          guild_id: G,
          channel_id: GENERAL,
          member: { user: { id: U_ANA, username: 'ana' } },
          data: { custom_id: buildCustomId('plan.aprobar', PLAN_ID), component_type: 2 },
          message: { id: '600000000000000001', channel_id: GENERAL } as any,
        },
      },
      { resolveActor: async () => ACTOR, budgetMs: 1000 },
    );
    expect(out.callback).toMatchObject({ type: 4, data: { flags: (1 << 15) | 64 } });
    expect(textOf(out.callback.data as any)).toBe('🔴 No se pudo: solo el dueño puede aprobar');
  });
});

// ================================================================ /roz pulso

describe('/roz pulso', () => {
  const slash = pulsoH.slash!.pulso!;

  it('autocompletado: devs activos por nombre o login, sin acentos, el actor primero', async () => {
    h.fake.table('dev').push({ id: 'd3', name: 'José Ñandú', github_login: 'jose', active: true }, { id: 'd4', name: 'Inactivo', github_login: null, active: false });
    const all = await slash.autocomplete!({ ...base(), subcommand: 'pulso', focused: { name: 'persona', value: '' }, options: {} } as any);
    expect(all[0]).toEqual({ name: 'Ana Pérez', value: ANA });
    expect(all.map((c) => c.value)).not.toContain('d4');
    const jose = await slash.autocomplete!({ ...base(), subcommand: 'pulso', focused: { name: 'persona', value: 'jose nan' }, options: {} } as any);
    expect(jose).toEqual([{ name: 'José Ñandú', value: 'd3' }]);
    const nadie = await slash.autocomplete!({ ...base(), subcommand: 'pulso', focused: { name: 'persona', value: 'zzz' }, options: {} } as any);
    expect(nadie).toEqual([]);
    const jose2 = await slash.autocomplete!({ ...base(), subcommand: 'pulso', focused: { name: 'persona', value: 'Jose' }, options: {} } as any);
    expect(jose2).toEqual([{ name: 'José Ñandú', value: 'd3' }]);
  });

  it('sin persona: resumen del equipo efímero; los que no tienen issue en UNA línea tenue', async () => {
    pulse.getPulse.mockResolvedValue({
      generatedAt: '2026-11-11T11:00:00.000Z',
      people: [
        person({ devId: 'd-z', name: 'Zoe', state: 'ocupado', stateDetail: 'Ocupado hasta las 11:30', githubLogin: 'zoe' }),
        person(),
        person({
          devId: 'd-agent',
          name: 'Iván',
          githubLogin: null,
          state: 'inactivo',
          currentIssue: null,
          agentPlan: { id: 'p', identifier: 'WAT-7', status: 'implementando', phase: 'implementar', progress: { step: 'tests', message: null, pct: 40 } as any },
        }),
        person({ devId: BETO, name: 'Beto Ruiz', currentIssue: null, state: 'fuera' }),
        person({ devId: 'd-c', name: 'Carla', currentIssue: null, state: 'inactivo' }),
      ],
    });
    const reply = await slash.run({ ...base(), subcommand: 'pulso', options: {} } as any);
    if (reply.kind !== 'message') throw new Error('esperaba mensaje');
    expect(reply.ephemeral).toBe(true);
    const text = textOf(reply.message);
    expect(text).toMatch(/^### Pulso del equipo\n-# 1 trabajando · 1 en junta · 3 fuera · 1 agente · actualizado <t:\d+:R>/);
    // Tarjetas: agente/en código primero, luego en junta. Sin "roz" de autor.
    const cards = [...ofType(reply.message, 9).map((s: any) => s.components[0].content), ...[]];
    expect(cards[0]).toBe('**Ana Pérez** · 🟢 En código\n`WAT-44` Login con Google');
    expect(cards[1]).toBe('**Zoe** · 🟡 Ocupado hasta las 11:30\n`WAT-44` Login con Google');
    // Iván no tiene foto: va como texto, pero con su agente.
    expect(text).toContain('**Iván** · ⚪ Inactivo\n-# Sin issue en curso\n-# 🟣 Agente · `WAT-7` Implementando 40%');
    expect(text.indexOf('Iván')).toBeLessThan(text.indexOf('Zoe'));
    expect(ofType(reply.message, 11).map((t: any) => t.media.url)).toEqual(['https://github.com/anagh.png?size=96', 'https://github.com/zoe.png?size=96']);
    // Nadie sin issue tiene su propia línea: van juntos al final.
    expect(text).toContain('-# Sin issue en curso: Beto Ruiz, Carla');
    expect(text).not.toContain('**Beto Ruiz**');
    expect(text).not.toMatch(/\broz\b · |autor/);
  });

  it('pulso grande: colapsa a los que no caben y respeta los topes de Discord', async () => {
    const many = Array.from({ length: 30 }, (_, i) => person({ devId: `d${i}`, name: `Persona ${String(i).padStart(2, '0')}`, githubLogin: `gh${i}` }));
    pulse.getPulse.mockResolvedValue({ generatedAt: null, people: many });
    const reply = await slash.run({ ...base(), subcommand: 'pulso', options: {} } as any);
    if (reply.kind !== 'message') throw new Error('esperaba mensaje');
    expect(ofType(reply.message, 9)).toHaveLength(10);
    expect(textOf(reply.message)).toMatch(/-# También con issue: Persona 10, /);
    expect(countComponents(reply.message.components!)).toBeLessThanOrEqual(V2_LIMITS.components);
    expect(textLength(reply.message.components!)).toBeLessThanOrEqual(V2_LIMITS.text);
  });

  it('con persona (id o nombre): ficha de la persona; desconocida → 404', async () => {
    pulse.getPulse.mockResolvedValue({ people: [person(), person({ devId: BETO, name: 'Beto Ruiz', githubLogin: null })] });
    const byId = await slash.run({ ...base(), subcommand: 'pulso', options: { persona: BETO } } as any);
    if (byId.kind !== 'message') throw new Error('esperaba mensaje');
    expect(textOf(byId.message)).toMatch(/^### Beto Ruiz\n🟢 En código/);
    expect(ofType(byId.message, 11)).toEqual([]);
    const byName = await slash.run({ ...base(), subcommand: 'pulso', options: { persona: 'ana' } } as any);
    if (byName.kind !== 'message') throw new Error('esperaba mensaje');
    const text = textOf(byName.message);
    expect(text).toContain('**Trabajando en**\n');
    expect(text).toContain('`WAT-44` Login con Google');
    expect(text).toContain('**Esta semana**\n3 commits · 1 PR abiertos · 1 mergeado · 0 issues cerrados');
    expect(ofType(byName.message, 11)[0].media.url).toBe('https://github.com/anagh.png?size=96');
    expect(buttonsOf(byName.message)[0]).toMatchObject({ label: 'Abrir', url: `https://roz.example.com/app/developers/${ANA}` });
    await expect(slash.run({ ...base(), subcommand: 'pulso', options: { persona: 'nadie' } } as any)).rejects.toMatchObject({ status: 404 });
  });

  it('findPerson: exacto antes que parcial', () => {
    const people = [person({ devId: 'a', name: 'Ana María' }), person({ devId: 'b', name: 'Ana' })];
    expect(findPerson(people, 'ana')!.devId).toBe('b');
  });
});

// ================================================================ /roz infra

describe('/roz infra', () => {
  const slash = infraH.slash!.infra!;
  const SVC_OK = 'svc-ok';
  const SVC_DOWN = 'svc-down';

  function seedInfra() {
    h.fake.table('project').push({ id: PROJECT_B, name: 'Backoffice', active: true });
    h.fake.table('project_service').push(
      { id: SVC_OK, project_id: PROJECT, provider: 'vercel', external_ref: 'portal-web', label: 'Portal web' },
      { id: SVC_DOWN, project_id: PROJECT, provider: 'railway', external_ref: 'portal-api', label: null },
    );
    const deployOld = { state: 'SUCCESS', url: null, sha: 'aaaaaaa1111', createdAt: '2026-11-10T10:00:00.000Z', commitMessage: 'viejo' };
    const deployNew = { state: 'FAILED', url: null, sha: 'bbbbbbb2222', createdAt: '2026-11-11T10:00:00.000Z', commitMessage: 'feat: rompe todo', author: 'ana' };
    h.fake.table('service_snapshot').push(
      { project_service_id: SVC_OK, captured_at: '2026-11-11T11:00:00.000Z', status: 'healthy', deploy: null, details: null, error: null },
      { project_service_id: SVC_DOWN, captured_at: '2026-11-11T09:00:00.000Z', status: 'healthy', deploy: deployOld, details: null, error: null },
      {
        project_service_id: SVC_DOWN,
        captured_at: '2026-11-11T11:00:00.000Z',
        status: 'down',
        deploy: deployNew,
        details: null,
        error: 'crash: Authorization: Bearer abc.def-SECRETO al conectar',
      },
    );
  }

  it('autocompletado: solo proyectos con servicios', async () => {
    seedInfra();
    const out = await slash.autocomplete!({ ...base(), subcommand: 'infra', focused: { name: 'proyecto', value: '' }, options: {} } as any);
    expect(out).toEqual([{ name: 'Portal', value: PROJECT }]);
  });

  it('resumen + ficha del caído con último error (sin credenciales) y deploy sospechoso', async () => {
    seedInfra();
    const reply = await slash.run({ ...base(), subcommand: 'infra', options: {} } as any);
    if (reply.kind !== 'message') throw new Error('esperaba mensaje');
    expect(reply.ephemeral).toBe(true);
    const text = textOf(reply.message);
    expect(text).toMatch(/^### Infraestructura\n-# 2 servicios · 1 en línea · 1 caído · actualizado <t:\d+:R>/);
    // Primero el servicio con problema, como Section con "Abrir".
    const [down] = ofType(reply.message, 9);
    const card = down.components[0].content as string;
    expect(card.split('\n')[0]).toBe('🔴 **portal-api** · Caído');
    expect(card.split('\n')[1]).toBe('-# <:roz_railway:111111111111111111> Railway · Portal');
    expect(card).not.toContain('SECRETO');
    expect(card).toContain('[oculto]');
    expect(card).toMatch(/-# Deploy sospechoso: `bbbbbbb` · feat: rompe todo · ana · FAILED · <t:\d+:R>/);
    expect(down.accessory).toMatchObject({ type: 2, style: 5, label: 'Abrir', url: 'https://roz.example.com/app/infra' });
    // Luego UNA línea por proveedor con los nombres tenues debajo (sin ícono de Vercel: texto plano).
    expect(text).toContain('**Vercel** · 🟢 1/1 en línea\n-# Portal web');
    expect(text).toContain('<:roz_railway:111111111111111111> **Railway** · 🔴 0/1 en línea · 1 caído\n-# portal-api');
    expect(text).not.toContain('Todo en línea');
  });

  it('filtra por proyecto (id o nombre); sin servicios → mensaje; desconocido → 404', async () => {
    seedInfra();
    const byName = await slash.run({ ...base(), subcommand: 'infra', options: { proyecto: 'portal' } } as any);
    if (byName.kind !== 'message') throw new Error('esperaba mensaje');
    expect(textOf(byName.message)).toMatch(/^### Infraestructura · Portal\n/);
    // Filtrado por proyecto: el proyecto no se repite en cada servicio.
    expect(textOf(byName.message)).toContain('-# <:roz_railway:111111111111111111> Railway\n');
    await expect(slash.run({ ...base(), subcommand: 'infra', options: { proyecto: 'backoffice' } } as any)).rejects.toMatchObject({ status: 404 });
    h.fake.tables.project_service = [];
    const none = await slash.run({ ...base(), subcommand: 'infra', options: {} } as any);
    if (none.kind !== 'message') throw new Error('esperaba mensaje');
    expect(textOf(none.message)).toMatch(/^⚪ No hay servicios vinculados/);
  });

  it('todo en línea: una línea grande y los proveedores colapsados, sin tarjetas por servicio', async () => {
    seedInfra();
    h.fake.tables.service_snapshot = h.fake.tables.service_snapshot.filter((s: any) => s.status === 'healthy');
    const reply = await slash.run({ ...base(), subcommand: 'infra', options: {} } as any);
    if (reply.kind !== 'message') throw new Error('esperaba mensaje');
    const text = textOf(reply.message);
    expect(text).toContain('## 🟢 Todo en línea');
    expect(ofType(reply.message, 9)).toEqual([]);
    expect(text).toContain('**Vercel** · 🟢 1/1 en línea\n-# Portal web');
  });

  it('muchos servicios sanos: una línea por proveedor, nunca una por servicio', async () => {
    seedInfra();
    for (let i = 0; i < 40; i++) {
      h.fake.table('project_service').push({ id: `v${i}`, project_id: PROJECT, provider: 'vercel', external_ref: `app-${String(i).padStart(2, '0')}`, label: null });
      h.fake.table('service_snapshot').push({ project_service_id: `v${i}`, captured_at: '2026-11-11T11:00:00.000Z', status: 'healthy', deploy: null, details: null, error: null });
    }
    const reply = await slash.run({ ...base(), subcommand: 'infra', options: {} } as any);
    if (reply.kind !== 'message') throw new Error('esperaba mensaje');
    const text = textOf(reply.message);
    expect(text).toContain('**Vercel** · 🟢 41/41 en línea\n-# app-00, app-01');
    expect(text).not.toContain('**app-00**');
    expect(ofType(reply.message, 9)).toHaveLength(1); // solo el caído
    expect(countComponents(reply.message.components!)).toBeLessThanOrEqual(V2_LIMITS.components);
    expect(textLength(reply.message.components!)).toBeLessThanOrEqual(V2_LIMITS.text);
  });

  it('piezas: scrubError, isNewDeploy', () => {
    expect(scrubError('token=abc123 falló')).toBe('token=[oculto] falló');
    expect(scrubError('x'.repeat(40))).toBe('[oculto]');
    expect(scrubError('  ')).toBeNull();
    expect(isNewDeploy({ state: 'X', url: null, sha: 'a', createdAt: null }, { state: 'Y', url: null, sha: 'a', createdAt: null })).toBe(false);
    expect(isNewDeploy({ state: 'X', url: null, sha: 'b', createdAt: null }, { state: 'Y', url: null, sha: 'a', createdAt: null })).toBe(true);
    expect(isNewDeploy(null, null)).toBe(false);
  });
});

// ================================================================ /roz junta

describe('/roz junta', () => {
  const slash = juntaH.slash!.junta!;

  it('abre el modal: proyecto de la opción, del nombre o del canal; nunca difiere', async () => {
    expect(slash.defer).toBe('never');
    const a = await slash.run({ ...base(), subcommand: 'junta', options: { proyecto: PROJECT } } as any);
    if (a.kind !== 'modal') throw new Error('esperaba modal');
    expect(parseCustomId(a.modal.custom_id)).toEqual({ ok: true, id: { action: 'junta.modal', args: [PROJECT] } });
    expect(a.modal.components.map((c: any) => c.component.custom_id)).toEqual(['titulo', 'notas']);
    expect((a.modal.components[1] as any).component).toMatchObject({ style: 2, max_length: 4000 });

    const b = await slash.run({ ...base(), subcommand: 'junta', options: { proyecto: 'portal' } } as any);
    if (b.kind !== 'modal') throw new Error('esperaba modal');
    expect(b.modal.custom_id).toBe(buildCustomId('junta.modal', PROJECT));

    const c = await slash.run({ ...base(), subcommand: 'junta', options: {} } as any);
    if (c.kind !== 'modal') throw new Error('esperaba modal');
    expect(c.modal.custom_id).toBe(buildCustomId('junta.modal', null));

    h.fake.table('discord_project_channel').push({ project_id: PROJECT, channel_id: GENERAL });
    const d = await slash.run({ ...base({ channelId: THREAD, interaction: { channel: { id: THREAD, parent_id: GENERAL } } }), subcommand: 'junta', options: {} } as any);
    if (d.kind !== 'modal') throw new Error('esperaba modal');
    expect(d.modal.custom_id).toBe(buildCustomId('junta.modal', PROJECT));
  });

  it('autocompletado de proyectos activos', async () => {
    h.fake.table('project').push({ id: PROJECT_B, name: 'Backoffice', active: true }, { id: 'x', name: 'Viejo', active: false });
    const out = await slash.autocomplete!({ ...base(), subcommand: 'junta', focused: { name: 'proyecto', value: '' }, options: {} } as any);
    expect(out).toEqual([
      { name: 'Backoffice', value: PROJECT_B },
      { name: 'Portal', value: PROJECT },
    ]);
  });

  it('modal: crea la junta manual en texto y responde efímero con el link a la bandeja', async () => {
    meetings.createMeeting.mockResolvedValue({ id: 'm-1', title: 'Kickoff', projectName: 'Portal' });
    const ctx = { ...base(), customId: { action: 'junta.modal', args: [PROJECT] }, fields: { titulo: ' Kickoff ', notas: 'Ana: vamos con Stripe' }, message: null } as any;
    const reply = await juntaH.modals!['junta.modal']!.run(ctx);
    const [user, req] = meetings.createMeeting.mock.calls[0]!;
    expect(user).toEqual({ id: AUTH_ANA, devId: ANA, devName: 'Ana Pérez' });
    expect(req).toMatchObject({ title: 'Kickoff', attendees: [], projectId: PROJECT, format: 'texto', content: 'Ana: vamos con Stripe' });
    expect(Number.isNaN(Date.parse(req.heldAt))).toBe(false);
    if (reply.kind !== 'message') throw new Error('esperaba mensaje');
    expect(reply.ephemeral).toBe(true);
    expect(textOf(reply.message)).toMatch(/^🟢 Junta «Kickoff» guardada/);
    expect(buttonsOf(reply.message)[0].url).toBe('https://roz.example.com/app/meetings?m=m-1');
  });

  it('modal sin notas o sin usuario de acceso: error sin crear nada', async () => {
    const ctx = (over = {}) => ({ ...base(over), customId: { action: 'junta.modal', args: [null] }, fields: { titulo: 'x', notas: ' ' }, message: null }) as any;
    await expect(juntaH.modals!['junta.modal']!.run(ctx())).rejects.toMatchObject({ status: 400 });
    const noUser = { ...ctx({ actor: { ...ACTOR, authUserId: null } }), fields: { titulo: 'x', notas: 'y' } };
    await expect(juntaH.modals!['junta.modal']!.run(noUser)).rejects.toMatchObject({ status: 403 });
    expect(meetings.createMeeting).not.toHaveBeenCalled();
  });
});

// ================================================================ Guardar como decisión

describe('Guardar como decisión', () => {
  const run = decisionH.message!.decision!.run;
  const target = (over: Record<string, unknown> = {}) =>
    ({
      id: MSG,
      channel_id: GENERAL,
      type: 0,
      author: { id: '200000000000000003', username: 'carla', global_name: 'Carla' },
      content: 'Vamos con Stripe para los pagos\nPayPal queda fuera por comisiones.',
      timestamp: '2026-11-11T12:00:00.000Z',
      edited_timestamp: null,
      attachments: [],
      embeds: [],
      mentions: [],
      mention_roles: [],
      mention_everyone: false,
      pinned: false,
      ...over,
    }) as any;
  const atoms = () => h.fake.table('knowledge_atom');

  it('canal mapeado: guarda el átomo con la cita, el link y la procedencia; dos veces no duplica', async () => {
    h.fake.table('discord_project_channel').push({ project_id: PROJECT, channel_id: GENERAL });
    h.fake.table('discord_message').push(msgRow(MSG, { content: 'Vamos con Stripe para los pagos\nPayPal queda fuera por comisiones.' }));
    const reply = await run({ ...base(), command: 'decision', target: target() } as any);
    if (reply.kind !== 'message') throw new Error('esperaba mensaje');
    expect(reply.ephemeral).toBe(true);
    expect(textOf(reply.message)).toContain('🟢 Guardado como decisión en el brain de **Portal**');
    expect(atoms()).toHaveLength(1);
    const atom = atoms()[0]!;
    expect(atom).toMatchObject({ scope: 'project', project_id: PROJECT, status: 'active', title: 'Vamos con Stripe para los pagos', provenance: [`discord:${MSG}`], embedding: null });
    expect(atom.body).toContain('> PayPal queda fuera por comisiones.');
    expect(atom.body).toContain(`https://discord.com/channels/${G}/${GENERAL}/${MSG}`);
    expect(atom.body).toContain('#general');

    const again = await run({ ...base(), command: 'decision', target: target() } as any);
    if (again.kind !== 'message') throw new Error('esperaba mensaje');
    expect(textOf(again.message)).toMatch(/ya estaba guardado/);
    expect(atoms()).toHaveLength(1);
  });

  it('hilo de un canal mapeado: usa el proyecto del canal padre', async () => {
    h.fake.table('discord_project_channel').push({ project_id: PROJECT, channel_id: GENERAL });
    h.fake.table('discord_message').push(msgRow(MSG, { channel_id: THREAD }));
    await run({ ...base({ channelId: THREAD }), command: 'decision', target: target({ channel_id: THREAD }) } as any);
    expect(atoms()[0]!.project_id).toBe(PROJECT);
  });

  it('canal sin proyecto: select de proyectos; al elegir guarda y deja el efímero en "Guardado"', async () => {
    h.fake.table('project').push({ id: PROJECT_B, name: 'Backoffice', active: true });
    h.fake.table('discord_message').push(msgRow(MSG, { content: 'Decidimos usar Postgres' }));
    const reply = await run({ ...base(), command: 'decision', target: target({ content: 'Decidimos usar Postgres' }) } as any);
    if (reply.kind !== 'message') throw new Error('esperaba mensaje');
    const select = rowsOf(reply.message)[0].components[0] as any;
    expect(select.custom_id).toBe(buildCustomId('msg.decision.proyecto', GENERAL, MSG));
    expect(select.options.map((o: any) => o.label)).toEqual(['Backoffice', 'Portal']);
    expect(atoms()).toHaveLength(0);

    const comp = decisionH.components!['msg.decision.proyecto']!;
    const done = await comp.run({ ...base(), customId: { action: 'msg.decision.proyecto', args: [GENERAL, MSG] }, values: [PROJECT_B], message: null } as any);
    expect(done.kind).toBe('update');
    if (done.kind !== 'update') return;
    expect(textOf(done.message)).toContain('**Backoffice**');
    expect(rowsOf(done.message)).toEqual([]);
    expect(atoms()[0]).toMatchObject({ project_id: PROJECT_B, title: 'Decidimos usar Postgres' });
  });

  it('select con proyecto inventado o mensaje de otro canal: no guarda', async () => {
    h.fake.table('discord_message').push(msgRow(MSG));
    const comp = decisionH.components!['msg.decision.proyecto']!;
    const ctx = (args: string[], values: string[]) => ({ ...base(), customId: { action: 'msg.decision.proyecto', args }, values, message: null }) as any;
    await expect(comp.run(ctx([GENERAL, MSG], ['no-es-uuid']))).rejects.toMatchObject({ status: 400 });
    await expect(comp.run(ctx([GENERAL, MSG], [PROJECT_B]))).rejects.toMatchObject({ status: 404 });
    await expect(comp.run(ctx([SECRET, MSG], [PROJECT]))).rejects.toMatchObject({ status: 404 });
    expect(atoms()).toHaveLength(0);
  });

  it('mensaje en un canal que el actor no ve: 404 y nada guardado', async () => {
    h.fake.table('discord_project_channel').push({ project_id: PROJECT, channel_id: SECRET });
    h.fake.table('discord_message').push(msgRow(MSG, { channel_id: SECRET }));
    await expect(run({ ...base({ channelId: SECRET }), command: 'decision', target: target({ channel_id: SECRET }) } as any)).rejects.toMatchObject({ status: 404 });
    // Aunque todavía no esté en el espejo: se revisa el canal.
    h.fake.tables.discord_message = [];
    await expect(run({ ...base({ channelId: SECRET }), command: 'decision', target: target({ channel_id: SECRET }) } as any)).rejects.toMatchObject({ status: 404 });
    expect(atoms()).toHaveLength(0);
  });

  it('mensaje sin texto: 400', async () => {
    h.fake.table('discord_project_channel').push({ project_id: PROJECT, channel_id: GENERAL });
    await expect(run({ ...base(), command: 'decision', target: target({ content: '' }) } as any)).rejects.toMatchObject({ status: 400 });
  });

  it('decisionAtomFromMessage: título sin marcas de markdown y recortado', () => {
    const { title, body } = decisionAtomFromMessage({
      guildId: G,
      channelId: GENERAL,
      channelName: null,
      messageId: MSG,
      authorName: null,
      content: `## ${'a'.repeat(200)}`,
      createdAt: '2026-11-11T12:00:00.000Z',
    });
    expect(title).toHaveLength(120);
    expect(title.startsWith('a')).toBe(true);
    expect(body).toContain('Decidido en Discord (11 nov 2026)');
  });
});
