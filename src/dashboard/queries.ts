// Consultas de agregación para el dashboard de visibilidad de ingeniería. Lee el schema `roz`
// con el service_role (la autorización ya la hizo el middleware de auth). Los volúmenes son
// pequeños (equipo de ~10), así que se agrega en JS en vez de meter funciones SQL: más simple
// de mantener y sin migraciones extra. Todo es time-series filtrable por período; la comparación
// es EXPLÍCITA (el front manda el rango a comparar, o ninguno) → soporta vs período anterior,
// vs año pasado, o sin comparación, sin lógica especial en el backend.
import { db } from '../db/supabase.js';
import { embed } from '../adapters/embeddings.js';

export interface Period {
  from: string; // ISO
  to: string; // ISO
}

/** Período anterior del mismo largo, contiguo hacia atrás (default de comparación). */
export function previousPeriod(p: Period): Period {
  const from = new Date(p.from).getTime();
  const to = new Date(p.to).getTime();
  const span = to - from;
  return { from: new Date(from - span).toISOString(), to: p.from };
}

/** Período por defecto: mes calendario actual (del día 1 a ahora). */
export function currentMonthPeriod(): Period {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: first.toISOString(), to: now.toISOString() };
}

export interface Metric {
  value: number;
  compare: number | null; // valor del período de comparación; null = sin comparación
  changePct: number | null;
  direction: 'up' | 'down' | 'flat' | 'none';
}

function metric(value: number, compare: number | null): Metric {
  if (compare === null) return { value, compare: null, changePct: null, direction: 'none' };
  const changePct = compare === 0 ? (value > 0 ? 100 : 0) : Math.round(((value - compare) / compare) * 100);
  const direction = value > compare ? 'up' : value < compare ? 'down' : 'flat';
  return { value, compare, changePct, direction };
}

const PRIORITY_WEIGHT: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 };
const CLOSED_STATES = ['completed', 'done', 'canceled'];

function avatarFor(login: string | null): string | null {
  return login ? `https://github.com/${login}.png?size=96` : null;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function hoursBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
}

function cycleTime(items: WorkItemRow[]): number {
  const durs = items.filter((w) => w.started_at && w.completed_at).map((w) => hoursBetween(w.started_at!, w.completed_at!));
  return durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0;
}

// ---- Lectores base (una sola pasada, se reparten en JS) ----

interface CommitRow {
  sha: string;
  repo: string;
  project_id: string | null;
  dev_id: string | null;
  author_login: string | null;
  message: string | null;
  url: string | null;
  additions: number | null;
  deletions: number | null;
  committed_at: string | null;
}

const COMMIT_COLS = 'sha, repo, project_id, dev_id, author_login, message, url, additions, deletions, committed_at';

async function commitsInRange(from: string, to: string, opts?: { devId?: string; projectId?: string }): Promise<CommitRow[]> {
  let q = db().from('commit').select(COMMIT_COLS).gte('committed_at', from).lt('committed_at', to);
  if (opts?.devId) q = q.eq('dev_id', opts.devId);
  if (opts?.projectId) q = q.eq('project_id', opts.projectId);
  const { data } = await q;
  return (data ?? []) as unknown as CommitRow[];
}

interface WorkItemRow {
  id: string;
  identifier: string;
  title: string;
  state: string;
  priority: string | null;
  project_id: string | null;
  assignee_dev_id: string | null;
  url: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
}

const WORK_ITEM_COLS =
  'id, identifier, title, state, priority, project_id, assignee_dev_id, url, started_at, completed_at, updated_at';

async function resolvedInRange(from: string, to: string, opts?: { devId?: string; projectId?: string }): Promise<WorkItemRow[]> {
  let q = db().from('work_item').select(WORK_ITEM_COLS).gte('completed_at', from).lt('completed_at', to);
  if (opts?.devId) q = q.eq('assignee_dev_id', opts.devId);
  if (opts?.projectId) q = q.eq('project_id', opts.projectId);
  const { data } = await q;
  return (data ?? []) as unknown as WorkItemRow[];
}

async function openWorkItems(devId?: string): Promise<WorkItemRow[]> {
  let q = db().from('work_item').select(WORK_ITEM_COLS).not('state', 'in', `(${CLOSED_STATES.join(',')})`);
  if (devId) q = q.eq('assignee_dev_id', devId);
  const { data } = await q;
  return (data ?? []) as unknown as WorkItemRow[];
}

