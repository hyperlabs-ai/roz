// El MCP de zeus como conector de claude.ai (OAuth 2.1 + PKCE, migración 0046) contra Postgres real
// (PGlite): registrar → aprobar en la web → canjear el código UNA vez por un token zeus_… que
// autentica de verdad; PKCE, redirect exacto, rechazo y reuso del código.
import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createZeusPg, type ZeusPg } from './zeus-pg.js';

const holder = vi.hoisted(() => {
  process.env.ROZ_LOG_LEVEL = 'silent';
  return { pg: null as unknown as { client: unknown } };
});
vi.mock('../src/db/supabase.js', () => ({ db: () => holder.pg.client, dbPublic: () => holder.pg.client }));
vi.mock('../src/notify/push.js', () => ({ pushToDev: vi.fn(), pushBroadcast: vi.fn(), pushToEmail: vi.fn() }));

import { actorForDev, authenticateZeusToken } from '../src/zeus/core.js';
import { resetDeviceRateLimits } from '../src/zeus/device-auth.js';
import {
  OAuthError,
  decideAuthorize,
  describeRedirect,
  exchangeCode,
  getAuthorizeRequest,
  redirectUriProblem,
  registerClient,
} from '../src/zeus/oauth.js';
import { wellKnownRoutes } from '../src/routes/oauth.js';
import { drainBackground } from '../src/utils/background.js';

let pg: ZeusPg;
let ana = '';
const ip = '203.0.113.9';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function flow(redirect = CALLBACK) {
  const client = await registerClient({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }, { ip });
  const { verifier, challenge } = pkce();
  const params = {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
  };
  return { client, verifier, params };
}

const codeFrom = (url: string) => new URL(url).searchParams.get('code')!;

beforeAll(async () => {
  pg = await createZeusPg();
  holder.pg = pg;
  const [row] = await pg.sql<{ id: string }>(`insert into roz.dev (name, email) values ('Ana', 'ana@hyper.test') returning id`);
  ana = row!.id;
});
beforeEach(() => resetDeviceRateLimits());
afterAll(async () => {
  await drainBackground(2000);
});

describe('OAuth del conector', () => {
  it('flujo completo: el token entregado autentica como quien aprobó', async () => {
    const { client, verifier, params } = await flow();
    expect(client.client_id).toMatch(/^zoc_/);
    const actor = await actorForDev(ana, 'web');

    const req = await getAuthorizeRequest(params, actor);
    expect(req).toMatchObject({ clientName: 'Claude', redirectHost: 'claude.ai', verified: true, reconnect: false });

    const { redirectTo } = await decideAuthorize(params, 'approve', actor);
    const back = new URL(redirectTo);
    expect(back.origin + back.pathname).toBe(CALLBACK);
    expect(back.searchParams.get('state')).toBe('st-123');
    const code = codeFrom(redirectTo);

    const out = await exchangeCode(
      { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CALLBACK },
      { ip },
    );
    expect(out.token_type).toBe('Bearer');
    const who = await authenticateZeusToken(out.access_token, 'mcp');
    expect(who?.devId).toBe(ana);

    // El código no vive en claro.
    const rows = await pg.sql<{ code_hash: string }>(`select code_hash from roz.zeus_oauth_code`);
    expect(rows.some((r) => r.code_hash === code)).toBe(false);

    // Reusar el código falla y revoca lo entregado (señal de robo).
    await expect(exchangeCode({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id }, { ip })).rejects.toMatchObject({
      error: 'invalid_grant',
    });
    expect(await authenticateZeusToken(out.access_token, 'mcp')).toBeNull();
  });

  it('PKCE: un verifier distinto no canjea', async () => {
    const { client, params } = await flow();
    const { redirectTo } = await decideAuthorize(params, 'approve', await actorForDev(ana, 'web'));
    await expect(
      exchangeCode({ grant_type: 'authorization_code', code: codeFrom(redirectTo), code_verifier: pkce().verifier, client_id: client.client_id }, { ip }),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it('reconectar el mismo conector reemplaza su token anterior', async () => {
    const actor = await actorForDev(ana, 'web');
    const a = await flow();
    const first = await exchangeCode(
      { grant_type: 'authorization_code', code: codeFrom((await decideAuthorize(a.params, 'approve', actor)).redirectTo), code_verifier: a.verifier, client_id: a.client.client_id },
      { ip },
    );
    const b = await flow();
    expect((await getAuthorizeRequest(b.params, actor)).reconnect).toBe(true);
    const second = await exchangeCode(
      { grant_type: 'authorization_code', code: codeFrom((await decideAuthorize(b.params, 'approve', actor)).redirectTo), code_verifier: b.verifier, client_id: b.client.client_id },
      { ip },
    );
    expect(await authenticateZeusToken(first.access_token, 'mcp')).toBeNull();
    expect((await authenticateZeusToken(second.access_token, 'mcp'))?.devId).toBe(ana);
  });

  it('rechazar vuelve con access_denied y sin código', async () => {
    const { params } = await flow();
    const { redirectTo } = await decideAuthorize(params, 'deny', await actorForDev(ana, 'web'));
    const u = new URL(redirectTo);
    expect(u.searchParams.get('error')).toBe('access_denied');
    expect(u.searchParams.get('code')).toBeNull();
    expect(u.searchParams.get('state')).toBe('st-123');
  });

  it('nunca redirige a una URI no registrada, ni sin PKCE', async () => {
    const actor = await actorForDev(ana, 'web');
    const { params } = await flow();
    await expect(decideAuthorize({ ...params, redirect_uri: 'https://evil.example/cb' }, 'approve', actor)).rejects.toThrow(/regreso/);
    await expect(decideAuthorize({ ...params, code_challenge_method: 'plain' }, 'approve', actor)).rejects.toThrow(/PKCE/);
    await expect(getAuthorizeRequest({ ...params, client_id: 'zoc_' + 'x'.repeat(24) }, actor)).rejects.toThrow(/registrado/);
  });

  it('registro: valida las redirect_uris', async () => {
    expect(redirectUriProblem('javascript:alert(1)')).toMatch(/esquema/);
    expect(redirectUriProblem('http://evil.example/cb')).toMatch(/localhost/);
    expect(redirectUriProblem('http://127.0.0.1:33418/callback')).toBeNull();
    expect(redirectUriProblem('cursor://anysphere.cursor-mcp/oauth/callback')).toBeNull();
    expect(describeRedirect('https://evil.example/cb').verified).toBe(false);
    await expect(registerClient({ redirect_uris: ['data:text/html,hi'] }, { ip })).rejects.toMatchObject({ error: 'invalid_redirect_uri' });
    await expect(registerClient({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'client_secret_basic' }, { ip })).rejects.toMatchObject({
      error: 'invalid_client_metadata',
    });
  });

  it('metadatos: el recurso y el issuer salen del host por el que llegó la petición', async () => {
    const app = new Hono().route('/.well-known', wellKnownRoutes);
    const res = await app.request('https://zeus.example.test/.well-known/oauth-protected-resource/mcp');
    expect(await res.json()).toMatchObject({ resource: 'https://zeus.example.test/mcp', authorization_servers: ['https://zeus.example.test'] });
    const as = (await (await app.request('https://zeus.example.test/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
    expect(as).toMatchObject({ issuer: 'https://zeus.example.test', token_endpoint: 'https://zeus.example.test/oauth/token', code_challenge_methods_supported: ['S256'] });
    expect(String(as.authorization_endpoint)).toMatch(/\/autorizar$/);
  });
});
