// zeus guard: el hook de Claude Code que evita que un secreto entre a la conversación.
//
// Claude Code le pasa por stdin un JSON con el evento (docs de hooks de Claude Code):
//   PreToolUse        → antes de correr una herramienta: se bloquea leer archivos .env (cat, Read,
//                       Grep, Edit…), `zeus env pull --stdout`, entubar un valor a `zeus env set` y
//                       abrir el visor `zeus env ui` (ese lo corre la persona, no el agente).
//   UserPromptSubmit  → antes de mandar lo que escribió la persona: si trae algo con forma de
//                       secreto (o el valor de una variable de los .env de esta carpeta) se bloquea
//                       y el mensaje NO se envía ni queda en la conversación.
//   SessionStart      → al abrir la sesión: imprime el resumen de `zeus doctor` (pendientes de la
//                       bandeja, variables desactualizadas) como contexto para Claude.
// Salir con 2 = bloquear (el texto de stderr es la razón). Cualquier error propio sale con 0: el
// guardia nunca debe dejar a Claude Code inservible.
import path from 'node:path';
import type { Ctx } from '../context.js';
import { parseDotenv } from '../dotenv.js';
import { findZeusFiles } from '../envfile.js';
import { doctorReport } from './doctor.js';

interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
  cwd?: string;
  source?: string;
}

export interface Verdict {
  block: boolean;
  reason?: string;
}

const ALLOW: Verdict = { block: false };

/** Quien lo escribe a propósito (p. ej. una llave pública "anon") lo marca con esto y pasa. */
export const BYPASS_TAG = '[zeus-ok]';

// ---------------------------------------------------------------- archivos .env

/** Archivos con valores: .env, .env.production, .env.local, .env.json, respaldos .bak… */
export function isSecretEnvPath(p: string): boolean {
  const base = path.basename(p.replace(/\\/g, '/'));
  if (!(base === '.env' || base.startsWith('.env.'))) return false;
  return !/\.(example|sample|template|dist|tpl)$/i.test(base);
}