interface DevRow {
  id: string;
  name: string;
  email: string | null;
  github_login: string | null;
  linear_user_id: string | null;
  active: boolean;
  availability: number;
}

async function allDevs(): Promise<DevRow[]> {
  const { data } = await db().from('dev').select('id, name, email, github_login, linear_user_id, active, availability');
  return (data ?? []) as unknown as DevRow[];
}

async function allProjects(): Promise<{ id: string; name: string; key: string; kind: string }[]> {
  const { data } = await db().from('project').select('id, name, key, kind');
  return (data ?? []) as unknown as { id: string; name: string; key: string; kind: string }[];
}

/** Normaliza un repo a full_name "owner/name" (acepta "name", URL de GitHub, o full_name). */
export function normalizeRepo(input: string): string {
  const r = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '');
  return r.includes('/') ? r : `hyperlabs-ai/${r}`;
}

export async function addProjectRepo(projectId: string, repo: string) {
  const { error } = await db().from('project_repo').insert({ project_id: projectId, repo: normalizeRepo(repo) });
  if (error) throw error;
}

export async function removeProjectRepo(projectId: string, repo: string) {
  const { error } = await db().from('project_repo').delete().eq('project_id', projectId).eq('repo', repo);
  if (error) throw error;
}

export async function setProjectKind(projectId: string, kind: 'client' | 'internal') {
  const { error } = await db().from('project').update({ kind, updated_at: new Date().toISOString() }).eq('id', projectId);
  if (error) throw error;
}

function sumLines(commits: CommitRow[]): { additions: number; deletions: number } {
  return commits.reduce(
    (acc, c) => ({ additions: acc.additions + (c.additions ?? 0), deletions: acc.deletions + (c.deletions ?? 0) }),
    { additions: 0, deletions: 0 },
  );
}

// ---- Overview (landing del CEO) ----

