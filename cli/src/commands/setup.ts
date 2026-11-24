// zeus setup: deja esta PC lista para zeus en UN comando, sin copiar tokens. Pensado para correr con
// `npx -y @hyperlabs-ai/zeus@latest setup` (y para que lo corra Claude Code con --yes: la única
// decisión, aprobar el equipo, se toma en el navegador, no en la terminal). Pasos, idempotentes:
//   1. CLI: si `zeus` no está instalado de verdad (corres por npx), se instala global, porque los
//      hooks de Claude Code llaman a `zeus guard`.
//   2. Cuenta: si la config ya sirve (whoami), se usa. Si no, login por navegador estilo RFC 8628:
//      zeus da un código corto, se abre <roz>/conectar?code=…, la persona lo compara y aprueba con su
//      sesión, y este CLI (que consulta cada pocos segundos) recibe UNA vez un token a su nombre.
//   3. Llave de la bóveda: si no hay, `zeus key init` con el nombre del equipo.
//   4. Hooks de `zeus guard` en settings.json de Claude Code (bloquean secretos; al abrir sesión, Claude
//      ve la bandeja y el estado de los .env).
//   5. MCP de zeus en Claude Code con el MISMO token (las instrucciones hacen de "skill").
// `zeus setup claude` es el nombre viejo: hace lo mismo.
import path from 'node:path';
import { DEFAULT_ZEUS_URL, ZeusApiError, normalizeUrl, type DeviceApi, type ZeusApi } from '../api.js';
import { CliError, UsageError, type Ctx } from '../context.js';
import { loadDeviceKey, maskToken, saveConfig, type ZeusConfig } from '../store.js';
import type { WhoAmI } from '../types.js';
import { PACKAGE } from '../update.js';
import { VERSION } from '../version.js';
import { keyInit } from './key.js';
import { parse } from './vault.js';

const GUARD = 'zeus guard';

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: 'command'; command: string; timeout?: number }>;
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookEntry[]> };

/** Los hooks que agrega zeus, por evento. */
export const GUARD_HOOKS: Record<string, HookEntry> = {
  PreToolUse: { matcher: 'Bash|PowerShell|Read|Edit|MultiEdit|Grep|NotebookRead', hooks: [{ type: 'command', command: GUARD, timeout: 10 }] },
  UserPromptSubmit: { hooks: [{ type: 'command', command: GUARD, timeout: 10 }] },
  SessionStart: { matcher: 'startup|resume|clear', hooks: [{ type: 'command', command: GUARD, timeout: 15 }] },
};

/** settings.json con los hooks de zeus agregados (sin tocar lo demás). Devuelve qué eventos se sumaron. */
export function withGuardHooks(settings: Settings): { settings: Settings; added: string[] } {
  const hooks: Record<string, HookEntry[]> = { ...(settings.hooks ?? {}) };
  const added: string[] = [];
  for (const [event, entry] of Object.entries(GUARD_HOOKS)) {
    const list = Array.isArray(hooks[event]) ? [...hooks[event]!] : [];
    const present = list.some((e) => Array.isArray(e?.hooks) && e.hooks.some((h) => typeof h?.command === 'string' && h.command.trim().startsWith(GUARD)));
    if (present) continue;
    list.push(entry);
    hooks[event] = list;
    added.push(event);
  }
  return { settings: { ...settings, hooks }, added };
}

function homeDir(ctx: Ctx): string {
  const home = ctx.env.USERPROFILE || ctx.env.HOME;
  if (!home) throw new CliError('no se pudo saber tu carpeta de usuario (HOME); usa --project');
  return home;
}

/** Lo que `setup` necesita además del contexto (inyectado: los tests lo cumplen en memoria). */
export interface SetupDeps {
  /** La config guardada (o de ZEUS_URL/ZEUS_TOKEN), si hay. */
  config: ZeusConfig | null;
  connect(url: string, token: string): ZeusApi;
  /** Cliente de las rutas públicas device/* de un zeus. */
  device(url: string): DeviceApi;
  sleep(ms: number): Promise<void>;
  /** Ruta del comando instalado de verdad (ignorando la carpeta temporal de npx), o null. */
  which(cmd: string): string | null;
  now?(): number;
}

