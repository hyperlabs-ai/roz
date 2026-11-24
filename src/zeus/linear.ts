// Linear desde zeus: la bandeja muestra los tickets activos de cada quien y el MCP deja a Claude
// leerlos (con todo el detalle para implementarlos), crearlos y moverlos de estado.
//
// Todo pasa por UNA llave (LINEAR_API_KEY). Linear pone como creador/autor al dueño de esa llave y
// eso no se puede cambiar con una llave personal, así que la atribución va por otro lado:
//   · el ticket se ASIGNA a quien usa el MCP (por defecto), resuelto por su correo;
//   · la descripción de lo creado y cada comentario llevan "vía zeus · <nombre>".
// (Para que Linear muestre a la persona como autor haría falta una app OAuth con actor=app.)
//
// Linear es la fuente de verdad: aquí no se guarda nada, se consulta en vivo con cachés cortas
// para equipos, estados y usuarios, que casi no cambian.
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import {
  ISSUE_FIELDS,
  LinearError,
  createComment,
  linearEnabled,
  linearGraphql,
  listLabels,
  listProjects,
  listTeams,
  listUsers,
  listWorkflowStates,
  parseIssue,
  type LinearIssue,
  type LinearTeam,
  type LinearUser,
  type LinearWorkflowState,
} from '../adapters/linear.js';
import type { LinearStateType } from '../types/roz-v2.js';
import type { ZeusLinearBoard, ZeusLinearIssue } from '../types/zeus.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { findDev } from './inbox.js';
import { boardTtlMs, cached, forget } from './linear-cache.js';
import type { ZeusActor } from './core.js';

// ---------------------------------------------------------------- cachés (src/zeus/linear-cache.ts)

export { clearLinearCache } from './linear-cache.js';

const users = () => cached<LinearUser[]>('users', listUsers);
const teams = () => cached<LinearTeam[]>('teams', listTeams);
const states = (teamId: string) => cached<LinearWorkflowState[]>(`states:${teamId}`, () => listWorkflowStates(teamId));

function assertLinear(): void {
  if (!linearEnabled()) throw new AppError('LINEAR_NOT_CONFIGURED', 'Linear no está configurado en zeus (falta LINEAR_API_KEY)', 503);
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ---------------------------------------------------------------- personas

/** El usuario de Linear de un dev, por sus correos (dev.email gana sobre github_email). */
export async function linearUserOf(devId: string): Promise<LinearUser | null> {
  const { data, error } = await db().from('dev').select('email, github_email, linear_user_id').eq('id', devId).maybeSingle();
  if (error) throw error;
  const d = data as { email: string | null; github_email: string | null; linear_user_id: string | null } | null;
  if (!d) return null;
  const all = await users();
  if (d.linear_user_id) {
    const direct = all.find((u) => u.id === d.linear_user_id);
    if (direct) return direct;
  }
  for (const email of [d.email, d.github_email]) {
    const e = email?.toLowerCase().trim();
    const hit = e ? all.find((u) => u.email === e && u.active) : undefined;
    if (hit) return hit;
  }
  return null;
}

async function mustLinearUserOf(devId: string, who: string): Promise<LinearUser> {
  const u = await linearUserOf(devId);
  if (!u) throw new ValidationError(`${who} no tiene usuario en Linear con su correo del equipo: que lo inviten a Linear con ese correo`);
  return u;
}

/** "yo", "me" o vacío = quien llama; si no, alguien del equipo por nombre/correo/login. */
async function resolveAssignee(who: string | null | undefined, actor: ZeusActor): Promise<LinearUser | null> {
  const q = who?.trim();
  if (q === undefined || q === null) return mustLinearUserOf(actor.devId, 'Tú');
  if (!q || ['yo', 'me', 'mi', 'mí', 'self'].includes(norm(q))) return mustLinearUserOf(actor.devId, 'Tú');
  if (['nadie', 'none', 'sin asignar', 'unassigned'].includes(norm(q))) return null;
  const dev = await findDev(q);
  return mustLinearUserOf(dev.id, dev.name);
}

// ---------------------------------------------------------------- equipos, estados, etiquetas

async function resolveTeam(key: string | null | undefined): Promise<LinearTeam> {
  const all = await teams();
  const q = key?.trim();
  if (!q) {
    const def = config.linear.teamId ? all.find((t) => t.id === config.linear.teamId) : all.length === 1 ? all[0] : undefined;
    if (def) return def;
    throw new ValidationError(`falta el equipo de Linear (team): ${all.map((t) => `${t.key} (${t.name})`).join(', ')}`);
  }
  const hit = all.find((t) => t.key.toLowerCase() === q.toLowerCase() || norm(t.name) === norm(q) || t.id === q);
  if (!hit) throw new NotFoundError(`no hay equipo "${q}" en Linear (hay: ${all.map((t) => t.key).join(', ')})`);
  return hit;
}

const STATE_TYPES: readonly LinearStateType[] = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];
/** Palabras con las que la gente y los agentes nombran un estado sin saber el nombre exacto. */
const STATE_ALIASES: Record<string, LinearStateType> = {
  todo: 'unstarted',
  'por hacer': 'unstarted',
  pendiente: 'unstarted',
  'en curso': 'started',
  'in progress': 'started',
  progreso: 'started',
  empezado: 'started',
  done: 'completed',
  hecho: 'completed',
  terminado: 'completed',
  completado: 'completed',
  cancelado: 'canceled',
  cancelled: 'canceled',
};

