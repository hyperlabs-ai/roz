#!/usr/bin/env node
// zeus: CLI que corre en la PC de cada dev. Ver README.md.
import os from 'node:os';
import { ZeusClient, type ZeusApi } from './api.js';
import { envGrant, envInit, envRevoke, envRotate } from './commands/admin.js';
import { login, mcp, whoami } from './commands/auth.js';
import { envLs, envPull, envPush, envRm, envSet } from './commands/env.js';
import { keyCommand } from './commands/key.js';
import { run } from './commands/run.js';
import { CliError, UsageError, type Ctx } from './context.js';
import { configPath, keyPath, loadConfig, zeusHome, type ZeusConfig } from './store.js';
import { realFs, realPrompt, realSpawn } from './system.js';
import { VERSION } from './version.js';

const HELP = `zeus ${VERSION} — variables de entorno del equipo en una bóveda de conocimiento cero, y tu PC conectada a zeus.

Conexión:
  zeus login --url https://zeus.tu-equipo.com [--token zeus_…]   (sin --token lo pregunta, sin eco)
  zeus whoami
  zeus mcp                                   comando para conectar Claude Code con zeus
  zeus key init [--name <equipo>] [--force]  crea y registra la llave de este equipo
  zeus key show

Variables (entorno por defecto: development):
  zeus env ls
  zeus env pull <proyecto> [entorno] [--out <ruta>] [--stdout] [--format dotenv|json] [--yes]
  zeus env push <proyecto> [entorno] [--from <ruta>] [--prune] [--yes]
  zeus env set  <proyecto> <entorno> NOMBRE [--empty]      (el valor: por stdin o pregunta sin eco)
  zeus env rm   <proyecto> <entorno> NOMBRE [--yes]
  zeus run <proyecto> [entorno] -- <comando…>              corre el comando con los secretos en su entorno

Admin de zeus:
  zeus env init   <proyecto> [entorno]
  zeus env grant  <proyecto> [entorno] --to <dev, correo o id de llave> [--all-devices] [--yes]
  zeus env revoke <proyecto> [entorno] --key <id de llave> [--yes]
  zeus env rotate <proyecto> [entorno] [--yes]

Archivos: ${configPath(zeusHome())} (URL y token) y ${keyPath(zeusHome())} (llave privada de este equipo).
Variables: ZEUS_HOME, ZEUS_URL, ZEUS_TOKEN, ZEUS_DEBUG=1.`;

const connect = (url: string, token: string): ZeusApi => new ZeusClient({ url, token, userAgent: `zeus-cli/${VERSION}` });

/** Para los comandos que no llaman a zeus: si alguno lo intenta, el error dice qué falta. */
const noApi = new Proxy({} as ZeusApi, {
  get: () => () => Promise.reject(new CliError('este equipo no está conectado a zeus: corre `zeus login`')),
});

function buildCtx(cfg: ZeusConfig | null): Ctx {
  return {
    api: cfg ? connect(cfg.url, cfg.token) : noApi,
    fs: realFs,
    prompt: realPrompt,
    out: (line) => console.log(line),
    log: (line) => console.error(line),
    home: zeusHome(),
    url: cfg?.url ?? '',
    cwd: process.cwd(),
    platform: process.platform,
    env: process.env,
    hostname: os.hostname(),
    spawn: realSpawn,
  };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case '--version':
    case '-v':
    case 'version':
      console.log(VERSION);
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    case 'login':
      return login({ fs: realFs, prompt: realPrompt, out: (l) => console.log(l), home: zeusHome(), env: process.env, connect }, rest);
    default:
  }

  const cfg = await loadConfig(realFs, zeusHome(), process.env);
  const ctx = buildCtx(cfg);
  const needConfig = (): ZeusConfig => {
    if (!cfg) throw new CliError('este equipo no está conectado a zeus: corre `zeus login`');
    return cfg;
  };

  switch (cmd) {
    case 'whoami':
      needConfig();
      return whoami(ctx);
    case 'mcp':
      return mcp(ctx, needConfig().token);
    case 'key':
      if (rest[0] === 'init') needConfig();
      return keyCommand(ctx, rest);
    case 'run':
      needConfig();
      return run(ctx, rest);
    case 'env': {
      const [sub, ...args] = rest;
      const handlers: Record<string, (c: Ctx, a: string[]) => Promise<number>> = {
        ls: (c) => envLs(c),
        list: (c) => envLs(c),
        pull: envPull,
        push: envPush,
        set: envSet,
        rm: envRm,
        init: envInit,
        grant: envGrant,
        revoke: envRevoke,
        rotate: envRotate,
      };
      const handler = sub ? handlers[sub] : undefined;
      if (!handler) throw new UsageError(`subcomando desconocido: env ${sub ?? ''} (ve \`zeus help\`)`);
      needConfig();
      return handler(ctx, args);
    }
    default:
      console.error(`comando desconocido: ${cmd}\n`);
      console.error(HELP);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (process.env.ZEUS_DEBUG === '1' && err instanceof Error && err.stack) console.error(err.stack);
    else console.error(`zeus: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(err instanceof CliError ? err.exitCode : 1);
  },
);
