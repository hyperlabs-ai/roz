// Un trabajo (RunnerJob) de principio a fin:
//   repo local → worktree aislado → claude -p en modo plan → reporta plan_ready
//   → (riesgo 0 con continue, o job en fase implementar ya aprobado) claude -p implementando
//   → commit de lo que quede → push → gh pr create → reporta pr_opened.
// Cualquier error se reporta como `failed` con un mensaje claro. Cancelación:
//   - Ctrl+C (abort con motivo 'shutdown') → mata a Claude y reporta `released` (el plan vuelve a la cola);
//   - stop del latido (cancelado / lease_perdido / reasignado) → mata a Claude y NO reporta (ya no es nuestro).
import path from 'node:path';
import { RozApiError, type RozClient } from './api.js';
import {
  PLAN_FILE,
  buildClaudeArgs,
  buildImplementPrompt,
  buildMcpConfig,
  buildPrBody,
  ghPrCreateArgs,
  ghPrViewArgs,
  isSafeBranch,
  parseClaudeOutput,
  parseDefaultBranch,
  parsePrUrl,
  prTitle,
  worktreeAddArgs,
  worktreePathFor,
  type ClaudeOutcome,
} from './commands.js';
import { repoPathFor, worktreesDir, type RunnerConfig } from './config.js';
import { AbortedError, run, type Exec } from './exec.js';
import type { FileOps, Logger } from './fsops.js';
import {
  MAX_TURNS_IMPLEMENT,
  MAX_TURNS_PLAN,
  RUNNER_ALLOWED_TOOLS_IMPLEMENT,
  RUNNER_ALLOWED_TOOLS_PLAN,
  type RunnerJob,
  type RunnerProgressRequest,
  type RunnerProgressResponse,
} from './types.js';

/** Error de un trabajo con mensaje pensado para la persona que lo verá en el dashboard. */
export class JobError extends Error {}
class LeaseLostError extends Error {}

export type JobOutcome = 'plan_ready' | 'pr_opened' | 'failed' | 'released' | 'stopped' | 'lease_lost';

/** Motivo con el que se aborta un trabajo. */
export const SHUTDOWN = 'shutdown';

export interface JobProgress {
  step: string | null;
  message: string | null;
  pct: number | null;
}

export interface JobDeps {
  exec: Exec;
  fs: FileOps;
  api: Pick<RozClient, 'progress'>;
  cfg: RunnerConfig;
  /** Carpeta del runner (~/.roz-runner): ahí van los archivos temporales con secretos. */
  home: string;
  mcpUrl: string;
  log: Logger;
  /** Último progreso conocido (el latido lo manda en `running[]`). */
  onProgress?: (p: JobProgress) => void;
  /** Tope de tiempo por corrida de Claude (default 2 h). */
  claudeTimeoutMs?: number;
}

const CLAUDE_TIMEOUT_MS = 2 * 60 * 60_000;
const MAX_ERROR_LEN = 2000;

