// Operaciones de archivos que usa un trabajo, abstraídas para poder probar sin disco.
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

export interface FileOps {
  exists(p: string): boolean;
  /** null si no existe. */
  read(p: string): Promise<string | null>;
  write(p: string, content: string, opts?: { private?: boolean }): Promise<void>;
  append(p: string, content: string): Promise<void>;
  mkdirp(p: string): Promise<void>;
  rm(p: string): Promise<void>;
}

export const realFs: FileOps = {
  exists: (p) => existsSync(p),
  async read(p) {
    try {
      return await readFile(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  async write(p, content, opts) {
    await writeFile(p, content, { encoding: 'utf8', mode: opts?.private ? 0o600 : 0o644 });
    if (opts?.private) await chmod(p, 0o600).catch(() => undefined);
  },
  async append(p, content) {
    await appendFile(p, content, 'utf8');
  },
  async mkdirp(p) {
    await mkdir(p, { recursive: true });
  },
  async rm(p) {
    await rm(p, { recursive: true, force: true });
  },
};

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export function consoleLogger(verbose = false, now: () => Date = () => new Date()): Logger {
  const stamp = () => now().toTimeString().slice(0, 8);
  return {
    info: (m) => console.log(`[${stamp()}] ${m}`),
    warn: (m) => console.warn(`[${stamp()}] aviso: ${m}`),
    error: (m) => console.error(`[${stamp()}] error: ${m}`),
    debug: (m) => {
      if (verbose) console.log(`[${stamp()}]   ${m}`);
    },
  };
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
