// Archivos locales de zeus: ~/.zeus (0700; ZEUS_HOME cambia la carpeta).
//   config.json      URL de zeus y token (0600)
//   key.json         llave X25519 de ESTE equipo; la privada nunca sale de aquí (0600)
//   known-keys.json  huellas que este equipo ya verificó al dar acceso (0600)
import os from 'node:os';
import path from 'node:path';
import { normalizeUrl } from './api.js';
import { CliError, type FileOps } from './context.js';

export const TOKEN_RE = /^zeus_[A-Za-z0-9_-]{43}$/;

export interface ZeusConfig {
  url: string;
  token: string;
}

export interface DeviceKeyFile {
  version: 1;
  /** Nombre del equipo, como aparece en zeus. */
  name: string;
  publicKey: string;
  privateKey: string;
  fingerprint: string;
  /** Id de la llave en zeus; null si se generó pero aún no se pudo registrar. */
  keyId: string | null;
  /** Origen de zeus donde se registró (un keyId no vale en otro zeus). */
  url: string | null;
  createdAt: string;
}

export function zeusHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZEUS_HOME ? path.resolve(env.ZEUS_HOME) : path.join(os.homedir(), '.zeus');
}

export const configPath = (home: string): string => path.join(home, 'config.json');
export const keyPath = (home: string): string => path.join(home, 'key.json');
export const knownKeysPath = (home: string): string => path.join(home, 'known-keys.json');

async function readJson<T>(fs: FileOps, file: string, fix: string): Promise<T | null> {
  const raw = await fs.read(file);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CliError(`${file} no es JSON válido; ${fix}`);
  }
}

async function writePrivate(fs: FileOps, home: string, file: string, data: unknown): Promise<void> {
  await fs.mkdirPrivate(home);
  await fs.write(file, JSON.stringify(data, null, 2) + '\n', 0o600);
}

// ---------------------------------------------------------------- config

/** Config efectiva: el archivo, con ZEUS_URL y ZEUS_TOKEN por encima. null si falta URL o token. */
export async function loadConfig(fs: FileOps, home: string, env: NodeJS.ProcessEnv): Promise<ZeusConfig | null> {
  const file = await readJson<Partial<ZeusConfig>>(fs, configPath(home), 'bórralo y corre `zeus login`');
  const url = env.ZEUS_URL?.trim() || file?.url;
  const token = env.ZEUS_TOKEN?.trim() || file?.token;
  if (!url || !token) return null;
  return { url: normalizeUrl(url), token };
}

export async function saveConfig(fs: FileOps, home: string, cfg: ZeusConfig): Promise<void> {
  await writePrivate(fs, home, configPath(home), cfg);
}

/** Enmascara el token para mostrarlo ("zeus_AbCd…"). */
export function maskToken(token: string): string {
  return token.length <= 12 ? '…' : `${token.slice(0, 9)}…`;
}

// ---------------------------------------------------------------- llave del equipo

export async function loadDeviceKey(fs: FileOps, home: string): Promise<DeviceKeyFile | null> {
  const k = await readJson<Partial<DeviceKeyFile>>(fs, keyPath(home), 'restáuralo de tu respaldo o genera otra llave con `zeus key init --force`');
  if (!k) return null;
  if (!k.publicKey || !k.privateKey) {
    throw new CliError(`${keyPath(home)} está incompleto; genera otra llave con \`zeus key init --force\``);
  }
  return {
    version: 1,
    name: k.name || 'equipo',
    publicKey: k.publicKey,
    privateKey: k.privateKey,
    fingerprint: k.fingerprint ?? '',
    keyId: k.keyId ?? null,
    url: k.url ?? null,
    createdAt: k.createdAt ?? '',
  };
}

export async function saveDeviceKey(fs: FileOps, home: string, key: DeviceKeyFile): Promise<void> {
  await writePrivate(fs, home, keyPath(home), key);
}

// ---------------------------------------------------------------- huellas verificadas

/** keyId → huella que una persona verificó en este equipo antes de dar acceso. */
export async function loadKnownKeys(fs: FileOps, home: string): Promise<Record<string, string>> {
  return (await readJson<Record<string, string>>(fs, knownKeysPath(home), 'bórralo (solo guarda huellas ya verificadas)')) ?? {};
}

export async function rememberKeys(fs: FileOps, home: string, entries: Array<{ keyId: string; fingerprint: string }>): Promise<void> {
  if (entries.length === 0) return;
  const known = await loadKnownKeys(fs, home);
  for (const e of entries) known[e.keyId] = e.fingerprint;
  await writePrivate(fs, home, knownKeysPath(home), known);
}
