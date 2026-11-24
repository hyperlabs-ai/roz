// Conectar una PC aprobando en el navegador (`zeus setup`), al estilo "device authorization" de
// RFC 8628. Tabla: roz.zeus_device_auth (migración 0044).
//
//   CLI  POST /v1/zeus/device/start  → device_code (secreto, solo para el CLI) + user_code (ABCD-2345)
//                                      + URL de aprobación <roz>/conectar?code=…
//   Web  GET  /api/dashboard/zeus/device/:userCode           → qué equipo pide entrar
//        POST /api/dashboard/zeus/device/:userCode/approve   → con la sesión de la persona
//        POST /api/dashboard/zeus/device/:userCode/deny
//   CLI  POST /v1/zeus/device/poll   → pending | slow_down | denied | expired | approved (+ token, UNA vez)
//
// Seguridad (lo que este módulo garantiza):
//   · device_code: 32 bytes aleatorios; en la base vive solo su sha256 (como zeus_token). Quien lea un
//     volcado no puede cobrar una aprobación.
//   · user_code: 8 caracteres de un alfabeto sin vocales ni ambiguos (nada de 0/O ni 1/I/L): se
//     dicta y se compara sin errores, y no forma palabras. 27^8 ≈ 2.8·10^11 combinaciones, y solo
//     sirve mientras está pendiente.
//   · Expira a los 10 minutos (expires_at); una expirada no se aprueba ni se cobra.
//   · Un solo uso: aprobar y cobrar son UPDATE condicionales sobre el estado (pending → approved →
//     delivered). Dos cobros simultáneos: solo uno encuentra 'approved'.
//   · Rate limit en memoria: abrir solicitudes por IP, consultar por IP y por device_code (respetando
//     `interval`; si el CLI va más rápido recibe slow_down), y buscar códigos por persona.
//   · Aprobar exige la sesión del dashboard (la ruta vive dentro de requireDashboardAuth) y la página
//     muestra el código, el nombre del equipo y la IP para que la persona los compare con su terminal:
//     así no aprueba sin querer una solicitud que le mandó otro (phishing de aprobación).
//   · El token no se guarda nunca en claro: se CREA en el momento de la entrega (al cobrar la
//     solicitud aprobada) a nombre de quien aprobó, se devuelve una vez y la fila queda 'delivered'
//     con solo el id del token. Un segundo cobro ya no recibe nada.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { db } from '../db/supabase.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import type { ZeusDeviceRequest, ZeusDeviceStatus } from '../types/zeus.js';
import { actorActivity, actorForDev, logActivity, type ZeusActor } from './core.js';
import { createToken } from './inbox.js';

export const DEVICE_TTL_SEC = 600;
export const DEVICE_INTERVAL_SEC = 5;
/** Alfabeto del user_code: consonantes y dígitos sin ambigüedad (ni vocales, ni 0/1, ni L). */
const USER_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXZ23456789';
const DEVICE_CODE_PREFIX = 'zdc_';
const MAX_ACTIVE_TOKENS = 10;

// ---------------------------------------------------------------- límites en memoria

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

/** Ventana fija por clave. true = se pasó del límite. */
function limited(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 5000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    return false;
  }
  b.count++;
  return b.count > max;
}

/** Para las pruebas. */
export function resetDeviceRateLimits(): void {
  buckets.clear();
}

const tooMany = () => new AppError('RATE_LIMITED', 'demasiados intentos; espera un momento y repite', 429);

// ---------------------------------------------------------------- códigos

export const hashDeviceCode = (code: string): string => createHash('sha256').update(code, 'utf8').digest('hex');

function newDeviceCode(): string {
  return DEVICE_CODE_PREFIX + randomBytes(32).toString('base64url');
}

function newUserCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** "abcd 2345", "ABCD2345" → "ABCD-2345". null si no tiene la forma. */
export function normalizeUserCode(raw: string): string | null {
  const s = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 8 || [...s].some((ch) => !USER_CODE_ALPHABET.includes(ch))) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Texto que manda el CLI: una línea, sin controles, acotado. */
