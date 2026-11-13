// Piezas comunes de los comandos de la bóveda: la llave de este equipo, el proyecto/entorno
// canónico y abrir un entorno (traerlo y descifrarlo en memoria).
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { ZeusApiError } from '../api.js';
import { CliError, UsageError, type Ctx } from '../context.js';
import { VaultCryptoError, decryptSecret, isValidSecretName, secretAad, unwrapDek, wrapAad } from '../crypto.js';
import { loadDeviceKey, type DeviceKeyFile } from '../store.js';
import type { VaultEnv } from '../types.js';

export const DEFAULT_ENV = 'development';
// La misma regla que el servidor: en minúsculas, así el entorno no tiene dos formas de escribirse.
const ENV_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const PROJECT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type RegisteredKey = DeviceKeyFile & { keyId: string };

export interface Target {
  projectKey: string;
  env: string;
  /** El entorno ya aparece en la bóveda. */
  exists: boolean;
}

/** parseArgs con el error en español y código de uso (2). */
export function parse<T extends NonNullable<ParseArgsConfig['options']>>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true });
  } catch (err) {
    throw new UsageError(`opciones inválidas: ${err instanceof Error ? err.message : String(err)} (ve \`zeus help\`)`);
  }
}

export async function requireKey(ctx: Ctx): Promise<RegisteredKey> {
  const key = await loadDeviceKey(ctx.fs, ctx.home);
  if (!key) throw new CliError('este equipo no tiene llave de la bóveda: corre `zeus key init`');
  if (!key.keyId || key.url !== ctx.url) {
    throw new CliError('la llave de este equipo no está registrada en este zeus: corre `zeus key init`');
  }
  return { ...key, keyId: key.keyId };
}

/**
 * Proyecto y entorno como los conoce zeus. Importa porque ambos entran en el AAD del cifrado: si un
 * dev escribe `roz` y otro `ROZ`, lo que cifra uno no lo abriría el otro. Se usa la forma del
 * servidor cuando existe; si no aparece, lo que se escribió (el servidor decide si existe).
 */
export async function resolveTarget(ctx: Ctx, projectArg: string | undefined, envArg: string | undefined): Promise<Target> {
  if (!projectArg) throw new UsageError('falta la clave del proyecto (ve las que hay con `zeus env ls`)');
  const envName = envArg ?? DEFAULT_ENV;
  if (!PROJECT_KEY_RE.test(projectArg)) throw new UsageError(`clave de proyecto inválida: "${projectArg}"`);
  if (!ENV_NAME_RE.test(envName)) {
    throw new UsageError(`nombre de entorno inválido: "${envName}" (minúsculas, números y guiones; p. ej. development, preview, production)`);
  }

  const { projects } = await ctx.api.listProjects();
  const pick = <T>(items: T[], name: (item: T) => string, wanted: string): T | undefined =>
    items.find((i) => name(i) === wanted) ?? only(items.filter((i) => name(i).toLowerCase() === wanted.toLowerCase()));
  const project = pick(projects, (p) => p.key, projectArg);
  const env = project ? pick(project.envs, (e) => e.name, envName) : undefined;
  return { projectKey: project?.key ?? projectArg, env: env?.name ?? envName, exists: Boolean(env) };
}

function only<T>(items: T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

export const label = (t: Target): string => `${t.projectKey}/${t.env}`;

/**
 * Trae el entorno y abre su DEK con la llave de este equipo. Quien llama debe `zeroize(dek)`.
 */
export async function openEnv(ctx: Ctx, key: RegisteredKey, t: Target): Promise<{ remote: VaultEnv; dek: Buffer }> {
  const remote = await ctx.api.getEnv(t.projectKey, t.env, key.keyId);
  if (!remote.wrappedDek) {
    throw new CliError(
      `este equipo no tiene acceso a ${label(t)}: pídele a un admin \`zeus env grant ${t.projectKey} ${t.env} --to ${key.keyId}\` y léele tu huella (${key.fingerprint})`,
    );
  }
  try {
    const dek = unwrapDek(remote.wrappedDek, key.privateKey, key.publicKey, wrapAad(t.projectKey, t.env, remote.dekVersion));
    return { remote, dek };
  } catch (err) {
    if (err instanceof VaultCryptoError) throw new CliError(`${label(t)}: ${err.message}`);
    throw err;
  }
}

export interface Decrypted {
  /** nombre → valor, ordenado por nombre. */
  values: Map<string, string>;
  /** Secretos cifrados con una versión anterior de la DEK: este equipo ya no puede abrirlos. */
  stale: string[];
}

export function decryptAll(t: Target, remote: VaultEnv, dek: Buffer): Decrypted {
  const values = new Map<string, string>();
  const stale: string[] = [];
  const sorted = [...remote.secrets].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const s of sorted) {
    if (!isValidSecretName(s.name)) throw new CliError(`${label(t)}: zeus devolvió un nombre de secreto inválido`);
    if (s.dekVersion !== remote.dekVersion) {
      stale.push(s.name);
      continue;
    }
    try {
      values.set(s.name, decryptSecret(dek, s.ciphertext, secretAad(t.projectKey, t.env, s.name, s.dekVersion)));
    } catch (err) {
      if (err instanceof VaultCryptoError) throw new CliError(`${label(t)} · ${s.name}: ${err.message}`);
      throw err;
    }
  }
  return { values, stale };
}

/** 409 ZEUS_VAULT_STALE → instrucción clara; lo demás pasa igual. */
export function staleToCliError(err: unknown, t: Target): never {
  if (err instanceof ZeusApiError && err.code === 'ZEUS_VAULT_STALE') {
    throw new CliError(
      `la llave de ${label(t)} cambió mientras trabajabas (alguien la rotó): corre \`zeus env pull ${t.projectKey} ${t.env}\` y vuelve a intentar`,
    );
  }
  throw err;
}

/** Diferencia en pantalla: SOLO nombres, nunca valores. */
export function printDiff(ctx: Pick<Ctx, 'log'>, rows: Array<{ sign: '+' | '~' | '-' | '='; names: string[]; note: string }>): void {
  for (const row of rows) {
    for (const name of row.names) ctx.log(`  ${row.sign} ${name}  (${row.note})`);
  }
}