export async function getOverview(period: Period, cmp: Period | null) {
  const [curCommits, curResolved, open, devs, projects, cmpCommits, cmpResolved] = await Promise.all([
    commitsInRange(period.from, period.to),
    resolvedInRange(period.from, period.to),
    openWorkItems(),
    allDevs(),
    allProjects(),
    cmp ? commitsInRange(cmp.from, cmp.to) : Promise.resolve(null),
    cmp ? resolvedInRange(cmp.from, cmp.to) : Promise.resolve(null),
  ]);

  const projName = new Map(projects.map((p) => [p.id, p.name]));
  const devName = new Map(devs.map((d) => [d.id, d.name]));

  const activeSet = (commits: CommitRow[], resolved: WorkItemRow[]) => {
    const s = new Set<string>();
    commits.forEach((c) => c.dev_id && s.add(c.dev_id));
    resolved.forEach((w) => w.assignee_dev_id && s.add(w.assignee_dev_id));
    return s;
  };

  const kpis = {
    commits: metric(curCommits.length, cmpCommits ? cmpCommits.length : null),
    ticketsResolved: metric(curResolved.length, cmpResolved ? cmpResolved.length : null),
    activeContributors: metric(
      activeSet(curCommits, curResolved).size,
      cmpCommits && cmpResolved ? activeSet(cmpCommits, cmpResolved).size : null,
    ),
    avgCycleTimeHours: metric(cycleTime(curResolved), cmpResolved ? cycleTime(cmpResolved) : null),
    linesChanged: metric(
      sumLines(curCommits).additions + sumLines(curCommits).deletions,
      cmpCommits ? sumLines(cmpCommits).additions + sumLines(cmpCommits).deletions : null,
    ),
  };

  // Contribución por proyecto (commits + tickets resueltos en el período).
  const byProjectMap = new Map<string, { projectId: string | null; name: string; commits: number; ticketsResolved: number }>();
  const bucketProj = (id: string | null) => {
    const key = id ?? 'none';
    if (!byProjectMap.has(key)) {
      byProjectMap.set(key, { projectId: id, name: id ? projName.get(id) ?? '(desconocido)' : '(sin proyecto)', commits: 0, ticketsResolved: 0 });
    }
    return byProjectMap.get(key)!;
  };
  curCommits.forEach((c) => bucketProj(c.project_id).commits++);
  curResolved.forEach((w) => bucketProj(w.project_id).ticketsResolved++);
  const byProject = [...byProjectMap.values()].sort((a, b) => b.commits + b.ticketsResolved - (a.commits + a.ticketsResolved));

  // Balance de carga: tickets abiertos asignados, ponderados por prioridad.
  const workloadMap = new Map<string, { devId: string; name: string; avatarUrl: string | null; openTickets: number; weighted: number }>();
  const devAvatar = new Map(devs.map((d) => [d.id, avatarFor(d.github_login)]));
  open.forEach((w) => {
    if (!w.assignee_dev_id) return;
    if (!workloadMap.has(w.assignee_dev_id)) {
      workloadMap.set(w.assignee_dev_id, {
        devId: w.assignee_dev_id,
        name: devName.get(w.assignee_dev_id) ?? '—',
        avatarUrl: devAvatar.get(w.assignee_dev_id) ?? null,
        openTickets: 0,
        weighted: 0,
      });
    }
    const row = workloadMap.get(w.assignee_dev_id)!;
    row.openTickets++;
    row.weighted += PRIORITY_WEIGHT[w.priority ?? ''] ?? 1;
  });
  const workload = [...workloadMap.values()].sort((a, b) => b.weighted - a.weighted);

  const skillsCoverage = await getSkillCatalog();

  // Contribución por developer (commits + tickets resueltos + líneas) en el período.
  const devAgg = new Map<string, { devId: string; name: string; avatarUrl: string | null; commits: number; ticketsResolved: number; lines: number }>();
  const ensureDev = (id: string) => {
    if (!devAgg.has(id)) devAgg.set(id, { devId: id, name: devName.get(id) ?? '—', avatarUrl: devAvatar.get(id) ?? null, commits: 0, ticketsResolved: 0, lines: 0 });
    return devAgg.get(id)!;
  };
  curCommits.forEach((c) => {
    if (!c.dev_id) return;
    const r = ensureDev(c.dev_id);
    r.commits++;
    r.lines += (c.additions ?? 0) + (c.deletions ?? 0);
  });
  curResolved.forEach((w) => w.assignee_dev_id && ensureDev(w.assignee_dev_id).ticketsResolved++);
  const byDeveloper = [...devAgg.values()].sort((a, b) => b.commits + b.ticketsResolved - (a.commits + a.ticketsResolved));

  // Cliente vs Interno: a dónde va el esfuerzo (commits + tickets) según project.kind.
  const kindByProject = new Map(projects.map((p) => [p.id, p.kind]));
  const split = { client: { commits: 0, ticketsResolved: 0 }, internal: { commits: 0, ticketsResolved: 0 } };
  curCommits.forEach((c) => {
    const k = c.project_id ? kindByProject.get(c.project_id) : null;
    if (k === 'client') split.client.commits++;
    else if (k === 'internal') split.internal.commits++;
  });
  curResolved.forEach((w) => {
    const k = w.project_id ? kindByProject.get(w.project_id) : null;
    if (k === 'client') split.client.ticketsResolved++;
    else if (k === 'internal') split.internal.ticketsResolved++;
  });

  // Tickets abiertos por estado (salud del pipeline, no atado al período).
  const stateAgg = new Map<string, number>();
  open.forEach((w) => stateAgg.set(w.state, (stateAgg.get(w.state) ?? 0) + 1));
  const ticketsByState = [...stateAgg.entries()].map(([state, count]) => ({ state, count })).sort((a, b) => b.count - a.count);

  // Tendencia diaria dentro del período.
  const trendMap = new Map<string, { date: string; commits: number; ticketsResolved: number }>();
  const ensureDay = (k: string) => {
    if (!trendMap.has(k)) trendMap.set(k, { date: k, commits: 0, ticketsResolved: 0 });
    return trendMap.get(k)!;
  };
  curCommits.forEach((c) => c.committed_at && ensureDay(dayKey(c.committed_at)).commits++);
  curResolved.forEach((w) => w.completed_at && ensureDay(dayKey(w.completed_at)).ticketsResolved++);
  const trend = [...trendMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  return { period, compare: cmp, kpis, byProject, byDeveloper, split, ticketsByState, workload, skillsCoverage, trend };
}

// ---- Lista de developers ----

export async function listDevelopers(period: Period) {
  const [commits, resolved, open, devs, skills] = await Promise.all([
    commitsInRange(period.from, period.to),
    resolvedInRange(period.from, period.to),
    openWorkItems(),
    allDevs(),
    devSkillsByDev(),
  ]);

  const commitsByDev = countBy(commits, (c) => c.dev_id);
  const resolvedByDev = countBy(resolved, (w) => w.assignee_dev_id);
  const openByDev = countBy(open, (w) => w.assignee_dev_id);
  const linesByDev = new Map<string, number>();
  commits.forEach((c) => c.dev_id && linesByDev.set(c.dev_id, (linesByDev.get(c.dev_id) ?? 0) + (c.additions ?? 0) + (c.deletions ?? 0)));
  const projectsByDev = new Map<string, Set<string>>();
  commits.forEach((c) => {
    if (!c.dev_id || !c.project_id) return;
    if (!projectsByDev.has(c.dev_id)) projectsByDev.set(c.dev_id, new Set());
    projectsByDev.get(c.dev_id)!.add(c.project_id);
  });

  return devs
    .filter((d) => d.active)
    .map((d) => ({
      id: d.id,
      name: d.name,
      githubLogin: d.github_login,
      avatarUrl: avatarFor(d.github_login),
      active: d.active,
      availability: d.availability,
      commits: commitsByDev.get(d.id) ?? 0,
      ticketsResolved: resolvedByDev.get(d.id) ?? 0,
      openTickets: openByDev.get(d.id) ?? 0,
      linesChanged: linesByDev.get(d.id) ?? 0,
      projects: projectsByDev.get(d.id)?.size ?? 0,
      topSkills: (skills.get(d.id) ?? []).slice(0, 5).map((s) => ({ tag: s.tag, level: s.level })),
    }))
    .sort((a, b) => b.commits + b.ticketsResolved - (a.commits + a.ticketsResolved));
}

// ---- Perfil de un developer ----

export async function getDeveloper(devId: string, period: Period, cmp: Period | null) {
  const dev = await db().from('dev').select('id, name, email, github_login, linear_user_id, active, availability').eq('id', devId).maybeSingle();
  const d = dev.data as unknown as DevRow | null;
  if (!d) return null;

  const [curCommits, curResolved, open, projects, skills, cmpCommits, cmpResolved] = await Promise.all([
    commitsInRange(period.from, period.to, { devId }),
    resolvedInRange(period.from, period.to, { devId }),
    openWorkItems(devId),
    allProjects(),
    devSkills(devId),
    cmp ? commitsInRange(cmp.from, cmp.to, { devId }) : Promise.resolve(null),
    cmp ? resolvedInRange(cmp.from, cmp.to, { devId }) : Promise.resolve(null),
  ]);
  const projName = new Map(projects.map((p) => [p.id, p.name]));

  const projectsTouched = new Set(curCommits.map((c) => c.project_id).filter(Boolean));
  const lines = sumLines(curCommits);

  const kpis = {
    commits: metric(curCommits.length, cmpCommits ? cmpCommits.length : null),
    ticketsResolved: metric(curResolved.length, cmpResolved ? cmpResolved.length : null),
    avgCycleTimeHours: metric(cycleTime(curResolved), cmpResolved ? cycleTime(cmpResolved) : null),
    linesChanged: metric(lines.additions + lines.deletions, cmpCommits ? sumLines(cmpCommits).additions + sumLines(cmpCommits).deletions : null),
  };

  const trendMap = new Map<string, number>();
  curCommits.forEach((c) => c.committed_at && trendMap.set(dayKey(c.committed_at), (trendMap.get(dayKey(c.committed_at)) ?? 0) + 1));
  const commitTrend = [...trendMap.entries()].map(([date, commits]) => ({ date, commits })).sort((a, b) => a.date.localeCompare(b.date));

  const projAgg = new Map<string, { projectId: string | null; name: string; commits: number }>();
  curCommits.forEach((c) => {
    const key = c.project_id ?? 'none';
    if (!projAgg.has(key)) projAgg.set(key, { projectId: c.project_id, name: c.project_id ? projName.get(c.project_id) ?? '(desconocido)' : '(sin proyecto)', commits: 0 });
    projAgg.get(key)!.commits++;
  });
  const repoAgg = countBy(curCommits, (c) => c.repo);

  const inProgress = open.filter((w) => w.state === 'started' || w.state === 'in_progress');
  const openOnly = open.filter((w) => !(w.state === 'started' || w.state === 'in_progress'));

  const activity = [
    ...curCommits.filter((c) => c.committed_at).map((c) => ({ type: 'commit' as const, ts: c.committed_at!, title: (c.message ?? '').split('\n')[0], url: c.url, repo: c.repo, additions: c.additions, deletions: c.deletions })),
    ...curResolved.filter((w) => w.completed_at).map((w) => ({ type: 'ticket_resolved' as const, ts: w.completed_at!, title: `${w.identifier}: ${w.title}`, url: w.url, repo: null, additions: null, deletions: null })),
  ]
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 25);

  return {
    dev: { id: d.id, name: d.name, email: d.email, githubLogin: d.github_login, avatarUrl: avatarFor(d.github_login), active: d.active, availability: d.availability },
    period,
    compare: cmp,
    kpis,
    commitTrend,
    projects: [...projAgg.values()].sort((a, b) => b.commits - a.commits),
    repos: [...repoAgg.entries()].map(([repo, commits]) => ({ repo, commits })).sort((a, b) => b.commits - a.commits),
    tickets: { open: openOnly.map(slimTicket), inProgress: inProgress.map(slimTicket), resolved: curResolved.map(slimTicket).slice(0, 20) },
    skills: skills.map((s) => ({ skillId: s.skill_id, tag: s.tag, level: s.level })),
    activity,
  };
}