type Mark = 'ok' | 'warn' | 'fail';
interface StepResult {
  mark: Mark;
  label: string;
  detail: string;
}
const ICON: Record<Mark, string> = { ok: '✓', warn: '!', fail: '✗' };

/**
 * ¿Hacer este paso? --yes dice que sí a todo; en una terminal se pregunta; sin terminal y sin --yes
 * no se puede adivinar: se pide repetir con --yes (Claude Code corre sin terminal).
 */
async function agree(ctx: Ctx, question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!ctx.prompt.interactive) throw new CliError('hace falta confirmar y no hay terminal interactiva: repite con `zeus setup --yes`');
  return ctx.prompt.confirm(question);
}

const USAGE =
  'uso: zeus setup [--yes] [--url <zeus>] [--relogin] [--name <equipo>] [--no-install] [--no-browser] [--project] [--no-mcp] [--no-hooks]';

export async function setup(ctx: Ctx, args: string[], deps: SetupDeps): Promise<number> {
  // `zeus setup claude` (nombre de antes) = `zeus setup`.
  const rest = args[0] === 'claude' ? args.slice(1) : args;
  if (rest[0] && !rest[0].startsWith('-')) throw new UsageError(USAGE);
  const { values: opts } = parse(rest, {
    url: { type: 'string' },
    name: { type: 'string' },
    relogin: { type: 'boolean' },
    'no-install': { type: 'boolean' },
    'no-browser': { type: 'boolean' },
    project: { type: 'boolean' },
    'no-mcp': { type: 'boolean' },
    'no-hooks': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
  });
  const yes = opts.yes ?? false;
  const results: StepResult[] = [];
  const step = (n: number, title: string) => ctx.log(`\n[${n}/5] ${title}`);

  ctx.log(`zeus setup ${VERSION}: deja esta PC lista para zeus (CLI, cuenta, llave de la bóveda y Claude Code).`);

  // ---- 1. CLI instalado de verdad (los hooks lo llaman sin npx)
  step(1, 'CLI');
  const installed = deps.which('zeus');
  if (installed) {
    ctx.log(`zeus ya está instalado: ${installed}`);
    results.push({ mark: 'ok', label: 'CLI', detail: `zeus instalado (${installed})` });
  } else if (opts['no-install']) {
    results.push({ mark: 'warn', label: 'CLI', detail: `no está instalado y los hooks lo necesitan: \`npm i -g ${PACKAGE}\`` });
  } else {
    const spec = `${PACKAGE}@${VERSION}`;
    ctx.log(`\`zeus\` no está instalado en este equipo (corres por npx). Los hooks de Claude Code lo llaman (\`zeus guard\`),`);
    ctx.log(`así que se instala global: npm i -g ${spec}`);
    if (await agree(ctx, '¿Instalarlo?', yes)) {
      const code = await ctx.spawn('npm', ['i', '-g', spec], ctx.env).catch(() => -1);
      results.push(
        code === 0
          ? { mark: 'ok', label: 'CLI', detail: `zeus ${VERSION} instalado global` }
          : { mark: 'fail', label: 'CLI', detail: `no se pudo instalar; corre a mano \`npm i -g ${PACKAGE}\`` },
      );
    } else {
      results.push({ mark: 'warn', label: 'CLI', detail: `sin instalar; los hooks no van a funcionar hasta \`npm i -g ${PACKAGE}\`` });
    }
  }

  // ---- 2. Cuenta: la config que ya sirve, o login por navegador
  step(2, 'Cuenta');
  const url = normalizeUrl(opts.url ?? ctx.env.ZEUS_URL ?? deps.config?.url ?? DEFAULT_ZEUS_URL);
  let token: string | null = null;
  let me: WhoAmI | null = null;
  if (deps.config && deps.config.url === url && !opts.relogin) {
    me = await deps.connect(url, deps.config.token).whoami().catch(() => null);
    if (me) token = deps.config.token;
    else ctx.log('la conexión guardada ya no sirve (token revocado o zeus no responde): se conecta de nuevo.');
  }
  if (me && token) {
    ctx.log(`ya conectado como ${me.dev.name} a ${url} (--relogin para conectar otra cuenta)`);
  } else {
    const got = await browserLogin(ctx, url, deps, opts['no-browser'] ?? false);
    token = got.token;
    await saveConfig(ctx.fs, ctx.home, { url, token });
    me = await deps.connect(url, token).whoami().catch(() => ({ dev: { ...got.dev }, zeusAdmin: false }));
    if (ctx.env.ZEUS_TOKEN) ctx.log('aviso: tienes ZEUS_TOKEN en el entorno y manda sobre la config; quítalo para usar este equipo conectado.');
  }
  results.push({ mark: 'ok', label: 'cuenta', detail: `${me.dev.name}${me.zeusAdmin ? ' (admin)' : ''} en ${url}` });
  // De aquí en adelante, todo con la cuenta y el zeus recién confirmados.
  const c: Ctx = { ...ctx, api: deps.connect(url, token), url };

  // ---- 3. Llave de la bóveda
  step(3, 'Llave de la bóveda');
  try {
    let key = await loadDeviceKey(c.fs, c.home);
    if (key?.keyId && key.url === url) {
      ctx.log(`este equipo ya tiene llave: "${key.name}" · huella ${key.fingerprint}`);
    } else {
      await keyInit(c, ['--name', opts.name ?? key?.name ?? c.hostname]);
      key = await loadDeviceKey(c.fs, c.home);
    }
    results.push({ mark: 'ok', label: 'llave', detail: key ? `"${key.name}" · huella ${key.fingerprint}` : 'registrada' });
  } catch (err) {
    results.push({ mark: 'fail', label: 'llave', detail: `${errText(err)} (repite con \`zeus key init\`)` });
  }

  // ---- 4. Hooks de zeus guard
  step(4, 'Claude Code: hooks que protegen secretos');
  if (opts['no-hooks']) results.push({ mark: 'warn', label: 'hooks', detail: 'omitidos (--no-hooks)' });
  else {
    try {
      results.push(await installHooks(c, opts.project ? path.join(c.cwd, '.claude', 'settings.json') : path.join(homeDir(c), '.claude', 'settings.json'), yes));
    } catch (err) {
      results.push({ mark: 'fail', label: 'hooks', detail: errText(err) });
    }
  }

  // ---- 5. MCP con el mismo token
  step(5, 'Claude Code: MCP de zeus');
  if (opts['no-mcp']) results.push({ mark: 'warn', label: 'MCP', detail: 'omitido (--no-mcp)' });
  else results.push(await connectMcp(c, token, deps));

  // ---- resumen
  const width = Math.max(...results.map((r) => r.label.length));
  ctx.out('');
  ctx.out('zeus setup:');
  for (const r of results) ctx.out(`  ${ICON[r.mark]} ${r.label.padEnd(width)}  ${r.detail}`);
  const failed = results.some((r) => r.mark === 'fail');
  ctx.out('');
  if (failed) ctx.out('Quedó algo pendiente (✗ arriba). Arréglalo y repite `zeus setup`: lo que ya está no se vuelve a hacer.');
  else ctx.out('Listo. Abre una sesión nueva de Claude Code y escribe /mcp__zeus__pendientes');
  return failed ? 1 : 0;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Login por navegador: zeus da un código, la persona aprueba en roz y este CLI cobra el token una vez. */
async function browserLogin(ctx: Ctx, url: string, deps: SetupDeps, noBrowser: boolean): Promise<{ token: string; dev: WhoAmI['dev'] }> {
  const device = deps.device(url);
  const now = deps.now ?? Date.now;
  let started;
  try {
    started = await device.start({ clientName: ctx.hostname, platform: ctx.platform, version: VERSION });
  } catch (err) {
    throw new CliError(`no se pudo abrir la conexión con ${url}: ${errText(err)}`);
  }
  // A stdout: es lo que la persona (o Claude, que se lo dice) necesita ver.
  ctx.out(`Aprueba este equipo en tu navegador. Código: ${started.userCode}`);
  ctx.out(`  ${started.verificationUriComplete}`);
  ctx.out('Antes de aprobar, revisa que la página muestre este mismo código y el nombre de este equipo.');
  if (!noBrowser) await ctx.openUrl(started.verificationUriComplete).catch(() => undefined);
  ctx.log(`esperando la aprobación (vence en ${Math.round(started.expiresIn / 60)} min)…`);

  const deadline = now() + started.expiresIn * 1000;
  let interval = Math.max(1, started.interval);
  for (;;) {
    await deps.sleep(interval * 1000);
    if (now() > deadline) throw new CliError('la solicitud venció sin aprobarse: corre `zeus setup` otra vez');
    let res;
    try {
      res = await device.poll(started.deviceCode);
    } catch (err) {
      // Red caída, zeus reiniciando o límite de consultas: se sigue esperando hasta el vencimiento.
      if (err instanceof ZeusApiError && (err.status === 0 || err.status === 429 || err.status >= 500)) {
        interval = Math.min(interval + 2, 30);
        continue;
      }
      throw err;
    }
    switch (res.status) {
      case 'pending':
        interval = Math.max(1, res.interval);
        continue;
      case 'slow_down':
        interval = Math.max(interval + 5, res.interval);
        continue;
      case 'approved':
        ctx.log(`aprobado: conectado como ${res.dev.name} (token ${maskToken(res.token)})`);
        return { token: res.token, dev: res.dev };
      case 'denied':
        throw new CliError('la conexión se rechazó en el navegador; no se guardó nada');
      case 'delivered':
        throw new CliError('esa aprobación ya se entregó a otro proceso; corre `zeus setup` otra vez');
      default:
        throw new CliError('la solicitud venció sin aprobarse: corre `zeus setup` otra vez');
    }
  }
}

async function installHooks(ctx: Ctx, file: string, yes: boolean): Promise<StepResult> {
  const raw = await ctx.fs.read(file);
  let current: Settings = {};
  if (raw != null && raw.trim()) {
    try {
      current = JSON.parse(raw) as Settings;
    } catch {
      throw new CliError(`${file} no es JSON válido; arréglalo y repite (no se tocó nada)`);
    }
  }
  const { settings, added } = withGuardHooks(current);
  if (added.length === 0) {
    ctx.log(`ya estaban en ${file}`);
    return { mark: 'ok', label: 'hooks', detail: `zeus guard en ${file}` };
  }
  ctx.log(`Se agregan a ${file} los hooks de \`zeus guard\` (${added.join(', ')}):`);
  ctx.log('  · bloquean leer .env y pegar secretos en la conversación');
  ctx.log('  · al abrir sesión, Claude ve tus pendientes de zeus y el estado de tus .env');
  if (!(await agree(ctx, '¿Agregarlos?', yes))) return { mark: 'warn', label: 'hooks', detail: 'no se instalaron (lo decidiste tú)' };
  await ctx.fs.mkdirPrivate(path.dirname(file));
  if (raw != null) await ctx.fs.write(`${file}.bak`, raw);
  await ctx.fs.write(file, JSON.stringify(settings, null, 2) + '\n');
  return { mark: 'ok', label: 'hooks', detail: `zeus guard en ${file}${raw != null ? ` (anterior en ${file}.bak)` : ''}` };
}

/**
 * Registra el MCP en Claude Code (alcance de usuario). Primero quita el anterior: si este equipo se
 * reconectó, el token viejo ya no sirve. Sin heredar la salida: el comando lleva el token.
 */
async function connectMcp(ctx: Ctx, token: string, deps: SetupDeps): Promise<StepResult> {
  if (!deps.which('claude')) {
    ctx.log('no se encontró el comando `claude` (Claude Code) en este equipo.');
    return { mark: 'warn', label: 'MCP', detail: 'falta Claude Code: instálalo y repite `zeus setup` (o `zeus mcp` para el comando a mano)' };
  }
  const mcpUrl = `${ctx.url}/mcp`;
  ctx.log(`conectando Claude Code con ${mcpUrl} (token ${maskToken(token)})…`);
  await ctx.spawn('claude', ['mcp', 'remove', '--scope', 'user', 'zeus'], ctx.env, { quiet: true }).catch(() => -1);
  const args = ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'zeus', mcpUrl, '--header', `Authorization: Bearer ${token}`];
  const code = await ctx.spawn('claude', args, ctx.env, { quiet: true }).catch(() => -1);
  if (code === 0) return { mark: 'ok', label: 'MCP', detail: `zeus en Claude Code (${mcpUrl}); las instrucciones llegan solas, sin skill` };
  return { mark: 'fail', label: 'MCP', detail: 'no se pudo registrar: revisa `claude mcp list`, o corre `zeus mcp` y pega el comando que imprime' };
}
