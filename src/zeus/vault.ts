// Bóveda de llaves: el lado del SERVIDOR.
//
// zeus nunca ve un secreto en claro ni la llave que los cifra. Guarda:
//   · la llave pública de cada equipo de cada dev,
//   · la llave del entorno (DEK) envuelta para cada llave pública con acceso,
//   · cada secreto cifrado con esa DEK.
// Cifrar y descifrar ocurre en la PC del dev (cli/). Aquí solo se valida la FORMA de los sobres, se
// decide quién puede leer o escribir cada fila y se deja rastro de todo.
//
// Lo que este diseño NO puede hacer: impedir que alguien con acceso copie los valores, ni "des-ver"
// un secreto. Por eso quitar un acceso marca el entorno para rotación.
import { createHash } from 'node:crypto';
import { db } from '../db/supabase.js';
import type { ZeusVaultEnvSummary, ZeusVaultKey, ZeusVaultOverview } from '../types/zeus.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { isUuid, logActivity, requireAdmin, resolveProject, actorActivity, type ZeusActor } from './core.js';

export const VAULT_STALE_CODE = 'ZEUS_VAULT_STALE';
export const VAULT_NO_ACCESS_CODE = 'ZEUS_VAULT_NO_ACCESS';

// Formas de los sobres (docs/zeus-contracts.md §5). El servidor no puede abrirlos; sí puede negarse
// a guardar algo que no lo parezca (p. ej. un valor en claro pegado por error).
const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const WRAPPED_DEK_RE = /^zv1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{64}$/;
const SECRET_RE = /^zs1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ENV_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** 64 KiB de valor + nonce + tag, en base64url. */
const MAX_CIPHERTEXT_CHARS = 90_000;
const MAX_SECRETS_PER_ENV = 500;

export const isWrappedDek = (s: unknown): s is string => typeof s === 'string' && WRAPPED_DEK_RE.test(s);
export const isSecretEnvelope = (s: unknown): s is string => typeof s === 'string' && s.length <= MAX_CIPHERTEXT_CHARS && SECRET_RE.test(s);
export const isSecretName = (s: unknown): s is string => typeof s === 'string' && SECRET_NAME_RE.test(s);

/** Huella de una llave pública: lo que se lee en voz alta antes de dar acceso. */
export function fingerprint(publicKey: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex').slice(0, 16);
  return hex.match(/.{4}/g)!.join('-');
}

function audit(actor: ZeusActor, action: string, envId: string | null, keyId: string | null, detail: Record<string, unknown> = {}): void {
  void db()
    .from('zeus_vault_audit')
    .insert({ dev_id: actor.devId, key_id: keyId, env_id: envId, action, detail })
    .then(() => undefined, () => undefined);
}

// ---------------------------------------------------------------- llaves de equipo

interface KeyRow {
  id: string;
  dev_id: string;
  name: string;
  public_key: string;
  fingerprint: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}
const KEY_COLS = 'id, dev_id, name, public_key, fingerprint, last_used_at, revoked_at, created_at';

async function devNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  const { data, error } = await db().from('dev').select('id, name').in('id', uniq);
  if (error) throw error;
  return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name]));
}

function toKey(k: KeyRow, names: Map<string, string>): ZeusVaultKey {
  return {
    id: k.id,
    devId: k.dev_id,
    devName: names.get(k.dev_id) ?? 'alguien',
    name: k.name,
    publicKey: k.public_key,
    fingerprint: k.fingerprint,
    lastUsedAt: k.last_used_at,
    revokedAt: k.revoked_at,
    createdAt: k.created_at,
  };
}

const MAX_KEYS_PER_DEV = 8;

