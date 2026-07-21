import { supabase } from './supabase';
import type { Range } from './period';

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function qs(range?: Range, compare?: Range | null): string {
  if (!range) return '';
  const p = new URLSearchParams({ from: range.from, to: range.to });
  if (compare) {
    p.set('compareFrom', compare.from);
    p.set('compareTo', compare.to);
  }
  return `?${p.toString()}`;
}

export async function apiGet<T>(path: string, range?: Range, compare?: Range | null): Promise<T> {
  const res = await fetch(`/api/dashboard${path}${qs(range, compare)}`, { headers: await authHeader() });
  return handle<T>(res);
}

export async function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/dashboard${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(await authHeader()) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return handle<T>(res);
}

/** Subida de archivo (multipart). No fijamos content-type: el navegador pone el boundary. */
export async function apiUpload<T>(path: string, file: File, field = 'file'): Promise<T> {
  const form = new FormData();
  form.append(field, file);
  const res = await fetch(`/api/dashboard${path}`, {
    method: 'POST',
    headers: { ...(await authHeader()) },
    body: form,
  });
  return handle<T>(res);
}

// ---- Tipos compartidos con el backend (src/dashboard/queries.ts) ----
export interface Metric {
  value: number;
  compare: number | null;
  changePct: number | null;
  direction: 'up' | 'down' | 'flat' | 'none';
}
export interface AuthedUser { id: string; email: string; name: string | null; role: string | null; }

export interface Overview {
  kpis: { commits: Metric; ticketsResolved: Metric; activeContributors: Metric; avgCycleTimeHours: Metric; linesChanged: Metric };
  byProject: { projectId: string | null; name: string; commits: number; ticketsResolved: number }[];
  byDeveloper: { devId: string; name: string; avatarUrl: string | null; commits: number; ticketsResolved: number; lines: number }[];
  split: { client: { commits: number; ticketsResolved: number }; internal: { commits: number; ticketsResolved: number } };
  ticketsByState: { state: string; count: number }[];
  workload: { devId: string; name: string; avatarUrl: string | null; openTickets: number; weighted: number }[];
  skillsCoverage: SkillCatalogItem[];
  trend: { date: string; commits: number; ticketsResolved: number }[];
}

/** Franja de tamaño de commit (conteo y líneas): describe el estilo de trabajo de un dev.
 *  Los hyper points salen de los totales del período, no del empaquetado. */
export interface SizeBucket { key: 'micro' | 'chico' | 'mediano' | 'grande'; commits: number; lines: number }

export interface DeveloperListItem {
  id: string; name: string; githubLogin: string | null; avatarUrl: string | null;
  active: boolean; availability: number; commits: number; ticketsResolved: number;
  openTickets: number; linesChanged: number; hyperPoints: number; projects: number;
  sizeDist: SizeBucket[];
  topSkills: { tag: string; level: number }[];
}

export interface Ticket { id: string; identifier: string; title: string; state: string; priority: string | null; url: string | null; }

/** Credenciales editables de un developer (formulario de alta/edición). */
export interface DeveloperCredentials {
  id: string; name: string; email: string | null;
  githubLogin: string | null; githubEmail: string | null;
  availability: number; active: boolean;
}

export interface DeveloperProfile {
  dev: { id: string; name: string; email: string | null; githubLogin: string | null; avatarUrl: string | null; active: boolean; availability: number };
  kpis: { commits: Metric; hyperPoints: Metric; ticketsResolved: Metric; avgCycleTimeHours: Metric; linesChanged: Metric };
  commitTrend: { date: string; commits: number }[];
  projects: { projectId: string | null; name: string; commits: number }[];
  repos: { repo: string; commits: number }[];
  sizeDist: SizeBucket[];
  tickets: { open: Ticket[]; inProgress: Ticket[]; resolved: Ticket[] };
  skills: { skillId: string; tag: string; level: number }[];
  activity: { type: 'commit' | 'ticket_resolved'; ts: string; title: string; url: string | null; repo: string | null; additions: number | null; deletions: number | null }[];
}

/** Cuadrícula de contribuciones de GitHub (la del perfil público), traída vía GraphQL API. */
export interface GithubContributions {
  linked: boolean;
  login: string | null;
  totalContributions: number;
  weeks: { days: { date: string; count: number; level: 0 | 1 | 2 | 3 | 4; weekday: number }[] }[];
}

export type ProjectKind = 'client' | 'internal';

export interface ProjectListItem {
  projectId: string; name: string; key: string; kind: ProjectKind; color: string | null; commits: number; additions: number; deletions: number;
  contributors: string[]; repos: string[]; ticketsResolved: number;
}

export interface CommitHistoryItem {
  sha: string; message: string; author: string | null; avatarUrl: string | null;
  committedAt: string | null; additions: number | null; deletions: number | null; repo: string; url: string | null;
}

export interface RepoSyncStatus {
  repo: string;
  status: 'idle' | 'queued' | 'syncing' | 'done' | 'error' | string;
  pages: number;
  commits: number;
  totalPages: number | null;
  error: string | null;
  updatedAt: string | null;
}

/** Progreso de una sincronización (backfill) para el widget global; repo + estado + progreso. */
export interface SyncItem extends RepoSyncStatus {
  projectId: string | null;
}

