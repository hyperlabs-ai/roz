// Rutas PÚBLICAS del OAuth del conector de claude.ai (descubrimiento, registro y canje). La parte con
// sesión (aprobar) vive en /api/dashboard/zeus/oauth/*. Modelo de amenaza en src/zeus/oauth.ts.
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { config } from '../config.js';
import type { RozContext } from '../types/hono.js';
import {
  OAuthError,
  authorizationServerMetadata,
  exchangeCode,
  protectedResourceMetadata,
  registerClient,
  type OAuthOrigins,
} from '../zeus/oauth.js';

/**
 * Orígenes tal como los ve el cliente. El issuer y el recurso salen del host por el que llegó la
 * petición (zeus directo o el rewrite de roz): el cliente exige que coincidan con la URL que usó.
 */
export function oauthOrigins(c: Context): OAuthOrigins {
  const u = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || u.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host') || u.host;
  const api = host ? `${proto}://${host}` : config.zeus.publicUrl;
  return { api, web: (config.dashboard.url || api).replace(/\/+$/, '') };
}

const clientIp = (c: Context): string | null => c.req.header('x-forwarded-for')?.split(',').pop()?.trim() || c.req.header('x-real-ip')?.trim() || null;

/** Los clientes de navegador (p. ej. el inspector de MCP) también descubren y canjean. */
const openCors = cors({ origin: '*', allowHeaders: ['authorization', 'content-type', 'mcp-protocol-version'], allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 600 });

function oauthFail(c: Context, err: unknown) {
  c.header('Cache-Control', 'no-store');
  if (err instanceof OAuthError) return c.json({ error: err.error, error_description: err.description }, err.status as 400);
  c.get('logger')?.error({ err }, 'oauth error');
  return c.json({ error: 'server_error', error_description: 'error interno' }, 500);
}

// ---------------------------------------------------------------- /.well-known

export const wellKnownRoutes = new Hono<RozContext>();
wellKnownRoutes.use('*', openCors);
const resource = (c: Context) => c.json(protectedResourceMetadata(oauthOrigins(c)));
const server = (c: Context) => c.json(authorizationServerMetadata(oauthOrigins(c)));
// El cliente prueba la ruta con el path del recurso insertado (RFC 9728 §3.1) y sin él.
wellKnownRoutes.get('/oauth-protected-resource', resource);
wellKnownRoutes.get('/oauth-protected-resource/mcp', resource);
wellKnownRoutes.get('/oauth-authorization-server', server);
wellKnownRoutes.get('/oauth-authorization-server/mcp', server);
wellKnownRoutes.get('/openid-configuration', server);

// ---------------------------------------------------------------- /oauth

export const oauthRoutes = new Hono<RozContext>();
oauthRoutes.use('*', openCors);

oauthRoutes.post('/register', async (c) => {
  try {
    const out = await registerClient(await c.req.json().catch(() => ({})), { ip: clientIp(c) });
    c.header('Cache-Control', 'no-store');
    return c.json(out, 201);
  } catch (err) {
    return oauthFail(c, err);
  }
});

oauthRoutes.post('/token', async (c) => {
  try {
    const type = c.req.header('content-type') ?? '';
    let form: Record<string, string> = {};
    if (type.includes('application/json')) {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      form = Object.fromEntries(Object.entries(b ?? {}).map(([k, v]) => [k, String(v ?? '')]));
    } else {
      const b = await c.req.parseBody().catch(() => ({}));
      form = Object.fromEntries(Object.entries(b).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    }
    // client_secret_basic no aplica (clientes públicos), pero algunos mandan el client_id en Basic.
    const basic = c.req.header('authorization');
    if (!form.client_id && basic?.startsWith('Basic ')) {
      const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8');
      form.client_id = decodeURIComponent(decoded.split(':')[0] ?? '');
    }
    const out = await exchangeCode(form, { ip: clientIp(c) });
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(out);
  } catch (err) {
    return oauthFail(c, err);
  }
});