function slimTicket(w: WorkItemRow) {
  return { id: w.id, identifier: w.identifier, title: w.title, state: w.state, priority: w.priority, url: w.url };
}

// ---- Proyectos (historial de commits + líneas) ----

export async function listProjects(period: Period) {
  const [commits, projects, resolved, devs, repoLinks] = await Promise.all([
    commitsInRange(period.from, period.to),
    allProjects(),
    resolvedInRange(period.from, period.to),
    allDevs(),
    projectRepos(),
  ]);
  const devName = new Map(devs.map((d) => [d.id, d.name]));
  const kindById = new Map(projects.map((p) => [p.id, p.kind]));
  const byId = new Map<string, { projectId: string; name: string; commits: number; additions: number; deletions: number; contributors: Set<string>; repos: Set<string>; ticketsResolved: number }>();
  projects.forEach((p) => byId.set(p.id, { projectId: p.id, name: p.name, commits: 0, additions: 0, deletions: 0, contributors: new Set(), repos: new Set(), ticketsResolved: 0 }));

  // repos = los MAPEADOS del proyecto (configurados), no solo los que tuvieron actividad.
  repoLinks.forEach((l) => {
    if (byId.has(l.project_id)) byId.get(l.project_id)!.repos.add(l.repo);
  });

  commits.forEach((c) => {
    if (!c.project_id || !byId.has(c.project_id)) return;
    const row = byId.get(c.project_id)!;
    row.commits++;
    row.additions += c.additions ?? 0;
    row.deletions += c.deletions ?? 0;
    if (c.dev_id) row.contributors.add(c.dev_id);
  });
  resolved.forEach((w) => {
    if (w.project_id && byId.has(w.project_id)) byId.get(w.project_id)!.ticketsResolved++;
  });

  return [...byId.values()]
    .map((p) => ({
      projectId: p.projectId,
      name: p.name,
      kind: kindById.get(p.projectId) ?? 'internal',
      commits: p.commits,
      additions: p.additions,
      deletions: p.deletions,
      contributors: [...p.contributors].map((id) => devName.get(id) ?? '—'),
      repos: [...p.repos],
      ticketsResolved: p.ticketsResolved,
    }))
    // Con actividad arriba; a igualdad, los que tienen más repos configurados.
    .sort((a, b) => b.commits - a.commits || b.repos.length - a.repos.length);
}