export async function runJob(job: RunnerJob, deps: JobDeps, signal: AbortSignal): Promise<JobOutcome> {
  const { exec, fs, api, cfg, log } = deps;
  const git = cfg.gitBin ?? 'git';
  const tag = job.identifier;
  let worktree: string | null = null;
  let repoPath: string | null = null;

  const report = (kind: RunnerProgressRequest['kind'], extra: Partial<RunnerProgressRequest> = {}) =>
    reportProgress(api, { planId: job.planId, leaseId: job.leaseId, kind, ...extra });

  const step = async (s: string, message: string, pct: number | null = null) => {
    if (signal.aborted) throw new AbortedError();
    log.info(`${tag} · ${message}`);
    deps.onProgress?.({ step: s, message, pct });
    try {
      await report('progress', { step: s, message, ...(pct != null ? { pct } : {}) });
    } catch (err) {
      if (err instanceof LeaseLostError) throw err;
      log.warn(`${tag} · no se pudo reportar el avance: ${(err as Error).message}`);
    }
  };

  try {
    // ---- 1. repo local
    if (!job.repo) throw new JobError('el plan no tiene repositorio: vincula un repo al proyecto en roz');
    repoPath = repoPathFor(cfg, job.repo);
    if (!repoPath) {
      throw new JobError(
        `el repo ${job.repo} no está mapeado en el equipo "${cfg.name}": corre \`roz-runner repo add ${job.repo} <ruta del clon>\``,
      );
    }
    if (!fs.exists(path.join(repoPath, '.git'))) {
      throw new JobError(`la ruta ${repoPath} (mapeada para ${job.repo}) no es un repositorio git`);
    }
    if (!isSafeBranch(job.branch)) throw new JobError(`nombre de rama inválido: "${job.branch}"`);

    // ---- 2. worktree aislado
    await step('preparando', `preparando worktree en ${job.branch}`, 5);
    const prepared = await prepareWorktree(job, repoPath, deps, signal);
    worktree = prepared.path;
    const base = prepared.base;
    const planPath = path.join(worktree, PLAN_FILE);

    // ---- 3. planear
    let planMd = job.planMd;
    let prompt = job.prompt;
    let tools: readonly string[] = job.allowedTools.length ? job.allowedTools : RUNNER_ALLOWED_TOOLS_PLAN;
    let maxTurns = job.maxTurns || MAX_TURNS_PLAN;

    if (job.phase === 'planear') {
      // Con "pedir cambios" llega el borrador anterior: se deja en PLAN.md para que Claude lo corrija.
      if (planMd) await fs.write(planPath, planMd);
      else await fs.rm(planPath);
      await step('planeando', 'Claude Code está escribiendo el plan', 15);
      await runClaude(job, deps, signal, { cwd: worktree, prompt, tools, maxTurns });
      planMd = ((await fs.read(planPath)) ?? '').trim();
      if (!planMd) throw new JobError('Claude Code terminó sin escribir PLAN.md');

      const res = await report('plan_ready', { planMd });
      log.info(`${tag} · plan listo (${res.status})`);
      if (!res.continue) {
        await removeWorktree(git, repoPath, worktree, deps);
        return 'plan_ready';
      }
      // Riesgo 0: sigue con el mismo lease y el plan recién escrito.
      prompt = buildImplementPrompt(job, planMd);
      tools = RUNNER_ALLOWED_TOOLS_IMPLEMENT;
      maxTurns = MAX_TURNS_IMPLEMENT;
    } else {
      if (job.risk === 2) {
        // El servidor nunca debería mandarlo (check de la base); por si acaso no se implementa.
        await report('released', { message: 'riesgo 2: lo implementa una persona' });
        await removeWorktree(git, repoPath, worktree, deps);
        return 'released';
      }
      if (planMd) await fs.write(planPath, planMd);
      tools = job.allowedTools.length ? job.allowedTools : RUNNER_ALLOWED_TOOLS_IMPLEMENT;
      maxTurns = job.maxTurns || MAX_TURNS_IMPLEMENT;
    }

    // ---- 4. implementar
    await step('implementando', 'Claude Code está implementando el plan', 40);
    await runClaude(job, deps, signal, { cwd: worktree, prompt, tools, maxTurns });

    // ---- 5. commit de lo que haya quedado + push
    await step('publicando', 'subiendo la rama', 85);
    const status = await run(exec, git, ['-C', worktree, 'status', '--porcelain'], { signal });
    if (status.stdout.trim()) {
      await run(exec, git, ['-C', worktree, 'add', '-A'], { signal });
      await run(exec, git, ['-C', worktree, 'commit', '-m', prTitle(job.identifier, job.issue.title)], { signal });
    }
    const ahead = await run(exec, git, ['-C', worktree, 'rev-list', '--count', `origin/${base}..HEAD`], { signal });
    if (Number(ahead.stdout.trim() || '0') === 0) throw new JobError('la implementación no produjo ningún commit');
    await run(exec, git, ['-C', worktree, 'push', '-u', 'origin', job.branch], { signal });

    // ---- 6. PR
    await step('pr', 'abriendo la PR', 95);
    const pr = await openPr(job, base, worktree, planMd, deps, signal);
    await report('pr_opened', { branch: job.branch, prNumber: pr.prNumber, prUrl: pr.prUrl });
    log.info(`${tag} · PR abierta: ${pr.prUrl}`);
    await removeWorktree(git, repoPath, worktree, deps);
    return 'pr_opened';
  } catch (err) {
    if (signal.aborted) {
      if (signal.reason === SHUTDOWN) {
        try {
          await report('released', { message: 'el runner se detuvo; el plan regresa a la cola' });
          log.info(`${tag} · regresado a la cola`);
          return 'released';
        } catch (e) {
          log.warn(`${tag} · no se pudo regresar a la cola (${(e as Error).message}); el watchdog lo regresará`);
        }
      } else {
        log.info(`${tag} · detenido (${String(signal.reason ?? 'stop')})`);
      }
      return 'stopped';
    }
    if (err instanceof LeaseLostError) {
      log.warn(`${tag} · el plan ya no es de este runner (lease perdido); se deja de trabajar en él`);
      return 'lease_lost';
    }
    const message = err instanceof AbortedError ? 'tiempo agotado' : (err as Error).message || String(err);
    log.error(`${tag} · ${message}`);
    try {
      await report('failed', { error: message.slice(0, MAX_ERROR_LEN) });
    } catch (e) {
      if (!(e instanceof LeaseLostError)) log.warn(`${tag} · no se pudo reportar el error: ${(e as Error).message}`);
    }
    return 'failed';
  }
}

