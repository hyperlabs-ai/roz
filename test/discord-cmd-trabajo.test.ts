import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ANA, APP, BETO, G, GENERAL, PROJECT, THREAD, U_ANA, U_BETO, createDiscordDb, seedGuild } from './discord-fixture.js';

// Handlers "trabajo" de /roz en Discord (docs/discord-commands-contract.md §5.1-5.3, §6.1, §6.3):
// tarea (autocompletado, ficha, Tomar, Cambiar estado), ticket (modal → ticket inteligente), status
// (daily), "Crear tarea con roz" y "Citar tareas". Base falsa + servicios de roz simulados: nada toca
// la red, Discord, Linear ni la base del .env.

const h = vi.hoisted(() => {
  process.env.ROZ_DISCORD_CHAT = 'true';
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  process.env.DISCORD_GUILD_ID = '100000000000000001';
  process.env.DISCORD_CLIENT_ID = '900000000000000001';
  process.env.DISCORD_CLIENT_SECRET = 'client-secret';
  process.env.DISCORD_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/discord/callback';
  process.env.DISCORD_API_URL = 'https://discord.test/api/v10';
  process.env.ROZ_BRIDGE_SECRET = 'bridge-secret';
  process.env.ROZ_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.DASHBOARD_URL = 'https://roz.example.com';
  return {
    fake: null as any,
    sot: false,
    autoAssign: true,
    tasks: new Map<string, any>(),
    search: [] as any[],
    legacy: new Map<string, string>(),
  };
});

vi.mock('../src/db/supabase.js', () => ({ db: () => h.fake, dbPublic: () => h.fake }));
vi.mock('../src/utils/background.js', () => ({ inBackground: () => {} }));
vi.mock('../src/linear/enabled.js', async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    linearSourceOfTruth: () => h.sot,
    assertTasksWritable: () => {
      if (h.sot) throw new Error('escritura nativa con Linear encendido');
    },
  };
});
vi.mock('../src/assign/enabled.js', async (orig) => ({ ...((await orig()) as any), autoAssignEnabled: () => h.autoAssign }));
vi.mock('../src/chat/tasks.js', async (orig) => ({
  ...((await orig()) as any),
  searchTasks: vi.fn(async () => h.search),
  tasksByIds: vi.fn(async (ids: string[]) => new Map(ids.filter((id) => h.tasks.has(id)).map((id) => [id, h.tasks.get(id)]))),
  tasksByIdentifier: vi.fn(async (idents: string[]) => {
    const out = new Map();
    for (const t of h.tasks.values()) if (idents.includes(t.identifier)) out.set(t.identifier, t);
    return out;
  }),
}));
vi.mock('../src/linear/legacy.js', async (orig) => ({
  ...((await orig()) as any),
  findWorkItemIdByIdentifier: vi.fn(async (ident: string) => {
    for (const t of h.tasks.values()) if (t.identifier === ident) return t.id;
    return h.legacy.get(ident) ?? null;
  }),
}));
vi.mock('../src/dashboard/queries.js', async (orig) => ({ ...((await orig()) as any), updateTask: vi.fn(async (id: string) => ({ id })) }));
vi.mock('../src/assign/decisions.js', async (orig) => ({ ...((await orig()) as any), latestDecision: vi.fn(async () => null) }));
vi.mock('../src/linear/issues.js', async (orig) => ({ ...((await orig()) as any), reassignIssue: vi.fn(async () => ({ assigneeLinearId: 'lu', identifier: 'X' })) }));
vi.mock('../src/linear/links.js', async (orig) => ({ ...((await orig()) as any), stateForStatus: vi.fn(async () => 'state-done') }));
vi.mock('../src/linear/mirror.js', async (orig) => ({ ...((await orig()) as any), upsertMirrorFromLinear: vi.fn(async () => ({ workItemId: 'x' })) }));
vi.mock('../src/adapters/linear.js', async (orig) => ({ ...((await orig()) as any), updateIssue: vi.fn(async () => ({ id: 'lin-1' })) }));
vi.mock('../src/tickets/smart.js', async (orig) => ({
  ...((await orig()) as any),
  previewTicket: vi.fn(),
  createTicket: vi.fn(),
}));
vi.mock('../src/discord/access.js', async (orig) => ({ ...((await orig()) as any), loadViewer: vi.fn(async (devId: string) => ({ devId, snap: {} })) }));
vi.mock('../src/discord/tasks.js', async (orig) => ({ ...((await orig()) as any), createTaskFromDiscordMessage: vi.fn() }));

