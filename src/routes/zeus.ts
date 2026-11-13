// Rutas HTTP de zeus (contrato: docs/zeus-contracts.md §3 y §4).
//   /api/dashboard/zeus/*  → zeusDashboardRoutes. Montadas DENTRO de dashboardRoutes: ya pasaron por
//                            requireDashboardAuth y la persona sale de la sesión.
//   /v1/zeus/*             → zeusCliRoutes. Las usa el CLI en la PC de cada dev; autentican un token
//                            `zeus_…` por persona.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { RozContext } from '../types/hono.js';
import { AppError, ValidationError } from '../utils/errors.js';
import { bearerToken } from '../utils/secure-compare.js';
import { errMessage } from './http.js';
import { ZEUS_NODE_KINDS, ZEUS_NODE_STATUSES, type ZeusNodeKind, type ZeusNodeStatus } from '../types/zeus.js';
import { actorForDev, authenticateZeusToken, isUuid, type ZeusActor } from '../zeus/core.js';
import { bootstrapAdmin, getGraph, getOrg, updateOrgMember } from '../zeus/graph.js';
import {
  cancelRequest,
  createRequest,
  createToken,
  getInbox,
  getMe,
  listActivity,
  listTokens,
  markRead,
  publicOrigin,
  resolveRequest,
  revokeToken,
  sendMessage,
} from '../zeus/inbox.js';
import { listSources, markSourceDirty, reimportNode } from '../zeus/ingest.js';
import { archiveNode, createEdge, createNode, deleteEdge, getNodeDetail, listNodes, searchNodes, updateNode } from '../zeus/nodes.js';
import {
  createEnv,
  grantAccess,
  listKeys,
  listProjectsForCli,
  pullEnv,
  pushSecrets,
  registerKey,
  revokeAccess,
  revokeKey,
  rotateEnv,
  vaultOverview,
} from '../zeus/vault.js';

type C = Context<any>;

/** Conserva `details`: el front y el CLI los usan (p. ej. el repo y la ruta de un archivo que ya no existe). */
function fail(c: C, err: unknown) {
  if (err instanceof AppError) {
    c.get('logger')?.warn({ code: err.code, err: err.message }, 'zeus app error');
    const body: { code: string; message: string; details?: unknown } = { code: err.code, message: err.message };
    if (err.details !== undefined) body.details = err.details;
    return c.json({ error: body }, err.status as 400);
  }
  c.get('logger')?.error({ err }, 'zeus error');
  return c.json({ error: { code: 'INTERNAL', message: errMessage(err) } }, 500);
}

/** Parámetro de ruta. Con el contexto genérico Hono lo tipa opcional; en una ruta que casó siempre viene. */
const param = (c: C, name: string): string => c.req.param(name) ?? '';

async function body(c: C): Promise<Record<string, any>> {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ValidationError('cuerpo JSON inválido');
  return b as Record<string, any>;
}

/** Envuelve un handler: resuelve el actor, serializa el resultado y traduce los errores. */
const run =
  <R>(actorOf: (c: C) => Promise<ZeusActor>, fn: (c: C, actor: ZeusActor) => Promise<R>) =>
  async (c: C) => {
    try {
      return c.json((await fn(c, await actorOf(c))) as any);
    } catch (err) {
      return fail(c, err);
    }
  };

// ================================================================ dashboard

export const zeusDashboardRoutes = new Hono<RozContext>();

const webActor = (c: C): Promise<ZeusActor> => actorForDev(c.get('user')!.devId, 'web');
const web = <R>(fn: (c: C, actor: ZeusActor) => Promise<R>) => run(webActor, fn);

const kindOf = (v: string | undefined): ZeusNodeKind | undefined => (v && (ZEUS_NODE_KINDS as readonly string[]).includes(v) ? (v as ZeusNodeKind) : undefined);
const statusOf = (v: string | undefined): ZeusNodeStatus | undefined =>
  v && (ZEUS_NODE_STATUSES as readonly string[]).includes(v) ? (v as ZeusNodeStatus) : undefined;
const uuidOrNull = (v: string | undefined): string | null => (v && isUuid(v) ? v : null);

zeusDashboardRoutes.get('/me', web((c, actor) => getMe(actor, publicOrigin(c.req))));

zeusDashboardRoutes.post(
  '/admin/bootstrap',
  web(async (c, actor) => {
    await bootstrapAdmin(actor);
    return getMe(await webActor(c), publicOrigin(c.req));
  }),
);

