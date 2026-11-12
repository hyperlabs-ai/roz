import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Components V2 de los mensajes de roz en Discord (src/discord/commands/v2.ts, embeds.ts, emojis.ts):
// forma del cuerpo que va a Discord (flag, sin content/embeds, edición), topes (40 componentes, 4000
// caracteres), colapso de lo normal (infra y pulso), daily agrupado, emojis de la app con caché y el
// aplanado para el espejo de roz. Puro o con `fetch` simulado: nada toca Discord.

vi.hoisted(() => {
  process.env.DISCORD_BOT_TOKEN = 'bot-token-SECRETO';
  process.env.DISCORD_GUILD_ID = '100000000000000001';
  process.env.DISCORD_CLIENT_ID = '900000000000000001';
  process.env.DISCORD_API_URL = 'https://discord.test/api/v10';
  process.env.DASHBOARD_URL = 'https://roz.example.com';
});

const V2 = await import('../src/discord/commands/v2.js');
const R = await import('../src/discord/commands/respond.js');
const E = await import('../src/discord/commands/embeds.js');
const EM = await import('../src/discord/commands/emojis.js');
const { normalizeApiMessage } = await import('../src/discord/normalize.js');
const { __resetDiscordRateLimits } = await import('../src/adapters/discord.js');
const { textOf, rowsOf, buttonsOf, ofType } = await import('./discord-v2-helpers.js');
type PulsePerson = import('../src/types/roz-v2.js').PulsePerson;
type ServiceCardInput = import('../src/discord/commands/embeds.js').ServiceCardInput;

const FLAG = 1 << 15;

function person(over: Partial<PulsePerson> = {}): PulsePerson {
  return {
    devId: 'd1',
    name: 'Manuel',
    githubLogin: 'manuel',
    avatarUrl: null,
    state: 'activo',
    stateDetail: null,
    currentIssue: null,
    agentPlan: null,
    cycle: null,
    week: { commits: 0, lines: 0, prsOpened: 0, prsMerged: 0, issuesClosed: 0 },
    projects: [],
    lastActivityAt: null,
    ...over,
  };
}

function within(msg: { components?: unknown[] }) {
  const list = (msg.components ?? []) as any[];
  expect(V2.countComponents(list)).toBeLessThanOrEqual(V2.V2_LIMITS.components);
  expect(V2.textLength(list)).toBeLessThanOrEqual(V2.V2_LIMITS.text);
}