function clean(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

// ---------------------------------------------------------------- filas

interface Row {
  id: string;
  user_code: string;
  client_name: string;
  client_platform: string | null;
  client_version: string | null;
  client_ip: string | null;
  status: 'pending' | 'approved' | 'denied' | 'delivered';
  dev_id: string | null;
  decided_at: string | null;
  last_poll_at: string | null;
  created_at: string;
  expires_at: string;
}
const COLS = 'id, user_code, client_name, client_platform, client_version, client_ip, status, dev_id, decided_at, last_poll_at, created_at, expires_at';

const isExpired = (r: Row, now = Date.now()): boolean => Date.parse(r.expires_at) <= now;

function effectiveStatus(r: Row, now = Date.now()): ZeusDeviceStatus {
  if ((r.status === 'pending' || r.status === 'approved') && isExpired(r, now)) return 'expired';
  return r.status;
}

async function toRequest(r: Row): Promise<ZeusDeviceRequest> {
  let decidedBy: string | null = null;
  if (r.dev_id && r.status !== 'pending') {
    const { data } = await db().from('dev').select('name').eq('id', r.dev_id).maybeSingle();
    decidedBy = (data as { name: string } | null)?.name ?? null;
  }
  return {
    userCode: r.user_code,
    clientName: r.client_name,
    clientPlatform: r.client_platform,
    clientVersion: r.client_version,
    clientIp: r.client_ip,
    status: effectiveStatus(r),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedBy,
  };
}

/** El nombre del token que se emite para un equipo. */
export const setupTokenName = (clientName: string): string => `${clientName || 'equipo'} (setup)`.slice(0, 60);

// ---------------------------------------------------------------- CLI: abrir y cobrar

export interface DeviceStartInput {
  clientName?: unknown;
  platform?: unknown;
  version?: unknown;
}

export interface DeviceStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export async function startDeviceAuth(input: DeviceStartInput, opts: { ip: string | null; approveBase: string }): Promise<DeviceStartResult> {
  if (limited(`start:${opts.ip ?? '?'}`, 10, 10 * 60_000)) throw tooMany();
  const supabase = db();
  // Limpieza de paso: lo vencido hace más de un día ya no le sirve a nadie.
  void supabase
    .from('zeus_device_auth')
    .delete()
    .lt('expires_at', new Date(Date.now() - 86_400_000).toISOString())
    .then(() => undefined, () => undefined);

  const deviceCode = newDeviceCode();
  const expiresAt = new Date(Date.now() + DEVICE_TTL_SEC * 1000).toISOString();
  let userCode = '';
  for (let attempt = 0; ; attempt++) {
    userCode = newUserCode();
    const { error } = await supabase.from('zeus_device_auth').insert({
      device_code_hash: hashDeviceCode(deviceCode),
      user_code: userCode,
      client_name: clean(input.clientName, 60) || 'equipo',
      client_platform: clean(input.platform, 20) || null,
      client_version: clean(input.version, 20) || null,
      client_ip: opts.ip ? clean(opts.ip, 64) : null,
      expires_at: expiresAt,
    });
    if (!error) break;
    // Choque con otro user_code pendiente (rarísimo): otro intento con un código nuevo.
    if ((error as { code?: string }).code !== '23505' || attempt >= 3) throw error;
  }
  const base = opts.approveBase.replace(/\/+$/, '');
  return {
    deviceCode,
    userCode,
    verificationUri: `${base}/conectar`,
    verificationUriComplete: `${base}/conectar?code=${encodeURIComponent(userCode)}`,
    expiresIn: DEVICE_TTL_SEC,
    interval: DEVICE_INTERVAL_SEC,
  };
}

export type DevicePollResult =
  | { status: 'pending' | 'slow_down'; interval: number }
  | { status: 'denied' | 'expired' | 'delivered' }
  | { status: 'approved'; token: string; dev: { id: string; name: string; email: string | null } };

export async function pollDeviceAuth(deviceCode: string, opts: { ip: string | null }): Promise<DevicePollResult> {
  if (limited(`poll-ip:${opts.ip ?? '?'}`, 120, 60_000)) throw tooMany();
  const code = String(deviceCode ?? '');
  if (!/^zdc_[A-Za-z0-9_-]{43}$/.test(code)) throw new ValidationError('device_code inválido');
  const supabase = db();
  const { data, error } = await supabase.from('zeus_device_auth').select(COLS).eq('device_code_hash', hashDeviceCode(code)).maybeSingle();
  if (error) throw error;
  const row = data as Row | null;
  // Desconocido o ya limpiado: para el CLI es lo mismo que vencido (empieza de nuevo).
  if (!row) return { status: 'expired' };

  const now = Date.now();
  const status = effectiveStatus(row, now);
  if (status === 'expired' || status === 'denied' || status === 'delivered') return { status };

  if (status === 'pending') {
    const last = row.last_poll_at ? Date.parse(row.last_poll_at) : 0;
    await supabase.from('zeus_device_auth').update({ last_poll_at: new Date(now).toISOString() }).eq('id', row.id);
    // Medio segundo de holgura por la latencia de la red.
    if (last && now - last < DEVICE_INTERVAL_SEC * 1000 - 500) return { status: 'slow_down', interval: DEVICE_INTERVAL_SEC + 5 };
    return { status: 'pending', interval: DEVICE_INTERVAL_SEC };
  }

  // approved: se cobra UNA vez. El UPDATE condicional es el candado.
  const { data: claimed, error: claimErr } = await supabase
    .from('zeus_device_auth')
    .update({ status: 'delivered', delivered_at: new Date(now).toISOString() })
    .eq('id', row.id)
    .eq('status', 'approved')
    .select('id, dev_id, client_name');
  if (claimErr) throw claimErr;
  const claim = ((claimed ?? []) as Array<{ id: string; dev_id: string | null; client_name: string }>)[0];
  if (!claim?.dev_id) return { status: 'delivered' };

  try {
    const actor = await actorForDev(claim.dev_id, 'cli');
    const name = setupTokenName(claim.client_name);
    // Repetir `zeus setup` en el mismo equipo reemplaza su token anterior en vez de acumularlos.
    await supabase.from('zeus_token').update({ revoked_at: new Date().toISOString() }).eq('dev_id', actor.devId).eq('name', name).is('revoked_at', null);
    const { token, summary } = await createToken(name, actor);
    await supabase.from('zeus_device_auth').update({ token_id: summary.id }).eq('id', claim.id);
    logActivity(actorActivity(actor), 'device.connect', `dev:${actor.devId}`, { name });
    return { status: 'approved', token, dev: { id: actor.devId, name: actor.name, email: actor.email } };
  } catch (err) {
    // No se pudo emitir: la aprobación sigue cobrable en el siguiente intento.
    await supabase.from('zeus_device_auth').update({ status: 'approved', delivered_at: null }).eq('id', claim.id).eq('status', 'delivered');
    throw err;
  }
}

// ---------------------------------------------------------------- web: ver y decidir

async function findByUserCode(raw: string, actor: ZeusActor): Promise<Row> {
  if (limited(`lookup:${actor.devId}`, 60, 10 * 60_000)) throw tooMany();
  const code = normalizeUserCode(raw);
  if (!code) throw new ValidationError('ese código no tiene la forma correcta (8 caracteres, p. ej. BCDF-2345)');
  const { data, error } = await db()
    .from('zeus_device_auth')
    .select(COLS)
    .eq('user_code', code)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = ((data ?? []) as Row[])[0];
  if (!row) throw new NotFoundError('no hay ninguna solicitud con ese código; revisa que sea el de tu terminal');
  // Una ya decidida solo la ve quien la decidió (no se filtra a quién se le entregó otra PC).
  if (row.status !== 'pending' && row.dev_id && row.dev_id !== actor.devId) {
    throw new NotFoundError('no hay ninguna solicitud pendiente con ese código');
  }
  return row;
}

export async function getDeviceRequest(userCode: string, actor: ZeusActor): Promise<ZeusDeviceRequest> {
  return toRequest(await findByUserCode(userCode, actor));
}

export async function decideDeviceRequest(userCode: string, decision: 'approve' | 'deny', actor: ZeusActor): Promise<ZeusDeviceRequest> {
  const row = await findByUserCode(userCode, actor);
  const status = effectiveStatus(row);
  if (status === 'expired') throw new AppError('ZEUS_DEVICE_EXPIRED', 'esta solicitud ya venció: corre `zeus setup` otra vez', 410);
  if (status !== 'pending') throw new AppError('ZEUS_DEVICE_DECIDED', 'esta solicitud ya se decidió', 409);

  if (decision === 'approve') {
    // El tope de tokens se revisa aquí para avisarlo en la web; el de este equipo se reemplaza al entregar.
    const { data: active, error: tokErr } = await db().from('zeus_token').select('id, name').eq('dev_id', actor.devId).is('revoked_at', null);
    if (tokErr) throw tokErr;
    const others = ((active ?? []) as Array<{ name: string }>).filter((t) => t.name !== setupTokenName(row.client_name));
    if (others.length >= MAX_ACTIVE_TOKENS) {
      throw new AppError('ZEUS_TOKEN_LIMIT', `ya tienes ${MAX_ACTIVE_TOKENS} tokens: revoca alguno en zeus → MCP y vuelve a aprobar`, 409);
    }
  }

  const { data, error } = await db()
    .from('zeus_device_auth')
    .update({ status: decision === 'approve' ? 'approved' : 'denied', dev_id: actor.devId, decided_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .select(COLS);
  if (error) throw error;
  const updated = ((data ?? []) as Row[])[0];
  if (!updated) throw new AppError('ZEUS_DEVICE_DECIDED', 'esta solicitud ya se decidió o venció', 409);
  logActivity(actorActivity(actor), decision === 'approve' ? 'device.approve' : 'device.deny', `dev:${actor.devId}`, { name: row.client_name });
  return toRequest(updated);
}