export async function registerKey(input: { name: string; publicKey: string }, actor: ZeusActor): Promise<ZeusVaultKey> {
  const name = input.name?.trim().slice(0, 60);
  if (!name) throw new ValidationError('ponle nombre al equipo (p. ej. "laptop-ana")');
  if (!PUBLIC_KEY_RE.test(input.publicKey ?? '') || Buffer.from(input.publicKey, 'base64url').length !== 32) {
    throw new ValidationError('llave pública inválida (se esperan 32 bytes X25519 en base64url)');
  }
  const supabase = db();
  const { data: mine, error: mineErr } = await supabase.from('zeus_vault_key').select('id').eq('dev_id', actor.devId).is('revoked_at', null);
  if (mineErr) throw mineErr;
  if ((mine ?? []).length >= MAX_KEYS_PER_DEV) throw new AppError('ZEUS_VAULT_KEY_LIMIT', 'ya tienes demasiados equipos registrados: revoca alguno', 409);
  const { data, error } = await supabase
    .from('zeus_vault_key')
    .insert({ dev_id: actor.devId, name, public_key: input.publicKey, fingerprint: fingerprint(input.publicKey) })
    .select(KEY_COLS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505') throw new AppError('ZEUS_VAULT_KEY_EXISTS', 'esa llave pública ya está registrada', 409);
    throw error;
  }
  const row = data as KeyRow;
  audit(actor, 'key.add', null, row.id, { name, fingerprint: row.fingerprint });
  return toKey(row, new Map([[actor.devId, actor.name]]));
}

/** Las llaves propias; con `all` (solo admin) las de todo el equipo, para poder darles acceso. */
export async function listKeys(actor: ZeusActor, all = false): Promise<ZeusVaultKey[]> {
  let q = db().from('zeus_vault_key').select(KEY_COLS).is('revoked_at', null);
  if (all) requireAdmin(actor);
  else q = q.eq('dev_id', actor.devId);
  const { data, error } = await q.order('created_at');
  if (error) throw error;
  const rows = (data ?? []) as KeyRow[];
  const names = await devNames(rows.map((r) => r.dev_id));
  if (!all) return rows.map((k) => toKey(k, names));
  const { data: devs, error: devErr } = await db().from('dev').select('id, email').in('id', [...new Set(rows.map((r) => r.dev_id))]);
  if (devErr) throw devErr;
  const emails = new Map(((devs ?? []) as Array<{ id: string; email: string | null }>).map((d) => [d.id, d.email]));
  return rows.map((k) => ({ ...toKey(k, names), devEmail: emails.get(k.dev_id) ?? null }));
}

/** Una llave vigente que pertenece a quien llama. Es la base de toda operación con secretos. */
async function ownKey(keyId: unknown, actor: ZeusActor): Promise<KeyRow> {
  if (typeof keyId !== 'string' || !isUuid(keyId)) throw new ValidationError('falta keyId (corre `zeus key init` en este equipo)');
  const { data, error } = await db().from('zeus_vault_key').select(KEY_COLS).eq('id', keyId).maybeSingle();
  if (error) throw error;
  const k = data as KeyRow | null;
  if (!k || k.dev_id !== actor.devId) throw new AppError(VAULT_NO_ACCESS_CODE, 'esa llave no es de este usuario', 403);
  if (k.revoked_at) throw new AppError(VAULT_NO_ACCESS_CODE, 'la llave de este equipo fue revocada: corre `zeus key init --force` y pide acceso de nuevo', 403);
  return k;
}

