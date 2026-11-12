// Reporte de trabajo y enfoque: en qué se fue el esfuerzo del período y si coincide con el plan.
//
// Vive aparte de queries.ts a propósito: es de solo lectura, no comparte forma con ninguna otra
// respuesta y así no se pisa con las consultas de Tareas. Las reglas de conteo son las mismas:
//
//  · Código = filas de `commit` (la ingesta ya deja solo commits no-merge de la rama por defecto,
//    cada sha una vez), acotadas por `committed_at`.
//  · Hyper points = √(commits × líneas) / 10 calculados SOBRE EL CUBO (persona, proyecto o persona ×
//    proyecto), nunca por commit. El "esfuerzo" de un cubo es eso, y la participación es su parte de
//    la suma de cubos hermanos: así ni un scaffold de 80 mil líneas ni cien micro-commits se llevan
//    solos la gráfica.
//  · Tareas cerradas = `completed_at` en el período, solo de la era roz (native/pr/commit).
//  · El plan sale de Capacidad (`dev_assignment.load_pct`), que es lo que el equipo dijo que haría.
import { db } from '../db/supabase.js';
import { CLOSED_STATES } from '../tasks/states.js';
import { avatarFor, type Metric, type Period } from './queries.js';
import { clientKeyFor } from './pulse.js';

type Row = Record<string, any>;

const PAGE = 1000;

/** Trae todas las páginas: PostgREST corta en 1000 filas y un trimestre de commits las pasa. */
async function all(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < 20; i++) {
    const { data, error } = await build(i * PAGE, i * PAGE + PAGE - 1);
    if (error || !Array.isArray(data)) break;
    out.push(...(data as Row[]));
    if (data.length < PAGE) break;
  }
  return out;
}

/** Lectura opcional: si la tabla/columna aún no existe en este entorno, llega vacía. */
async function soft(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
  try {
    const { data, error } = await q;
    return error || !Array.isArray(data) ? [] : (data as Row[]);
  } catch {
    return [];
  }
}

function metric(value: number, compare: number | null): Metric {
  if (compare === null) return { value, compare: null, changePct: null, direction: 'none' };
  const changePct = compare === 0 ? (value > 0 ? 100 : 0) : Math.round(((value - compare) / compare) * 100);
  return { value, compare, changePct, direction: value > compare ? 'up' : value < compare ? 'down' : 'flat' };
}

const linesOf = (c: Row) => (c.additions ?? 0) + (c.deletions ?? 0);
const points = (commits: number, lines: number) => Math.sqrt(commits * lines) / 10;
const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);

function commitsIn(p: Period): Promise<Row[]> {
  return all((a, b) =>
    db().from('commit').select('sha, project_id, dev_id, message, additions, deletions, committed_at')
      .gte('committed_at', p.from).lt('committed_at', p.to).order('committed_at').range(a, b));
}

function closedIn(p: Period): Promise<Row[]> {
  return all((a, b) =>
    db().from('work_item').select('id, project_id, assignee_dev_id, priority, started_at, completed_at, created_at')
      .gte('completed_at', p.from).lt('completed_at', p.to).in('source', ['native', 'pr', 'commit']).order('completed_at').range(a, b));
}

function createdIn(p: Period): Promise<Row[]> {
  return all((a, b) =>
    db().from('work_item').select('id, project_id, created_at')
      .gte('created_at', p.from).lt('created_at', p.to).order('created_at').range(a, b));
}

// Tipo de trabajo, leído del prefijo convencional del commit. Sin modelo: es lo que el dev escribió.
const TYPE_RULES: [string, RegExp][] = [
  ['feature', /^(feat|feature|add)\b/i],
  ['fix', /^(fix|bugfix|hotfix|bug)\b/i],
  ['refactor', /^(refactor|perf|style)\b/i],
  ['docs', /^(docs?)\b/i],
  ['tests', /^(tests?)\b/i],
  ['mantenimiento', /^(chore|build|ci|deps?|bump|revert|release)\b/i],
];

function workType(message: string | null): string {
  const m = (message ?? '').trim();
  for (const [key, re] of TYPE_RULES) if (re.test(m)) return key;
  return 'otro';
}

