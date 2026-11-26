// El MCP de zeus como conector de claude.ai: servidor de autorización OAuth 2.1 mínimo, el que pide
// la spec de MCP (2025-06-18). Tablas: roz.zeus_oauth_client y roz.zeus_oauth_code (migración 0046).
//
//   Cliente  POST /mcp sin token                      → 401 + WWW-Authenticate (resource_metadata)
//            GET  /.well-known/oauth-protected-resource[/mcp]   → quién autoriza este recurso
//            GET  /.well-known/oauth-authorization-server       → endpoints
//            POST /oauth/register   (RFC 7591)        → client_id público
//   Persona  <roz>/autorizar?client_id&redirect_uri&code_challenge&state…  (página del SPA, con sesión)
//            GET  /api/dashboard/zeus/oauth/authorize        → qué conector pide entrar
//            POST /api/dashboard/zeus/oauth/authorize/approve|deny → a dónde volver (con code o error)
//   Cliente  POST /oauth/token      grant_type=authorization_code + code_verifier → zeus_… (Bearer)
//
// Seguridad (lo que este módulo garantiza):
//   · Clientes públicos sin secreto: la protección es PKCE S256 obligatorio + redirect_uri EXACTO entre
//     los registrados. Un redirect inválido nunca se usa para redirigir: se muestra como error.
//   · Esquemas peligrosos (javascript:, data:, file:…) no se registran: el SPA navega a esa URL.
//   · El código: 32 bytes aleatorios, en la base solo su sha256, vence a los 5 minutos y se cobra UNA
//     vez (UPDATE condicional). Un segundo canje del mismo código revoca el token que ya se entregó
//     (señal de robo, RFC 6749 §4.1.2).
//   · La página de aprobación muestra el nombre del conector y el dominio exacto al que vuelve, y marca
//     si es Claude (claude.ai / claude.com) o no: el registro es abierto, así que cualquiera puede
//     llamarse "Claude"; lo que no puede falsear es el dominio.
//   · El token entregado es un zeus_… normal a nombre de quien aprobó (se ve y se revoca en zeus → MCP).
//     Reconectar el mismo conector reemplaza su token anterior en vez de acumularlos.
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db/supabase.js';
import { AppError, ValidationError } from '../utils/errors.js';
import { actorActivity, actorForDev, logActivity, type ZeusActor } from './core.js';
import { rateLimited } from './device-auth.js';
import { createToken } from './inbox.js';

export const OAUTH_CODE_TTL_SEC = 300;
const MAX_ACTIVE_TOKENS = 10;
const CLIENT_PREFIX = 'zoc_';
const CODE_PREFIX = 'zac_';

/** Dominios a los que vuelve Claude (web, escritorio y móvil usan el callback de claude.ai). */
const CLAUDE_HOSTS = new Set(['claude.ai', 'claude.com']);
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:', 'filesystem:']);

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const tooMany = () => new AppError('RATE_LIMITED', 'demasiados intentos; espera un momento y repite', 429);

/** Error con la forma de OAuth ({ error, error_description }), para register y token. */
export class OAuthError extends Error {
  constructor(
    public error: string,
    public description: string,
    public status = 400,
  ) {
    super(description);
    this.name = 'OAuthError';
  }
}