/** Un estado del equipo por nombre exacto ("In Review"), por tipo ("started") o por alias ("hecho"). */
async function resolveState(teamId: string, name: string): Promise<LinearWorkflowState> {
  const list = (await states(teamId)).sort((a, b) => a.position - b.position);
  const q = norm(name);
  const exact = list.find((s) => norm(s.name) === q);
  if (exact) return exact;
  const type = (STATE_TYPES as readonly string[]).includes(q) ? (q as LinearStateType) : STATE_ALIASES[q];
  const byType = type ? list.find((s) => s.type === type) : undefined;
  if (byType) return byType;
  throw new ValidationError(`no hay estado "${name}" en ese equipo (hay: ${list.map((s) => s.name).join(', ')})`);
}

async function resolveLabels(teamId: string, names: string[] | undefined): Promise<string[] | undefined> {
  if (!names?.length) return undefined;
  const all = await cached(`labels:${teamId}`, () => listLabels(teamId));
  const missing: string[] = [];
  const ids = names.map((n) => {
    const hit = all.find((l) => norm(l.name) === norm(n));
    if (!hit) missing.push(n);
    return hit?.id;
  });
  if (missing.length) throw new ValidationError(`etiquetas que no existen en ese equipo: ${missing.join(', ')}`);
  return ids as string[];
}

async function resolveProjectId(teamId: string, name: string | null | undefined): Promise<string | undefined> {
  const q = name?.trim();
  if (!q) return undefined;
  const all = await cached('projects', listProjects);
  const pool = all.filter((p) => !p.teamIds.length || p.teamIds.includes(teamId));
  const hit = pool.find((p) => norm(p.name) === norm(q) || p.id === q) ?? pool.find((p) => norm(p.name).includes(norm(q)));
  if (!hit) throw new NotFoundError(`no hay proyecto de Linear "${q}" en ese equipo`);
  return hit.id;
}

// ---------------------------------------------------------------- forma que devuelve zeus

const PRIORITY_LABEL = ['Sin prioridad', 'Urgente', 'Alta', 'Media', 'Baja'] as const;

function brief(i: LinearIssue): ZeusLinearIssue {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    url: i.url,
    state: i.state.name,
    stateType: i.state.type,
    priority: i.priority,
    priorityLabel: PRIORITY_LABEL[i.priority] ?? 'Sin prioridad',
    team: i.team.key,
    project: i.project?.name ?? null,
    assignee: i.assignee?.name ?? null,
    labels: i.labels.map((l) => l.name),
    dueDate: i.dueDate,
    cycle: i.cycle ? (i.cycle.name ?? `Ciclo ${i.cycle.number}`) : null,
    branchName: i.branchName,
    updatedAt: i.updatedAt,
  };
}