/** Revocar la llave de un equipo: pierde todos sus accesos y esos entornos quedan por rotar. */
export async function revokeKey(keyId: string, actor: ZeusActor): Promise<void> {
  if (!isUuid(keyId)) throw new ValidationError('id de llave inválido');
  const supabase = db();
  const { data, error } = await supabase.from('zeus_vault_key').select(KEY_COLS).eq('id', keyId).maybeSingle();
  if (error) throw error;
  const k = data as KeyRow | null;
  if (!k) throw new NotFoundError('esa llave no existe');
  if (k.dev_id !== actor.devId) requireAdmin(actor);
  if (k.revoked_at) return;
  const { data: grants, error: gErr } = await supabase.from('zeus_vault_grant').delete().eq('key_id', keyId).select('env_id');
  if (gErr) throw gErr;
  const envIds = [...new Set(((grants ?? []) as Array<{ env_id: string }>).map((g) => g.env_id))];
  if (envIds.length) {
    const { error: envErr } = await supabase.from('zeus_vault_env').update({ needs_rotation: true, updated_at: new Date().toISOString() }).in('id', envIds);
    if (envErr) throw envErr;
  }
  const { error: updErr } = await supabase.from('zeus_vault_key').update({ revoked_at: new Date().toISOString() }).eq('id', keyId);
  if (updErr) throw updErr;
  audit(actor, 'key.revoke', null, keyId, { name: k.name, envs: envIds.length });
}

// ---------------------------------------------------------------- entornos

interface EnvRow {
  id: string;
  project_id: string;
  name: string;
  dek_version: number;
  needs_rotation: boolean;
}
const ENV_COLS = 'id, project_id, name, dek_version, needs_rotation';

function checkEnvName(env: unknown): string {
  if (typeof env !== 'string' || !ENV_NAME_RE.test(env)) {
    throw new ValidationError('nombre de entorno inválido (minúsculas, p. ej. development, preview, production)');
  }
  return env;
}

async function loadEnv(projectKey: string, env: string): Promise<{ env: EnvRow; project: { id: string; key: string; name: string } }> {
  const project = await resolveProject(projectKey);
  const { data, error } = await db().from('zeus_vault_env').select(ENV_COLS).eq('project_id', project.id).eq('name', checkEnvName(env)).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError(`el proyecto ${project.key} no tiene el entorno "${env}" en la bóveda (un admin lo crea con \`zeus env init ${project.key} ${env}\`)`);
  return { env: data as EnvRow, project };
}

/** El grant vigente de una llave en un entorno, o el error que explica por qué no puede. */
async function currentGrant(env: EnvRow, key: KeyRow): Promise<{ wrapped_dek: string }> {
  const { data, error } = await db()
    .from('zeus_vault_grant')
    .select('wrapped_dek')
    .eq('env_id', env.id)
    .eq('key_id', key.id)
    .eq('dek_version', env.dek_version)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new AppError(VAULT_NO_ACCESS_CODE, 'este equipo no tiene acceso a ese entorno: pídeselo a un administrador de zeus', 403);
  return data as { wrapped_dek: string };
}

function touchKey(key: KeyRow): void {
  void db().from('zeus_vault_key').update({ last_used_at: new Date().toISOString() }).eq('id', key.id).then(() => undefined, () => undefined);
}

export async function createEnv(input: { projectKey: string; env: string; keyId: string; wrappedDek: string }, actor: ZeusActor): Promise<{ envId: string; dekVersion: number }> {
  requireAdmin(actor);
  const name = checkEnvName(input.env);
  const key = await ownKey(input.keyId, actor);
  if (!isWrappedDek(input.wrappedDek)) throw new ValidationError('wrappedDek con formato inválido');
  const project = await resolveProject(input.projectKey);
  const supabase = db();
  const { data, error } = await supabase.from('zeus_vault_env').insert({ project_id: project.id, name, created_by: actor.devId }).select('id, dek_version').single();
  if (error) {
    if ((error as { code?: string }).code === '23505') throw new AppError('ZEUS_VAULT_ENV_EXISTS', `ese entorno ya existe en ${project.key}`, 409);
    throw error;
  }
  const env = data as { id: string; dek_version: number };
  const { error: gErr } = await supabase
    .from('zeus_vault_grant')
    .insert({ env_id: env.id, key_id: key.id, dek_version: env.dek_version, wrapped_dek: input.wrappedDek, granted_by: actor.devId });
  if (gErr) {
    // Sin su primer grant el entorno quedaría con una llave que nadie tiene: se deshace.
    await supabase.from('zeus_vault_env').delete().eq('id', env.id);
    throw gErr;
  }
  audit(actor, 'env.create', env.id, key.id, { project: project.key, env: name });
  logActivity(actorActivity(actor), 'env.create', `project:${project.id}`, { env: name });
  return { envId: env.id, dekVersion: env.dek_version };
}

