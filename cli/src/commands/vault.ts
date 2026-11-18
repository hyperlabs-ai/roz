// Piezas comunes de los comandos de la bóveda: la llave de este equipo, el proyecto/entorno
// canónico y abrir un entorno (traerlo y descifrarlo en memoria).
import path from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { ZeusApiError } from '../api.js';
import { CliError, UsageError, type Ctx } from '../context.js';
import { VaultCryptoError, decryptSecret, isValidSecretName, secretAad, unwrapDek, wrapAad } from '../crypto.js';
import { loadDeviceKey, type DeviceKeyFile } from '../store.js';
import type { VaultEnv } from '../types.js';

export const DEFAULT_ENV = 'development';
/** Las etapas que el estándar reconoce. Un nombre de entorno que es solo una etapa se completa con el repo. */
export const STAGES = ['development', 'production', 'staging', 'preview', 'test'] as const;
/** Cómo dice la gente las etapas → como se llaman en zeus. */
export const ENV_ALIASES: Readonly<Record<string, string>> = {
  local: 'development',
  dev: 'development',
  develop: 'development',
  prod: 'production',
  prd: 'production',
  stg: 'staging',
  stage: 'staging',
  pre: 'preview',
};
// La misma regla que el servidor: en minúsculas, así el entorno no tiene dos formas de escribirse.
const ENV_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const PROJECT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type RegisteredKey = DeviceKeyFile & { keyId: string };

export interface Target {
  projectKey: string;
  /** Nombre completo del entorno en zeus (p. ej. `api-hyperhub-production`). */
  env: string;
  /** La etapa (development, production…): decide el archivo local (.env, .env.production). */
  stage: string;
  /** El repo al que pertenece el entorno, si se dedujo de la carpeta. */
  repo: string | null;
  /** El entorno ya aparece en la bóveda. */
  exists: boolean;
}

/** La etapa de un nombre ("production" o "api-hyperhub-production" → production), o null. */
export function stageOf(envName: string): string | null {
  return STAGES.find((s) => envName === s || envName.endsWith(`-${s}`)) ?? null;
}

/** Nombre de repo como entra en un entorno: minúsculas, letras, números y guiones. */
export function repoSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '');
}

/** El remote "origin" de un .git/config (url), o null. */
export function originUrl(config: string): string | null {
  const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config);
  return m?.[1] ?? null;
}

/**
 * El repo de la carpeta actual: el nombre del remote "origin" (`…/api-hyperhub.git` → api-hyperhub)
 * o, sin remote, el nombre de la carpeta raíz del repo. null fuera de un repo de git.
 */
export async function detectRepo(ctx: Pick<Ctx, 'fs' | 'cwd'>): Promise<string | null> {
  let dir = path.resolve(ctx.cwd);
  for (;;) {
    let config = await ctx.fs.read(path.join(dir, '.git', 'config')).catch(() => null);
    if (config == null) {
      // Un worktree: `.git` es un archivo "gitdir: <ruta>" y la config vive en el repo común.
      const pointer = await ctx.fs.read(path.join(dir, '.git')).catch(() => null);
      const gitdir = pointer ? /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim() : undefined;
      if (gitdir) {
        const abs = path.resolve(dir, gitdir);
        const common = (await ctx.fs.read(path.join(abs, 'commondir')).catch(() => null))?.trim();
        config = await ctx.fs.read(path.join(common ? path.resolve(abs, common) : abs, 'config')).catch(() => null);
        if (config == null) config = '';
      }
    }
    if (config != null) {
      const url = originUrl(config);
      const name = url ? (url.replace(/\/+$/, '').split(/[/:]/).pop() ?? '') : path.basename(dir);
      return repoSlug(name) || null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
 * El nombre de entorno según el ESTÁNDAR de zeus, sin que nadie lo decida a mano:
 *   · se escribe solo la etapa (o su alias: local, prod…) y, dentro de un repo de git, el entorno es
 *     `<repo>-<etapa>` (api-hyperhub-production). Cada repo tiene sus propias variables y el mismo
 *     comando en otro repo nunca toca las de este.
 *   · fuera de un repo, la etapa sola (development, production).
 *   · un nombre que no es solo una etapa (el completo, p. ej. `api-hyperhub-production`) se usa tal cual.
 */
export async function standardEnvName(ctx: Pick<Ctx, 'fs' | 'cwd'>, envArg: string | undefined): Promise<{ env: string; stage: string; repo: string | null }> {
  const raw = (envArg ?? DEFAULT_ENV).trim();
  const stage = ENV_ALIASES[raw] ?? raw;
  if ((STAGES as readonly string[]).includes(stage)) {
    const repo = await detectRepo(ctx);
    return { env: repo ? `${repo}-${stage}` : stage, stage, repo };
  }
  return { env: raw, stage: stageOf(raw) ?? raw, repo: null };
}

/**
 * Proyecto y entorno como los conoce zeus. Importa porque ambos entran en el AAD del cifrado: si un
 * dev escribe `roz` y otro `ROZ`, lo que cifra uno no lo abriría el otro. Se usa la forma del
 * servidor cuando existe; si no aparece, lo que se escribió (el servidor decide si existe).
 */
export async function resolveTarget(ctx: Ctx, projectArg: string | undefined, envArg: string | undefined): Promise<Target> {
  if (!projectArg) throw new UsageError('falta la clave del proyecto (ve las que hay con `zeus env ls`)');
  if (!PROJECT_KEY_RE.test(projectArg)) throw new UsageError(`clave de proyecto inválida: "${projectArg}"`);
  const std = await standardEnvName(ctx, envArg);
  if (!ENV_NAME_RE.test(std.env)) {
    throw new UsageError(`nombre de entorno inválido: "${std.env}" (minúsculas, números y guiones; p. ej. development, production)`);
  }

  const { projects } = await ctx.api.listProjects();
  const pick = <T>(items: T[], name: (item: T) => string, wanted: string): T | undefined =>
    items.find((i) => name(i) === wanted) ?? only(items.filter((i) => name(i).toLowerCase() === wanted.toLowerCase()));
  const project = pick(projects, (p) => p.key, projectArg);
  const env = project ? pick(project.envs, (e) => e.name, std.env) : undefined;
  return { projectKey: project?.key ?? projectArg, env: env?.name ?? std.env, stage: std.stage, repo: std.repo, exists: Boolean(env) };
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