describe('cuerpo para Discord (toMessageBody)', () => {
  it('siempre V2: flag, sin content ni embeds, un Container naranja; efímero suma el bit 64', () => {
    const pub = R.toMessageBody({ content: 'hola' });
    expect(pub.flags).toBe(FLAG);
    expect(pub.content).toBeUndefined();
    expect(pub.embeds).toBeUndefined();
    expect(pub.components).toEqual([{ type: 17, accent_color: 0xff5b23, components: [{ type: 10, content: 'hola' }] }]);
    expect(R.toMessageBody({ content: 'x' }, true).flags).toBe(FLAG | 64);
  });

  it('al editar vacía content (null) y embeds ([]): así una ficha vieja con embeds pasa a V2', () => {
    expect(R.toMessageBody({ content: 'x' }, false, true)).toMatchObject({ content: null, embeds: [], flags: FLAG });
  });

  it('mensaje clásico (texto + filas) → Container con el texto y las filas dentro', () => {
    const btn = R.button({ label: 'Tomar', customId: 'roz1:tarea.tomar:_' });
    const body = R.toMessageBody({ content: 'elige', components: [R.row(btn)] });
    const [box] = body.components as any[];
    expect(box.type).toBe(17);
    expect(box.components.map((c: any) => c.type)).toEqual([10, 1]);
  });

  it('allowed_mentions seguro aunque el texto traiga @everyone o roles', () => {
    const body = R.toMessageBody({ content: '@everyone <@&123> <@200000000000000002>', mentionUserIds: ['200000000000000002'] });
    expect(body.allowed_mentions).toEqual({ parse: [], users: ['200000000000000002'], roles: [], replied_user: false });
  });

  it('errores y "sin cuenta": un aviso corto con 🔴/⚪', () => {
    const err = R.errorReply(new Error('x'));
    if (err.kind !== 'message') throw new Error('esperaba mensaje');
    expect(textOf(err.message)).toBe('🔴 Algo falló en roz al hacer esto.\n-# Intenta de nuevo; si sigue, avisa en el canal de roz.');
    const nl = R.notLinkedReply();
    if (nl.kind !== 'message') throw new Error('esperaba mensaje');
    expect(textOf(nl.message)).toMatch(/^⚪ Tu cuenta de Discord no está ligada a roz\.\n-# /);
    expect(buttonsOf(nl.message)[0]).toMatchObject({ label: 'Ligar mi cuenta en roz', url: 'https://roz.example.com/app/settings' });
  });
});

describe('topes de Discord (fitV2)', () => {
  it('cuenta componentes anidados y accesorios', () => {
    const msg = V2.v2Message([V2.text('a'), V2.section('b', V2.thumbnail('https://x.test/a.png')), R.row(R.button({ label: 'x', customId: 'roz1:a' }))]);
    // container + text + (section + text + thumbnail) + (row + button)
    expect(V2.countComponents(msg.components as any)).toBe(7);
  });

  it('más de 40 componentes: quita del final, deja el encabezado, las filas de botones y una nota', () => {
    const rows = [R.row(R.button({ label: 'Tomar', customId: 'roz1:tarea.tomar:_' }))];
    const many = Array.from({ length: 30 }, (_, i) => V2.section(`persona ${i}`, V2.thumbnail(`https://x.test/${i}.png`)));
    const fitted = V2.fitV2(V2.v2Message([V2.header('Título', 'resumen'), ...many, ...rows]).components as any);
    within({ components: fitted });
    const box = fitted[0] as any;
    expect(box.components[0].content).toBe('### Título\n-# resumen');
    expect(box.components.at(-1).type).toBe(1);
    expect(textOf({ components: fitted })).toContain('…y más en roz');
  });

  it('más de 4000 caracteres de texto: recorta', () => {
    const fitted = V2.fitV2(V2.v2Message([V2.header('T'), V2.text('x'.repeat(3000)), V2.text('y'.repeat(3000))]).components as any);
    within({ components: fitted });
  });

  it('no toca la entrada', () => {
    const msg = V2.v2Message([V2.header('T'), ...Array.from({ length: 50 }, (_, i) => V2.text(String(i)))]);
    const before = JSON.stringify(msg);
    V2.fitV2(msg.components as any);
    expect(JSON.stringify(msg)).toBe(before);
  });

  it('joinFit: lista con "+N" cuando no cabe', () => {
    expect(V2.joinFit(['a', 'b', 'c'], 100)).toBe('a, b, c');
    expect(V2.joinFit(['alfa', 'beta', 'gamma', 'delta'], 14)).toBe('alfa, beta +2');
  });

  it('un solo mapa de estados', () => {
    expect(V2.STATUS_EMOJI).toEqual({ ok: '🟢', wait: '🟡', agent: '🟣', bad: '🔴', off: '⚪' });
  });
});

describe('/roz infra (infraMessage)', () => {
  const svc = (i: number, over: Partial<ServiceCardInput> = {}): ServiceCardInput => ({
    name: `svc-${String(i).padStart(2, '0')}`,
    provider: i % 2 ? 'vercel' : 'supabase',
    projectName: 'Hyperflow',
    status: 'healthy',
    checkedAt: '2026-11-11T11:00:00.000Z',
    ...over,
  });

  it('todo bien: "Todo en línea" y UNA línea por proveedor (nunca una por servicio)', () => {
    const msg = E.infraMessage([...Array.from({ length: 21 }, (_, i) => svc(i)), svc(99, { status: 'unknown', provider: 'railway' })], {
      emojis: new Map([['roz_vercel', '<:roz_vercel:1>']]),
    });
    const text = textOf(msg);
    expect(text).toMatch(/^### Infraestructura\n-# 22 servicios · 21 en línea · 1 sin datos · actualizado <t:\d+:R>/);
    expect(text).toContain('## 🟢 Todo en línea');
    expect(text).toContain('<:roz_vercel:1> **Vercel** · 🟢 10/10 en línea\n-# svc-01, svc-03');
    expect(text).toContain('**Supabase** · 🟢 11/11 en línea');
    expect(text).toContain('**Railway** · ⚪ 0/1 en línea · 1 sin datos\n-# svc-99');
    expect(ofType(msg, 9)).toEqual([]);
    // El orden de proveedores: Vercel, Railway, Supabase.
    expect(text.indexOf('Vercel')).toBeLessThan(text.indexOf('Railway'));
    expect(text.indexOf('Railway')).toBeLessThan(text.indexOf('Supabase'));
    within(msg);
  });

  it('con problemas: tarjetas primero (máx. 6) y el resto contado; dentro de los topes', () => {
    const down = Array.from({ length: 9 }, (_, i) => svc(i, { status: 'down', lastError: 'boom '.repeat(100) }));
    const msg = E.infraMessage([...down, ...Array.from({ length: 60 }, (_, i) => svc(100 + i))]);
    expect(ofType(msg, 9)).toHaveLength(E.MAX_SERVICE_SECTIONS);
    expect(textOf(msg)).toContain('-# +3 con problemas más en roz');
    expect(textOf(msg)).not.toContain('Todo en línea');
    within(msg);
    within({ components: R.toMessageBody(msg).components });
  });
});

describe('/roz pulso (pulseMessage)', () => {
  it('nadie con issue: sin tarjetas, todos en una sola línea tenue', () => {
    const msg = E.pulseMessage([person({ name: 'Manuel', state: 'ocupado' }), person({ devId: 'd2', name: 'Fer', state: 'fuera' })]);
    expect(ofType(msg, 9)).toEqual([]);
    expect(textOf(msg)).toContain('-# Sin issue en curso: Manuel, Fer');
    expect(textOf(msg)).toMatch(/^### Pulso del equipo\n-# 1 en junta · 1 fuera/);
  });

  it('título del issue recortado a ~60 caracteres', () => {
    const msg = E.pulseMessage([
      person({ currentIssue: { workItemId: 'w', identifier: 'HYPERHUB-96', name: 'x'.repeat(120), status: 'en_progreso', linearStateName: null, url: null, projectId: null } }),
    ]);
    const line = textOf(msg)
      .split('\n')
      .find((l) => l.startsWith('`HYPERHUB-96`'))!;
    expect(line.length).toBeLessThanOrEqual('`HYPERHUB-96` '.length + E.TITLE_IN_LINE);
  });
});

describe('daily (statusMessage)', () => {
  const card = (id: string, status: string) => ({ id: `t-${id}`, identifier: id, name: `Tarea ${id}`, status, priority: null, projectName: null, assignee: null });

  it('agrupa En curso / Por hacer / En revisión / Hecho, en ese orden, con su emoji', () => {
    const msg = E.statusMessage({
      person: { name: 'Manuel', avatarUrl: null },
      cards: [card('A-1', 'completada'), card('A-2', 'revision'), card('A-3', 'pendiente'), card('A-4', 'en_progreso'), card('A-5', 'en_progreso')],
      day: '2026-11-11',
    });
    const text = textOf(msg);
    expect(text).toMatch(/^### Daily de Manuel\n-# miércoles 11 nov · 5 tareas/);
    const order = ['**🟢 En curso**', '**⚪ Por hacer**', '**🟡 En revisión**', '**🟢 Hecho**'].map((g) => text.indexOf(g));
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('**🟢 En curso**\n`A-4` [Tarea A-4](https://roz.example.com/app/tasks?task=t-A-4)\n`A-5`');
  });

  it('dayLabel', () => {
    expect(E.dayLabel('2026-11-12')).toBe('jueves 12 nov');
    expect(E.dayLabel(null)).toBeNull();
  });
});

describe('plan (planMessage)', () => {
  it('error → 🔴 y línea de error; pasos numerados; botones solo los permitidos', () => {
    const msg = E.planMessage({
      id: 'p1',
      workItemId: 'w',
      identifier: 'WAT-44',
      linearIssueId: null,
      issue: { name: 'Login', url: null, status: 'en_progreso', projectId: null, projectName: null },
      owner: { id: 'd', name: 'Ana', githubLogin: null, avatarUrl: null } as any,
      status: 'implementando',
      phase: 'implementar',
      risk: 0,
      riskReasons: [],
      repo: null,
      branch: 'feat/wat-44',
      prNumber: 12,
      prUrl: 'https://github.com/x/y/pull/12',
      progress: null,
      runner: null,
      heartbeatAt: null,
      attempts: 1,
      error: 'tests rojos',
      claimable: false,
      claimableReason: null,
      pulledBy: null,
      enqueuedAt: '',
      updatedAt: '',
      actions: [],
      planMd: '- Uno\n- Dos',
    });
    const text = textOf(msg);
    expect(text).toMatch(/^### `WAT-44` Login\n🔴 Implementando/);
    expect(text).toContain('1. Uno\n2. Dos');
    expect(text).toContain('[PR #12](https://github.com/x/y/pull/12) · `feat/wat-44`');
    expect(text).toContain('🔴 **Error** · tests rojos');
    expect(buttonsOf(msg).map((b) => b.label)).toEqual(['Abrir', 'PR']);
  });
});

describe('emojis de la app', () => {
  let calls = 0;
  beforeEach(() => {
    calls = 0;
    EM.resetAppEmojis();
    __resetDiscordRateLimits();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('GET /applications/{id}/emojis una vez (caché) y markup por nombre; lo que falta cae a texto', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      calls++;
      expect(String(url)).toBe('https://discord.test/api/v10/applications/900000000000000001/emojis');
      return new Response(JSON.stringify({ items: [{ id: '42', name: 'roz_vercel' }, { id: '43', name: 'roz_bot', animated: true }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const a = await EM.appEmojis();
    const b = await EM.appEmojis();
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(EM.providerIcon('vercel', a)).toBe('<:roz_vercel:42>');
    expect(EM.icon('roz_bot', a)).toBe('<a:roz_bot:43>');
    expect(EM.providerIcon('railway', a)).toBe('');
    expect(EM.withIcon('', 'Railway')).toBe('Railway');
  });

  it('si Discord falla: mapa vacío (y no reintenta en cada comando)', async () => {
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('{"message":"no"}', { status: 403, headers: { 'content-type': 'application/json' } });
    });
    expect((await EM.appEmojis()).size).toBe(0);
    expect((await EM.appEmojis()).size).toBe(0);
    expect(calls).toBe(1);
  });
});

describe('espejo de roz (normalize)', () => {
  it('un mensaje V2 sin embeds se guarda con UN embed aplanado (título, texto, miniatura, color)', () => {
    const msg = E.taskCardMessage({
      id: '44444444-4444-4444-8444-444444444444',
      identifier: 'WAT-44',
      name: 'Login',
      status: 'en_progreso',
      priority: 'high',
      projectName: 'Portal',
      assignee: { name: 'Ana', avatarUrl: 'https://github.com/ana.png?size=96' },
    });
    const row = normalizeApiMessage(
      {
        id: '1',
        channel_id: '2',
        type: 0,
        author: { id: '3', username: 'roz', bot: true },
        content: '',
        timestamp: '2026-11-11T11:00:00.000Z',
        edited_timestamp: null,
        attachments: [],
        embeds: [],
        mentions: [],
        mention_roles: [],
        mention_everyone: false,
        pinned: false,
        flags: FLAG,
        components: msg.components,
      } as any,
      '100000000000000001',
    );
    expect(row.embeds).toHaveLength(1);
    expect(row.embeds[0]).toMatchObject({ color: 0xff5b23, thumbnail: { url: 'https://github.com/ana.png?size=96' } });
    expect(row.embeds[0]!.description).toBe('**Login**\n`WAT-44` · 🟢 En curso · Prioridad alta · Ana\nPortal');
    expect(rowsOf(msg)).toHaveLength(2);
  });
});
