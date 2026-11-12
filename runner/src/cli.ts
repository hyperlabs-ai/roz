#!/usr/bin/env node
// roz-runner: CLI que corre en la PC de cada dev. Ver README.md.
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { RozApiError, RozClient, normalizeUrl } from './api.js';
import { parseRemoteRepo } from './commands.js';
import {
  ConfigError,
  configPath,
  deleteConfig,
  ensurePrivateDir,
  loadConfig,
  maskToken,
  normalizeRepo,
  requireConfig,
  runnerHome,
  saveConfig,
  worktreesDir,
  type RunnerConfig,
} from './config.js';
import { realExec } from './exec.js';
import { consoleLogger, realFs } from './fsops.js';
import { pullPlan } from './pull.js';
import { Runner, statePath, type RunnerStateFile } from './runner.js';
import { ScheduleError, buildSchedule, describeSchedule, inSchedule } from './schedule.js';
import { VERSION } from './version.js';

const HELP = `roz-runner ${VERSION} — corre los planes de tu cola de roz con Claude Code en tu PC.

Uso:
  roz-runner login [--url https://roz.tu-equipo.com] [--token rozr_…] [--name mi-laptop]
  roz-runner repo add <owner/name> <ruta del clon>     (o: repo add <ruta> y se deduce de origin)
  roz-runner repo list | repo rm <owner/name>
  roz-runner start [--max 1] [--horario 9-19] [--dias 1-5] [--tz America/Mexico_City] [--verbose]
  roz-runner pull <ID de Linear, p. ej. HYP-123>
  roz-runner status
  roz-runner logout

El token se crea en el dashboard de roz (Configuración → roz-runner en tus equipos → Nuevo token) y se guarda en
${configPath()} con permisos solo para tu usuario.`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'login':
      return login(rest);
    case 'logout':
      return logout();
    case 'repo':
      return repo(rest);
    case 'start':
      return start(rest);
    case 'pull':
      return pull(rest);
    case 'status':
      return status();
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
    default:
      console.error(`comando desconocido: ${cmd}\n`);
      console.log(HELP);
      return 2;
  }
}

// ---------------------------------------------------------------- login / logout

async function login(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { url: { type: 'string' }, token: { type: 'string' }, name: { type: 'string' }, worktrees: { type: 'string' } },
  });
  const prev = await loadConfig().catch(() => null);
  const url = normalizeUrl(values.url ?? process.env.ROZ_URL ?? prev?.url ?? (await ask('URL de roz (https://…): ')));
  const token = (values.token ?? process.env.ROZ_RUNNER_TOKEN ?? (await ask('Token del runner (rozr_…): ', true))).trim();
  if (!token.startsWith('rozr_')) {
    console.error('ese no parece un token de runner (empieza con rozr_). Créalo en el dashboard: Configuración → roz-runner en tus equipos.');
    return 1;
  }
  const name = values.name ?? prev?.name ?? os.hostname();

  const client = new RozClient({ url, token, userAgent: `roz-runner/${VERSION}` });
  let note = '';
  try {
    const reg = await client.register({ name, version: VERSION, platform: `${process.platform}-${process.arch}` });
    note = `conectado como runner "${reg.runner.name}" de ${reg.dev.name}`;
  } catch (err) {
    if (err instanceof RozApiError && err.status === 401) {
      console.error(err.message);
      return 1;
    }
    if (err instanceof RozApiError && err.code === 'LINEAR_SOT_OFF') {
      note = 'guardado; roz v2 aún está apagado en el servidor (ROZ_LINEAR_SOT), el runner esperará';
    } else {
      note = `guardado, pero no se pudo verificar: ${(err as Error).message}`;
    }
  }

  const cfg: RunnerConfig = {
    ...(prev ?? { repos: {} }),
    url,
    token,
    name,
    repos: prev?.repos ?? {},
    ...(values.worktrees ? { worktreesDir: path.resolve(values.worktrees) } : {}),
  };
  await saveConfig(cfg);
  console.log(`${note}\nconfig: ${configPath()}`);
  if (Object.keys(cfg.repos).length === 0) {
    console.log('siguiente paso: `roz-runner repo add <owner/name> <ruta del clon>` por cada repo en el que trabajes.');
  }
  return 0;
}

