// El grafo que dibuja el front: nodos guardados + entidades derivadas (personas, proyectos, repos,
// equipos de los devs) y sus aristas. Las derivadas no se guardan: salen de las tablas que ya son la
// fuente de verdad, así el mapa no puede quedar desfasado del organigrama o de los proyectos.
import { db } from '../db/supabase.js';
import { runnerOnline } from '../plans/rules.js';
import type {
  ZeusEdgeKind,
  ZeusGraph,
  ZeusGraphEdge,
  ZeusGraphKind,
  ZeusGraphNode,
  ZeusNodeKind,
  ZeusNodeStatus,
  ZeusOrg,
  ZeusOrgMember,
} from '../types/zeus.js';
import { isZeusAdmin, needsAdmin, requireAdmin, isUuid, logActivity, actorActivity, type ZeusActor } from './core.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';

interface DevRow {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  github_login: string | null;
  active: boolean;
  reports_to: string | null;
  zeus_admin: boolean | null;
}

const DEV_COLS = 'id, name, email, role, github_login, active, reports_to, zeus_admin';

async function loadOrgData(now: Date) {
  const supabase = db();
  const [devs, assignments, skills, runners, projects] = await Promise.all([
    supabase.from('dev').select(DEV_COLS).eq('active', true).order('name'),
    supabase.from('dev_assignment').select('dev_id, project_id'),
    supabase.from('dev_skill').select('dev_id, skill:skill_id(tag)'),
    supabase.from('runner').select('id, dev_id, name, platform, last_seen_at').is('revoked_at', null),
    supabase.from('project').select('id, key, name, color, active'),
  ]);
  for (const r of [devs, assignments, skills, runners, projects]) if (r.error) throw r.error;
  const runnerRows = (runners.data ?? []) as Array<{ id: string; dev_id: string; name: string; platform: string | null; last_seen_at: string | null }>;
  const online = new Set(runnerRows.filter((r) => runnerOnline(r.last_seen_at, now)).map((r) => r.dev_id));
  return {
    devs: (devs.data ?? []) as DevRow[],
    assignments: (assignments.data ?? []) as Array<{ dev_id: string; project_id: string | null }>,
    skills: (skills.data ?? []) as unknown as Array<{ dev_id: string; skill: { tag: string } | { tag: string }[] | null }>,
    runners: runnerRows,
    projects: (projects.data ?? []) as Array<{ id: string; key: string; name: string; color: string | null; active: boolean }>,
    online,
  };
}

function toMember(d: DevRow, ctx: Awaited<ReturnType<typeof loadOrgData>>): ZeusOrgMember {
  const keyOf = new Map(ctx.projects.map((p) => [p.id, p.key]));
  const projects = [...new Set(ctx.assignments.filter((a) => a.dev_id === d.id && a.project_id).map((a) => keyOf.get(a.project_id!)).filter((k): k is string => !!k))];
  const skills = ctx.skills
    .filter((s) => s.dev_id === d.id)
    .flatMap((s) => (Array.isArray(s.skill) ? s.skill : s.skill ? [s.skill] : []))
    .map((s) => s.tag);
  return {
    devId: d.id,
    name: d.name,
    email: d.email,
    role: d.role ?? 'dev',
    githubLogin: d.github_login,
    active: d.active,
    reportsTo: d.reports_to,
    zeusAdmin: isZeusAdmin(d),
    projects,
    skills: [...new Set(skills)],
    online: ctx.online.has(d.id),
  };
}

export async function getOrg(now: Date = new Date()): Promise<ZeusOrg> {
  const ctx = await loadOrgData(now);
  const members = ctx.devs.map((d) => toMember(d, ctx));
  return { members, needsAdmin: !members.some((m) => m.zeusAdmin) };
}

/** True si poner a `managerId` como jefe de `devId` cerraría un ciclo en la jerarquía. */
export function createsCycle(devId: string, managerId: string, reportsTo: Map<string, string | null>): boolean {
  let cur: string | null | undefined = managerId;
  for (let hops = 0; cur && hops < 100; hops++) {
    if (cur === devId) return true;
    cur = reportsTo.get(cur);
  }
  return false;
}

