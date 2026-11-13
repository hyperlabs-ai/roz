// Base de zeus: identidad (quién llama), tokens por persona, referencias del grafo y registro de
// actividad. Todo lo demás en src/zeus/ se apoya aquí.
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db/supabase.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import type { ZeusGraphKind, ZeusRef } from '../types/zeus.js';

// ---------------------------------------------------------------- identidad

export type ZeusVia = 'mcp' | 'web' | 'cli' | 'runner';

/** Quién ejecuta una operación de zeus. Siempre es un dev concreto. */
export interface ZeusActor {
  devId: string;
  name: string;
  email: string | null;
  admin: boolean;
  via: ZeusVia;
}

interface DevAccessRow {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  active: boolean;
  zeus_admin: boolean | null;
}

const DEV_ACCESS = 'id, name, email, role, active, zeus_admin';

/** Administra zeus quien tiene la marca o es CEO (el rol más alto ya implica la decisión). */
export function isZeusAdmin(row: { role?: string | null; zeus_admin?: boolean | null }): boolean {
  return !!row.zeus_admin || row.role === 'ceo';
}

export async function actorForDev(devId: string, via: ZeusVia): Promise<ZeusActor> {
  const { data, error } = await db().from('dev').select(DEV_ACCESS).eq('id', devId).maybeSingle();
  if (error) throw error;
  const row = data as DevAccessRow | null;
  if (!row || !row.active) throw new AppError('FORBIDDEN', 'tu cuenta no está activa en roz', 403);
  return { devId: row.id, name: row.name, email: row.email, admin: isZeusAdmin(row), via };
}

/** True mientras nadie administre zeus: el primer dev que lo pida toma el rol. */
export async function needsAdmin(): Promise<boolean> {
  const { data, error } = await db().from('dev').select('id, role, zeus_admin').eq('active', true);
  if (error) throw error;
  return !((data ?? []) as Array<{ role: string | null; zeus_admin: boolean | null }>).some(isZeusAdmin);
}

export function requireAdmin(actor: ZeusActor): void {
  if (!actor.admin) throw new AppError('ZEUS_ADMIN_ONLY', 'esto lo hace un administrador de zeus', 403);
}

// ---------------------------------------------------------------- tokens

export const ZEUS_TOKEN_PREFIX = 'zeus_';