zeusDashboardRoutes.get('/graph', web((c) => getGraph({ projectId: uuidOrNull(c.req.query('projectId')) })));

zeusDashboardRoutes.get(
  '/nodes',
  web(async (c) => ({
    nodes: await listNodes({
      projectId: uuidOrNull(c.req.query('projectId')),
      kind: kindOf(c.req.query('kind')),
      status: statusOf(c.req.query('status')),
      q: c.req.query('q'),
    }),
  })),
);
zeusDashboardRoutes.get('/nodes/:id', web((c) => getNodeDetail(param(c, 'id'))));
zeusDashboardRoutes.post('/nodes', web(async (c, actor) => createNode((await body(c)) as any, actor)));
zeusDashboardRoutes.patch('/nodes/:id', web(async (c, actor) => updateNode(param(c, 'id'), await body(c), actor)));
zeusDashboardRoutes.delete(
  '/nodes/:id',
  web(async (c, actor) => {
    await archiveNode(param(c, 'id'), actor);
    return { ok: true };
  }),
);
// "Traer la versión del repo": la única vía por la que git pisa un documento que ya está en zeus.
zeusDashboardRoutes.post('/nodes/:id/reimport', web(async (c, actor) => (await reimportNode(param(c, 'id'), actor)).node));

zeusDashboardRoutes.post(
  '/edges',
  web(async (c, actor) => {
    const b = await body(c);
    return createEdge({ src: String(b.src ?? ''), dst: String(b.dst ?? ''), kind: String(b.kind ?? ''), note: b.note ?? null }, actor);
  }),
);
zeusDashboardRoutes.delete(
  '/edges/:id',
  web(async (c, actor) => {
    await deleteEdge({ id: param(c, 'id') }, actor);
    return { ok: true };
  }),
);

zeusDashboardRoutes.get(
  '/search',
  web(async (c) => {
    const kinds = (c.req.query('kinds') ?? '').split(',').map((k) => kindOf(k.trim())).filter((k): k is ZeusNodeKind => !!k);
    return { hits: await searchNodes({ query: c.req.query('q') ?? '', projectId: uuidOrNull(c.req.query('projectId')), kinds, limit: 30 }) };
  }),
);

zeusDashboardRoutes.get('/org', web(() => getOrg()));
zeusDashboardRoutes.patch(
  '/org/:devId',
  web(async (c, actor) => {
    const b = await body(c);
    const patch: { reportsTo?: string | null; zeusAdmin?: boolean } = {};
    if (b.reportsTo !== undefined) patch.reportsTo = b.reportsTo === null ? null : String(b.reportsTo);
    if (b.zeusAdmin !== undefined) patch.zeusAdmin = !!b.zeusAdmin;
    return updateOrgMember(param(c, 'devId'), patch, actor);
  }),
);

zeusDashboardRoutes.get('/tokens', web(async (_c, actor) => ({ tokens: await listTokens(actor) })));
zeusDashboardRoutes.post('/tokens', web(async (c, actor) => createToken(String((await body(c)).name ?? ''), actor)));
zeusDashboardRoutes.delete(
  '/tokens/:id',
  web(async (c, actor) => {
    await revokeToken(param(c, 'id'), actor);
    return { ok: true };
  }),
);

zeusDashboardRoutes.get('/inbox', web((_c, actor) => getInbox(actor)));
zeusDashboardRoutes.post(
  '/messages',
  web(async (c, actor) => {
    const b = await body(c);
    return sendMessage({ to: String(b.toDevId ?? ''), subject: b.subject ?? null, body: String(b.body ?? ''), ref: b.ref ?? null }, actor);
  }),
);
zeusDashboardRoutes.post(
  '/messages/read',
  web(async (c, actor) => {
    const b = await body(c);
    const ids = b.ids === 'all' ? 'all' : Array.isArray(b.ids) ? b.ids.map(String) : [];
    await markRead(ids, actor);
    return { ok: true };
  }),
);

zeusDashboardRoutes.post(
  '/requests',
  web(async (c, actor) => {
    const b = await body(c);
    return createRequest({ kind: b.kind, title: String(b.title ?? ''), detail: b.detail ?? '', resourceRef: b.resourceRef ?? null }, actor);
  }),
);
zeusDashboardRoutes.post(
  '/requests/:id/resolve',
  web(async (c, actor) => {
    const b = await body(c);
    return resolveRequest(param(c, 'id'), b.decision, b.note ?? null, actor);
  }),
);
zeusDashboardRoutes.post('/requests/:id/cancel', web((c, actor) => cancelRequest(param(c, 'id'), actor)));