export interface PullResult {
  envId: string;
  dekVersion: number;
  wrappedDek: string;
  secrets: Array<{ name: string; ciphertext: string; dekVersion: number; version: number; updatedAt: string }>;
  grants: Array<{ keyId: string; devName: string; keyName: string; fingerprint: string; publicKey: string }>;
}

export async function pullEnv(projectKey: string, envName: string, keyId: string, actor: ZeusActor): Promise<PullResult> {
  const { env, project } = await loadEnv(projectKey, envName);
  const key = await ownKey(keyId, actor);
  const grant = await currentGrant(env, key);
  const supabase = db();
  const [secrets, grants] = await Promise.all([
    supabase.from('zeus_vault_secret').select('name, ciphertext, dek_version, version, updated_at').eq('env_id', env.id).order('name'),
    supabase.from('zeus_vault_grant').select('key_id, key:key_id(dev_id, name, fingerprint, public_key)').eq('env_id', env.id).eq('dek_version', env.dek_version),
  ]);
  if (secrets.error) throw secrets.error;
  if (grants.error) throw grants.error;
  type G = { key_id: string; key: { dev_id: string; name: string; fingerprint: string; public_key: string } | null };
  const grantRows = (grants.data ?? []) as unknown as G[];
  const names = await devNames(grantRows.map((g) => g.key?.dev_id ?? null));
  touchKey(key);
  audit(actor, 'pull', env.id, key.id, { project: project.key, env: env.name });
  logActivity(actorActivity(actor), 'env.pull', `project:${project.id}`, { env: env.name });
  return {
    envId: env.id,
    dekVersion: env.dek_version,
    wrappedDek: grant.wrapped_dek,
    secrets: ((secrets.data ?? []) as Array<{ name: string; ciphertext: string; dek_version: number; version: number; updated_at: string }>).map((s) => ({
      name: s.name,
      ciphertext: s.ciphertext,
      dekVersion: s.dek_version,
      version: s.version,
      updatedAt: s.updated_at,
    })),
    // Las públicas viajan para que quien rota pueda re-envolver la DEK a cada equipo con acceso.
    grants: grantRows.flatMap((g) =>
      g.key ? [{ keyId: g.key_id, devName: names.get(g.key.dev_id) ?? 'alguien', keyName: g.key.name, fingerprint: g.key.fingerprint, publicKey: g.key.public_key }] : [],
    ),
  };
}

export interface PushInput {
  keyId: string;
  dekVersion: number;
  set?: Array<{ name: string; ciphertext: string }>;
  delete?: string[];
}