const { handlers: tarea, takeTask, findTasks } = await import('../src/discord/commands/handlers/tarea.js');
const { handlers: ticket, channelProjectId } = await import('../src/discord/commands/handlers/ticket.js');
const { handlers: status } = await import('../src/discord/commands/handlers/status.js');
const { handlers: crear, splitMessageText } = await import('../src/discord/commands/handlers/mensaje-crear-tarea.js');
const { handlers: citar, findTaskIdentifiers } = await import('../src/discord/commands/handlers/mensaje-citar.js');
const { buildCustomId, parseCustomId } = await import('../src/discord/commands/custom-id.js');
const { ROZ_ORANGE } = await import('../src/discord/commands/embeds.js');
const { textOf, rowsOf, buttonsOf, ofType } = await import('./discord-v2-helpers.js');
const { routeInteraction } = await import('../src/discord/commands/router.js');
const { AppError, NotFoundError } = await import('../src/utils/errors.js');
const chatTasks = await import('../src/chat/tasks.js');
const queries = await import('../src/dashboard/queries.js');
const decisions = await import('../src/assign/decisions.js');
const linearIssues = await import('../src/linear/issues.js');
const linearAdapter = await import('../src/adapters/linear.js');
const linearLinks = await import('../src/linear/links.js');
const smart = await import('../src/tickets/smart.js');
const discordTasks = await import('../src/discord/tasks.js');

type CommandActor = import('../src/discord/commands/types.js').CommandActor;

const T1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const T2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const T3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const T4 = 'aaaaaaaa-0000-4000-8000-000000000004';
const OTHER_PROJECT = '55555555-5555-4555-8555-555555555555';
const AUTH_ANA = '66666666-6666-4666-8666-666666666666';
const MSG = '600000000000000123';

const ACTOR: CommandActor = { devId: ANA, devName: 'Ana Pérez', githubLogin: 'anagh', authUserId: AUTH_ANA, discordUserId: U_ANA };

function ref(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    identifier: `ROZ-${id.slice(-1)}`,
    name: `Tarea ${id.slice(-1)}`,
    status: 'pendiente',
    statusLabel: 'Por hacer',
    priority: 'high',
    dueDate: null,
    overdue: false,
    labels: [],
    projectName: 'Portal',
    assigneeDevIds: [BETO],
    ...over,
  };
}

function base(over: Record<string, unknown> = {}) {
  return {
    interaction: { id: '1', application_id: APP, type: 2, token: 't', guild_id: G, channel_id: GENERAL } as any,
    actor: ACTOR,
    guildId: G,
    channelId: GENERAL,
    log: vi.fn(),
    ...over,
  };
}
const slashCtx = (subcommand: any, options: Record<string, any> = {}) => ({ ...base(), subcommand, options });
const autoCtx = (subcommand: any, focused: { name: string; value: string }, options: Record<string, any> = {}) => ({ ...base(), subcommand, focused, options });
const compCtx = (action: string, args: (string | null)[], values: string[] = []) => ({ ...base(), customId: { action: action as any, args }, values, message: null });
const modalCtx = (action: string, args: (string | null)[], fields: Record<string, string | string[]>) => ({
  ...base(),
  customId: { action: action as any, args },
  fields,
  message: null,
});
const targetMsg = (content: string, over: Record<string, unknown> = {}) =>
  ({ id: MSG, channel_id: GENERAL, type: 0, author: { id: U_BETO, username: 'beto' }, content, timestamp: '', edited_timestamp: null, attachments: [], embeds: [], mentions: [], mention_roles: [], mention_everyone: false, pinned: false, ...over }) as any;

beforeEach(() => {
  h.fake = createDiscordDb();
  seedGuild(h.fake);
  h.fake.table('project').push({ id: OTHER_PROJECT, name: 'Alfa', key: 'ALF', active: true }, { id: '77777777-7777-4777-8777-777777777777', name: 'Viejo', active: false });
  h.sot = false;
  h.autoAssign = true;
  h.tasks = new Map([
    [T1, ref(T1)],
    [T2, ref(T2, { status: 'en_progreso', statusLabel: 'En curso', assigneeDevIds: [ANA] })],
    [T3, ref(T3, { status: 'completada', statusLabel: 'Completada' })],
  ]);
  h.search = [h.tasks.get(T2), h.tasks.get(T1)];
  h.legacy = new Map();
  vi.clearAllMocks();
});

// ================================================================ /roz tarea

