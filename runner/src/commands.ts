// Armado de comandos (claude, git, gh) y prompts. Todo puro: se prueba sin procesos.
import path from 'node:path';
import type { PlanRisk, RiskReason, RunnerJob } from './types.js';

// ---------------------------------------------------------------- Claude Code headless

export interface ClaudeRunSpec {
  allowedTools: readonly string[];
  maxTurns: number;
  /** Archivo JSON con el MCP de roz (fuera del worktree, se borra al terminar). */
  mcpConfigPath: string;
  model?: string;
}

/**
 * `claude -p` con el prompt por stdin (nunca como argumento: no se escapa ni aparece en la lista de
 * procesos). Solo el MCP de roz (--strict-mcp-config ignora los MCP personales del dev) y la lista
 * blanca de herramientas: en modo -p lo que no está permitido se rechaza solo.
 * --allowedTools es variádico: va al final para que no se trague otras banderas.
 */
export function buildClaudeArgs(spec: ClaudeRunSpec): string[] {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--max-turns',
    String(spec.maxTurns),
    '--mcp-config',
    spec.mcpConfigPath,
    '--strict-mcp-config',
  ];
  if (spec.model) args.push('--model', spec.model);
  if (spec.allowedTools.length > 0) args.push('--allowedTools', ...spec.allowedTools);
  return args;
}