zeusDashboardRoutes.get('/sources', web(async () => ({ sources: await listSources() })));
zeusDashboardRoutes.post(
  '/sources/sync',
  web(async (c) => {
    const repo = String((await body(c)).repo ?? '');
    if (!(await markSourceDirty(repo))) throw new ValidationError('ese repo no está vinculado a ningún proyecto');
    return { ok: true };
  }),
);

zeusDashboardRoutes.get('/activity', web((c) => listActivity(c.req.query('since') ?? null)));

zeusDashboardRoutes.get('/vault', web(() => vaultOverview()));
zeusDashboardRoutes.post(
  '/vault/keys/:id/revoke',
  web(async (c, actor) => {
    await revokeKey(param(c, 'id'), actor);
    return { ok: true };
  }),
);

// ================================================================ CLI

export const zeusCliRoutes = new Hono<RozContext>();

async function cliActor(c: C): Promise<ZeusActor> {
  const actor = await authenticateZeusToken(bearerToken(c.req.header('authorization')), 'cli');
  if (!actor) throw new AppError('UNAUTHORIZED', 'token de zeus inválido o revocado (crea uno en roz → Zeus → Acceso)', 401);
  return actor;
}
const cli = <R>(fn: (c: C, actor: ZeusActor) => Promise<R>) => run(cliActor, fn);

zeusCliRoutes.get('/whoami', cli(async (_c, actor) => ({ dev: { id: actor.devId, name: actor.name, email: actor.email }, zeusAdmin: actor.admin })));

zeusCliRoutes.get('/vault/keys', cli(async (c, actor) => ({ keys: await listKeys(actor, c.req.query('all') === '1') })));
zeusCliRoutes.post(
  '/vault/keys',
  cli(async (c, actor) => {
    const b = await body(c);
    return { key: await registerKey({ name: String(b.name ?? ''), publicKey: String(b.publicKey ?? '') }, actor) };
  }),
);

zeusCliRoutes.get('/vault/projects', cli(async (_c, actor) => ({ projects: await listProjectsForCli(actor) })));

zeusCliRoutes.post(
  '/vault/envs',
  cli(async (c, actor) => {
    const b = await body(c);
    return createEnv({ projectKey: String(b.projectKey ?? ''), env: String(b.env ?? ''), keyId: String(b.keyId ?? ''), wrappedDek: String(b.wrappedDek ?? '') }, actor);
  }),
);

zeusCliRoutes.get('/vault/envs/:projectKey/:env', cli((c, actor) => pullEnv(param(c, 'projectKey'), param(c, 'env'), c.req.query('keyId') ?? '', actor)));

zeusCliRoutes.put(
  '/vault/envs/:projectKey/:env/secrets',
  cli(async (c, actor) => {
    const b = await body(c);
    return pushSecrets(
      param(c, 'projectKey'),
      param(c, 'env'),
      { keyId: String(b.keyId ?? ''), dekVersion: Number(b.dekVersion), set: Array.isArray(b.set) ? b.set : [], delete: Array.isArray(b.delete) ? b.delete.map(String) : [] },
      actor,
    );
  }),
);

zeusCliRoutes.post(
  '/vault/envs/:projectKey/:env/grants',
  cli(async (c, actor) => {
    const b = await body(c);
    return grantAccess(param(c, 'projectKey'), param(c, 'env'), { keyId: String(b.keyId ?? ''), grants: Array.isArray(b.grants) ? b.grants : [] }, actor);
  }),
);

zeusCliRoutes.delete('/vault/envs/:projectKey/:env/grants/:keyId', cli((c, actor) => revokeAccess(param(c, 'projectKey'), param(c, 'env'), param(c, 'keyId'), actor)));

zeusCliRoutes.post(
  '/vault/envs/:projectKey/:env/rotate',
  cli(async (c, actor) => {
    const b = await body(c);
    return rotateEnv(
      param(c, 'projectKey'),
      param(c, 'env'),
      { keyId: String(b.keyId ?? ''), dekVersion: Number(b.dekVersion), grants: Array.isArray(b.grants) ? b.grants : [], secrets: Array.isArray(b.secrets) ? b.secrets : [] },
      actor,
    );
  }),
);