export function generateZeusToken(): string {
  return ZEUS_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** En la base solo vive el sha256: un volcado no sirve para suplantar a nadie. */
export function hashZeusToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function zeusTokenPrefix(token: string): string {
  return token.slice(0, 12);
}

/** Forma válida antes de ir a la base (descarta basura sin consultar). */
export function looksLikeZeusToken(token: string): boolean {
  return /^zeus_[A-Za-z0-9_-]{43}$/.test(token);
}

/** Sellar last_used_at en cada request sería una escritura por llamada MCP: basta una por minuto. */
const TOUCH_EVERY_MS = 60_000;
const touched = new Map<string, number>();

/** Resuelve un token `zeus_…` a su dev. Null si no existe, está revocado o el dev está inactivo. */
export async function authenticateZeusToken(token: string, via: ZeusVia): Promise<ZeusActor | null> {
  if (!looksLikeZeusToken(token)) return null;
  const { data, error } = await db()
    .from('zeus_token')
    .select('id, dev_id, revoked_at')
    .eq('token_hash', hashZeusToken(token))
    .maybeSingle();
  if (error) throw error;
  const row = data as { id: string; dev_id: string; revoked_at: string | null } | null;
  if (!row || row.revoked_at) return null;
  let actor: ZeusActor;
  try {
    actor = await actorForDev(row.dev_id, via);
  } catch {
    return null;
  }
  const now = Date.now();
  if (now - (touched.get(row.id) ?? 0) > TOUCH_EVERY_MS) {
    touched.set(row.id, now);
    void db().from('zeus_token').update({ last_used_at: new Date(now).toISOString() }).eq('id', row.id).then(() => undefined);
  }
  return actor;
}

// ---------------------------------------------------------------- referencias

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID_RE.test(s);

export type RefType = 'node' | 'dev' | 'project' | 'repo' | 'runner';
const REF_TYPES: readonly RefType[] = ['node', 'dev', 'project', 'repo', 'runner'];

export interface ParsedRef {
  type: RefType;
  id: string;
}

export function parseRef(ref: string): ParsedRef | null {
  const i = ref.indexOf(':');
  if (i < 1) return null;
  const type = ref.slice(0, i) as RefType;
  const id = ref.slice(i + 1);
  if (!REF_TYPES.includes(type) || !id) return null;
  if (type === 'repo') return /^[\w.-]+\/[\w.-]+$/.test(id) ? { type, id } : null;
  return isUuid(id) ? { type, id: id.toLowerCase() } : null;
}

export function mustParseRef(ref: string): ParsedRef {
  const p = parseRef(ref);
  if (!p) throw new ValidationError(`referencia inválida: "${ref}" (usa node:<id>, dev:<id>, project:<id>, repo:<owner/name> o runner:<id>)`);
  return p;
}

export const nodeRef = (id: string): ZeusRef => `node:${id}`;
export const devRef = (id: string): ZeusRef => `dev:${id}`;
export const projectRef = (id: string): ZeusRef => `project:${id}`;

export interface RefInfo {
  ref: ZeusRef;
  kind: ZeusGraphKind;
  title: string;
}

/** Título y tipo de un lote de referencias (para pintar el otro extremo de una arista). */
export async function describeRefs(refs: readonly string[]): Promise<Map<string, RefInfo>> {
  const out = new Map<string, RefInfo>();
  const by: Record<RefType, string[]> = { node: [], dev: [], project: [], repo: [], runner: [] };
  for (const r of new Set(refs)) {
    const p = parseRef(r);
    if (p) by[p.type].push(p.id);
  }
  const supabase = db();
  const [nodes, devs, projects, runners] = await Promise.all([
    by.node.length ? supabase.from('zeus_node').select('id, kind, title').in('id', by.node) : null,
    by.dev.length ? supabase.from('dev').select('id, name').in('id', by.dev) : null,
    by.project.length ? supabase.from('project').select('id, name').in('id', by.project) : null,
    by.runner.length ? supabase.from('runner').select('id, name').in('id', by.runner) : null,
  ]);
  for (const res of [nodes, devs, projects, runners]) if (res?.error) throw res.error;
  for (const n of (nodes?.data ?? []) as Array<{ id: string; kind: ZeusGraphKind; title: string }>) {
    out.set(`node:${n.id}`, { ref: `node:${n.id}`, kind: n.kind, title: n.title });
  }
  for (const d of (devs?.data ?? []) as Array<{ id: string; name: string }>) out.set(`dev:${d.id}`, { ref: `dev:${d.id}`, kind: 'dev', title: d.name });
  for (const p of (projects?.data ?? []) as Array<{ id: string; name: string }>) {
    out.set(`project:${p.id}`, { ref: `project:${p.id}`, kind: 'project', title: p.name });
  }
  for (const r of (runners?.data ?? []) as Array<{ id: string; name: string }>) {
    out.set(`runner:${r.id}`, { ref: `runner:${r.id}`, kind: 'runner', title: r.name });
  }
  for (const id of by.repo) out.set(`repo:${id}`, { ref: `repo:${id}`, kind: 'repo', title: id });
  return out;
}

/** Exige que la referencia apunte a algo que existe. */
export async function assertRefExists(ref: string): Promise<RefInfo> {
  mustParseRef(ref);
  const info = (await describeRefs([ref])).get(ref);
  if (!info) throw new NotFoundError(`no existe ${ref}`);
  return info;
}

// ---------------------------------------------------------------- proyectos

export interface ProjectLite {
  id: string;
  key: string;
  name: string;
}

/** Proyecto por clave (lo que escribe un agente) o por uuid. */
export async function resolveProject(keyOrId: string): Promise<ProjectLite> {
  const q = db().from('project').select('id, key, name');
  const { data, error } = isUuid(keyOrId) ? await q.eq('id', keyOrId).maybeSingle() : await q.ilike('key', keyOrId).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError(`no existe el proyecto "${keyOrId}" (usa list_projects para ver las claves)`);
  return data as ProjectLite;
}

// ---------------------------------------------------------------- actividad

export type ActivityActor = ZeusVia | 'git' | 'system';

/**
 * Deja rastro de quién consultó o cambió qué. Alimenta los pulsos del mapa y, más importante, dice
 * si el contexto de verdad se usa. Best-effort: registrar no debe tumbar la operación.
 */
export function logActivity(
  who: { devId: string | null; actor: ActivityActor },
  action: string,
  ref: ZeusRef | null = null,
  detail: Record<string, unknown> = {},
): void {
  void db()
    .from('zeus_activity')
    .insert({ dev_id: who.devId, actor: who.actor, action, ref, detail })
    .then(() => undefined, () => undefined);
}

export const actorActivity = (a: ZeusActor): { devId: string; actor: ActivityActor } => ({ devId: a.devId, actor: a.via });