describe('/roz tarea', () => {
  it('autocompletado: "ID · Título — Responsable" con el id de la tarea como value', async () => {
    const choices = await tarea.slash!.tarea!.autocomplete!(autoCtx('tarea', { name: 'buscar', value: '#login' }) as any);
    expect(chatTasks.searchTasks).toHaveBeenCalledWith(ANA, 'login', 25);
    expect(choices).toEqual([
      { name: 'ROZ-2 · Tarea 2 — Ana Pérez', value: T2 },
      { name: 'ROZ-1 · Tarea 1 — Beto Ruiz', value: T1 },
    ]);
  });

  it('autocompletado con persona: busca con su nombre y filtra exacto por responsable', async () => {
    const choices = await tarea.slash!.tarea!.autocomplete!(autoCtx('tarea', { name: 'buscar', value: 'api' }, { persona: BETO }) as any);
    expect(chatTasks.searchTasks).toHaveBeenCalledWith(ANA, 'Beto Ruiz api', 40);
    expect(choices.map((c) => c.value)).toEqual([T1]);
    expect(await findTasks(ANA, 'x', '99999999-9999-4999-8999-999999999999')).toEqual([]);
  });

  it('autocompletado de persona: devs activos por prefijo de palabra, sin acentos', async () => {
    h.fake.table('dev').push({ id: '88888888-8888-4888-8888-888888888888', name: 'Pedro Inactivo', active: false });
    const choices = await tarea.slash!.tarea!.autocomplete!(autoCtx('tarea', { name: 'persona', value: 'pere' }) as any);
    expect(choices).toEqual([{ name: 'Ana Pérez', value: ANA }]);
    const all = await tarea.slash!.tarea!.autocomplete!(autoCtx('tarea', { name: 'persona', value: '' }) as any);
    expect(all.map((c) => c.value)).toEqual([ANA, BETO]);
  });

  it('publica la ficha con la identidad de roz, Tomar, Abrir y el menú de estado', async () => {
    const reply: any = await tarea.slash!.tarea!.run(slashCtx('tarea', { buscar: T1 }) as any);
    expect(reply).toMatchObject({ kind: 'message', ephemeral: false });
    const [box] = ofType(reply.message, 17);
    expect(box.accent_color).toBe(ROZ_ORANGE);
    // Título en negritas, chips (ID · estado · prioridad · responsable) y el proyecto tenue. Beto no
    // tiene login de GitHub: sin foto no hay Section (sería un accesorio vacío), va como texto.
    expect(box.components[0]).toEqual({ type: 10, content: '**Tarea 1**\n`ROZ-1` · ⚪ Por hacer · Prioridad alta · Beto Ruiz\n-# Portal' });
    expect(ofType(reply.message, 11)).toEqual([]);
    const [buttons, select] = rowsOf(reply.message);
    expect(buttons.components[0]).toMatchObject({ label: 'Tomar', custom_id: buildCustomId('tarea.tomar', T1) });
    expect(buttons.components[1]).toMatchObject({ label: 'Abrir', style: 5, url: `https://roz.example.com/app/tasks?task=${T1}` });
    expect(select.components[0].custom_id).toBe(buildCustomId('tarea.estado', T1));
    expect(select.components[0].options.find((o: any) => o.default)?.value).toBe('pendiente');
    expect(parseCustomId(buttons.components[0].custom_id).ok).toBe(true);
  });

  it('con Linear: botón y campo con el link al issue', async () => {
    h.fake.table('work_item').push({ id: T1, url: 'https://linear.app/hyper/issue/ROZ-1', linear_id: 'lin-1' });
    const reply: any = await tarea.slash!.tarea!.run(slashCtx('tarea', { buscar: T1 }) as any);
    expect(buttonsOf(reply.message).map((b: any) => b.label)).toEqual(['Tomar', 'Abrir', 'Linear']);
    expect(buttonsOf(reply.message)[2].url).toBe('https://linear.app/hyper/issue/ROZ-1');
  });

  it('Enter sin elegir: resuelve el ID (vigente o viejo) o la primera coincidencia; sin nada, efímero', async () => {
    const byId: any = await tarea.slash!.tarea!.run(slashCtx('tarea', { buscar: 'roz-1' }) as any);
    expect(textOf(byId.message)).toContain('**Tarea 1**\n`ROZ-1`');
    h.legacy.set('OLD-9', T2);
    const legacy: any = await tarea.slash!.tarea!.run(slashCtx('tarea', { buscar: '#OLD-9' }) as any);
    expect(textOf(legacy.message)).toContain('**Tarea 2**\n`ROZ-2`');
    const text: any = await tarea.slash!.tarea!.run(slashCtx('tarea', { buscar: 'algo' }) as any);
    expect(textOf(text.message)).toContain('**Tarea 2**\n`ROZ-2`');
    h.search = [];
    const none: any = await tarea.slash!.tarea!.run(slashCtx('tarea', { buscar: 'nada' }) as any);
    expect(none).toMatchObject({ kind: 'message', ephemeral: true });
    expect(textOf(none.message)).toMatch(/^⚪ No encontré esa tarea/);
    const linked: any = await tarea.slash!.tarea!.run(slashCtx('tarea', { buscar: '__ligar_cuenta__' }) as any);
    expect(linked.ephemeral).toBe(true);
  });
});

// ================================================================ Tomar / Cambiar estado