export async function updateOrgMember(devId: string, patch: { reportsTo?: string | null; zeusAdmin?: boolean }, actor: ZeusActor): Promise<ZeusOrgMember> {
  requireAdmin(actor);
  if (!isUuid(devId)) throw new ValidationError('devId inválido');
  const ctx = await loadOrgData(new Date());
  const target = ctx.devs.find((d) => d.id === devId);
  if (!target) throw new NotFoundError('esa persona no existe o está inactiva');
  const next: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.reportsTo !== undefined) {
    if (patch.reportsTo !== null) {
      if (!ctx.devs.some((d) => d.id === patch.reportsTo)) throw new ValidationError('el jefe indicado no existe o está inactivo');
      if (patch.reportsTo === devId) throw new ValidationError('nadie se reporta a sí mismo');
      if (createsCycle(devId, patch.reportsTo, new Map(ctx.devs.map((d) => [d.id, d.reports_to])))) {
        throw new ValidationError('eso cerraría un ciclo en la jerarquía');
      }
    }
    next.reports_to = patch.reportsTo;
  }
  if (patch.zeusAdmin !== undefined) {
    // Quitar al último admin dejaría a zeus sin nadie que apruebe ni dé acceso a la bóveda.
    if (!patch.zeusAdmin && isZeusAdmin(target)) {
      const others = ctx.devs.filter((d) => d.id !== devId && isZeusAdmin(d));
      if (!others.length) throw new AppError('ZEUS_LAST_ADMIN', 'es el único administrador de zeus: nombra a otro antes de quitarlo', 409);
      if (target.role === 'ceo') throw new ValidationError('el CEO administra zeus por su rol; no se le puede quitar aquí');
    }
    next.zeus_admin = patch.zeusAdmin;
  }
  const { error } = await db().from('dev').update(next).eq('id', devId);
  if (error) throw error;
  logActivity(actorActivity(actor), 'org.update', `dev:${devId}`, patch);
  const fresh = await loadOrgData(new Date());
  return toMember(fresh.devs.find((d) => d.id === devId)!, fresh);
}

/** El primer dev que lo pida administra zeus, una sola vez: después solo otro admin puede nombrar. */
export async function bootstrapAdmin(actor: ZeusActor): Promise<void> {
  if (!(await needsAdmin())) throw new AppError('ZEUS_HAS_ADMIN', 'zeus ya tiene administrador: pídele el rol', 409);
  const { error } = await db().from('dev').update({ zeus_admin: true, updated_at: new Date().toISOString() }).eq('id', actor.devId);
  if (error) throw error;
  logActivity(actorActivity(actor), 'org.bootstrap', `dev:${actor.devId}`);
}

// ---------------------------------------------------------------- grafo