/** Horas de ciclo de una tarea cerrada (inicio → cierre; si nunca se marcó inicio, alta → cierre). */
function cycleHours(w: Row): number | null {
  const start = w.started_at ?? w.created_at;
  if (!start || !w.completed_at) return null;
  const h = (new Date(w.completed_at).getTime() - new Date(start).getTime()) / 3_600_000;
  return h >= 0 ? h : null;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const CYCLE_BUCKETS: { label: string; max: number }[] = [
  { label: '< 4 h', max: 4 },
  { label: 'Mismo día', max: 24 },
  { label: '1 a 3 días', max: 72 },
  { label: '3 a 7 días', max: 168 },
  { label: '+ 1 semana', max: Infinity },
];

const AGE_BUCKETS: { label: string; max: number }[] = [
  { label: '< 1 sem', max: 7 },
  { label: '1 a 2 sem', max: 14 },
  { label: '2 a 4 sem', max: 30 },
  { label: '1 a 3 meses', max: 90 },
  { label: '+ 3 meses', max: Infinity },
];

/** Días del período, uno por cubo, o semanas (lunes) cuando el rango pasa de ~2 meses. */
function timeBuckets(p: Period): { keys: string[]; keyOf: (iso: string) => string; weekly: boolean } {
  const from = new Date(p.from);
  const to = new Date(p.to);
  const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000));
  const weekly = days > 62;
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const weekStart = (d: Date) => {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
    return x;
  };
  const keyOf = (iso: string) => (weekly ? dayKey(weekStart(new Date(iso))) : iso.slice(0, 10));
  const keys: string[] = [];
  const seen = new Set<string>();
  for (let t = from.getTime(); t < to.getTime(); t += 86_400_000) {
    const k = keyOf(new Date(t).toISOString());
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  return { keys, keyOf, weekly };
}