/** Pie de atribución: Linear pone como autor al dueño de la llave, aquí va quién fue de verdad. */
const signature = (actor: ZeusActor) => `\n\n— vía zeus · ${actor.name}`;

// ---------------------------------------------------------------- leer

/** Lo activo primero: en curso, luego por hacer, luego backlog; dentro, por prioridad (1 urgente … 4 baja, 0 al final). */
const ACTIVE_ORDER: Record<string, number> = { started: 0, unstarted: 1, triage: 2, backlog: 3 };
const prio = (p: number) => (p === 0 ? 9 : p);
function byActivity(a: LinearIssue, b: LinearIssue): number {
  return (ACTIVE_ORDER[a.state.type] ?? 9) - (ACTIVE_ORDER[b.state.type] ?? 9) || prio(a.priority) - prio(b.priority) || b.updatedAt.localeCompare(a.updatedAt);
}

export interface ListIssuesInput {
  /** Persona (nombre, correo…); vacío = quien llama. "todos" = sin filtrar por persona. */
  assignee?: string | null;
  /** Tipos de estado. Por defecto todo lo abierto: started + unstarted + backlog (+ triage). */
  stateTypes?: LinearStateType[];
  team?: string | null;
  /** Texto en el título o identificador. */
  query?: string | null;
  limit?: number;
}

export async function listIssues(input: ListIssuesInput, actor: ZeusActor): Promise<{ assignee: string | null; issues: ZeusLinearIssue[] }> {
  assertLinear();
  const filter: Record<string, unknown> = {};
  const everyone = input.assignee && ['todos', 'all', 'equipo', 'team'].includes(norm(input.assignee));
  let who: LinearUser | null = null;
  if (!everyone) {
    who = await resolveAssignee(input.assignee, actor);
    filter.assignee = who ? { id: { eq: who.id } } : { null: true };
  }
  // Backlog también: es trabajo asignado que sigue abierto, aunque no esté planeado todavía.
  const types = input.stateTypes?.length ? input.stateTypes : (['started', 'unstarted', 'backlog', 'triage'] as LinearStateType[]);
  filter.state = { type: { in: types } };
  if (input.team) filter.team = { id: { eq: (await resolveTeam(input.team)).id } };
  const q = input.query?.trim();
  if (q) filter.or = [{ title: { containsIgnoreCase: q } }, ...(/^[A-Za-z]+-\d+$/.test(q) ? [{ number: { eq: Number(q.split('-')[1]) } }] : [])];
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const data = await linearGraphql<{ issues: { nodes: unknown[] } }>(
    `query ZeusIssues($filter: IssueFilter, $first: Int!) {
      issues(filter: $filter, first: $first, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } }
    }`,
    { filter, first: limit },
  );
  const issues = data.issues.nodes.map(parseIssue).sort(byActivity);
  return { assignee: everyone ? 'todos' : (who?.name ?? 'sin asignar'), issues: issues.map(brief) };
}

/**
 * Lo de Linear para la bandeja: tus tickets abiertos (en curso, por hacer y backlog). Nunca lanza: si Linear no está o
 * falla, la bandeja sigue funcionando y dice por qué no hay tickets.
 */
export async function linearBoard(actor: ZeusActor): Promise<ZeusLinearBoard> {
  const at = new Date().toISOString();
  if (!linearEnabled()) return { status: 'not_configured', user: null, issues: [], fetchedAt: at };
  try {
    const me = await linearUserOf(actor.devId);
    if (!me) return { status: 'no_user', user: null, issues: [], fetchedAt: at };
    const { issues } = await cached(`board:${actor.devId}`, () => listIssues({ assignee: null }, actor), boardTtlMs());
    return { status: 'ok', user: me.name, issues, fetchedAt: at };
  } catch (err) {
    return { status: 'error', user: null, issues: [], fetchedAt: at, error: err instanceof Error ? err.message : String(err) };
  }
}