/** Verbos que pueden nombrar un .env sin mostrar su contenido. */
const SAFE_VERBS = new Set([
  'zeus',
  'ls',
  'dir',
  'rm',
  'del',
  'mv',
  'cp',
  'copy',
  'move',
  'touch',
  'chmod',
  'icacls',
  'test',
  '[',
  'stat',
  'wc',
  'echo',
  'remove-item',
  'test-path',
  'copy-item',
  'move-item',
  'rename-item',
]);
const SAFE_GIT = new Set(['check-ignore', 'ls-files', 'rm', 'status', 'add', 'mv']);
const ENV_TOKEN = /(?:^|[\s'"=/\\:(])(\.env(?:\.[\w.-]+)?)(?=$|[\s'";|&)<>])/g;

function segments(command: string): string[] {
  return command
    .split(/\|\||&&|[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** El verbo de un segmento, sin `sudo`, variables de entorno al inicio ni la ruta del ejecutable. */
function verbOf(segment: string): { verb: string; rest: string[] } {
  const words = segment.split(/\s+/).filter(Boolean);
  while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || words[0] === 'sudo' || words[0] === 'npx')) words.shift();
  const verb = (words.shift() ?? '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|ps1)$/i, '').toLowerCase();
  return { verb, rest: words };
}

export function checkBash(command: string): Verdict {
  const cmd = command.replace(/\s+/g, ' ');
  if (/\bzeus(?:\.cmd)? env pull\b/.test(cmd) && /--stdout\b/.test(cmd)) {
    return {
      block: true,
      reason:
        'zeus guard: `zeus env pull --stdout` imprimiría los valores en la conversación. Usa `zeus env pull <proyecto> <entorno> --yes` (escribe el archivo) o `zeus env status` (solo nombres).',
    };
  }
  if (/\bzeus(?:\.cmd)? env ui\b/.test(cmd)) {
    return {
      block: true,
      reason: 'zeus guard: el visor `zeus env ui` muestra valores; lo abre la persona, no el agente. Pídele que corra `! zeus env ui` en su terminal.',
    };
  }
  if (/(\||<<<?)\s*zeus(?:\.cmd)? env set\b/.test(cmd) || /\bzeus(?:\.cmd)? env set\b[^|;&]*<<<?/.test(cmd)) {
    return {
      block: true,
      reason: 'zeus guard: no le pases el valor a `zeus env set` desde el comando. Pide a la persona que lo copie y usa `--from-clipboard` (o `--from-file <ruta>`).',
    };
  }
  for (const seg of segments(command)) {
    const tokens = [...seg.matchAll(ENV_TOKEN)].map((m) => m[1]!).filter(isSecretEnvPath);
    if (tokens.length === 0) continue;
    const { verb, rest } = verbOf(seg);
    if (SAFE_VERBS.has(verb)) continue;
    if (verb === 'git' && SAFE_GIT.has((rest[0] ?? '').toLowerCase())) continue;
    return {
      block: true,
      reason:
        `zeus guard: \`${verb || seg}\` mostraría los valores de ${tokens[0]} en la conversación. Para ver qué variables hay o faltan usa ` +
        '`zeus env status` (solo nombres); para cambiar una, `zeus env set <proyecto> <entorno> NOMBRE --from-clipboard`.',
    };
  }
  return ALLOW;
}

export function checkTool(tool: string, input: Record<string, unknown>): Verdict {
  if (tool === 'Bash' || tool === 'PowerShell') return checkBash(String(input.command ?? ''));
  if (['Read', 'Edit', 'MultiEdit', 'NotebookRead', 'Grep'].includes(tool)) {
    // Grep puede apuntar al archivo (path) o filtrar por nombre (glob: ".env*").
    const paths = [input.file_path, input.path, input.notebook_path].map((v) => String(v ?? '')).filter(Boolean);
    const glob = String(input.glob ?? '');
    const target = paths.find(isSecretEnvPath) ?? (/\.env(?:\*|\.\*|\{|$)/.test(glob) ? glob : undefined);
    if (target) {
      return {
        block: true,
        reason: `zeus guard: ${path.basename(target)} tiene valores de secretos y no se lee desde Claude. Usa \`zeus env status\` para ver nombres y qué falta.`,
      };
    }
  }
  return ALLOW;
}

// ---------------------------------------------------------------- secretos en lo que escribe la persona

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['una llave de Stripe', /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/],
  ['un secreto de webhook', /\bwhsec_[0-9A-Za-z]{16,}/],
  ['un token de GitHub', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['un token de Slack', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['una llave de AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['una llave de Google', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['una llave privada', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['una llave de Anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['una llave de OpenAI', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['un token de zeus', /\b(?:zeus|rozr)_[A-Za-z0-9_-]{30,}/],
  ['una llave de SendGrid', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/],
  ['un token de npm', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['una URL con contraseña', /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:/@]+:[^\s@/]{6,}@/],
  ['un JWT (p. ej. una service key de Supabase)', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];

/** Un valor que vale la pena cuidar: largo, mezcla letras y números, no es una URL sin credenciales. */
function looksSecret(value: string): boolean {
  if (value.length < 12 || /\s/.test(value)) return false;
  if (/^https?:\/\/[^@]*$/i.test(value)) return false;
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

export function checkPrompt(prompt: string, knownValues: ReadonlyMap<string, string> = new Map()): Verdict {
  if (!prompt || prompt.includes(BYPASS_TAG)) return ALLOW;
  for (const [name, value] of knownValues) {
    if (looksSecret(value) && prompt.includes(value)) {
      return { block: true, reason: promptReason(`el valor de ${name} de tus .env`) };
    }
  }
  for (const [what, re] of SECRET_PATTERNS) if (re.test(prompt)) return { block: true, reason: promptReason(what) };
  return ALLOW;
}

function promptReason(what: string): string {
  return (
    `zeus guard: tu mensaje parece traer ${what}, así que NO se envió ni quedó en la conversación.\n` +
    'Para subir o reemplazar un secreto: cópialo y pídele a Claude `zeus env set <proyecto> <entorno> NOMBRE --from-clipboard`, ' +
    'o córrelo tú. Para verlos: `zeus env ui`.\n' +
    `Si no es secreto (p. ej. una llave pública "anon"), vuelve a mandarlo con ${BYPASS_TAG} en el texto.`
  );
}

/** Valores de los .env de zeus de una carpeta (para reconocerlos si alguien los pega). */
async function knownValues(ctx: Ctx, dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of await findZeusFiles(ctx.fs, dir)) {
    const text = await ctx.fs.read(f.file);
    if (text == null) continue;
    const parsed = parseDotenv(text);
    for (const [n, v] of parsed.vars) out.set(n, v);
  }
  return out;
}

// ---------------------------------------------------------------- comando

export async function guard(ctx: Ctx): Promise<number> {
  let input: HookInput;
  try {
    input = JSON.parse((await ctx.stdin()) || '{}') as HookInput;
  } catch {
    return 0;
  }
  try {
    const event = input.hook_event_name ?? '';
    let verdict: Verdict = ALLOW;
    if (event === 'PreToolUse') verdict = checkTool(input.tool_name ?? '', input.tool_input ?? {});
    else if (event === 'UserPromptSubmit') verdict = checkPrompt(input.prompt ?? '', await knownValues(ctx, input.cwd || ctx.cwd));
    else if (event === 'SessionStart') {
      const lines = await doctorReport({ ...ctx, cwd: input.cwd || ctx.cwd }, { brief: true });
      if (lines.length) ctx.out(['zeus — estado al abrir la sesión:', ...lines].join('\n'));
      return 0;
    }
    if (verdict.block) {
      ctx.log(verdict.reason ?? 'zeus guard: bloqueado');
      return 2;
    }
    return 0;
  } catch {
    return 0;
  }
}
