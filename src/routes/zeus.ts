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
import { config } from '../config.js';
import { actorForDev, authenticateZeusToken, isUuid, type ZeusActor } from '../zeus/core.js';
import { decideDeviceRequest, getDeviceRequest, pollDeviceAuth, startDeviceAuth } from '../zeus/device-auth.js';
import { decideAuthorize, getAuthorizeRequest, type AuthorizeParams } from '../zeus/oauth.js';
import { bootstrapAdmin, getGraph, getOrg, setOrgDuty, updateOrgMember, type OrgMemberPatch } from '../zeus/graph.js';
import {
  cancelRequest,
  createRequest,
  createToken,
  getInbox,
  getMe,
  getMessage,
  listActivity,
  listTokens,
  markRead,
  messageHistory,
  publicOrigin,
  resolveRequest,
  revokeToken,
  sendMessage,
  setMessageStatus,
  sharePlan,
} from '../zeus/inbox.js';
import { ZEUS_MESSAGE_STATUSES, type ZeusMessageStatus } from '../types/zeus.js';
import { listSources, markSourceDirty, reimportNode } from '../zeus/ingest.js';
import { linearBoard } from '../zeus/linear.js';
import { mcpStatus } from '../zeus/mcp-status.js';
import { archiveNode, createEdge, createNode, deleteEdge, getNodeDetail, listNodes, searchNodes, updateNode } from '../zeus/nodes.js';
import {
  cancelGrantIntent,
  createEnv,
  createGrantIntent,
  envHistory,
  envHistoryMeta,
  grantAccess,
  listGrantIntentsForCli,
  listKeys,
  listProjectsForCli,
  pullEnv,
  pushSecrets,
  registerKey,
  revokeAccess,
  revokeKey,
  rotateDeviceKey,
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

/**
 * IP de quien llama, detrás del proxy de Railway. Solo para los límites y para mostrarla al aprobar.
 * Se toma la ÚLTIMA de x-forwarded-for (la que agregó el proxy): las de antes las escribe el cliente.
 */
const clientIp = (c: C): string | null => c.req.header('x-forwarded-for')?.split(',').pop()?.trim() || c.req.header('x-real-ip')?.trim() || null;

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
    const patch: OrgMemberPatch = {};
    if (b.reportsTo !== undefined) patch.reportsTo = b.reportsTo === null ? null : String(b.reportsTo);
    if (b.zeusAdmin !== undefined) patch.zeusAdmin = !!b.zeusAdmin;
    if (b.title !== undefined) patch.title = b.title === null ? null : String(b.title);
    if (b.alsoReportsTo !== undefined) patch.alsoReportsTo = Array.isArray(b.alsoReportsTo) ? b.alsoReportsTo.map(String) : [];
    return updateOrgMember(param(c, 'devId'), patch, actor);
  }),
);
// Quién se encarga de un tema (lista en orden). Solo admin de zeus.
zeusDashboardRoutes.put(
  '/org/duties/:duty',
  web(async (c, actor) => {
    const b = await body(c);
    return setOrgDuty(param(c, 'duty'), Array.isArray(b.devIds) ? b.devIds.map(String) : [], actor);
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

// Conectar una PC (`zeus setup`): la página /conectar lee la solicitud por su código y la aprueba o
// rechaza con la sesión de quien mira. Ver src/zeus/device-auth.ts.
zeusDashboardRoutes.get('/device/:userCode', web((c, actor) => getDeviceRequest(param(c, 'userCode'), actor)));
zeusDashboardRoutes.post('/device/:userCode/approve', web((c, actor) => decideDeviceRequest(param(c, 'userCode'), 'approve', actor)));
zeusDashboardRoutes.post('/device/:userCode/deny', web((c, actor) => decideDeviceRequest(param(c, 'userCode'), 'deny', actor)));

// Conector de claude.ai (OAuth): la página /autorizar manda los parámetros tal cual llegaron del
// cliente y recibe a dónde volver. Ver src/zeus/oauth.ts.
const oauthParams = (src: Record<string, unknown>): AuthorizeParams => {
  const keys = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'] as const;
  return Object.fromEntries(keys.filter((k) => src[k] != null).map((k) => [k, String(src[k])])) as AuthorizeParams;
};
zeusDashboardRoutes.get('/oauth/authorize', web((c, actor) => getAuthorizeRequest(oauthParams(c.req.query()), actor)));
zeusDashboardRoutes.post('/oauth/authorize/approve', web(async (c, actor) => decideAuthorize(oauthParams(await body(c)), 'approve', actor)));
zeusDashboardRoutes.post('/oauth/authorize/deny', web(async (c, actor) => decideAuthorize(oauthParams(await body(c)), 'deny', actor)));

zeusDashboardRoutes.get('/inbox', web((_c, actor) => getInbox(actor)));
// Tickets de Linear de quien mira, aparte de la bandeja: Linear puede tardar y no debe frenarla.
zeusDashboardRoutes.get('/linear/board', web((_c, actor) => linearBoard(actor)));
// Historial completo (leído y no leído) con filtros: para volver a abrir un mensaje viejo.
zeusDashboardRoutes.get(
  '/messages',
  web((c, actor) => {
    const kind = c.req.query('kind');
    return messageHistory(
      {
        box: c.req.query('box') === 'sent' ? 'sent' : 'received',
        kind: kind === 'message' || kind === 'task' || kind === 'plan' || kind === 'env_change' ? kind : null,
        with: c.req.query('with') ?? null,
        projectKey: c.req.query('project') ?? null,
        q: c.req.query('q') ?? null,
        before: c.req.query('before') ?? null,
        limit: Number(c.req.query('limit')) || undefined,
      },
      actor,
    );
  }),
);
zeusDashboardRoutes.post(
  '/messages',
  web(async (c, actor) => {
    const b = await body(c);
    return sendMessage(
      {
        to: String(b.toDevId ?? ''),
        subject: b.subject ?? null,
        body: String(b.body ?? ''),
        ref: b.ref ?? null,
        kind: b.kind === 'task' ? 'task' : 'message',
        projectKey: b.projectKey ? String(b.projectKey) : null,
      },
      actor,
    );
  }),
);
zeusDashboardRoutes.post(
  '/plans',
  web(async (c, actor) => {
    const b = await body(c);
    return sharePlan(
      {
        to: String(b.toDevId ?? ''),
        title: String(b.title ?? ''),
        plan: String(b.plan ?? ''),
        projectKey: b.projectKey ? String(b.projectKey) : null,
        revises: b.revises ? String(b.revises) : null,
      },
      actor,
    );
  }),
);
zeusDashboardRoutes.get('/messages/:id', web((c, actor) => getMessage(param(c, 'id'), actor)));
zeusDashboardRoutes.post(
  '/messages/:id/status',
  web(async (c, actor) => {
    const b = await body(c);
    const status = String(b.status ?? '');
    if (!(ZEUS_MESSAGE_STATUSES as readonly string[]).includes(status)) throw new ValidationError('estado inválido');
    return setMessageStatus(param(c, 'id'), status as ZeusMessageStatus, b.note ? String(b.note) : null, actor);
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
    return createRequest({ kind: b.kind, title: String(b.title ?? ''), detail: b.detail ?? '', resourceRef: b.resourceRef ?? null, topic: b.topic ? String(b.topic) : null }, actor);
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
// Página "MCP": estado del servidor, conexiones, último trabajo, pendientes, runners e ingesta.
zeusDashboardRoutes.get('/mcp', web(() => mcpStatus()));

zeusDashboardRoutes.get('/vault', web(() => vaultOverview()));
zeusDashboardRoutes.get('/vault/envs/:projectKey/:env/history', web((c) => envHistoryMeta(param(c, 'projectKey'), param(c, 'env'), c.req.query('name') || null)));
// Dar acceso desde la web = APROBAR: el navegador no tiene la DEK. Lo cifra después el CLI de
// alguien con acceso (`zeus env grant --pending`). Ver el modelo de amenaza en src/zeus/vault.ts.
zeusDashboardRoutes.post(
  '/vault/grant-intents',
  web(async (c, actor) => {
    const b = await body(c);
    return createGrantIntent(
      { envId: b.envId ? String(b.envId) : null, projectKey: b.projectKey ? String(b.projectKey) : null, env: b.env ? String(b.env) : null, toDevId: String(b.toDevId ?? '') },
      actor,
    );
  }),
);
zeusDashboardRoutes.post('/vault/grant-intents/:id/cancel', web((c, actor) => cancelGrantIntent(param(c, 'id'), actor)));
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
  if (!actor) throw new AppError('UNAUTHORIZED', 'token de zeus inválido o revocado (conecta este equipo otra vez con `zeus setup`)', 401);
  return actor;
}
const cli = <R>(fn: (c: C, actor: ZeusActor) => Promise<R>) => run(cliActor, fn);

// Conectar este equipo sin copiar tokens (`zeus setup`): rutas PÚBLICAS, sin token. Abrir da un
// device_code secreto y un código corto que la persona aprueba en roz (/conectar); consultar devuelve
// el token una sola vez cuando ya se aprobó. Límites y modelo de amenaza en src/zeus/device-auth.ts.
const open =
  <R>(fn: (c: C) => Promise<R>) =>
  async (c: C) => {
    try {
      return c.json((await fn(c)) as any);
    } catch (err) {
      return fail(c, err);
    }
  };
zeusCliRoutes.post(
  '/device/start',
  open(async (c) => {
    const b = await c.req.json().catch(() => ({}));
    // La aprobación vive en el front (roz); si no hay DASHBOARD_URL, se asume front y back en el mismo origen.
    return startDeviceAuth(b && typeof b === 'object' ? b : {}, { ip: clientIp(c), approveBase: config.dashboard.url || publicOrigin(c.req) });
  }),
);
zeusCliRoutes.post('/device/poll', open(async (c) => pollDeviceAuth(String((await body(c)).deviceCode ?? ''), { ip: clientIp(c) })));

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

// Accesos aprobados en la web que este dev puede cifrar (tiene acceso al entorno).
zeusCliRoutes.get('/vault/grant-intents', cli(async (_c, actor) => ({ intents: await listGrantIntentsForCli(actor) })));

zeusCliRoutes.delete('/vault/envs/:projectKey/:env/grants/:keyId', cli((c, actor) => revokeAccess(param(c, 'projectKey'), param(c, 'env'), param(c, 'keyId'), actor)));

zeusCliRoutes.post(
  '/vault/envs/:projectKey/:env/rotate',
  cli(async (c, actor) => {
    const b = await body(c);
    return rotateEnv(
      param(c, 'projectKey'),
      param(c, 'env'),
      {
        keyId: String(b.keyId ?? ''),
        dekVersion: Number(b.dekVersion),
        grants: Array.isArray(b.grants) ? b.grants : [],
        secrets: Array.isArray(b.secrets) ? b.secrets : [],
        // Un CLI anterior al historial no manda el campo (ver zeus_vault_rotate).
        ...(Array.isArray(b.revisions) ? { revisions: b.revisions } : {}),
      },
      actor,
    );
  }),
);

zeusCliRoutes.get(
  '/vault/envs/:projectKey/:env/history',
  cli((c, actor) => envHistory(param(c, 'projectKey'), param(c, 'env'), c.req.query('keyId') ?? '', c.req.query('name') || null, actor)),
);

zeusCliRoutes.post(
  '/vault/keys/rotate',
  cli(async (c, actor) => {
    const b = await body(c);
    return rotateDeviceKey(
      { oldKeyId: String(b.oldKeyId ?? ''), newKeyId: String(b.newKeyId ?? ''), grants: Array.isArray(b.grants) ? b.grants : [], compromised: !!b.compromised },
      actor,
    );
  }),
);

// Resumen para `zeus doctor` y el inicio de sesión de Claude: pendientes, sin cuerpos largos.
zeusCliRoutes.get(
  '/inbox',
  cli(async (_c, actor) => {
    const inbox = await getInbox(actor, { unreadOnly: true, limit: 20 });
    const brief = (m: (typeof inbox.open)[number]) => ({ id: m.id, kind: m.kind, from: m.fromName, to: m.toName, subject: m.subject, status: m.status, at: m.createdAt });
    return {
      unread: inbox.unread,
      open: inbox.open.map(brief),
      waiting: inbox.waiting.map(brief),
      envChanges: inbox.messages.filter((m) => m.kind === 'env_change').map(brief),
      toResolve: inbox.toResolve.length,
    };
  }),
);