async function reportProgress(api: Pick<RozClient, 'progress'>, body: RunnerProgressRequest): Promise<RunnerProgressResponse> {
  try {
    return await api.progress(body);
  } catch (err) {
    if (err instanceof RozApiError && err.code === 'LEASE_LOST') throw new LeaseLostError(err.message);
    throw err;
  }
}

async function prepareWorktree(
  job: RunnerJob,
  repoPath: string,
  deps: JobDeps,
  signal: AbortSignal,
): Promise<{ path: string; base: string }> {
  const { exec, fs, cfg, home } = deps;
  const git = cfg.gitBin ?? 'git';
  await run(exec, git, ['-C', repoPath, 'fetch', 'origin', '--prune'], { signal });

  let base = job.baseBranch;
  if (!base) {
    const head = await exec(git, ['-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { signal });
    base = (head.code === 0 ? parseDefaultBranch(head.stdout) : null) ?? 'main';
  }

  const wt = worktreePathFor(worktreesDir(cfg, home), job.repo!, job.identifier);
  let reuse = false;
  if (fs.exists(wt)) {
    const head = await exec(git, ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'], { signal });
    if (head.code === 0 && head.stdout.trim() === job.branch) {
      reuse = true; // un intento anterior (reencolado) dejó avance aquí
    } else {
      await exec(git, ['-C', repoPath, 'worktree', 'remove', '--force', wt], { signal });
      await fs.rm(wt);
      await exec(git, ['-C', repoPath, 'worktree', 'prune'], { signal });
    }
  }

  if (!reuse) {
    const local = (await exec(git, ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${job.branch}`], { signal })).code === 0;
    const remote =
      (await exec(git, ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${job.branch}`], { signal })).code === 0;
    await fs.mkdirp(path.dirname(wt));
    await run(exec, git, ['-C', repoPath, ...worktreeAddArgs(wt, job.branch, base, { local, remote })], { signal });
  }

  // PLAN.md nunca entra al commit: se ignora en info/exclude (compartido por los worktrees del repo).
  const excl = await run(exec, git, ['-C', wt, 'rev-parse', '--git-path', 'info/exclude'], { signal });
  const exclPath = path.resolve(wt, excl.stdout.trim());
  const current = (await fs.read(exclPath)) ?? '';
  if (!/^\/?PLAN\.md\s*$/m.test(current)) {
    await fs.mkdirp(path.dirname(exclPath));
    await fs.append(exclPath, `${current && !current.endsWith('\n') ? '\n' : ''}/${PLAN_FILE}\n`);
  }
  return { path: wt, base };
}

async function runClaude(
  job: RunnerJob,
  deps: JobDeps,
  signal: AbortSignal,
  o: { cwd: string; prompt: string; tools: readonly string[]; maxTurns: number },
): Promise<ClaudeOutcome> {
  const { exec, fs, cfg, home, log } = deps;
  const tmp = path.join(home, 'tmp');
  await fs.mkdirp(tmp);
  const mcpConfigPath = path.join(tmp, `mcp-${job.planId}.json`);
  await fs.write(mcpConfigPath, buildMcpConfig(deps.mcpUrl, cfg.token), { private: true });
  try {
    const args = buildClaudeArgs({ allowedTools: o.tools, maxTurns: o.maxTurns, mcpConfigPath });
    const r = await exec(cfg.claudeBin ?? 'claude', args, {
      cwd: o.cwd,
      input: o.prompt,
      signal,
      timeoutMs: deps.claudeTimeoutMs ?? CLAUDE_TIMEOUT_MS,
      onLine: (line, stream) => {
        if (stream === 'stderr' && line.trim()) log.debug(`${job.identifier} · claude: ${line.trim()}`);
      },
    });
    if (r.aborted) throw new AbortedError();
    if (r.code === 127 || /ENOENT/.test(r.stderr)) {
      throw new JobError('no se encontró Claude Code (`claude`): instálalo o configura claudeBin en ~/.roz-runner/config.json');
    }
    const out = parseClaudeOutput(r.stdout, r.code);
    if (!out.ok) throw new JobError(`Claude Code no terminó: ${out.result}`);
    log.debug(`${job.identifier} · claude terminó en ${out.turns ?? '?'} turnos`);
    return out;
  } finally {
    await fs.rm(mcpConfigPath).catch(() => undefined);
  }
}

async function openPr(
  job: RunnerJob,
  base: string,
  worktree: string,
  planMd: string | null,
  deps: JobDeps,
  signal: AbortSignal,
): Promise<{ prNumber: number; prUrl: string }> {
  const { exec, fs, cfg, home } = deps;
  const gh = cfg.ghBin ?? 'gh';
  const repo = job.repo!;
  const tmp = path.join(home, 'tmp');
  await fs.mkdirp(tmp);
  const bodyFile = path.join(tmp, `pr-${job.planId}.md`);
  await fs.write(bodyFile, buildPrBody(job, planMd));
  try {
    const r = await exec(
      gh,
      ghPrCreateArgs({ repo, base, branch: job.branch, title: prTitle(job.identifier, job.issue.title), bodyFile }),
      { cwd: worktree, signal },
    );
    if (r.aborted) throw new AbortedError();
    if (r.code === 0) {
      const pr = parsePrUrl(r.stdout);
      if (pr) return pr;
    }
    // Ya existía una PR para la rama (reintento) o gh no imprimió la URL: se consulta.
    const view = await exec(gh, ghPrViewArgs(repo, job.branch), { cwd: worktree, signal });
    if (view.aborted) throw new AbortedError();
    if (view.code === 0) {
      try {
        const j = JSON.parse(view.stdout) as { number?: number; url?: string };
        if (j.number && j.url) return { prNumber: j.number, prUrl: j.url };
      } catch {
        /* cae al error */
      }
    }
    const why = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ');
    if (r.code === 127 || /ENOENT/.test(r.stderr)) {
      throw new JobError('no se encontró GitHub CLI (`gh`): instálalo y corre `gh auth login`');
    }
    throw new JobError(`no se pudo abrir la PR: ${why || 'gh falló'}`);
  } finally {
    await fs.rm(bodyFile).catch(() => undefined);
  }
}

async function removeWorktree(git: string, repoPath: string, worktree: string, deps: JobDeps): Promise<void> {
  const r = await deps.exec(git, ['-C', repoPath, 'worktree', 'remove', '--force', worktree]);
  if (r.code !== 0) deps.log.debug(`no se pudo quitar el worktree ${worktree}`);
}