export async function pushSecrets(projectKey: string, envName: string, input: PushInput, actor: ZeusActor): Promise<{ ok: true; written: number; deleted: number }> {
  const { env, project } = await loadEnv(projectKey, envName);
  const key = await ownKey(input.keyId, actor);
  await currentGrant(env, key);
  if (input.dekVersion !== env.dek_version) {
    throw new AppError(VAULT_STALE_CODE, 'la llave del entorno se rotó desde tu último pull: baja de nuevo antes de subir', 409);
  }
  const set = input.set ?? [];
  const del = input.delete ?? [];
  if (!set.length && !del.length) return { ok: true, written: 0, deleted: 0 };
  for (const s of set) {
    if (!isSecretName(s?.name)) throw new ValidationError(`nombre de variable inválido: "${String(s?.name).slice(0, 40)}"`);
    if (!isSecretEnvelope(s.ciphertext)) {
      // Lo más probable: alguien mandó el valor en claro. Se rechaza sin repetirlo en el error.
      throw new ValidationError(`el valor de ${s.name} no viene cifrado (se espera un sobre zs1.…): usa el CLI de zeus`);
    }
  }
  if (new Set(set.map((s) => s.name)).size !== set.length) throw new ValidationError('hay nombres repetidos en el envío');
  for (const n of del) if (!isSecretName(n)) throw new ValidationError('nombre de variable inválido en delete');

  const supabase = db();
  const { data: existing, error: exErr } = await supabase.from('zeus_vault_secret').select('name, version').eq('env_id', env.id);
  if (exErr) throw exErr;
  const versions = new Map(((existing ?? []) as Array<{ name: string; version: number }>).map((s) => [s.name, s.version]));
  const added = set.filter((s) => !versions.has(s.name)).length;
  if (versions.size + added > MAX_SECRETS_PER_ENV) throw new ValidationError(`un entorno no puede pasar de ${MAX_SECRETS_PER_ENV} variables`);

  const now = new Date().toISOString();
  if (set.length) {
    const { error } = await supabase.from('zeus_vault_secret').upsert(
      set.map((s) => ({
        env_id: env.id,
        name: s.name,
        ciphertext: s.ciphertext,
        dek_version: env.dek_version,
        version: (versions.get(s.name) ?? 0) + 1,
        updated_by: actor.devId,
        updated_at: now,
      })),
      { onConflict: 'env_id,name' },
    );
    if (error) throw error;
  }
  let deleted = 0;
  if (del.length) {
    const { data, error } = await supabase.from('zeus_vault_secret').delete().eq('env_id', env.id).in('name', del).select('name');
    if (error) throw error;
    deleted = (data ?? []).length;
  }
  touchKey(key);
  // En la auditoría quedan los NOMBRES tocados, nunca los valores (que el servidor ni tiene).
  audit(actor, 'push', env.id, key.id, { project: project.key, env: env.name, set: set.map((s) => s.name), deleted: del });
  logActivity(actorActivity(actor), 'env.push', `project:${project.id}`, { env: env.name, written: set.length, deleted });
  return { ok: true, written: set.length, deleted };
}

export async function grantAccess(
  projectKey: string,
  envName: string,
  input: { keyId: string; grants: Array<{ keyId: string; wrappedDek: string }> },
  actor: ZeusActor,
): Promise<{ ok: true; granted: number }> {
  requireAdmin(actor);
  const { env, project } = await loadEnv(projectKey, envName);
  // Quien da acceso tiene que tenerlo: es la única forma de haber envuelto la DEK de verdad.
  await currentGrant(env, await ownKey(input.keyId, actor));
  const grants = input.grants ?? [];
  if (!grants.length) throw new ValidationError('no hay a quién dar acceso');
  for (const g of grants) {
    if (!isUuid(g?.keyId ?? '')) throw new ValidationError('keyId inválido en grants');
    if (!isWrappedDek(g.wrappedDek)) throw new ValidationError('wrappedDek con formato inválido en grants');
  }
  const supabase = db();
  const { data: keys, error: kErr } = await supabase.from('zeus_vault_key').select('id, dev_id, name').in('id', grants.map((g) => g.keyId)).is('revoked_at', null);
  if (kErr) throw kErr;
  const valid = new Map(((keys ?? []) as Array<{ id: string; dev_id: string; name: string }>).map((k) => [k.id, k]));
  const missing = grants.filter((g) => !valid.has(g.keyId));
  if (missing.length) throw new ValidationError('alguna llave destino no existe o está revocada');
  const { error } = await supabase.from('zeus_vault_grant').upsert(
    grants.map((g) => ({ env_id: env.id, key_id: g.keyId, dek_version: env.dek_version, wrapped_dek: g.wrappedDek, granted_by: actor.devId })),
    { onConflict: 'env_id,key_id,dek_version' },
  );
  if (error) throw error;
  for (const g of grants) audit(actor, 'grant', env.id, g.keyId, { project: project.key, env: env.name, to: valid.get(g.keyId)!.name });
  logActivity(actorActivity(actor), 'env.grant', `project:${project.id}`, { env: env.name, keys: grants.length });
  return { ok: true, granted: grants.length };
}