export async function getWorkReport(period: Period, cmp: Period | null) {
  const supabase = db();
  const [commits, closed, created, cmpCommits, cmpClosed, cmpCreated, devs, projects, openItems, assignments] = await Promise.all([
    commitsIn(period),
    closedIn(period),
    createdIn(period),
    cmp ? commitsIn(cmp) : Promise.resolve(null),
    cmp ? closedIn(cmp) : Promise.resolve(null),
    cmp ? createdIn(cmp) : Promise.resolve(null),
    soft(supabase.from('dev').select('id, name, github_login, active')),
    // `color` y `client_email_domains` llegaron en migraciones posteriores: si faltan, respaldo sin ellas.
    soft(supabase.from('project').select('id, name, kind, color, client_email_domains')).then((rows) =>
      rows.length ? rows : soft(supabase.from('project').select('id, name, kind'))),
    all((a, b) =>
      supabase.from('work_item').select('id, project_id, assignee_dev_id, created_at, linear_created_at, due_date')
        .not('status', 'in', `(${CLOSED_STATES.join(',')})`).order('id').range(a, b)),
    soft(supabase.from('dev_assignment').select('dev_id, kind, project_id, load_pct')),
  ]);

  const proj = new Map(projects.map((p) => [p.id as string, p]));
  const dev = new Map(devs.map((d) => [d.id as string, d]));
  const projName = (id: string | null) => (id ? (proj.get(id)?.name as string | undefined) ?? '(desconocido)' : 'Sin proyecto');

  // ---- Totales y comparación ---------------------------------------------------------------
  const teamPoints = (rows: Row[]) => {
    const by = new Map<string, { c: number; l: number }>();
    for (const c of rows) {
      const k = c.dev_id ?? 'none';
      const a = by.get(k) ?? { c: 0, l: 0 };
      a.c++;
      a.l += linesOf(c);
      by.set(k, a);
    }
    let s = 0;
    by.forEach((a) => (s += points(a.c, a.l)));
    return Math.round(s);
  };
  const sumLines = (rows: Row[]) => rows.reduce((s, c) => s + linesOf(c), 0);
  const medianCycle = (rows: Row[]) => Math.round(median(rows.map(cycleHours).filter((h): h is number => h !== null)));

  // ---- Por proyecto ------------------------------------------------------------------------
  const { keys, keyOf, weekly } = timeBuckets(period);
  const keyIndex = new Map(keys.map((k, i) => [k, i]));

  interface ProjAgg { projectId: string | null; commits: number; lines: number; closed: number; opened: number; open: number; devs: Set<string>; spark: number[] }
  const byProj = new Map<string, ProjAgg>();
  const projAgg = (id: string | null) => {
    const k = id ?? 'none';
    let a = byProj.get(k);
    if (!a) {
      a = { projectId: id, commits: 0, lines: 0, closed: 0, opened: 0, open: 0, devs: new Set(), spark: keys.map(() => 0) };
      byProj.set(k, a);
    }
    return a;
  };
  for (const c of commits) {
    const a = projAgg(c.project_id ?? null);
    a.commits++;
    a.lines += linesOf(c);
    if (c.dev_id) a.devs.add(c.dev_id);
    const i = c.committed_at ? keyIndex.get(keyOf(c.committed_at)) : undefined;
    if (i !== undefined) a.spark[i]!++;
  }
  for (const w of closed) {
    const a = projAgg(w.project_id ?? null);
    a.closed++;
    if (w.assignee_dev_id) a.devs.add(w.assignee_dev_id);
  }
  for (const w of created) projAgg(w.project_id ?? null).opened++;
  // Las abiertas solo suman a proyectos que ya tuvieron movimiento o que tienen cola: un proyecto
  // con cola y cero trabajo es justo el dato de enfoque que hay que ver.
  for (const w of openItems) projAgg(w.project_id ?? null).open++;

  const projRows = [...byProj.values()].map((a) => {
    const p = a.projectId ? proj.get(a.projectId) : null;
    const client = p ? clientKeyFor(p as any) : { key: 'none', label: 'Sin proyecto' };
    return {
      projectId: a.projectId,
      name: projName(a.projectId),
      kind: (p?.kind as string | undefined) ?? null,
      color: (p?.color as string | null | undefined) ?? null,
      client: client.label,
      clientKey: client.key,
      commits: a.commits,
      lines: a.lines,
      points: round1(points(a.commits, a.lines)),
      closed: a.closed,
      opened: a.opened,
      open: a.open,
      people: a.devs.size,
      spark: a.spark,
      share: 0,
    };
  });
  const totalProjPoints = projRows.reduce((s, r) => s + r.points, 0);
  projRows.forEach((r) => (r.share = pct(r.points, totalProjPoints)));
  projRows.sort((a, b) => b.points - a.points || b.closed - a.closed || b.open - a.open);

  // Enfoque del equipo: parte del esfuerzo en el proyecto #1 y en los tres primeros.
  const focusOf = (rows: Row[]) => {
    const by = new Map<string, { c: number; l: number }>();
    for (const c of rows) {
      const k = c.project_id ?? 'none';
      const a = by.get(k) ?? { c: 0, l: 0 };
      a.c++;
      a.l += linesOf(c);
      by.set(k, a);
    }
    const pts = [...by.values()].map((a) => points(a.c, a.l)).sort((a, b) => b - a);
    const total = pts.reduce((s, x) => s + x, 0);
    return { top1: pct(pts[0] ?? 0, total), top3: pct((pts[0] ?? 0) + (pts[1] ?? 0) + (pts[2] ?? 0), total), active: pts.filter((x) => x > 0).length };
  };
  const focus = focusOf(commits);
  const cmpFocus = cmpCommits ? focusOf(cmpCommits) : null;

  const kpis = {
    hyperPoints: metric(teamPoints(commits), cmpCommits ? teamPoints(cmpCommits) : null),
    commits: metric(commits.length, cmpCommits ? cmpCommits.length : null),
    linesChanged: metric(sumLines(commits), cmpCommits ? sumLines(cmpCommits) : null),
    closed: metric(closed.length, cmpClosed ? cmpClosed.length : null),
    opened: metric(created.length, cmpCreated ? cmpCreated.length : null),
    cycleHours: metric(medianCycle(closed), cmpClosed ? medianCycle(cmpClosed) : null),
    activeProjects: metric(focus.active, cmpFocus ? cmpFocus.active : null),
    focusTop3: metric(focus.top3, cmpFocus ? cmpFocus.top3 : null),
  };

  // ---- Por cliente y cliente vs interno ----------------------------------------------------
  const byClientMap = new Map<string, { label: string; commits: number; lines: number; closed: number; projects: number }>();
  for (const r of projRows) {
    if (!r.commits && !r.closed) continue;
    const a = byClientMap.get(r.clientKey) ?? { label: r.client, commits: 0, lines: 0, closed: 0, projects: 0 };
    a.commits += r.commits;
    a.lines += r.lines;
    a.closed += r.closed;
    a.projects++;
    byClientMap.set(r.clientKey, a);
  }
  const clientRows = [...byClientMap.values()].map((a) => ({ ...a, points: round1(points(a.commits, a.lines)), share: 0 }));
  const totalClientPoints = clientRows.reduce((s, r) => s + r.points, 0);
  clientRows.forEach((r) => (r.share = pct(r.points, totalClientPoints)));
  clientRows.sort((a, b) => b.points - a.points);

  const kindPoints = { client: 0, internal: 0, none: 0 };
  for (const r of projRows) {
    if (r.kind === 'client') kindPoints.client += r.points;
    else if (r.kind === 'internal') kindPoints.internal += r.points;
    else kindPoints.none += r.points;
  }
  const split = {
    client: round1(kindPoints.client),
    internal: round1(kindPoints.internal),
    unassigned: round1(kindPoints.none),
  };

  // ---- Tendencia (período vs comparación, alineada por posición) ---------------------------
  const cmpBuckets = cmp ? timeBuckets(cmp) : null;
  const cur = keys.map(() => ({ commits: 0, lines: 0, opened: 0, closed: 0 }));
  for (const c of commits) {
    const i = c.committed_at ? keyIndex.get(keyOf(c.committed_at)) : undefined;
    if (i !== undefined) {
      cur[i]!.commits++;
      cur[i]!.lines += linesOf(c);
    }
  }
  for (const w of created) {
    const i = keyIndex.get(keyOf(w.created_at));
    if (i !== undefined) cur[i]!.opened++;
  }
  for (const w of closed) {
    const i = keyIndex.get(keyOf(w.completed_at));
    if (i !== undefined) cur[i]!.closed++;
  }
  const prev = keys.map(() => 0);
  if (cmpBuckets && cmpCommits) {
    const idx = new Map(cmpBuckets.keys.map((k, i) => [k, i]));
    for (const c of cmpCommits) {
      const i = c.committed_at ? idx.get(cmpBuckets.keyOf(c.committed_at)) : undefined;
      if (i !== undefined && i < prev.length) prev[i]!++;
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  let backlogDelta = 0;
  const trend = keys.map((date, i) => {
    backlogDelta += cur[i]!.opened - cur[i]!.closed;
    return {
      date,
      commits: cur[i]!.commits,
      lines: cur[i]!.lines,
      opened: cur[i]!.opened,
      closed: cur[i]!.closed,
      // Neto acumulado: sube cuando entra más de lo que sale.
      net: backlogDelta,
      previous: cmp ? prev[i]! : null,
      future: date > today,
    };
  }).filter((d) => !d.future).map(({ future: _f, ...d }) => d);

  // ---- Tipo de trabajo ---------------------------------------------------------------------
  const typeMap = new Map<string, { commits: number; lines: number }>();
  for (const c of commits) {
    const k = workType(c.message);
    const a = typeMap.get(k) ?? { commits: 0, lines: 0 };
    a.commits++;
    a.lines += linesOf(c);
    typeMap.set(k, a);
  }
  const byType = [...typeMap.entries()].map(([type, a]) => ({ type, ...a })).sort((a, b) => b.commits - a.commits);

  // ---- Ritmo: día de la semana × hora (UTC-6, el huso del equipo) --------------------------
  const weekday = Array.from({ length: 7 }, () => 0);
  for (const c of commits) {
    if (!c.committed_at) continue;
    const local = new Date(new Date(c.committed_at).getTime() - 6 * 3_600_000);
    weekday[(local.getUTCDay() + 6) % 7]!++;
  }

  // ---- Ciclo y antigüedad de la cola -------------------------------------------------------
  const cycleDist = CYCLE_BUCKETS.map((b) => ({ label: b.label, value: 0 }));
  for (const w of closed) {
    const h = cycleHours(w);
    if (h === null) continue;
    cycleDist[CYCLE_BUCKETS.findIndex((b) => h < b.max)]!.value++;
  }
  const now = Date.now();
  const ageDist = AGE_BUCKETS.map((b) => ({ label: b.label, value: 0 }));
  let overdue = 0;
  let unassigned = 0;
  for (const w of openItems) {
    const born = w.linear_created_at ?? w.created_at;
    if (born) {
      const d = (now - new Date(born).getTime()) / 86_400_000;
      ageDist[AGE_BUCKETS.findIndex((b) => d < b.max)]!.value++;
    }
    if (w.due_date && String(w.due_date).slice(0, 10) < today) overdue++;
    if (!w.assignee_dev_id) unassigned++;
  }

  // ---- Enfoque por persona: real (código) contra plan (Capacidad) ---------------------------
  const perDev = new Map<string, { commits: number; lines: number; byProject: Map<string, { c: number; l: number }> }>();
  for (const c of commits) {
    if (!c.dev_id) continue;
    let a = perDev.get(c.dev_id);
    if (!a) {
      a = { commits: 0, lines: 0, byProject: new Map() };
      perDev.set(c.dev_id, a);
    }
    a.commits++;
    a.lines += linesOf(c);
    const k = c.project_id ?? 'none';
    const pa = a.byProject.get(k) ?? { c: 0, l: 0 };
    pa.c++;
    pa.l += linesOf(c);
    a.byProject.set(k, pa);
  }
  const closedByDev = new Map<string, number>();
  for (const w of closed) if (w.assignee_dev_id) closedByDev.set(w.assignee_dev_id, (closedByDev.get(w.assignee_dev_id) ?? 0) + 1);
  const openByDev = new Map<string, number>();
  for (const w of openItems) if (w.assignee_dev_id) openByDev.set(w.assignee_dev_id, (openByDev.get(w.assignee_dev_id) ?? 0) + 1);

  const planByDev = new Map<string, { projectId: string | null; pct: number; kind: string }[]>();
  for (const a of assignments) {
    const list = planByDev.get(a.dev_id) ?? [];
    list.push({ projectId: a.project_id ?? null, pct: Number(a.load_pct) || 0, kind: a.kind });
    planByDev.set(a.dev_id, list);
  }

  const peopleIds = new Set<string>([...perDev.keys(), ...closedByDev.keys()]);
  // Quien tiene plan pero no movió nada también sale: es el caso que más interesa ver.
  for (const [id, plan] of planByDev) if (dev.get(id)?.active && plan.length) peopleIds.add(id);

  const people = [...peopleIds].filter((id) => dev.has(id)).map((id) => {
    const d = dev.get(id)!;
    const a = perDev.get(id);
    const real = a
      ? [...a.byProject.entries()].map(([k, v]) => ({ projectId: k === 'none' ? null : k, points: points(v.c, v.l), commits: v.c }))
      : [];
    const realTotal = real.reduce((s, r) => s + r.points, 0);
    const actual = real
      .map((r) => ({ projectId: r.projectId, name: projName(r.projectId), color: (r.projectId ? proj.get(r.projectId)?.color : null) ?? null, commits: r.commits, share: pct(r.points, realTotal) }))
      .sort((x, y) => y.share - x.share);

    // El plan se normaliza a 100: la carga puede sumar 160%, pero aquí se compara REPARTO, no carga.
    const planRaw = (planByDev.get(id) ?? []).filter((p) => p.pct > 0);
    const planTotal = planRaw.reduce((s, p) => s + p.pct, 0);
    const planMap = new Map<string, number>();
    for (const p of planRaw) {
      const k = p.projectId ?? 'none';
      planMap.set(k, (planMap.get(k) ?? 0) + p.pct);
    }
    const planned = [...planMap.entries()]
      .map(([k, v]) => ({ projectId: k === 'none' ? null : k, name: projName(k === 'none' ? null : k), color: (k !== 'none' ? proj.get(k)?.color : null) ?? null, share: pct(v, planTotal) }))
      .sort((x, y) => y.share - x.share);

    // Alineación = traslape de los dos repartos (Σ min). 100 = trabajó justo donde estaba puesto.
    let alignment: number | null = null;
    let offPlan = 0;
    if (planned.length && actual.length) {
      const pm = new Map(planned.map((p) => [p.projectId ?? 'none', p.share]));
      let overlap = 0;
      for (const r of actual) {
        const k = r.projectId ?? 'none';
        overlap += Math.min(r.share, pm.get(k) ?? 0);
        if (!pm.has(k)) offPlan += r.share;
      }
      alignment = Math.min(100, Math.round(overlap));
    }

    return {
      devId: id,
      name: d.name as string,
      avatarUrl: avatarFor((d.github_login as string | null) ?? null),
      commits: a?.commits ?? 0,
      lines: a?.lines ?? 0,
      points: Math.round(points(a?.commits ?? 0, a?.lines ?? 0)),
      closed: closedByDev.get(id) ?? 0,
      open: openByDev.get(id) ?? 0,
      projectCount: actual.length,
      topProject: actual[0]?.name ?? null,
      topShare: actual[0]?.share ?? 0,
      actual,
      planned,
      alignment,
      offPlan: Math.min(100, offPlan),
    };
  }).sort((x, y) => y.points - x.points || y.closed - x.closed || x.name.localeCompare(y.name));

  const aligned = people.filter((p) => p.alignment !== null);
  const teamAlignment = aligned.length ? Math.round(aligned.reduce((s, p) => s + p.alignment!, 0) / aligned.length) : null;

  return {
    period,
    compare: cmp,
    granularity: weekly ? ('week' as const) : ('day' as const),
    kpis,
    focus: { top1: focus.top1, top3: focus.top3, activeProjects: focus.active, topProject: projRows[0]?.points ? projRows[0].name : null, teamAlignment },
    trend,
    byProject: projRows,
    byClient: clientRows,
    split,
    byType,
    weekday,
    cycle: { medianHours: kpis.cycleHours.value, dist: cycleDist },
    backlog: { open: openItems.length, overdue, unassigned, age: ageDist },
    people,
  };
}
