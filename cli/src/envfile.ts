// Los archivos .env que maneja zeus en la carpeta de un proyecto. Funciones PURAS salvo las que
// reciben FileOps.
//
// Cada entorno va a su propio archivo, para que local y prod nunca se mezclen:
//   development → .env      production → .env.production      <otro> → .env.<otro>
// y cada archivo lleva en su cabecera de dónde salió y qué versión tenía cada variable al bajarla:
//   # zeus:source orwel/production
//   # zeus:versions API_KEY=3 DATABASE_URL=1
// Con eso `zeus env status` sabe, sin preguntar nada, a qué entorno pertenece cada archivo y si una
// diferencia es porque la bóveda cambió (te falta bajar) o porque tú lo cambiaste (te falta subir).
import path from 'node:path';
import type { FileOps } from './context.js';

const SOURCE_RE = /^#\s*zeus:source\s+([A-Za-z0-9][A-Za-z0-9._-]*)\/([a-z][a-z0-9_-]*)\s*$/m;
const LEGACY_SOURCE_RE = /^#\s*zeus:\s+([A-Za-z0-9][A-Za-z0-9._-]*)\/([a-z][a-z0-9_-]*)\.\s/m;
const VERSIONS_RE = /^#\s*zeus:versions[ \t]*(.*)$/m;
/** Archivos .env que nunca son "el de un entorno": plantillas y respaldos. */
const NOT_ENV_FILE = /\.(example|sample|template|dist|bak|tpl)$/i;

export interface ZeusHeader {
  projectKey: string;
  env: string;
  /** nombre → versión que tenía en la bóveda cuando se bajó. */
  versions: Map<string, number>;
}

/** El archivo de una ETAPA: development → .env, production → .env.production, <otra> → .env.<otra>. */
export function defaultEnvFile(stage: string): string {
  return stage === 'development' ? '.env' : `.env.${stage}`;
}

/** La cabecera de zeus de un archivo, o null si no la tiene (no lo bajó zeus). */
export function readHeader(text: string): ZeusHeader | null {
  // Los archivos que bajó el CLI 0.1 solo traen la primera línea ("# zeus: orwel/development. …").
  const src = SOURCE_RE.exec(text) ?? LEGACY_SOURCE_RE.exec(text);
  if (!src || !src[1] || !src[2]) return null;
  const versions = new Map<string, number>();
  const line = VERSIONS_RE.exec(text)?.[1] ?? '';
  for (const pair of line.split(/\s+/).filter(Boolean)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(\d+)$/.exec(pair);
    if (m && m[1] && m[2]) versions.set(m[1], Number(m[2]));
  }
  return { projectKey: src[1], env: src[2], versions };
}

/** Líneas de cabecera (sin el `#`) para un archivo bajado de `projectKey/env`. */
export function headerLines(projectKey: string, env: string, versions: Iterable<[string, number]>, localStart: string, localEnd: string): string[] {
  const pairs = [...versions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([n, v]) => `${n}=${v}`);
  return [
    `zeus: ${projectKey}/${env}. Esta parte se reescribe en cada \`zeus env pull\`; no la edites a mano.`,
    `Lo propio de tu máquina va entre "${localStart}" y "${localEnd}": eso se conserva y nunca se sube.`,
    `zeus:source ${projectKey}/${env}`,
    `zeus:versions ${pairs.join(' ')}`.trimEnd(),
  ];
}

export function isEnvFileName(name: string): boolean {
  return (name === '.env' || name.startsWith('.env.')) && !NOT_ENV_FILE.test(name);
}

export interface FoundEnvFile {
  file: string;
  header: ZeusHeader;
}

/** Los .env de una carpeta que bajó zeus (los que tienen cabecera), ordenados por nombre. */
export async function findZeusFiles(fs: FileOps, dir: string): Promise<FoundEnvFile[]> {
  const out: FoundEnvFile[] = [];
  for (const name of (await fs.list(dir)).filter(isEnvFileName).sort()) {
    const file = path.join(dir, name);
    const text = await fs.read(file);
    const header = text != null ? readHeader(text) : null;
    if (header) out.push({ file, header });
  }
  return out;
}

/**
 * El archivo de un entorno en esta carpeta: el que diga venir de él en su cabecera (aunque se llame
 * .env.local, por ejemplo) y, si ninguno, el nombre por defecto.
 */
export async function locateEnvFile(fs: FileOps, dir: string, projectKey: string, env: string, stage: string): Promise<string> {
  const found = (await findZeusFiles(fs, dir)).find((f) => f.header.projectKey.toLowerCase() === projectKey.toLowerCase() && f.header.env === env);
  return found?.file ?? path.join(dir, defaultEnvFile(stage));
}