function clean(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

// ---------------------------------------------------------------- metadatos

export interface OAuthOrigins {
  /** Origen público de zeus tal como lo usó el cliente (issuer, token, register, recurso). */
  api: string;
  /** Origen del front (donde vive /autorizar). Si no hay, el mismo que el API. */
  web: string;
}

export const mcpResourceUrl = (o: OAuthOrigins): string => `${o.api}/mcp`;
export const resourceMetadataUrl = (o: OAuthOrigins): string => `${o.api}/.well-known/oauth-protected-resource/mcp`;

export function protectedResourceMetadata(o: OAuthOrigins) {
  return {
    resource: mcpResourceUrl(o),
    authorization_servers: [o.api],
    bearer_methods_supported: ['header'],
    scopes_supported: ['zeus'],
    resource_name: 'zeus',
  };
}

export function authorizationServerMetadata(o: OAuthOrigins) {
  return {
    issuer: o.api,
    authorization_endpoint: `${o.web}/autorizar`,
    token_endpoint: `${o.api}/oauth/token`,
    registration_endpoint: `${o.api}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['zeus'],
  };
}

// ---------------------------------------------------------------- redirect URIs

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** null si la URI se puede registrar; si no, por qué. */
export function redirectUriProblem(raw: string): string | null {
  if (!raw || raw.length > 500) return 'redirect_uri vacía o demasiado larga';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `redirect_uri inválida: ${raw}`;
  }
  if (u.hash) return 'redirect_uri no puede llevar fragmento (#)';
  if (BLOCKED_SCHEMES.has(u.protocol)) return `esquema no permitido: ${u.protocol}`;
  if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) return 'http solo se permite a localhost; usa https';
  if (u.protocol === 'https:' || u.protocol === 'http:') return null;
  // Esquema propio de una app de escritorio (cursor://, vscode://…): permitido, se marca como no verificado.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) ? null : `esquema no permitido: ${u.protocol}`;
}

/** Para mostrar en la página de aprobación: a dónde vuelve y si es Claude. */
export function describeRedirect(raw: string): { host: string; verified: boolean } {
  const u = new URL(raw);
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    const host = u.hostname.toLowerCase();
    return { host: u.host, verified: u.protocol === 'https:' && CLAUDE_HOSTS.has(host) };
  }
  return { host: `${u.protocol}//${u.host}`, verified: false };
}

// ---------------------------------------------------------------- registro (RFC 7591)

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  client_uri: string | null;
}

export async function registerClient(input: unknown, opts: { ip: string | null }) {
  if (rateLimited(`oauth-register:${opts.ip ?? '?'}`, 20, 60 * 60_000)) throw new OAuthError('slow_down', 'demasiados registros; espera un momento', 429);
  const b = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map((u) => String(u ?? '')) : [];
  if (!uris.length || uris.length > 5) throw new OAuthError('invalid_redirect_uri', 'manda entre 1 y 5 redirect_uris');
  for (const u of uris) {
    const problem = redirectUriProblem(u);
    if (problem) throw new OAuthError('invalid_redirect_uri', problem);
  }
  const auth = b.token_endpoint_auth_method;
  if (auth != null && auth !== 'none') throw new OAuthError('invalid_client_metadata', 'solo clientes públicos (token_endpoint_auth_method=none) con PKCE');
  const grants = Array.isArray(b.grant_types) ? b.grant_types.map(String) : ['authorization_code'];
  if (!grants.includes('authorization_code')) throw new OAuthError('invalid_client_metadata', 'grant_types debe incluir authorization_code');

  const clientUriRaw = clean(b.client_uri, 300);
  const clientUri = clientUriRaw && /^https:\/\//.test(clientUriRaw) ? clientUriRaw : null;
  const row = {
    client_id: CLIENT_PREFIX + randomBytes(18).toString('base64url'),
    client_name: clean(b.client_name, 80) || 'Conector MCP',
    redirect_uris: uris,
    client_uri: clientUri,
    created_ip: opts.ip ? clean(opts.ip, 64) : null,
  };
  const { error } = await db().from('zeus_oauth_client').insert(row);
  if (error) throw error;
  return {
    client_id: row.client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: row.client_name,
    redirect_uris: row.redirect_uris,
    ...(clientUri ? { client_uri: clientUri } : {}),
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

// ---------------------------------------------------------------- autorizar (web, con sesión)

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  resource?: string;
}

export interface ZeusOAuthRequest {
  clientName: string;
  clientUri: string | null;
  /** Dominio exacto al que vuelve el código. */
  redirectHost: string;
  /** Vuelve a Claude (claude.ai / claude.com). */
  verified: boolean;
  /** Ya tienes un token de este mismo conector (reconectar lo reemplaza). */
  reconnect: boolean;
}

const tokenNameFor = (clientName: string): string => `${clientName || 'Conector'} (conector)`.slice(0, 60);

async function loadClient(clientId: string): Promise<ClientRow | null> {
  if (!/^zoc_[A-Za-z0-9_-]{24}$/.test(clientId)) return null;
  const { data, error } = await db().from('zeus_oauth_client').select('client_id, client_name, redirect_uris, client_uri').eq('client_id', clientId).maybeSingle();
  if (error) throw error;
  return (data as ClientRow | null) ?? null;
}

/**
 * Valida la solicitud. Lo que impide saber a dónde volver (cliente o redirect inválidos) se lanza como
 * error para la página: nunca se redirige a una URI que no está registrada.
 */
async function validate(p: AuthorizeParams): Promise<{ client: ClientRow; redirectUri: string; challenge: string }> {
  const client = await loadClient(String(p.client_id ?? ''));
  if (!client) throw new ValidationError('este conector no está registrado en zeus; vuelve a agregarlo desde Claude');
  const redirectUri = String(p.redirect_uri ?? '');
  if (!client.redirect_uris.includes(redirectUri)) throw new ValidationError('la dirección de regreso no coincide con la que registró el conector');
  if (p.response_type !== 'code') throw new ValidationError('response_type debe ser "code"');
  const challenge = String(p.code_challenge ?? '');
  if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    throw new ValidationError('falta PKCE (code_challenge con S256)');
  }
  if (String(p.state ?? '').length > 2000) throw new ValidationError('state demasiado largo');
  return { client, redirectUri, challenge };
}

export async function getAuthorizeRequest(p: AuthorizeParams, actor: ZeusActor): Promise<ZeusOAuthRequest> {
  if (rateLimited(`oauth-lookup:${actor.devId}`, 60, 10 * 60_000)) throw tooMany();
  const { client, redirectUri } = await validate(p);
  const { data, error } = await db()
    .from('zeus_token')
    .select('id')
    .eq('dev_id', actor.devId)
    .eq('name', tokenNameFor(client.client_name))
    .is('revoked_at', null)
    .limit(1);
  if (error) throw error;
  const { host, verified } = describeRedirect(redirectUri);
  return { clientName: client.client_name, clientUri: client.client_uri, redirectHost: host, verified, reconnect: (data ?? []).length > 0 };
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  return u.toString();
}

export async function decideAuthorize(
  p: AuthorizeParams,
  decision: 'approve' | 'deny',
  actor: ZeusActor,
): Promise<{ redirectTo: string }> {
  if (rateLimited(`oauth-decide:${actor.devId}`, 30, 10 * 60_000)) throw tooMany();
  const { client, redirectUri, challenge } = await validate(p);
  const state = p.state ? String(p.state) : undefined;
  if (decision === 'deny') {
    logActivity(actorActivity(actor), 'oauth.deny', `dev:${actor.devId}`, { client: client.client_name });
    return { redirectTo: withParams(redirectUri, { error: 'access_denied', error_description: 'la persona rechazó el acceso', state }) };
  }

  // El tope de tokens se avisa aquí (en la web); el de este mismo conector se reemplaza al canjear.
  const { data: active, error: tokErr } = await db().from('zeus_token').select('name').eq('dev_id', actor.devId).is('revoked_at', null);
  if (tokErr) throw tokErr;
  const others = ((active ?? []) as Array<{ name: string }>).filter((t) => t.name !== tokenNameFor(client.client_name));
  if (others.length >= MAX_ACTIVE_TOKENS) {
    throw new AppError('ZEUS_TOKEN_LIMIT', `ya tienes ${MAX_ACTIVE_TOKENS} tokens: revoca alguno en zeus → MCP y vuelve a intentar`, 409);
  }

  const supabase = db();
  // Limpieza de paso: los códigos vencidos hace más de un día ya no le sirven a nadie.
  void supabase
    .from('zeus_oauth_code')
    .delete()
    .lt('expires_at', new Date(Date.now() - 86_400_000).toISOString())
    .then(() => undefined, () => undefined);

  const code = CODE_PREFIX + randomBytes(32).toString('base64url');
  const { error } = await supabase.from('zeus_oauth_code').insert({
    code_hash: sha256hex(code),
    client_id: client.client_id,
    dev_id: actor.devId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    resource: p.resource ? clean(p.resource, 300) : null,
    expires_at: new Date(Date.now() + OAUTH_CODE_TTL_SEC * 1000).toISOString(),
  });
  if (error) throw error;
  logActivity(actorActivity(actor), 'oauth.approve', `dev:${actor.devId}`, { client: client.client_name });
  return { redirectTo: withParams(redirectUri, { code, state }) };
}

// ---------------------------------------------------------------- canje (token endpoint)

interface CodeRow {
  id: string;
  client_id: string;
  dev_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: string;
  used_at: string | null;
  token_id: string | null;
}

export async function exchangeCode(form: Record<string, string>, opts: { ip: string | null }) {
  if (rateLimited(`oauth-token:${opts.ip ?? '?'}`, 60, 60_000)) throw new OAuthError('slow_down', 'demasiados intentos', 429);
  if (form.grant_type !== 'authorization_code') throw new OAuthError('unsupported_grant_type', 'solo authorization_code');
  const code = form.code ?? '';
  const verifier = form.code_verifier ?? '';
  if (!/^zac_[A-Za-z0-9_-]{43}$/.test(code)) throw new OAuthError('invalid_grant', 'código inválido');
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_request', 'falta code_verifier (PKCE)');

  const supabase = db();
  const { data, error } = await supabase
    .from('zeus_oauth_code')
    .select('id, client_id, dev_id, redirect_uri, code_challenge, expires_at, used_at, token_id')
    .eq('code_hash', sha256hex(code))
    .maybeSingle();
  if (error) throw error;
  const row = data as CodeRow | null;
  if (!row) throw new OAuthError('invalid_grant', 'código desconocido o vencido');

  if (row.used_at) {
    // Segundo canje del mismo código: alguien más lo tiene. Se revoca lo que ya se entregó con él.
    if (row.token_id) await supabase.from('zeus_token').update({ revoked_at: new Date().toISOString() }).eq('id', row.token_id).is('revoked_at', null);
    throw new OAuthError('invalid_grant', 'este código ya se usó');
  }
  if (Date.parse(row.expires_at) <= Date.now()) throw new OAuthError('invalid_grant', 'el código venció; vuelve a conectar');
  if (!form.client_id || form.client_id !== row.client_id) throw new OAuthError('invalid_grant', 'el código no es de este cliente');
  if (form.redirect_uri && form.redirect_uri !== row.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri no coincide');
  const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  if (computed !== row.code_challenge) throw new OAuthError('invalid_grant', 'code_verifier no coincide (PKCE)');

  // Un solo canje: el UPDATE condicional es el candado.
  const { data: claimed, error: claimErr } = await supabase
    .from('zeus_oauth_code')
    .update({ used_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('used_at', null)
    .select('id');
  if (claimErr) throw claimErr;
  if (!(claimed ?? []).length) throw new OAuthError('invalid_grant', 'este código ya se usó');

  const { data: client } = await supabase.from('zeus_oauth_client').select('client_name').eq('client_id', row.client_id).maybeSingle();
  const name = tokenNameFor((client as { client_name: string } | null)?.client_name ?? '');
  let actor: ZeusActor;
  try {
    actor = await actorForDev(row.dev_id, 'mcp');
  } catch {
    throw new OAuthError('invalid_grant', 'la cuenta que aprobó ya no está activa');
  }
  // Reconectar el mismo conector reemplaza su token anterior en vez de acumularlos.
  await supabase.from('zeus_token').update({ revoked_at: new Date().toISOString() }).eq('dev_id', actor.devId).eq('name', name).is('revoked_at', null);
  const { token, summary } = await createToken(name, actor);
  await supabase.from('zeus_oauth_code').update({ token_id: summary.id }).eq('id', row.id);
  void supabase.from('zeus_oauth_client').update({ last_used_at: new Date().toISOString() }).eq('client_id', row.client_id).then(() => undefined, () => undefined);
  logActivity(actorActivity(actor), 'oauth.connect', `dev:${actor.devId}`, { name });
  return { access_token: token, token_type: 'Bearer', scope: 'zeus' };
}