/** Configuración MCP para Claude Code: el servidor HTTP de roz con el mismo token del runner. */
export function buildMcpConfig(mcpUrl: string, token: string): string {
  return JSON.stringify(
    { mcpServers: { roz: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
}

export interface ClaudeOutcome {
  ok: boolean;
  /** Texto final de Claude (o el motivo del error). */
  result: string;
  turns: number | null;
  costUsd: number | null;
}

/** Interpreta la salida de `claude -p --output-format json` (un objeto `type: 'result'`). */
export function parseClaudeOutput(stdout: string, exitCode: number | null): ClaudeOutcome {
  const text = stdout.trim();
  // Puede venir ruido antes del JSON: se toma la última línea que parezca objeto.
  const line = text
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  if (line) {
    try {
      const j = JSON.parse(line) as {
        type?: string;
        subtype?: string;
        is_error?: boolean;
        result?: string;
        num_turns?: number;
        total_cost_usd?: number;
      };
      const failed = j.is_error === true || (j.subtype != null && j.subtype !== 'success') || exitCode !== 0;
      const why = j.subtype === 'error_max_turns' ? 'se acabaron los turnos permitidos' : (j.result ?? j.subtype ?? 'error');
      return {
        ok: !failed,
        result: failed ? why : (j.result ?? ''),
        turns: typeof j.num_turns === 'number' ? j.num_turns : null,
        costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
      };
    } catch {
      /* cae al caso sin JSON */
    }
  }
  return {
    ok: false,
    result: exitCode === 0 ? 'Claude Code no devolvió un resultado legible' : `Claude Code salió con código ${exitCode ?? 'null'}`,
    turns: null,
    costUsd: null,
  };
}

// ---------------------------------------------------------------- git

/**
 * Un segmento de ruta nunca puede ser "", "." ni "..": la ruta del worktree se borra con rm -rf al
 * rehacerlo, y un ".." la sacaría de la carpeta de worktrees.
 */
function safeSegment(s: string): string {
  return /^\.*$/.test(s) ? `_${s.length}` : s;
}

export function repoSlug(repo: string): string {
  return safeSegment(repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '__'));
}

/** Ruta del worktree de un plan: <dir>/<owner__name>/<identificador en minúsculas>. */
export function worktreePathFor(dir: string, repo: string, identifier: string): string {
  return path.join(dir, repoSlug(repo), safeSegment(identifier.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')));
}

/** Rama con el ID de Linear: `<id minúsculas>-<slug del título, 40>` (la misma receta del servidor). */
export function branchFor(identifier: string, title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  const id = identifier.toLowerCase();
  return slug ? `${id}-${slug}` : id;
}

/** Valida un nombre de rama antes de pasárselo a git (lo manda el servidor, pero no se confía a ciegas). */
export function isSafeBranch(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

export type BranchState = { local: boolean; remote: boolean };

/**
 * Argumentos de `git worktree add` según lo que ya exista:
 * - rama local → se reusa (conserva commits de un intento anterior);
 * - solo remota → se crea local siguiendo a origin/<rama> (otro runner ya empujó avance);
 * - ninguna → nueva desde origin/<base>.
 */
export function worktreeAddArgs(worktreePath: string, branch: string, base: string, state: BranchState): string[] {
  if (state.local) return ['worktree', 'add', worktreePath, branch];
  if (state.remote) return ['worktree', 'add', '--track', '-b', branch, worktreePath, `origin/${branch}`];
  return ['worktree', 'add', '--no-track', '-b', branch, worktreePath, `origin/${base}`];
}

/** "origin/main" (de `git symbolic-ref --short refs/remotes/origin/HEAD`) → "main". */
export function parseDefaultBranch(out: string): string | null {
  const s = out.trim();
  if (!s) return null;
  return s.replace(/^refs\/remotes\//, '').replace(/^origin\//, '') || null;
}

/** "git@github.com:Owner/Name.git" | "https://github.com/owner/name" → "owner/name". */
export function parseRemoteRepo(url: string): string | null {
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m && m[1] && m[2] ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

// ---------------------------------------------------------------- gh

export function prTitle(identifier: string, title: string): string {
  return `${identifier}: ${title}`.slice(0, 250);
}

export function buildPrBody(job: Pick<RunnerJob, 'identifier' | 'issue' | 'risk' | 'riskReasons'>, planMd: string | null): string {
  const lines: string[] = [];
  lines.push(`Issue: ${job.issue.url ?? job.identifier}`);
  lines.push('');
  lines.push(`Riesgo: ${riskLabel(job.risk)}${job.riskReasons.length ? ` (${job.riskReasons.map((r) => r.detail).join('; ')})` : ''}`);
  if (planMd && planMd.trim()) {
    lines.push('', '## Plan', '', planMd.trim());
  }
  lines.push('', '---', `Abierta por roz-runner para ${job.identifier}.`);
  return lines.join('\n');
}

export function ghPrCreateArgs(o: { repo: string; base: string; branch: string; title: string; bodyFile: string }): string[] {
  return ['pr', 'create', '--repo', o.repo, '--base', o.base, '--head', o.branch, '--title', o.title, '--body-file', o.bodyFile];
}

export function ghPrViewArgs(repo: string, branch: string): string[] {
  return ['pr', 'view', branch, '--repo', repo, '--json', 'number,url'];
}

/** Saca número y URL de la salida de `gh pr create` (imprime la URL de la PR). */
export function parsePrUrl(out: string): { prNumber: number; prUrl: string } | null {
  const m = /(https:\/\/\S+\/pull\/(\d+))/.exec(out);
  if (!m || !m[1] || !m[2]) return null;
  return { prUrl: m[1], prNumber: Number(m[2]) };
}

// ---------------------------------------------------------------- prompts y PLAN.md

export function riskLabel(risk: PlanRisk): string {
  return risk === 0 ? '0 (planea e implementa)' : risk === 1 ? '1 (requiere aprobación)' : '2 (solo plan; implementa una persona)';
}

/**
 * Prompt de implementación cuando el runner sigue solo (plan_listo con riesgo 0, mismo lease):
 * el servidor no manda prompt nuevo en esa respuesta, así que se arma aquí con el plan recién escrito.
 */
export function buildImplementPrompt(job: Pick<RunnerJob, 'identifier' | 'issue' | 'branch'>, planMd: string): string {
  return [
    `Implementa el issue ${job.identifier}: ${job.issue.title}`,
    job.issue.url ? `Issue: ${job.issue.url}` : '',
    '',
    'Estás en un git worktree aislado, en la rama ' + job.branch + '. Sigue el plan aprobado de abajo (también está en PLAN.md).',
    'Reglas:',
    '- Haz cambios pequeños y enfocados en lo que pide el plan; no toques nada fuera de su alcance.',
    '- Corre las pruebas y el typecheck del proyecto si existen, y corrige lo que rompas.',
    '- Haz commits con git (mensajes claros, en el idioma del repo). No agregues pies de atribución ni Co-Authored-By.',
    '- No hagas push ni abras la PR: el runner lo hace al terminar.',
    '- No modifiques PLAN.md ni lo agregues al commit.',
    '- Al final responde con un resumen breve de lo que cambiaste y lo que quedó pendiente.',
    '',
    '## Plan',
    '',
    planMd.trim(),
  ]
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n');
}

/** PLAN.md para `pull` cuando el servidor no lo trae (normalmente sí trae la plantilla). */
export function fallbackPlanMd(identifier: string, title: string, url: string | null): string {
  return [`# ${identifier}: ${title}`, '', url ? `Issue: ${url}` : '', '', '## Plan', '', '- [ ] ', ''].join('\n');
}

export function describeRisk(reasons: RiskReason[]): string {
  return reasons.length ? reasons.map((r) => r.detail).join('; ') : 'sin reglas de riesgo';
}

export const PLAN_FILE = 'PLAN.md';