describe('ficha: Tomar', () => {
  it('nativa: el actor queda de principal, los de apoyo se quedan y la ficha se actualiza', async () => {
    h.tasks.set(T1, ref(T1, { assigneeDevIds: [BETO, 'cccccccc-0000-4000-8000-000000000009'] }));
    vi.mocked(queries.updateTask).mockImplementationOnce(async (id) => {
      h.tasks.set(T1, ref(T1, { assigneeDevIds: [ANA] }));
      return { id };
    });
    const reply: any = await tarea.components!['tarea.tomar']!.run(compCtx('tarea.tomar', [T1]) as any);
    expect(queries.updateTask).toHaveBeenCalledWith(T1, { assigneeDevIds: [ANA, 'cccccccc-0000-4000-8000-000000000009'] });
    expect(reply.kind).toBe('update');
    expect(textOf(reply.message)).toContain('· Ana Pérez');
  });

  it('ya era tuya: no escribe, aviso efímero', async () => {
    const reply: any = await tarea.components!['tarea.tomar']!.run(compCtx('tarea.tomar', [T2]) as any);
    expect(queries.updateTask).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ kind: 'message', ephemeral: true });
  });

  it('cerrada o inexistente: AppError para el usuario', async () => {
    await expect(takeTask(ACTOR, T3)).rejects.toMatchObject({ code: 'TASK_CLOSED', status: 409 });
    await expect(takeTask(ACTOR, T4)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('quitarle a alguien lo que eligió la asignación automática pide hacerlo en roz (motivo)', async () => {
    vi.mocked(decisions.latestDecision).mockResolvedValueOnce({ outcome: 'assigned', chosen_dev_id: BETO, overridden_at: null } as any);
    await expect(takeTask(ACTOR, T1)).rejects.toMatchObject({ code: 'OVERRIDE_REASON_REQUIRED' });
    expect(queries.updateTask).not.toHaveBeenCalled();
  });

  it('con ROZ_LINEAR_SOT: reasigna en Linear, nunca escribe la tarea nativa', async () => {
    h.sot = true;
    await expect(takeTask(ACTOR, T1)).resolves.toEqual({ changed: true });
    expect(linearIssues.reassignIssue).toHaveBeenCalledWith({ workItemId: T1, toDevId: ANA, reason: 'manual' });
    expect(queries.updateTask).not.toHaveBeenCalled();
  });
});

describe('ficha: Cambiar estado', () => {
  it('nativa: updateTask con el estado elegido y la ficha nueva', async () => {
    vi.mocked(queries.updateTask).mockImplementationOnce(async (id) => {
      h.tasks.set(T1, ref(T1, { status: 'revision', statusLabel: 'En revisión' }));
      return { id };
    });
    const reply: any = await tarea.components!['tarea.estado']!.run(compCtx('tarea.estado', [T1], ['revision']) as any);
    expect(queries.updateTask).toHaveBeenCalledWith(T1, { status: 'revision' });
    expect(reply.kind).toBe('update');
    expect(textOf(reply.message)).toContain('`ROZ-1` · 🟡 En revisión');
  });

  it('estado inventado: efímero sin escribir', async () => {
    const reply: any = await tarea.components!['tarea.estado']!.run(compCtx('tarea.estado', [T1], ['borrada']) as any);
    expect(reply.ephemeral).toBe(true);
    expect(queries.updateTask).not.toHaveBeenCalled();
  });

  it('con ROZ_LINEAR_SOT: estado equivalente del equipo en Linear y espejo al día', async () => {
    h.sot = true;
    h.fake.table('work_item').push({ id: T1, linear_id: 'lin-1', linear_team_id: 'team-1', url: null });
    await tarea.components!['tarea.estado']!.run(compCtx('tarea.estado', [T1], ['completada']) as any);
    expect(linearLinks.stateForStatus).toHaveBeenCalledWith('team-1', 'completada');
    expect(linearAdapter.updateIssue).toHaveBeenCalledWith('lin-1', { stateId: 'state-done' });
    expect(queries.updateTask).not.toHaveBeenCalled();
  });

  it('con ROZ_LINEAR_SOT y una tarea que no está en Linear: error claro', async () => {
    h.sot = true;
    await expect(tarea.components!['tarea.estado']!.run(compCtx('tarea.estado', [T1], ['completada']) as any)).rejects.toMatchObject({ code: 'NOT_IN_LINEAR' });
  });
});

// ================================================================ /roz ticket

describe('/roz ticket', () => {
  it('con proyecto en la opción: el modal lo lleva en el custom_id y no pide proyecto', async () => {
    const reply: any = await ticket.slash!.ticket!.run(slashCtx('ticket', { proyecto: OTHER_PROJECT }) as any);
    expect(reply.kind).toBe('modal');
    expect(reply.modal.custom_id).toBe(buildCustomId('ticket.modal', OTHER_PROJECT));
    expect(reply.modal.title).toBe('Ticket en Alfa');
    expect(reply.modal.components.map((c: any) => c.component.custom_id)).toEqual(['titulo', 'descripcion']);
  });

  it('sin opción: el proyecto del canal (o del canal padre de un hilo)', async () => {
    h.fake.table('discord_project_channel').push({ project_id: PROJECT, channel_id: GENERAL });
    const reply: any = await ticket.slash!.ticket!.run(slashCtx('ticket') as any);
    expect(reply.modal.custom_id).toBe(buildCustomId('ticket.modal', PROJECT));
    expect(await channelProjectId(THREAD)).toBe(PROJECT);
  });

  it('sin opción ni mapeo: `_` y un select de proyectos activos', async () => {
    const reply: any = await ticket.slash!.ticket!.run(slashCtx('ticket') as any);
    expect(reply.modal.custom_id).toBe('roz1:ticket.modal:_');
    const select = reply.modal.components[2].component;
    expect(select).toMatchObject({ type: 3, custom_id: 'proyecto' });
    expect(select.options.map((o: any) => o.label)).toEqual(['Alfa', 'Portal']);
  });

  it('autocompletado de proyecto: activos, el del canal primero', async () => {
    h.fake.table('discord_project_channel').push({ project_id: PROJECT, channel_id: GENERAL });
    const choices = await ticket.slash!.ticket!.autocomplete!(autoCtx('ticket', { name: 'proyecto', value: '' }) as any);
    expect(choices).toEqual([
      { name: 'Portal', value: PROJECT },
      { name: 'Alfa', value: OTHER_PROJECT },
    ]);
  });

  it('sin TypeSafe o sin usuario de roz: no abre el modal', async () => {
    h.autoAssign = false;
    await expect(ticket.slash!.ticket!.run(slashCtx('ticket') as any)).rejects.toMatchObject({ code: 'AUTO_ASSIGN_DISABLED' });
    h.autoAssign = true;
    await expect(ticket.slash!.ticket!.run({ ...slashCtx('ticket'), actor: { ...ACTOR, authUserId: null } } as any)).rejects.toBeInstanceOf(AppError);
  });

  it('envío: previewTicket + createTicket con el responsable de roz; ficha pública con la mención', async () => {
    vi.mocked(smart.previewTicket).mockResolvedValueOnce({ outcome: 'assigned', chosenDevId: BETO, previewId: 'pv-1', reason: null } as any);
    vi.mocked(smart.createTicket).mockImplementationOnce(async () => {
      h.tasks.set(T4, ref(T4, { identifier: 'ROZ-77', name: 'Arreglar login', assigneeDevIds: [BETO] }));
      return { task: null, identifier: 'ROZ-77', conversationId: null, messageSent: true, linear: { linearIssueId: 'l', url: 'u', warnings: ['sin etiqueta'] } };
    });
    const reply: any = await ticket.modals!['ticket.modal']!.run(
      modalCtx('ticket.modal', [null], { titulo: '  Arreglar login ', descripcion: 'falla en móvil', proyecto: [PROJECT] }) as any,
    );
    const user = { userId: AUTH_ANA, devId: ANA };
    expect(smart.previewTicket).toHaveBeenCalledWith(user, { title: 'Arreglar login', projectId: PROJECT, description: 'falla en móvil' }, expect.anything());
    expect(smart.createTicket).toHaveBeenCalledWith(
      user,
      { title: 'Arreglar login', projectId: PROJECT, description: 'falla en móvil', previewId: 'pv-1', assigneeDevId: BETO },
      expect.anything(),
    );
    expect(reply).toMatchObject({ kind: 'message', ephemeral: false });
    const [box] = ofType(reply.message, 17);
    expect(box.components[0].content).toBe(`🟢 Ticket \`ROZ-77\` creado · asignado a <@${U_BETO}>`);
    expect(reply.message.mentionUserIds).toEqual([U_BETO]);
    expect(textOf(reply.message)).toContain('**Arreglar login**\n`ROZ-77`');
    expect(reply.followups).toHaveLength(1);
    expect(reply.followups[0].ephemeral).toBe(true);
    expect(textOf(reply.followups[0].message)).toBe('🟡 Avisos de Linear\n-# sin etiqueta');
  });

  it('envío escalado: sin responsable y con el motivo de roz', async () => {
    vi.mocked(smart.previewTicket).mockResolvedValueOnce({ outcome: 'escalated', chosenDevId: null, previewId: 'pv-2', reason: 'nadie tiene la skill' } as any);
    vi.mocked(smart.createTicket).mockResolvedValueOnce({ task: null, identifier: 'ROZ-78', conversationId: null, messageSent: false, linear: null } as any);
    const reply: any = await ticket.modals!['ticket.modal']!.run(modalCtx('ticket.modal', [PROJECT], { titulo: 'X', descripcion: '' }) as any);
    expect(vi.mocked(smart.createTicket).mock.calls[0]![1].assigneeDevId).toBeNull();
    expect(textOf(reply.message)).toContain('🟡 Ticket `ROZ-78` creado sin responsable\n-# nadie tiene la skill');
    expect(reply.message.mentionUserIds).toEqual([]);
  });

  it('envío sin título o con un proyecto inactivo: error de validación', async () => {
    await expect(ticket.modals!['ticket.modal']!.run(modalCtx('ticket.modal', [PROJECT], { titulo: '  ' }) as any)).rejects.toMatchObject({ status: 400 });
    await expect(
      ticket.modals!['ticket.modal']!.run(modalCtx('ticket.modal', ['77777777-7777-4777-8777-777777777777'], { titulo: 'x' }) as any),
    ).rejects.toMatchObject({ status: 400 });
    expect(smart.previewTicket).not.toHaveBeenCalled();
  });
});

// ================================================================ /roz status

describe('/roz status', () => {
  it('efímero con un select múltiple de tus tareas (las en curso marcadas) y "Buscar otras"', async () => {
    const reply: any = await status.slash!.status!.run(slashCtx('status') as any);
    expect(chatTasks.searchTasks).toHaveBeenCalledWith(ANA, '', 25);
    expect(reply).toMatchObject({ kind: 'message', ephemeral: true });
    expect(textOf(reply.message)).toMatch(/^### Tu status\n-# Elige las tareas/);
    const [selectRow, searchRow] = rowsOf(reply.message);
    const select = selectRow.components[0];
    expect(select).toMatchObject({ custom_id: 'roz1:status.elegir', min_values: 1, max_values: 2 });
    expect(select.options).toEqual([
      { label: 'ROZ-2 · Tarea 2', value: T2, description: 'En curso', default: true },
      { label: 'ROZ-1 · Tarea 1', value: T1, description: 'Por hacer' },
    ]);
    expect(searchRow.components[0]).toMatchObject({ label: 'Buscar otras', custom_id: 'roz1:status.buscar' });
  });

  it('sin tareas: solo el botón de buscar', async () => {
    h.search = [];
    const reply: any = await status.slash!.status!.run(slashCtx('status') as any);
    expect(rowsOf(reply.message)).toHaveLength(1);
    expect(rowsOf(reply.message)[0].components[0].custom_id).toBe('roz1:status.buscar');
  });

  it('elegir: deja el efímero en "Publicado" y publica el daily en el canal, agrupado por estado', async () => {
    const reply: any = await status.components!['status.elegir']!.run(compCtx('status.elegir', [], [T2, T1]) as any);
    expect(reply.kind).toBe('update');
    expect(textOf(reply.message)).toBe('🟢 Publicado en el canal.');
    expect(rowsOf(reply.message)).toEqual([]);
    expect(reply.followups).toHaveLength(1);
    expect(reply.followups[0].ephemeral).toBe(false);
    const daily = reply.followups[0].message;
    // Encabezado con la foto: "### Daily de Ana" + "-# <día> · 2 tareas".
    const [head] = ofType(daily, 9);
    expect(head.components[0].content).toMatch(/^### Daily de Ana Pérez\n-# \S+ \d{1,2} \S+ · 2 tareas$/);
    expect(head.accessory.media.url).toBe('https://github.com/anagh.png?size=96');
    expect(textOf(daily)).toContain(`**🟢 En curso**\n\`ROZ-2\` [Tarea 2](https://roz.example.com/app/tasks?task=${T2})`);
    expect(textOf(daily)).toContain(`**⚪ Por hacer**\n\`ROZ-1\` [Tarea 1](https://roz.example.com/app/tasks?task=${T1})`);
    // En curso antes que Por hacer.
    expect(textOf(daily).indexOf('En curso')).toBeLessThan(textOf(daily).indexOf('Por hacer'));
  });

  it('elegir tareas que ya no existen: efímero', async () => {
    const reply: any = await status.components!['status.elegir']!.run(compCtx('status.elegir', [], [T4]) as any);
    expect(reply.ephemeral).toBe(true);
  });

  it('buscar: modal con el campo `buscar`; al enviarlo rehace el selector con los resultados', async () => {
    const m: any = await status.components!['status.buscar']!.run(compCtx('status.buscar', []) as any);
    expect(m.modal.custom_id).toBe('roz1:status.buscar.modal');
    expect(m.modal.components[0].component.custom_id).toBe('buscar');
    h.search = [h.tasks.get(T3)];
    const r: any = await status.modals!['status.buscar.modal']!.run(modalCtx('status.buscar.modal', [], { buscar: '#ROZ-3' }) as any);
    expect(chatTasks.searchTasks).toHaveBeenCalledWith(ANA, 'ROZ-3', 25);
    expect(r.kind).toBe('update');
    expect(textOf(r.message)).toMatch(/Resultados para "ROZ-3"/);
    expect(rowsOf(r.message)[0].components[0].options.map((o: any) => o.value)).toEqual([T3]);
  });
});

// ================================================================ "Crear tarea con roz"

describe('acción "Crear tarea con roz"', () => {
  it('título = primera línea, descripción = el resto', () => {
    expect(splitMessageText('\n## Falla el login\nen móvil\n\ncon Safari')).toEqual({ title: 'Falla el login', description: 'en móvil\n\ncon Safari' });
    expect(splitMessageText('')).toEqual({ title: '', description: '' });
    const long = 'x'.repeat(250);
    const r = splitMessageText(long);
    expect(r.title.length).toBe(200);
    expect(r.description).toBe(long);
  });

  it('abre el modal prellenado con el proyecto del canal preseleccionado', async () => {
    h.fake.table('discord_project_channel').push({ project_id: PROJECT, channel_id: GENERAL });
    const reply: any = await crear.message!['crear-tarea']!.run({ ...base(), command: 'crear-tarea', target: targetMsg('Falla el login\nen móvil') } as any);
    expect(reply.kind).toBe('modal');
    expect(reply.modal.custom_id).toBe(buildCustomId('msg.tarea.modal', GENERAL, MSG));
    const [titulo, desc, proyecto] = reply.modal.components.map((c: any) => c.component);
    expect(titulo).toMatchObject({ custom_id: 'titulo', value: 'Falla el login' });
    expect(desc).toMatchObject({ custom_id: 'descripcion', value: 'en móvil', required: false });
    expect(proyecto.options[0]).toEqual({ label: 'Portal', value: PROJECT, default: true });
  });

  it('envío: crea desde el mensaje como el actor (evidencia y aviso los pone src/discord) y publica la ficha', async () => {
    vi.mocked(discordTasks.createTaskFromDiscordMessage).mockResolvedValueOnce({ task: null, identifier: 'ROZ-1', workItemId: T1, linear: null });
    const reply: any = await crear.modals!['msg.tarea.modal']!.run(
      modalCtx('msg.tarea.modal', [GENERAL, MSG], { titulo: 'Falla el login', descripcion: 'en móvil', proyecto: [PROJECT] }) as any,
    );
    expect(discordTasks.createTaskFromDiscordMessage).toHaveBeenCalledWith(
      { devId: ANA, snap: {} },
      MSG,
      { projectId: PROJECT, name: 'Falla el login', description: 'en móvil' },
      AUTH_ANA,
      expect.any(Function),
    );
    expect(reply).toMatchObject({ kind: 'message', ephemeral: false });
    expect(textOf(reply.message)).toContain('🟢 Tarea creada desde un mensaje');
    expect(textOf(reply.message)).toContain('**Tarea 1**\n`ROZ-1`');
  });

  it('mensaje que roz aún no tiene: error claro', async () => {
    vi.mocked(discordTasks.createTaskFromDiscordMessage).mockRejectedValueOnce(new NotFoundError('el mensaje no existe'));
    await expect(
      crear.modals!['msg.tarea.modal']!.run(modalCtx('msg.tarea.modal', [GENERAL, MSG], { titulo: 'x', proyecto: [PROJECT] }) as any),
    ).rejects.toThrow(/todavía no tiene ese mensaje/);
  });

  it('sin proyecto válido: validación, no crea', async () => {
    await expect(crear.modals!['msg.tarea.modal']!.run(modalCtx('msg.tarea.modal', [GENERAL, MSG], { titulo: 'x', proyecto: [] }) as any)).rejects.toMatchObject({
      status: 400,
    });
    expect(discordTasks.createTaskFromDiscordMessage).not.toHaveBeenCalled();
  });
});

// ================================================================ "Citar tareas"

describe('acción "Citar tareas"', () => {
  it('detecta IDs sueltos, con # o en ramas; ignora código y URLs', () => {
    expect(findTaskIdentifiers('mira WAT-44 y #hyp-12, la rama feat/ROZ-123 (WAT-44 otra vez)')).toEqual(['WAT-44', 'HYP-12', 'ROZ-123']);
    expect(findTaskIdentifiers('```\nABC-1\n``` https://x.com/DEF-2 sin ids')).toEqual([]);
    expect(findTaskIdentifiers('x_WAT-44 WAT-44a WAT-44-2')).toEqual([]);
  });

  it('hasta 3: una ficha con botones por mensaje (la primera es la respuesta, las demás followups)', async () => {
    h.legacy.set('OLD-5', T3);
    const reply: any = await citar.message!['citar-tareas']!.run({ ...base(), command: 'citar-tareas', target: targetMsg('ROZ-1 bloquea a OLD-5 y NOPE-9') } as any);
    expect(reply).toMatchObject({ kind: 'message', ephemeral: false });
    expect(textOf(reply.message)).toContain('**Tarea 1**\n`ROZ-1`');
    expect(rowsOf(reply.message)[0].components[0].custom_id).toBe(buildCustomId('tarea.tomar', T1));
    expect(reply.followups).toHaveLength(1);
    expect(reply.followups[0]).toMatchObject({ ephemeral: false });
    expect(textOf(reply.followups[0].message)).toContain('**Tarea 3**\n`ROZ-3`');
  });

  it('más de 3: un solo mensaje con todas las fichas y sin botones', async () => {
    h.tasks.set(T4, ref(T4));
    const reply: any = await citar.message!['citar-tareas']!.run({ ...base(), command: 'citar-tareas', target: targetMsg('ROZ-1 ROZ-2 ROZ-3 ROZ-4') } as any);
    const text = textOf(reply.message);
    expect(text).toMatch(/^### 4 tareas citadas/);
    for (const id of ['ROZ-1', 'ROZ-2', 'ROZ-3', 'ROZ-4']) expect(text).toContain(`\`${id}\``);
    expect(rowsOf(reply.message)).toEqual([]);
    expect(buttonsOf(reply.message)).toEqual([]);
    expect(reply.followups).toBeUndefined();
  });

  it('busca también en los embeds de un mensaje del bot', async () => {
    const reply: any = await citar.message!['citar-tareas']!.run({
      ...base(),
      command: 'citar-tareas',
      target: targetMsg('', { embeds: [{ title: 'ROZ-2 · Tarea 2' }] }),
    } as any);
    expect(textOf(reply.message)).toContain('`ROZ-2`');
  });

  it('busca también en una ficha de roz en Components V2 (sin content ni embeds)', async () => {
    const card = await import('../src/discord/commands/embeds.js');
    const v2 = card.taskCardMessage({ id: T2, identifier: 'ROZ-2', name: 'Tarea 2', status: 'pendiente', priority: null, projectName: null, assignee: null });
    const reply: any = await citar.message!['citar-tareas']!.run({
      ...base(),
      command: 'citar-tareas',
      target: targetMsg('', { flags: 1 << 15, components: v2.components }),
    } as any);
    expect(textOf(reply.message)).toContain('**Tarea 2**\n`ROZ-2`');
  });

  it('sin IDs o con IDs que no existen: efímero', async () => {
    const none: any = await citar.message!['citar-tareas']!.run({ ...base(), command: 'citar-tareas', target: targetMsg('hola') } as any);
    expect(none).toMatchObject({ kind: 'message', ephemeral: true });
    const missing: any = await citar.message!['citar-tareas']!.run({ ...base(), command: 'citar-tareas', target: targetMsg('NOPE-1') } as any);
    expect(missing.ephemeral).toBe(true);
    expect(textOf(missing.message)).toMatch(/NOPE-1/);
  });
});

// ================================================================ por el router (callback real)

describe('por el router', () => {
  const DISCORD_EPOCH = 1420070400000;
  const id = () => ((BigInt(Date.now() - DISCORD_EPOCH) << 22n) + 1n).toString();
  const interaction = (over: Record<string, unknown>) => ({
    id: id(),
    application_id: APP,
    token: 'tok',
    guild_id: G,
    channel_id: GENERAL,
    member: { user: { id: U_ANA, username: 'ana' } },
    ...over,
  });
  const actorFor = async (u: string) => (u === U_ANA ? ACTOR : null);

  it('/roz tarea → type 4 público con la ficha; Tomar → type 7 sobre el mensaje', async () => {
    const out = await routeInteraction(
      {
        guildId: G,
        interaction: interaction({ type: 2, data: { type: 1, name: 'roz', options: [{ type: 1, name: 'tarea', options: [{ type: 3, name: 'buscar', value: T1 }] }] } }) as any,
      },
      { resolveActor: actorFor, budgetMs: 1000 },
    );
    expect(out.callback.type).toBe(4);
    expect((out.callback.data as any).flags).toBe(1 << 15);
    expect((out.callback.data as any).embeds).toBeUndefined();
    expect(textOf(out.callback.data as any)).toContain('**Tarea 1**\n`ROZ-1`');
    expect((out.callback.data as any).allowed_mentions.parse).toEqual([]);

    const click = await routeInteraction(
      {
        guildId: G,
        interaction: interaction({ type: 3, data: { custom_id: buildCustomId('tarea.estado', T1), component_type: 3, values: ['en_progreso'] }, message: targetMsg('') }) as any,
      },
      { resolveActor: actorFor, budgetMs: 1000 },
    );
    expect(click.callback.type).toBe(7);
    expect(queries.updateTask).toHaveBeenCalledWith(T1, { status: 'en_progreso' });
  });

  it('un AppError del handler sale efímero como "No se pudo: …"', async () => {
    const out = await routeInteraction(
      {
        guildId: G,
        interaction: interaction({ type: 3, data: { custom_id: buildCustomId('tarea.tomar', T3), component_type: 2 }, message: targetMsg('') }) as any,
      },
      { resolveActor: actorFor, budgetMs: 1000 },
    );
    expect(out.callback.type).toBe(4);
    expect((out.callback.data as any).flags).toBe((1 << 15) | 64);
    expect(textOf(out.callback.data as any)).toMatch(/^🔴 No se pudo: ROZ-3 ya está completada/);
  });
});