export async function revokeAccess(projectKey: string, envName: string, targetKeyId: string, actor: ZeusActor): Promise<{ ok: true }> {
  requireAdmin(actor);
  if (!isUuid(targetKeyId)) throw new ValidationError('keyId inválido');
  const { env, project } = await loadEnv(projectKey, envName);
  const supabase = db();
  const { data: left, error: leftErr } = await supabase.from('zeus_vault_grant').select('key_id').eq('env_id', env.id).eq('dek_version', env.dek_version);
  if (leftErr) throw leftErr;
  const holders = ((left ?? []) as Array<{ key_id: string }>).map((g) => g.key_id);
  if (!holders.includes(targetKeyId)) throw new NotFoundError('esa llave no tiene acceso a este entorno');
  // Quitar el último acceso dejaría los secretos cifrados con una llave que ya nadie puede abrir.
  if (holders.length === 1) throw new AppError('ZEUS_VAULT_LAST_GRANT', 'es el único equipo con acceso: dale acceso a otro antes de quitarlo', 409);
  const { error } = await supabase.from('zeus_vault_grant').delete().eq('env_id', env.id).eq('key_id', targetKeyId);
  if (error) throw error;
  const { error: envErr } = await supabase.from('zeus_vault_env').update({ needs_rotation: true, updated_at: new Date().toISOString() }).eq('id', env.id);
  if (envErr) throw envErr;
  audit(actor, 'revoke', env.id, targetKeyId, { project: project.key, env: env.name });
  return { ok: true };
}

export interface RotateInput {
  keyId: string;
  /** La versión NUEVA (vigente + 1). */
  dekVersion: number;
  grants: Array<{ keyId: string; wrappedDek: string }>;
  secrets: Array<{ name: string; ciphertext: string }>;
}

export async function rotateEnv(projectKey: string, envName: string, input: RotateInput, actor: ZeusActor): Promise<{ ok: true; dekVersion: number }> {
  requireAdmin(actor);
  const { env, project } = await loadEnv(projectKey, envName);
  const key = await ownKey(input.keyId, actor);
  await currentGrant(env, key);
  if (input.dekVersion !== env.dek_version + 1) {
    throw new AppError(VAULT_STALE_CODE, 'alguien más rotó o cambió este entorno: baja de nuevo y repite la rotación', 409);
  }
  const grants = input.grants ?? [];
  const secrets = input.secrets ?? [];
  if (!grants.some((g) => g.keyId === key.id)) throw new ValidationError('la rotación debe incluir tu propio equipo, o te quedarías sin acceso');
  for (const g of grants) {
    if (!isUuid(g?.keyId ?? '') || !isWrappedDek(g.wrappedDek)) throw new ValidationError('grant inválido en la rotación');
  }
  for (const s of secrets) {
    if (!isSecretName(s?.name) || !isSecretEnvelope(s.ciphertext)) throw new ValidationError('secreto inválido en la rotación');
  }
  const { data, error } = await db().rpc('zeus_vault_rotate', {
    p_env_id: env.id,
    p_from_version: env.dek_version,
    p_grants: grants,
    p_secrets: secrets,
    p_dev_id: actor.devId,
  });
  if (error) {
    const msg = error.message ?? '';
    if (msg.includes('ZEUS_VAULT_STALE')) throw new AppError(VAULT_STALE_CODE, 'el entorno cambió durante la rotación: baja de nuevo y repítela', 409);
    if (msg.includes('ZEUS_VAULT_INCOMPLETE')) {
      throw new AppError('ZEUS_VAULT_INCOMPLETE', 'la rotación debe traer TODAS las variables re-cifradas: baja de nuevo (alguien agregó o quitó una)', 409);
    }
    throw error;
  }
  audit(actor, 'rotate', env.id, key.id, { project: project.key, env: env.name, dekVersion: Number(data), keys: grants.length, secrets: secrets.length });
  logActivity(actorActivity(actor), 'env.rotate', `project:${project.id}`, { env: env.name });
  return { ok: true, dekVersion: Number(data) };
}