async function logout(): Promise<number> {
  const removed = await deleteConfig();
  console.log(
    removed
      ? `config borrada (${configPath()}). El token sigue vigente en roz hasta que lo revoques en el dashboard.`
      : 'no había runner configurado en este equipo.',
  );
  return 0;
}

// ---------------------------------------------------------------- repos

async function repo(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const cfg = await requireConfig();
  if (sub === 'list' || sub === undefined) {
    const entries = Object.entries(cfg.repos);
    if (entries.length === 0) console.log('sin repos mapeados. Usa `roz-runner repo add <owner/name> <ruta>`.');
    for (const [k, v] of entries) console.log(`${k}  →  ${v}`);
    return 0;
  }
  if (sub === 'rm' || sub === 'remove') {
    const key = rest[0] ? normalizeRepo(rest[0]) : null;
    if (!key || !cfg.repos[key]) {
      console.error(`no hay mapeo para "${rest[0] ?? ''}"`);
      return 1;
    }
    delete cfg.repos[key];
    await saveConfig(cfg);
    console.log(`quitado ${key}`);
    return 0;
  }
  if (sub === 'add') {
    let [name, dir] = rest;
    if (name && !dir) {
      dir = name; // repo add <ruta>: se deduce owner/name del remoto origin
      name = undefined;
    }
    if (!dir) {
      console.error('uso: roz-runner repo add <owner/name> <ruta del clon>');
      return 2;
    }
    const abs = path.resolve(dir);
    const top = await realExec(cfg.gitBin ?? 'git', ['-C', abs, 'rev-parse', '--show-toplevel']);
    if (top.code !== 0) {
      console.error(`${abs} no es un repositorio git`);
      return 1;
    }
    const root = path.resolve(top.stdout.trim());
    const origin = await realExec(cfg.gitBin ?? 'git', ['-C', root, 'remote', 'get-url', 'origin']);
    const fromRemote = origin.code === 0 ? parseRemoteRepo(origin.stdout) : null;
    const key = name ? normalizeRepo(name) : fromRemote;
    if (!key) {
      console.error('no se pudo deducir owner/name: pásalo explícito (roz-runner repo add owner/name <ruta>)');
      return 1;
    }
    if (fromRemote && fromRemote !== key) console.warn(`aviso: origin de ${root} es ${fromRemote}, no ${key}`);
    cfg.repos[key] = root;
    await saveConfig(cfg);
    console.log(`${key}  →  ${root}`);
    return 0;
  }
  console.error(`subcomando desconocido: repo ${sub}`);
  return 2;
}

// ---------------------------------------------------------------- start

async function start(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      max: { type: 'string' },
      horario: { type: 'string' },
      dias: { type: 'string' },
      tz: { type: 'string' },
      verbose: { type: 'boolean', short: 'v' },
    },
  });
  const cfg = await requireConfig();
  const home = runnerHome();
  const log = consoleLogger(values.verbose ?? false);

  const max = values.max != null ? Number(values.max) : (cfg.maxConcurrent ?? 1);
  if (!Number.isInteger(max) || max < 1 || max > 8) {
    console.error('--max debe ser un entero entre 1 y 8');
    return 2;
  }
  let schedule = cfg.schedule;
  if (values.horario || values.dias || values.tz) {
    try {
      schedule = buildSchedule({ horario: values.horario, dias: values.dias, tz: values.tz }, cfg.schedule);
    } catch (err) {
      if (err instanceof ScheduleError) {
        console.error(err.message);
        return 2;
      }
      throw err;
    }
  }
  // Se recuerda para la próxima vez.
  if (schedule !== cfg.schedule || max !== cfg.maxConcurrent) {
    await saveConfig({ ...cfg, schedule, maxConcurrent: max });
  }
  if (Object.keys(cfg.repos).length === 0) {
    log.warn('no hay repos mapeados: los planes fallarán hasta que corras `roz-runner repo add`');
  }
  await ensurePrivateDir(home);
  await realFs.mkdirp(worktreesDir(cfg, home));

  const runner = new Runner(
    {
      api: new RozClient({ url: cfg.url, token: cfg.token, userAgent: `roz-runner/${VERSION}` }),
      exec: realExec,
      fs: realFs,
      log,
      cfg,
      home,
      writeState: (s) => writeFile(statePath(home), JSON.stringify(s, null, 2) + '\n', 'utf8'),
    },
    { maxConcurrent: max, ...(schedule ? { schedule } : {}) },
  );

  let stopping = false;
  const onSignal = () => {
    if (stopping) {
      log.warn('salida forzada; el watchdog de roz regresará los planes a la cola');
      process.exit(130);
    }
    stopping = true;
    log.info('deteniendo… los planes en curso regresan a la cola (Ctrl+C otra vez para forzar)');
    void runner.shutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  log.info(`roz-runner ${VERSION} · ${cfg.url} · Ctrl+C para detener`);
  const fatal = await runner.start();
  if (fatal) {
    console.error(fatal);
    return 1;
  }
  // stop() por señal: el handler termina el proceso.
  await new Promise(() => undefined);
  return 0;
}

