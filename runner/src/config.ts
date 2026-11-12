// Configuración local del runner: ~/.roz-runner/config.json (permisos 0600; carpeta 0700).
// Guarda la URL de roz, el token del runner (secreto: solo vive aquí) y el mapeo repo → ruta local.
// ROZ_RUNNER_HOME cambia la carpeta (útil para tener dos runners o para pruebas).
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RunnerSchedule } from './types.js';

export interface RunnerConfig {
  url: string;
  token: string;
  /** Nombre con el que aparece en el dashboard (default: hostname). */
  name: string;
  /** "owner/name" (en minúsculas) → ruta absoluta del clon local. */
  repos: Record<string, string>;
  /** Dónde viven los worktrees de los planes (default: ~/.roz-runner/worktrees). */
  worktreesDir?: string;
  /** Último horario/máximo usado con `start` (se reusa si no pasas banderas). */
  schedule?: RunnerSchedule;
  maxConcurrent?: number;
  /** Ejecutables (por si no están en PATH o hay varias versiones). */
  claudeBin?: string;
  ghBin?: string;
  gitBin?: string;
}

export function runnerHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ROZ_RUNNER_HOME ? path.resolve(env.ROZ_RUNNER_HOME) : path.join(os.homedir(), '.roz-runner');
}

export function configPath(home = runnerHome()): string {
  return path.join(home, 'config.json');
}

export class ConfigError extends Error {}

export async function loadConfig(home = runnerHome()): Promise<RunnerConfig | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: Partial<RunnerConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<RunnerConfig>;
  } catch {
    throw new ConfigError(`${configPath(home)} no es JSON válido; bórralo y corre \`roz-runner login\``);
  }
  if (!parsed.url || !parsed.token) {
    throw new ConfigError(`${configPath(home)} está incompleto; corre \`roz-runner login\``);
  }
  return {
    url: parsed.url,
    token: parsed.token,
    name: parsed.name || os.hostname(),
    repos: parsed.repos ?? {},
    worktreesDir: parsed.worktreesDir,
    schedule: parsed.schedule,
    maxConcurrent: parsed.maxConcurrent,
    claudeBin: parsed.claudeBin,
    ghBin: parsed.ghBin,
    gitBin: parsed.gitBin,
  };
}

/** Carga o falla con un mensaje para la persona. */
export async function requireConfig(home = runnerHome()): Promise<RunnerConfig> {
  const cfg = await loadConfig(home);
  if (!cfg) throw new ConfigError('este equipo no tiene runner configurado: corre `roz-runner login`');
  return cfg;
}

export async function saveConfig(cfg: RunnerConfig, home = runnerHome()): Promise<void> {
  await ensurePrivateDir(home);
  const file = configPath(home);
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  // writeFile solo aplica `mode` al crear; si ya existía, se fuerza aquí. En Windows chmod solo
  // controla "solo lectura": la carpeta del perfil ya es privada del usuario.
  await chmod(file, 0o600).catch(() => undefined);
}

export async function deleteConfig(home = runnerHome()): Promise<boolean> {
  try {
    await rm(configPath(home));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
}

export function worktreesDir(cfg: RunnerConfig, home = runnerHome()): string {
  return cfg.worktreesDir ? path.resolve(cfg.worktreesDir) : path.join(home, 'worktrees');
}

/** "Owner/Name" | "https://github.com/owner/name(.git)" | "git@github.com:owner/name.git" → "owner/name". */
export function normalizeRepo(raw: string): string | null {
  const s = raw.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const m = /(?:github\.com[/:])?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (!m || !m[1] || !m[2]) return null;
  return `${m[1]}/${m[2]}`.toLowerCase();
}

export function repoPathFor(cfg: RunnerConfig, repo: string | null): string | null {
  if (!repo) return null;
  const key = normalizeRepo(repo);
  return key ? (cfg.repos[key] ?? null) : null;
}

/** Enmascara el token para mostrarlo ("rozr_AbCdEfG…"). */
export function maskToken(token: string): string {
  return token.length <= 12 ? '…' : `${token.slice(0, 12)}…`;
}
