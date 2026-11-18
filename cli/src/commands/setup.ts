// zeus setup claude: deja Claude Code listo para trabajar con zeus en un solo comando.
//   1. Conecta el MCP de zeus (herramientas + las instrucciones que hacen de "skill": se cargan solas
//      en cada sesión, sin instalar nada más).
//   2. Instala los hooks de `zeus guard` en settings.json: bloquean que un secreto entre a la
//      conversación y, al abrir sesión, le dan a Claude el estado de la bandeja y de los .env.
// Es idempotente: correrlo de nuevo no duplica nada.
import path from 'node:path';
import { CliError, UsageError, confirmOrAbort, type Ctx } from '../context.js';
import { maskToken } from '../store.js';
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

export async function setup(ctx: Ctx, args: string[], token: string | null): Promise<number> {
  const [target, ...rest] = args;
  if (target !== 'claude') throw new UsageError('uso: zeus setup claude [--project] [--no-mcp] [--no-hooks] [--yes]');
  const { values: opts } = parse(rest, {
    project: { type: 'boolean' },
    'no-mcp': { type: 'boolean' },
    'no-hooks': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
  });

  // ---- hooks
  if (!opts['no-hooks']) {
    const file = opts.project ? path.join(ctx.cwd, '.claude', 'settings.json') : path.join(homeDir(ctx), '.claude', 'settings.json');
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
    if (added.length === 0) ctx.out(`hooks: ya estaban en ${file}`);
    else {
      ctx.log(`Se agregan a ${file} los hooks de \`zeus guard\` (${added.join(', ')}):`);
      ctx.log('  · bloquean leer .env y pegar secretos en la conversación');
      ctx.log('  · al abrir sesión, Claude ve tus pendientes de zeus y el estado de tus .env');
      await confirmOrAbort(ctx, '¿Continuar?', opts.yes ?? false);
      await ctx.fs.mkdirPrivate(path.dirname(file));
      if (raw != null) await ctx.fs.write(`${file}.bak`, raw);
      await ctx.fs.write(file, JSON.stringify(settings, null, 2) + '\n');
      ctx.out(`hooks: instalados en ${file}${raw != null ? ` (anterior en ${file}.bak)` : ''}`);
    }
  }

  // ---- MCP
  if (!opts['no-mcp']) {
    if (!token || !ctx.url) throw new CliError('este equipo no está conectado a zeus: corre `zeus login` primero');
    const args = ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'zeus', `${ctx.url}/mcp`, '--header', `Authorization: Bearer ${token}`];
    ctx.log(`MCP: conectando Claude Code con ${ctx.url}/mcp (token ${maskToken(token)})…`);
    const code = await ctx.spawn('claude', args, ctx.env).catch(() => -1);
    if (code === 0) ctx.out('MCP: zeus conectado. Las instrucciones de zeus se cargan solas en cada sesión (no hace falta instalar una skill).');
    else {
      ctx.out('MCP: no se pudo registrar automáticamente (¿ya existía, o falta el comando `claude`?). Revisa con `claude mcp list`;');
      ctx.out('     para conectarlo a mano corre `zeus mcp` y pega el comando que imprime.');
    }
  }
  ctx.out('Listo. Abre una sesión nueva de Claude Code para que tome los cambios. Prueba: /mcp__zeus__pendientes');
  return 0;
}