interface IssueDetailRaw {
  issue: (Record<string, unknown> & {
    comments?: { nodes: Array<{ body: string; createdAt: string; user?: { name: string } | null }> };
    children?: { nodes: Array<{ identifier: string; title: string; state: { name: string } }> };
    parent?: { identifier: string; title: string } | null;
    attachments?: { nodes: Array<{ title: string | null; url: string }> };
    relations?: { nodes: Array<{ type: string; relatedIssue: { identifier: string; title: string; state: { name: string } } }> };
  }) | null;
}

/** Un ticket con TODO lo necesario para implementarlo: descripción, comentarios, subtareas y enlaces. */
export async function getIssueDetail(idOrIdentifier: string, opts: { maxChars?: number } = {}) {
  assertLinear();
  const id = idOrIdentifier.trim().toUpperCase().match(/^[A-Z]+-\d+$/) ? idOrIdentifier.trim().toUpperCase() : idOrIdentifier.trim();
  let data: IssueDetailRaw;
  try {
    data = await linearGraphql<IssueDetailRaw>(
      `query ZeusIssue($id: String!) {
        issue(id: $id) {
          ${ISSUE_FIELDS}
          parent { identifier title }
          children(first: 50) { nodes { identifier title state { name } } }
          comments(first: 50) { nodes { body createdAt user { name } } }
          attachments(first: 30) { nodes { title url } }
          relations(first: 30) { nodes { type relatedIssue { identifier title state { name } } } }
        }
      }`,
      { id },
    );
  } catch (err) {
    if (err instanceof LinearError && /not found/i.test(err.message)) throw new NotFoundError(`no existe el ticket ${idOrIdentifier} en Linear`);
    throw err;
  }
  if (!data.issue) throw new NotFoundError(`no existe el ticket ${idOrIdentifier} en Linear`);
  const raw = data.issue;
  const issue = parseIssue(raw);
  const max = opts.maxChars ?? 30_000;
  const description = issue.description ?? '';
  return {
    ...brief(issue),
    creator: issue.creator?.name ?? null,
    createdAt: issue.createdAt,
    estimate: issue.estimate,
    description: description.length > max ? `${description.slice(0, max)}… [recortado]` : description,
    parent: raw.parent ?? null,
    subIssues: (raw.children?.nodes ?? []).map((c) => ({ identifier: c.identifier, title: c.title, state: c.state.name })),
    relations: (raw.relations?.nodes ?? []).map((r) => ({ type: r.type, identifier: r.relatedIssue.identifier, title: r.relatedIssue.title, state: r.relatedIssue.state.name })),
    links: (raw.attachments?.nodes ?? []).map((a) => ({ title: a.title, url: a.url })),
    comments: (raw.comments?.nodes ?? [])
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((c) => ({ by: c.user?.name ?? 'Linear', at: c.createdAt, body: c.body })),
  };
}

/** Equipos con sus estados y proyectos activos: lo que hace falta para crear o mover un ticket. */
export async function linearCatalog() {
  assertLinear();
  const [all, projects] = await Promise.all([teams(), cached('projects', listProjects)]);
  return {
    teams: await Promise.all(
      all.map(async (t) => ({
        key: t.key,
        name: t.name,
        states: (await states(t.id)).sort((a, b) => a.position - b.position).map((s) => ({ name: s.name, type: s.type })),
        projects: projects.filter((p) => p.teamIds.includes(t.id) && !['completed', 'canceled'].includes(p.state ?? '')).map((p) => p.name),
      })),
    ),
  };
}

// ---------------------------------------------------------------- escribir