export async function getGraph(input: { projectId?: string | null } = {}, now: Date = new Date()): Promise<ZeusGraph> {
  const supabase = db();
  const projectId = input.projectId && isUuid(input.projectId) ? input.projectId : null;

  let nodeQ = supabase
    .from('zeus_node')
    .select('id, kind, title, summary, project_id, status, pinned, source, owner_dev_id, meta, updated_at')
    .neq('status', 'archived');
  // Con filtro de proyecto se ve lo suyo y lo de la organización (que también le aplica).
  if (projectId) nodeQ = nodeQ.or(`project_id.eq.${projectId},project_id.is.null`);
  const [nodesRes, edgesRes, reposRes, org] = await Promise.all([
    nodeQ.order('updated_at', { ascending: false }).limit(2000),
    supabase.from('zeus_edge').select('id, src_ref, dst_ref, kind, note, source').limit(5000),
    supabase.from('project_repo').select('repo, project_id'),
    loadOrgData(now),
  ]);
  for (const r of [nodesRes, edgesRes, reposRes]) if (r.error) throw r.error;

  type NodeRow = {
    id: string; kind: ZeusNodeKind; title: string; summary: string; project_id: string | null; status: ZeusNodeStatus;
    pinned: boolean; source: 'manual' | 'git'; owner_dev_id: string | null; meta: Record<string, unknown> | null; updated_at: string;
  };
  const nodes: ZeusGraphNode[] = [];
  const edges: ZeusGraphEdge[] = [];
  const derived = (src: string, kind: ZeusGraphEdge['kind'], dst: string) =>
    edges.push({ id: `d:${src}|${kind}|${dst}`, src, dst, kind, derived: true, source: 'derived', note: null });

  const projects = org.projects.filter((p) => p.active && (!projectId || p.id === projectId));
  for (const p of projects) {
    nodes.push({
      ref: `project:${p.id}`, kind: 'project', title: p.name, summary: '', projectId: p.id, status: 'active', pinned: false,
      source: 'derived', updatedAt: null, meta: { key: p.key, color: p.color },
    });
  }
  const projectIds = new Set(projects.map((p) => p.id));

  const members = org.devs.filter((d) => !projectId || org.assignments.some((a) => a.dev_id === d.id && a.project_id === projectId));
  const memberIds = new Set(members.map((d) => d.id));
  for (const d of members) {
    nodes.push({
      ref: `dev:${d.id}`, kind: 'dev', title: d.name, summary: d.role ?? 'dev', projectId: null, status: 'active', pinned: false,
      source: 'derived', updatedAt: null, meta: { role: d.role ?? 'dev', githubLogin: d.github_login, online: org.online.has(d.id), zeusAdmin: isZeusAdmin(d) },
    });
    if (d.reports_to && memberIds.has(d.reports_to)) derived(`dev:${d.id}`, 'reports_to', `dev:${d.reports_to}`);
  }
  for (const a of org.assignments) {
    if (a.project_id && projectIds.has(a.project_id) && memberIds.has(a.dev_id)) {
      const id = `d:dev:${a.dev_id}|part_of|project:${a.project_id}`;
      if (!edges.some((e) => e.id === id)) derived(`dev:${a.dev_id}`, 'part_of', `project:${a.project_id}`);
    }
  }
  for (const r of org.runners) {
    if (!memberIds.has(r.dev_id)) continue;
    nodes.push({
      ref: `runner:${r.id}`, kind: 'runner', title: r.name, summary: r.platform ?? '', projectId: null, status: 'active', pinned: false,
      source: 'derived', updatedAt: r.last_seen_at, meta: { online: runnerOnline(r.last_seen_at, now), devId: r.dev_id, platform: r.platform },
    });
    derived(`runner:${r.id}`, 'part_of', `dev:${r.dev_id}`);
  }
  for (const r of (reposRes.data ?? []) as Array<{ repo: string; project_id: string }>) {
    if (!projectIds.has(r.project_id)) continue;
    nodes.push({
      ref: `repo:${r.repo}`, kind: 'repo', title: r.repo, summary: '', projectId: r.project_id, status: 'active', pinned: false,
      source: 'derived', updatedAt: null, meta: { url: `https://github.com/${r.repo}` },
    });
    derived(`repo:${r.repo}`, 'part_of', `project:${r.project_id}`);
  }
  for (const n of (nodesRes.data ?? []) as NodeRow[]) {
    const ref = `node:${n.id}`;
    nodes.push({
      ref, kind: n.kind, title: n.title, summary: n.summary, projectId: n.project_id, status: n.status, pinned: n.pinned,
      source: n.source, updatedAt: n.updated_at, meta: n.meta ?? {},
    });
    if (n.project_id && projectIds.has(n.project_id)) derived(ref, 'part_of', `project:${n.project_id}`);
    if (n.owner_dev_id && memberIds.has(n.owner_dev_id)) derived(`dev:${n.owner_dev_id}`, 'owns', ref);
  }

  // Aristas guardadas: solo las que tienen ambos extremos a la vista.
  const present = new Set(nodes.map((n) => n.ref));
  for (const e of (edgesRes.data ?? []) as Array<{ id: string; src_ref: string; dst_ref: string; kind: ZeusEdgeKind; note: string | null; source: 'manual' | 'git' }>) {
    if (present.has(e.src_ref) && present.has(e.dst_ref)) edges.push({ id: e.id, src: e.src_ref, dst: e.dst_ref, kind: e.kind, derived: false, source: e.source, note: e.note });
  }

  const counts: Partial<Record<ZeusGraphKind, number>> = {};
  for (const n of nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
  return { nodes, edges, counts, generatedAt: now.toISOString() };
}
