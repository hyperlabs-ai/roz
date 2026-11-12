// Abstracción de procesos: todo lo que el runner ejecuta (git, gh, claude) pasa por `Exec`, así los
// tests inyectan un falso y nada toca procesos reales. La implementación real usa spawn SIN shell
// (los argumentos no se interpretan), salvo en Windows con .cmd/.bat, donde se arma la línea para
// cmd.exe con comillas seguras (como cross-spawn).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface ExecOptions {
  cwd?: string;
  /** Se escribe en stdin y se cierra (el prompt de Claude va por aquí, nunca como argumento). */
  input?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Cada línea de salida conforme llega (para logs y progreso). */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** true si se mató por la señal de cancelación o por timeout. */
  aborted: boolean;
}

export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export class ExecError extends Error {
  constructor(
    readonly cmd: string,
    readonly args: string[],
    readonly result: ExecResult,
  ) {
    const tail = (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n');
    super(`${cmd} ${args.slice(0, 3).join(' ')} falló (código ${result.code ?? 'null'})${tail ? `: ${tail}` : ''}`);
    this.name = 'ExecError';
  }
}

export class AbortedError extends Error {
  constructor(message = 'cancelado') {
    super(message);
    this.name = 'AbortedError';
  }
}

/** Corre y lanza si el código no es 0 (o si se canceló). */
export async function run(exec: Exec, cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
  const r = await exec(cmd, args, opts);
  if (r.aborted) throw new AbortedError();
  if (r.code !== 0) throw new ExecError(cmd, args, r);
  return r;
}

// ---------------------------------------------------------------- spawn en cada plataforma

export interface SpawnSpec {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

// Metacaracteres de cmd.exe (misma receta que cross-spawn).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Escapa un argumento para cmd.exe: reglas de CommandLineToArgvW (barras antes de comillas) y luego
 * ^ delante de cada metacaracter. `double` repite el escape para los shims .cmd de npm, que vuelven a
 * pasar `%*` por cmd (así `Bash(git status:*)` llega intacto a Claude Code).
 */
export function quoteCmdArg(arg: string, double = false): string {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"');
  out = out.replace(/(\\*)$/, '$1$1');
  out = `"${out}"`;
  out = out.replace(CMD_META, '^$1');
  if (double) out = out.replace(CMD_META, '^$1');
  return out;
}

/** Escapa la ruta del ejecutable para cmd.exe (sin comillas, solo ^). */
export function escapeCmdCommand(cmd: string): string {
  return cmd.replace(CMD_META, '^$1');
}

/**
 * Cómo lanzar `cmd` en esta plataforma. `resolved` es la ruta encontrada en PATH (o null).
 * - POSIX o .exe/.com en Windows → directo, sin shell.
 * - .cmd/.bat en Windows → `cmd.exe /d /s /c "<línea>"` con argumentos escapados (doble para .cmd).
 */
export function buildSpawnSpec(cmd: string, args: string[], platform: NodeJS.Platform, resolved: string | null): SpawnSpec {
  if (platform !== 'win32') return { file: cmd, args, windowsVerbatimArguments: false };
  const target = resolved ?? cmd;
  const ext = path.win32.extname(target).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const double = ext === '.cmd';
    const line = [escapeCmdCommand(path.win32.normalize(target)), ...args.map((a) => quoteCmdArg(a, double))].join(' ');
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

/** Mata el proceso y sus hijos (en Windows `taskkill /T`, en POSIX el grupo). */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ya terminó */
    }
  }
}

export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise<ExecResult>((resolve) => {
    const env = opts.env ?? process.env;
    const spec = buildSpawnSpec(cmd, args, process.platform, process.platform === 'win32' ? resolveCommand(cmd, env) : null);
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let settled = false;

    if (opts.signal?.aborted) {
      resolve({ code: null, stdout, stderr, aborted: true });
      return;
    }

    const child = spawn(spec.file, spec.args, {
      cwd: opts.cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      detached: process.platform !== 'win32', // grupo propio para poder matar el árbol
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lineBuf = { stdout: '', stderr: '' };
    const feed = (stream: 'stdout' | 'stderr', chunk: string) => {
      if (!opts.onLine) return;
      lineBuf[stream] += chunk;
      const lines = lineBuf[stream].split(/\r?\n/);
      lineBuf[stream] = lines.pop() ?? '';
      for (const l of lines) opts.onLine(l, stream);
    };

    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      feed('stdout', d);
    });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
      feed('stderr', d);
    });

    const onAbort = () => {
      aborted = true;
      killTree(child.pid);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = opts.timeoutMs ? setTimeout(onAbort, opts.timeoutMs) : null;

    const finish = (code: number | null, extraErr = '') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.onLine) {
        if (lineBuf.stdout) opts.onLine(lineBuf.stdout, 'stdout');
        if (lineBuf.stderr) opts.onLine(lineBuf.stderr, 'stderr');
      }
      resolve({ code, stdout, stderr: stderr + extraErr, aborted });
    };

    child.on('error', (err) => finish(127, `\n${err.message}`));
    child.on('close', (code) => finish(code));

    child.stdin?.on('error', () => undefined); // el proceso puede cerrar stdin antes que nosotros
    if (opts.input != null) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