export interface CreateIssueInput {
  team?: string | null;
  title: string;
  description?: string | null;
  /** Vacío = quien llama. "nadie" = sin asignar. */
  assignee?: string | null;
  priority?: number | null;
  state?: string | null;
  project?: string | null;
  labels?: string[];
  dueDate?: string | null;
}

export async function createIssueAs(input: CreateIssueInput, actor: ZeusActor) {
  assertLinear();
  const title = input.title?.trim();
  if (!title) throw new ValidationError('el ticket necesita título');
  const team = await resolveTeam(input.team);
  const [assignee, state, labelIds, projectId] = await Promise.all([
    resolveAssignee(input.assignee, actor),
    input.state ? resolveState(team.id, input.state) : Promise.resolve(null),
    resolveLabels(team.id, input.labels),
    resolveProjectId(team.id, input.project),
  ]);
  if (input.priority != null && ![0, 1, 2, 3, 4].includes(input.priority)) throw new ValidationError('priority va de 0 (sin) a 4 (baja); 1 es urgente');
  const description = `${(input.description ?? '').trim()}${signature(actor)}`.trim();
  const data = await linearGraphql<{ issueCreate: { success: boolean; issue: unknown } }>(
    `mutation ZeusIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
    {
      input: Object.fromEntries(
        Object.entries({
          teamId: team.id,
          title: title.slice(0, 255),
          description,
          assigneeId: assignee?.id,
          stateId: state?.id,
          labelIds,
          projectId,
          priority: input.priority ?? undefined,
          dueDate: input.dueDate ?? undefined,
        }).filter(([, v]) => v !== undefined),
      ),
    },
  );
  if (!data.issueCreate.success || !data.issueCreate.issue) throw new AppError('LINEAR_REJECTED', 'Linear rechazó la creación del ticket', 502);
  forget(`board:${actor.devId}`);
  return brief(parseIssue(data.issueCreate.issue));
}

export interface UpdateIssueInput {
  issue: string;
  state?: string | null;
  /** "yo" = quien llama; "nadie" = desasignar. */
  assignee?: string | null;
  priority?: number | null;
  title?: string | null;
  comment?: string | null;
}

export async function updateIssueAs(input: UpdateIssueInput, actor: ZeusActor) {
  assertLinear();
  const current = await getIssueDetail(input.issue, { maxChars: 1 });
  const teamId = (await resolveTeam(current.team)).id;
  const patch: Record<string, unknown> = {};
  if (input.state) patch.stateId = (await resolveState(teamId, input.state)).id;
  if (input.assignee !== undefined && input.assignee !== null) patch.assigneeId = (await resolveAssignee(input.assignee, actor))?.id ?? null;
  if (input.priority != null) {
    if (![0, 1, 2, 3, 4].includes(input.priority)) throw new ValidationError('priority va de 0 (sin) a 4 (baja); 1 es urgente');
    patch.priority = input.priority;
  }
  if (input.title?.trim()) patch.title = input.title.trim().slice(0, 255);
  const comment = input.comment?.trim();
  if (!Object.keys(patch).length && !comment) throw new ValidationError('no hay nada que cambiar (state, assignee, priority, title o comment)');

  let issue = current;
  if (Object.keys(patch).length) {
    const data = await linearGraphql<{ issueUpdate: { success: boolean; issue: unknown } }>(
      `mutation ZeusIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
      { id: current.id, input: patch },
    );
    if (!data.issueUpdate.success || !data.issueUpdate.issue) throw new AppError('LINEAR_REJECTED', 'Linear rechazó el cambio', 502);
    issue = { ...current, ...brief(parseIssue(data.issueUpdate.issue)) };
  }
  // Un cambio de estado sin comentario también deja rastro de quién lo hizo (Linear diría "Manuel").
  const note = comment ?? (patch.stateId ? `Movido a "${issue.state}".` : null);
  if (note) await createComment(current.id, `${note}${signature(actor)}`);
  forget(`board:${actor.devId}`);
  const { description: _d, comments: _c, ...rest } = issue as typeof current;
  return { ...rest, commented: !!note };
}
