// Lo que cada comando recibe inyectado. Nada en src/commands toca la red, el disco, la terminal ni
// procesos directamente: todo pasa por aquí, así los tests corren con un zeus y un disco en memoria.
import type { ZeusApi } from './api.js';

export interface FileOps {
  /** Contenido UTF-8, o null si no existe. */
  read(path: string): Promise<string | null>;
  /** `mode` se aplica donde el sistema lo soporta (en Windows no falla, solo no aplica). */
  write(path: string, content: string, mode?: number): Promise<void>;
  /** Crea la carpeta (0700) si no existe. */
  mkdirPrivate(dir: string): Promise<void>;
  remove(path: string): Promise<boolean>;
}

export interface Prompter {
  /** false si no hay terminal: los comandos piden `--yes` en vez de quedarse esperando. */
  readonly interactive: boolean;
  confirm(question: string): Promise<boolean>;
  ask(question: string): Promise<string>;
  /** Lee un valor sin eco. Si stdin no es una terminal, lee todo stdin (para tuberías). */
  secret(question: string): Promise<string>;
}

/** Corre un comando con stdio heredado y devuelve su código de salida. */
export type SpawnFn = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

export interface Ctx {
  api: ZeusApi;
  fs: FileOps;
  prompt: Prompter;
  /** Salida principal (stdout). */
  out(line: string): void;
  /** Avisos y progreso (stderr): no ensucian lo que se entuba desde stdout. */
  log(line: string): void;
  /** Carpeta de zeus en este equipo (~/.zeus o ZEUS_HOME). */
  home: string;
  /** Origen de zeus con el que se armó `api`. */
  url: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  hostname: string;
  spawn: SpawnFn;
}

/** Error para la persona: una línea, sin stack. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'UsageError';
  }
}

/** Confirma o aborta. `yes` (bandera --yes) salta la pregunta. */
export async function confirmOrAbort(ctx: Ctx, question: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!ctx.prompt.interactive) {
    throw new CliError('hace falta confirmar y no hay terminal interactiva: repite el comando con --yes');
  }
  if (!(await ctx.prompt.confirm(question))) throw new CliError('cancelado, no se cambió nada');
}