export interface ProjectDetail {
  project: { id: string; name: string; key: string; kind: ProjectKind; color: string | null };
  repos: string[];
  repoSync: RepoSyncStatus[];
  totals: { commits: number; additions: number; deletions: number; ticketsResolved: number; contributors: number; openTickets: number };
  contributors: { name: string; avatarUrl: string | null; commits: number; lines: number }[];
  openTickets: { id: string; identifier: string; title: string; state: string; stateName: string; priority: string | null; url: string | null; assignee: { name: string; avatarUrl: string | null } | null }[];
  byRepo: { repo: string; commits: number }[];
  ticketsByState: { state: string; label: string; count: number }[];
  history: CommitHistoryItem[];
  trend: { date: string; additions: number; deletions: number }[];
}

/** Persona atribuida a un ticket vía PR (autor / revisor / merger). `login` viene siempre; `devId` solo si está mapeado a un roz.dev. */
export interface TicketPerson {
  name: string; avatarUrl: string | null; login: string | null;
  devId?: string | null; reviewState?: string | null;
}
export interface Ticket {
  id: string; identifier: string; number: number | null; title: string;
  spec: string | null;
  state: string; stateName: string; priority: string | null;
  projectId: string | null; projectName: string | null;
  assignee: { id: string; name: string; avatarUrl: string | null } | null; // primary (compat) = primer assignee
  assignees: { id: string; name: string; avatarUrl: string | null }[]; // lista completa de responsables
  createdBy: { name: string; avatarUrl: string | null } | null; // quién creó/asignó (usuario del dashboard)
  estimate: number | null; dueDate: string | null; overdue: boolean;
  labels: string[]; creatorName: string | null; url: string | null;
  updatedAt: string | null; ageDays: number | null;
  parentId: string | null;
  // Agendado (calendario) + resolución
  scheduledStart: string | null; scheduledEnd: string | null;
  completedAt: string | null;
  // Conexión con código (migraciones 0011 + 0016)
  source: 'pr' | 'commit' | 'native' | null;
  headRef: string | null;
  prState: 'open' | 'merged' | 'closed' | null;
  pr: { repo: string; number: number; url: string } | null;
  effort: { commits: number; lines: number; points: number };
  authors: TicketPerson[]; reviewers: TicketPerson[]; merger: TicketPerson | null;
}
export interface TicketsResponse {
  total: number; overdue: number; unassigned: number;
  summary: { total: number; open: number; inProgress: number; completed: number; unassigned: number; overdue: number };
  byState: { label: string; value: number }[];
  byPriority: { label: string; value: number }[];
  byProject: { label: string; value: number }[];
  bySource: { label: string; value: number }[];
  developers: { name: string; avatarUrl: string | null; count: number }[];
  topReviewers: { name: string; avatarUrl: string | null; count: number }[];
  attributionMismatch: number; // tickets mergeados por alguien distinto al autor
  withoutPr: number;           // tickets cerrados sin PR vinculado
  tickets: Ticket[];
}
/** Adjunto (imagen) de una tarea en Supabase Storage. Nombre calza con el backend. */
export interface Attachment {
  id: string;
  url: string;
  name: string;
  contentType: string | null;
  size: number | null;
  createdAt: string;
}
export interface TicketFilterOptions {
  projects: { id: string; name: string }[];
  allProjects: { id: string; name: string }[];
  devs: { id: string; name: string; avatarUrl: string | null }[];
  states: { value: string; label: string }[];
  allStates: { value: string; label: string }[];
  priorities: { value: string; label: string }[];
}

export type ServiceProvider = 'vercel' | 'railway' | 'supabase';
export type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'paused' | 'unknown';

export interface InfraDeploy {
  state: string;
  url: string | null;
  sha: string | null;
  createdAt: string | null;
  commitMessage?: string | null;
  branch?: string | null;
  author?: string | null;
  repo?: string | null;
  durationMs?: number | null;
}
export interface InfraServiceDetails {
  framework?: string | null;
  productionUrl?: string | null;
  region?: string | null;
  dbVersion?: string | null;
  postgresEngine?: string | null;
  replicas?: number | null;
  runtime?: string | null;
  plan?: string | null;
  subsystems?: { name: string; healthy: boolean }[];
  recent?: { state: string; sha: string | null; createdAt: string | null }[];
}
export interface InfraService {
  id: string;
  provider: ServiceProvider;
  externalRef: string;
  label: string | null;
  config: Record<string, unknown>;
  capturedAt: string | null;
  ok: boolean | null;
  status: ServiceStatus;
  providerStatus: string | null;
  active: boolean | null;
  deploy: InfraDeploy | null;
  metrics: Record<string, number> | null;
  details: InfraServiceDetails | null;
  error: string | null;
}
export interface InfraProject { projectId: string; name: string; kind: ProjectKind; services: InfraService[]; }
export interface InfraResponse { projects: InfraProject[]; }

export interface SkillCatalogItem { skillId: string; tag: string; description: string | null; devCount: number; avgLevel: number; busFactorRisk: boolean; }
export interface SkillMatrix {
  devs: { id: string; name: string; avatarUrl: string | null }[];
  skills: { id: string; tag: string }[];
  cells: { devId: string; skillId: string; level: number }[];
}