// ---------------------------------------------------------------- vistas

/** Proyectos y entornos, y si ALGUNA llave de quien llama tiene acceso. Para `zeus env ls`. */
export async function listProjectsForCli(actor: ZeusActor): Promise<Array<{ key: string; name: string; envs: Array<{ name: string; dekVersion: number; hasGrant: boolean; needsRotation: boolean }> }>> {
  const supabase = db();
  const [projects, envs, keys] = await Promise.all([
    supabase.from('project').select('id, key, name').eq('active', true).order('name'),
    supabase.from('zeus_vault_env').select(ENV_COLS).order('name'),
    supabase.from('zeus_vault_key').select('id').eq('dev_id', actor.devId).is('revoked_at', null),
  ]);
  for (const r of [projects, envs, keys]) if (r.error) throw r.error;
  const myKeys = ((keys.data ?? []) as Array<{ id: string }>).map((k) => k.id);
  const granted = new Set<string>();
  if (myKeys.length) {
    const { data, error } = await supabase.from('zeus_vault_grant').select('env_id, dek_version').in('key_id', myKeys);
    if (error) throw error;
    for (const g of (data ?? []) as Array<{ env_id: string; dek_version: number }>) granted.add(`${g.env_id}:${g.dek_version}`);
  }
  const envRows = (envs.data ?? []) as EnvRow[];
  return ((projects.data ?? []) as Array<{ id: string; key: string; name: string }>).map((p) => ({
    key: p.key,
    name: p.name,
    envs: envRows
      .filter((e) => e.project_id === p.id)
      .map((e) => ({ name: e.name, dekVersion: e.dek_version, hasGrant: granted.has(`${e.id}:${e.dek_version}`), needsRotation: e.needs_rotation })),
  }));
}

