// Implementaciones reales de lo que los comandos reciben inyectado: disco, terminal y procesos.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { FileOps, Prompter, SpawnFn } from './context.js';

// ---------------------------------------------------------------- disco

export const realFs: FileOps = {
  async read(file) {
    try {
      return await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  async write(file, content, mode) {
    await writeFile(file, content, { encoding: 'utf8', ...(mode != null ? { mode } : {}) });
    // writeFile solo aplica `mode` al crear; si ya existía, se fuerza aquí. En Windows chmod solo
    // controla "solo lectura": la carpeta del perfil ya es privada del usuario.
    if (mode != null) await chmod(file, mode).catch(() => undefined);
  },
  async mkdirPrivate(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => undefined);
  },
  async remove(file) {
    try {
      await rm(file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  },
};

// ---------------------------------------------------------------- terminal

function question(text: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    // Las preguntas van por stderr: stdout queda limpio para `--stdout` y tuberías.
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
      out._writeToOutput = (s: string) => {
        if (s.includes(text)) out.output.write(s);
      };
    }
    rl.question(text, (answer) => {
      rl.close();
      if (hidden) process.stderr.write('\n');
      resolve(answer);
    });
  });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  // Un solo salto final es del `echo` o del editor, no del valor.
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

export const realPrompt: Prompter = {
  get interactive() {
    return Boolean(process.stdin.isTTY);
  },
  async confirm(text) {
    const answer = (await question(`${text} [s/N] `, false)).trim().toLowerCase();
    return ['s', 'si', 'sí', 'y', 'yes'].includes(answer);
  },
  async ask(text) {
    return (await question(text, false)).trim();
  },
  async secret(text) {
    if (!process.stdin.isTTY) return readAllStdin();
    return question(text, true);
  },
};

// ---------------------------------------------------------------- procesos

export interface SpawnSpec {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

// Metacaracteres de cmd.exe (misma receta que cross-spawn y que runner/src/exec.ts).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

export function quoteCmdArg(arg: string, double = false): string {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"');
  out = out.replace(/(\\*)$/, '$1$1');
  out = `"${out}"`;
  out = out.replace(CMD_META, '^$1');
  if (double) out = out.replace(CMD_META, '^$1');
  return out;
}

/**
 * Cómo lanzar `cmd` en esta plataforma, SIN shell (los argumentos no se interpretan). La excepción
 * son los .cmd/.bat de Windows (npm, pnpm, vercel…), que solo corren por cmd.exe: ahí se arma la
 * línea con comillas seguras. `resolved` es la ruta encontrada en PATH (o null).
 */
export function buildSpawnSpec(cmd: string, args: string[], platform: NodeJS.Platform, resolved: string | null): SpawnSpec {
  if (platform !== 'win32') return { file: cmd, args, windowsVerbatimArguments: false };
  const target = resolved ?? cmd;
  const ext = path.win32.extname(target).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const double = ext === '.cmd';
    const line = [path.win32.normalize(target).replace(CMD_META, '^$1'), ...args.map((a) => quoteCmdArg(a, double))].join(' ');
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
  }
  return { file: target, args, windowsVerbatimArguments: false };
}

/** Busca `cmd` en PATH respetando PATHEXT en Windows. */
export function resolveCommand(cmd: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  if (cmd.includes('/') || cmd.includes('\\')) return existsSync(cmd) ? cmd : null;
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts =
    platform === 'win32'
      ? path.extname(cmd)
        ? ['']
        : (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

export const realSpawn: SpawnFn = (command, args, env) =>
  new Promise((resolve, reject) => {
    const spec = buildSpawnSpec(command, args, process.platform, resolveCommand(command, env));
    const child = spawn(spec.file, spec.args, {
      stdio: 'inherit',
      env,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    // Ctrl+C llega al hijo por la terminal; el padre espera a que termine para propagar su código.
    const ignore = (): void => undefined;
    process.on('SIGINT', ignore);
    process.on('SIGTERM', ignore);
    const done = (): void => {
      process.off('SIGINT', ignore);
      process.off('SIGTERM', ignore);
    };
    child.on('error', (err) => {
      done();
      const code = (err as NodeJS.ErrnoException).code;
      reject(new Error(code === 'ENOENT' ? `no se encontró el comando "${command}"` : `no se pudo ejecutar "${command}": ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      done();
      resolve(code ?? (signal ? 128 + (signalNumber(signal) ?? 1) : 1));
    });
  });

function signalNumber(signal: NodeJS.Signals): number | null {
  const table: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return table[signal] ?? null;
}