/** Mapeos repo → proyecto configurados (roz.project_repo). */
async function projectRepos(): Promise<{ project_id: string; repo: string }[]> {
  const { data } = await db().from('project_repo').select('project_id, repo');
  return (data ?? []) as unknown as { project_id: string; repo: string }[];
}

export async function getProject(projectId: string, period: Period) {
  const proj = await db().from('project').select('id, name, key, kind').eq('id', projectId).maybeSingle();
  const p = proj.data as unknown as { id: string; name: string; key: string; kind: string } | null;
  if (!p) return null;

  const [commits, devs, resolved, repoRows] = await Promise.all([
    commitsInRange(period.from, period.to, { projectId }),
    allDevs(),
    resolvedInRange(period.from, period.to, { projectId }),
    db().from('project_repo').select('repo').eq('project_id', projectId),
  ]);
  const repos = ((repoRows.data ?? []) as unknown as { repo: string }[]).map((r) => r.repo).sort();
  const devName = new Map(devs.map((d) => [d.id, d.name]));
  const devAvatar = new Map(devs.map((d) => [d.id, avatarFor(d.github_login)]));
  const lines = sumLines(commits);

  // Historial de commits (más recientes primero).
  const history = commits
    .slice()
    .sort((a, b) => (b.committed_at ?? '').localeCompare(a.committed_at ?? ''))
    .slice(0, 100)
    .map((c) => ({
      sha: c.sha.slice(0, 8),
      message: (c.message ?? '').split('\n')[0],
      author: c.dev_id ? devName.get(c.dev_id) ?? c.author_login : c.author_login,
      avatarUrl: c.dev_id ? devAvatar.get(c.dev_id) ?? null : avatarFor(c.author_login),
      committedAt: c.committed_at,
      additions: c.additions,
      deletions: c.deletions,
      repo: c.repo,
      url: c.url,
    }));

  // Contribuidores con su volumen.
  const contribMap = new Map<string, { name: string; avatarUrl: string | null; commits: number; lines: number }>();
  commits.forEach((c) => {
    const key = c.dev_id ?? c.author_login ?? 'desconocido';
    const name = c.dev_id ? devName.get(c.dev_id) ?? '—' : c.author_login ?? 'desconocido';
    const avatarUrl = c.dev_id ? devAvatar.get(c.dev_id) ?? null : avatarFor(c.author_login);
    if (!contribMap.has(key)) contribMap.set(key, { name, avatarUrl, commits: 0, lines: 0 });
    const row = contribMap.get(key)!;
    row.commits++;
    row.lines += (c.additions ?? 0) + (c.deletions ?? 0);
  });

  // Tendencia diaria de líneas.
  const trendMap = new Map<string, { date: string; additions: number; deletions: number }>();
  commits.forEach((c) => {
    if (!c.committed_at) return;
    const k = dayKey(c.committed_at);
    if (!trendMap.has(k)) trendMap.set(k, { date: k, additions: 0, deletions: 0 });
    const row = trendMap.get(k)!;
    row.additions += c.additions ?? 0;
    row.deletions += c.deletions ?? 0;
  });

  return {
    project: { id: p.id, name: p.name, key: p.key, kind: p.kind },
    repos,
    period,
    totals: { commits: commits.length, additions: lines.additions, deletions: lines.deletions, ticketsResolved: resolved.length, contributors: contribMap.size },
    contributors: [...contribMap.values()].sort((a, b) => b.commits - a.commits),
    history,
    trend: [...trendMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// ---- Tickets (espejo de Linear) ----

const OPEN_STATES = ['backlog', 'unstarted', 'triage', 'started'];

export interface TicketFilters {
  projectId?: string;
  state?: string; // tipo de estado
  assigneeDevId?: string;
  priority?: string;
  scope?: 'open' | 'all'; // open = no cerrados (default)
}

export async function getTickets(f: TicketFilters) {
  const [devs, projects] = await Promise.all([allDevs(), allProjects()]);
  const devName = new Map(devs.map((d) => [d.id, d.name]));
  const devAvatar = new Map(devs.map((d) => [d.id, avatarFor(d.github_login)]));
  const projName = new Map(projects.map((p) => [p.id, p.name]));

  let q = db()
    .from('work_item')
    .select(
      'id, identifier, number, title, state, state_name, priority, project_id, assignee_dev_id, estimate, due_date, labels, creator_name, url, started_at, completed_at, linear_created_at, linear_updated_at',
    );
  if (f.projectId) q = q.eq('project_id', f.projectId);
  if (f.assigneeDevId) q = q.eq('assignee_dev_id', f.assigneeDevId);
  if (f.priority) q = q.eq('priority', f.priority);
  if (f.state) q = q.eq('state', f.state);
  else if (f.scope !== 'all') q = q.in('state', OPEN_STATES);
  const { data } = await q.order('linear_updated_at', { ascending: false }).limit(500);
  const rows = (data ?? []) as any[];

  const PRIO_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
  const now = Date.now();

  const tickets = rows
    .map((w) => ({
      id: w.id,
      identifier: w.identifier,
      number: w.number,
      title: w.title,
      state: w.state,
      stateName: w.state_name ?? w.state,
      priority: w.priority,
      projectId: w.project_id,
      projectName: w.project_id ? projName.get(w.project_id) ?? null : null,
      assignee: w.assignee_dev_id ? { name: devName.get(w.assignee_dev_id) ?? '—', avatarUrl: devAvatar.get(w.assignee_dev_id) ?? null } : null,
      estimate: w.estimate,
      dueDate: w.due_date,
      overdue: w.due_date ? !['completed', 'done', 'canceled'].includes(w.state) && new Date(w.due_date).getTime() < now : false,
      labels: w.labels ?? [],
      creatorName: w.creator_name,
      url: w.url,
      updatedAt: w.linear_updated_at,
      ageDays: w.linear_created_at ? Math.floor((now - new Date(w.linear_created_at).getTime()) / 86_400_000) : null,
    }))
    .sort((a, b) => (PRIO_ORDER[a.priority ?? ''] ?? 9) - (PRIO_ORDER[b.priority ?? ''] ?? 9));

  // Agregaciones para los KPIs/gráficas (sobre el conjunto filtrado).
  const byState = countMap(tickets, (t) => t.stateName);
  const byPriority = countMap(tickets, (t) => t.priority ?? 'sin prioridad');
  const byAssignee = countMap(tickets, (t) => t.assignee?.name ?? 'sin asignar');

  return {
    total: tickets.length,
    overdue: tickets.filter((t) => t.overdue).length,
    unassigned: tickets.filter((t) => !t.assignee).length,
    byState,
    byPriority,
    byAssignee,
    tickets,
  };
}

/** Opciones para los filtros del front (proyectos con tickets, devs, estados presentes). */
export async function getTicketFilters() {
  const [{ data: wi }, devs, projects] = await Promise.all([
    db().from('work_item').select('project_id, assignee_dev_id, state, state_name'),
    allDevs(),
    allProjects(),
  ]);
  const rows = (wi ?? []) as any[];
  const projWithTickets = new Set(rows.map((r) => r.project_id).filter(Boolean));
  const states = [...new Map(rows.filter((r) => r.state).map((r) => [r.state, r.state_name ?? r.state])).entries()].map(([value, label]) => ({ value, label }));
  return {
    projects: projects.filter((p) => projWithTickets.has(p.id)).map((p) => ({ id: p.id, name: p.name })),
    devs: devs.filter((d) => d.active).map((d) => ({ id: d.id, name: d.name })),
    states,
  };
}

function countMap<T>(items: T[], key: (t: T) => string): { label: string; value: number }[] {
  const m = new Map<string, number>();
  items.forEach((it) => {
    const k = key(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  });
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

// ---- Skills (catálogo, matriz, CRUD) ----

export async function getSkillCatalog() {
  const [{ data: skills }, links] = await Promise.all([db().from('skill').select('id, tag, description'), devSkillLinks()]);
  const countBySkill = new Map<string, { sum: number; n: number }>();
  links.forEach((l) => {
    const c = countBySkill.get(l.skill_id) ?? { sum: 0, n: 0 };
    c.sum += l.level;
    c.n++;
    countBySkill.set(l.skill_id, c);
  });
  return ((skills ?? []) as unknown as { id: string; tag: string; description: string | null }[])
    .map((s) => {
      const c = countBySkill.get(s.id);
      return {
        skillId: s.id,
        tag: s.tag,
        description: s.description,
        devCount: c?.n ?? 0,
        avgLevel: c && c.n ? Math.round((c.sum / c.n) * 10) / 10 : 0,
        busFactorRisk: (c?.n ?? 0) <= 1,
      };
    })
    .sort((a, b) => b.devCount - a.devCount);
}

export async function getSkillsMatrix() {
  const [devs, { data: skills }, links] = await Promise.all([allDevs(), db().from('skill').select('id, tag'), devSkillLinks()]);
  return {
    devs: devs.filter((d) => d.active).map((d) => ({ id: d.id, name: d.name, avatarUrl: avatarFor(d.github_login) })),
    skills: ((skills ?? []) as unknown as { id: string; tag: string }[]).map((s) => ({ id: s.id, tag: s.tag })),
    cells: links.map((l) => ({ devId: l.dev_id, skillId: l.skill_id, level: l.level })),
  };
}

export async function createSkill(tag: string, description: string | null) {
  const embedding = await embed(`${tag}. ${description ?? ''}`.trim()).catch(() => null);
  const { data, error } = await db().from('skill').insert({ tag, description, embedding }).select('id, tag, description').single();
  if (error) throw error;
  return data;
}

export async function updateSkill(id: string, patch: { tag?: string; description?: string | null }) {
  const row: Record<string, unknown> = {};
  if (patch.tag !== undefined) row.tag = patch.tag;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.tag !== undefined || patch.description !== undefined) {
    const { data: cur } = await db().from('skill').select('tag, description').eq('id', id).maybeSingle();
    const c = cur as { tag?: string; description?: string | null } | null;
    const tag = patch.tag ?? c?.tag ?? '';
    const desc = patch.description !== undefined ? patch.description : c?.description ?? '';
    row.embedding = await embed(`${tag}. ${desc ?? ''}`.trim()).catch(() => null);
  }
  row.updated_at = new Date().toISOString();
  const { data, error } = await db().from('skill').update(row).eq('id', id).select('id, tag, description').single();
  if (error) throw error;
  return data;
}

export async function deleteSkill(id: string) {
  const { error } = await db().from('skill').delete().eq('id', id);
  if (error) throw error;
}

/** Ajusta la disponibilidad de un dev (0 saturado .. 1 libre). Afecta al router de asignación. */
export async function setDevAvailability(devId: string, availability: number) {
  const a = Math.max(0, Math.min(1, availability));
  const { error } = await db().from('dev').update({ availability: a, updated_at: new Date().toISOString() }).eq('id', devId);
  if (error) throw error;
  return { id: devId, availability: a };
}

export async function setDevSkill(devId: string, skillId: string, level: number) {
  const { error } = await db().from('dev_skill').upsert({ dev_id: devId, skill_id: skillId, level }, { onConflict: 'dev_id,skill_id' });
  if (error) throw error;
}

export async function removeDevSkill(devId: string, skillId: string) {
  const { error } = await db().from('dev_skill').delete().eq('dev_id', devId).eq('skill_id', skillId);
  if (error) throw error;
}

// ---- helpers de skills ----

interface SkillLink {
  dev_id: string;
  skill_id: string;
  level: number;
  tag: string;
}

async function devSkillLinks(): Promise<SkillLink[]> {
  const [{ data: ds }, { data: sk }] = await Promise.all([
    db().from('dev_skill').select('dev_id, skill_id, level'),
    db().from('skill').select('id, tag'),
  ]);
  const tagById = new Map(((sk ?? []) as unknown as { id: string; tag: string }[]).map((s) => [s.id, s.tag]));
  return ((ds ?? []) as unknown as { dev_id: string; skill_id: string; level: number }[]).map((l) => ({ ...l, tag: tagById.get(l.skill_id) ?? '?' }));
}

async function devSkillsByDev(): Promise<Map<string, SkillLink[]>> {
  const links = await devSkillLinks();
  links.sort((a, b) => b.level - a.level);
  const map = new Map<string, SkillLink[]>();
  links.forEach((l) => {
    if (!map.has(l.dev_id)) map.set(l.dev_id, []);
    map.get(l.dev_id)!.push(l);
  });
  return map;
}

async function devSkills(devId: string): Promise<SkillLink[]> {
  return (await devSkillLinks()).filter((l) => l.dev_id === devId).sort((a, b) => b.level - a.level);
}

// ---- util ----

function countBy<T>(items: T[], key: (t: T) => string | null): Map<string, number> {
  const m = new Map<string, number>();
  items.forEach((it) => {
    const k = key(it);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  });
  return m;
}