/** Lo que el dashboard muestra: nombres, quién tiene acceso y la auditoría. Jamás valores. */
export async function vaultOverview(): Promise<ZeusVaultOverview> {
  const supabase = db();
  const [envs, secrets, grants, keys, auditRes, projects] = await Promise.all([
    supabase.from('zeus_vault_env').select(ENV_COLS).order('name'),
    supabase.from('zeus_vault_secret').select('env_id, name, dek_version, version, updated_at, updated_by').order('name'),
    supabase.from('zeus_vault_grant').select('env_id, key_id, dek_version, created_at'),
    supabase.from('zeus_vault_key').select(KEY_COLS).order('created_at'),
    supabase.from('zeus_vault_audit').select('id, at, dev_id, env_id, action, detail').order('at', { ascending: false }).limit(60),
    supabase.from('project').select('id, key, name'),
  ]);
  for (const r of [envs, secrets, grants, keys, auditRes, projects]) if (r.error) throw r.error;
  const keyRows = (keys.data ?? []) as KeyRow[];
  type S = { env_id: string; name: string; dek_version: number; version: number; updated_at: string; updated_by: string | null };
  type G = { env_id: string; key_id: string; dek_version: number; created_at: string };
  type A = { id: number; at: string; dev_id: string | null; env_id: string | null; action: string; detail: Record<string, unknown> | null };
  const secretRows = (secrets.data ?? []) as S[];
  const grantRows = (grants.data ?? []) as G[];
  const auditRows = (auditRes.data ?? []) as A[];
  const names = await devNames([...keyRows.map((k) => k.dev_id), ...secretRows.map((s) => s.updated_by), ...auditRows.map((a) => a.dev_id)]);
  const keyById = new Map(keyRows.map((k) => [k.id, k]));
  const projectById = new Map(((projects.data ?? []) as Array<{ id: string; key: string; name: string }>).map((p) => [p.id, p]));
  const envRows = (envs.data ?? []) as EnvRow[];
  const envLabel = new Map(envRows.map((e) => [e.id, `${projectById.get(e.project_id)?.key ?? '?'} · ${e.name}`]));

  const out: ZeusVaultEnvSummary[] = envRows.flatMap((e) => {
    const p = projectById.get(e.project_id);
    if (!p) return [];
    return [{
      id: e.id,
      projectId: p.id,
      projectKey: p.key,
      projectName: p.name,
      name: e.name,
      dekVersion: e.dek_version,
      secrets: secretRows
        .filter((s) => s.env_id === e.id)
        .map((s) => ({ name: s.name, version: s.version, updatedAt: s.updated_at, updatedByName: s.updated_by ? (names.get(s.updated_by) ?? null) : null, stale: s.dek_version !== e.dek_version })),
      grants: grantRows
        .filter((g) => g.env_id === e.id && g.dek_version === e.dek_version)
        .flatMap((g) => {
          const k = keyById.get(g.key_id);
          return k ? [{ keyId: k.id, devId: k.dev_id, devName: names.get(k.dev_id) ?? 'alguien', keyName: k.name, fingerprint: k.fingerprint, grantedAt: g.created_at }] : [];
        }),
      needsRotation: e.needs_rotation,
    }];
  });
  out.sort((a, b) => a.projectName.localeCompare(b.projectName) || a.name.localeCompare(b.name));
  return {
    envs: out,
    keys: keyRows.map((k) => toKey(k, names)),
    audit: auditRows.map((a) => ({
      id: Number(a.id),
      at: a.at,
      devName: a.dev_id ? (names.get(a.dev_id) ?? null) : null,
      action: a.action,
      envLabel: a.env_id ? (envLabel.get(a.env_id) ?? null) : null,
      detail: a.detail ?? {},
    })),
  };
}

/** Para el agente (zeus_env_status): qué variables existen y si quien pregunta puede bajarlas. */
export async function envStatus(projectKey: string, actor: ZeusActor): Promise<{
  project: string;
  envs: Array<{ name: string; variables: string[]; youHaveAccess: boolean; needsRotation: boolean; pull: string }>;
  note: string;
}> {
  const project = await resolveProject(projectKey);
  const supabase = db();
  const { data: envs, error } = await supabase.from('zeus_vault_env').select(ENV_COLS).eq('project_id', project.id).order('name');
  if (error) throw error;
  const envRows = (envs ?? []) as EnvRow[];
  const mine = (await listProjectsForCli(actor)).find((p) => p.key === project.key);
  const { data: secrets, error: sErr } = envRows.length
    ? await supabase.from('zeus_vault_secret').select('env_id, name').in('env_id', envRows.map((e) => e.id)).order('name')
    : { data: [], error: null };
  if (sErr) throw sErr;
  return {
    project: project.key,
    envs: envRows.map((e) => ({
      name: e.name,
      variables: ((secrets ?? []) as Array<{ env_id: string; name: string }>).filter((s) => s.env_id === e.id).map((s) => s.name),
      youHaveAccess: !!mine?.envs.find((x) => x.name === e.name)?.hasGrant,
      needsRotation: e.needs_rotation,
      pull: `zeus env pull ${project.key} ${e.name}`,
    })),
    note:
      'zeus no puede leer los valores: se descifran solo en la PC del dev con el CLI. No pidas ni pegues valores de secretos en el chat; ' +
      'si falta acceso, abre una solicitud con zeus_request.',
  };
}