// ---------------------------------------------------------------- pull

async function pull(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error('uso: roz-runner pull <ID de Linear>');
    return 2;
  }
  const cfg = await requireConfig();
  const log = consoleLogger(false);
  const res = await pullPlan(id, {
    api: new RozClient({ url: cfg.url, token: cfg.token, userAgent: `roz-runner/${VERSION}` }),
    exec: realExec,
    fs: realFs,
    log,
    cwd: process.cwd(),
    gitBin: cfg.gitBin,
  });
  for (const w of res.warnings) log.warn(w);
  console.log(
    [
      `${res.pull.identifier}: ${res.pull.issue.title}`,
      `rama ${res.branch}${res.createdBranch ? ' (nueva)' : ''} en ${res.repoRoot}`,
      `plan en ${res.planPath} (no está en .gitignore: decide si lo commiteas)`,
      res.pull.issue.url ? `issue: ${res.pull.issue.url}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return 0;
}

// ---------------------------------------------------------------- status

async function status(): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.log('este equipo no tiene runner configurado: corre `roz-runner login`');
    return 1;
  }
  const home = runnerHome();
  console.log(`roz:      ${cfg.url}`);
  console.log(`runner:   ${cfg.name} · token ${maskToken(cfg.token)}`);
  console.log(`config:   ${configPath(home)}`);
  console.log(`worktrees: ${worktreesDir(cfg, home)}`);
  const repos = Object.entries(cfg.repos);
  console.log(`repos:    ${repos.length ? repos.map(([k, v]) => `${k} → ${v}`).join('\n          ') : '(ninguno)'}`);

  const state = await readState(home);
  if (state && isAlive(state.pid)) {
    console.log(`proceso:  corriendo (pid ${state.pid}, desde ${state.startedAt}) · ${state.running.length}/${state.maxConcurrent} plan(es)`);
    for (const r of state.running) {
      console.log(`  ${r.identifier}  ${r.phase}  ${r.step ?? ''}${r.message ? ` — ${r.message}` : ''}`);
    }
  } else {
    console.log('proceso:  detenido (corre `roz-runner start`)');
  }

  try {
    const reg = await new RozClient({ url: cfg.url, token: cfg.token, userAgent: `roz-runner/${VERSION}` }).register({
      name: cfg.name,
      version: VERSION,
      platform: `${process.platform}-${process.arch}`,
    });
    const s = reg.runner.schedule;
    console.log(`servidor: conectado como ${reg.dev.name} · ${reg.runner.running} plan(es) en curso según roz`);
    console.log(`horario:  ${describeSchedule(s)} · ${inSchedule(s) ? 'en horario' : 'fuera de horario'}`);
  } catch (err) {
    console.log(`servidor: ${(err as Error).message}`);
    return 1;
  }
  return 0;
}

async function readState(home: string): Promise<RunnerStateFile | null> {
  const raw = await realFs.read(statePath(home)).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RunnerStateFile;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ---------------------------------------------------------------- utilidades

function ask(question: string, secret = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (secret) {
      // No mostrar el token mientras se pega.
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
      out._writeToOutput = (s: string) => {
        if (s.includes(question)) out.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (secret) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof ConfigError || err instanceof RozApiError) console.error(err.message);
    else console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
