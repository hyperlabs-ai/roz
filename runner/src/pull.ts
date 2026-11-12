// `roz-runner pull <ID>`: una persona implementa el plan. Marca el plan como jalado en roz (el agente
// ya no corre), crea la rama con el ID de Linear en el repo actual y escribe PLAN.md.
import path from 'node:path';
import type { RozClient } from './api.js';
import { PLAN_FILE, fallbackPlanMd, isSafeBranch, parseDefaultBranch, parseRemoteRepo } from './commands.js';
import { normalizeRepo } from './config.js';
import { run, type Exec } from './exec.js';
import type { FileOps, Logger } from './fsops.js';
import type { RunnerPullRequest, RunnerPullResponse } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINEAR_ID = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/;

/** "HYP-123" | "hyp-123" → { identifier: 'HYP-123' }; un uuid → { planId }. */
export function pullTarget(raw: string): RunnerPullRequest {
  const s = raw.trim();
  if (UUID.test(s)) return { planId: s.toLowerCase() };
  if (LINEAR_ID.test(s)) return { identifier: s.toUpperCase() };
  throw new Error(`"${raw}" no parece un ID de Linear (HYP-123) ni un id de plan`);
}

export interface PullDeps {
  api: Pick<RozClient, 'pull'>;
  exec: Exec;
  fs: FileOps;
  log: Logger;
  cwd: string;
  gitBin?: string;
}

export interface PullResult {
  pull: RunnerPullResponse;
  repoRoot: string;
  branch: string;
  planPath: string;
  createdBranch: boolean;
  warnings: string[];
}

export async function pullPlan(rawId: string, deps: PullDeps): Promise<PullResult> {
  const { exec, fs, log } = deps;
  const git = deps.gitBin ?? 'git';
  const target = pullTarget(rawId);
  const warnings: string[] = [];

  // El repo actual primero: si no es git no tiene caso marcar el plan.
  const top = await exec(git, ['-C', deps.cwd, 'rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new Error('aquí no hay un repositorio git: corre `roz-runner pull` dentro del clon del repo');
  const repoRoot = path.resolve(top.stdout.trim());

  const pull = await deps.api.pull(target);
  if (!isSafeBranch(pull.branch)) throw new Error(`roz devolvió un nombre de rama inválido: "${pull.branch}"`);
  log.info(`${pull.identifier} marcado como "lo implementa una persona"`);

  // ¿Es el repo correcto?
  const remote = await exec(git, ['-C', repoRoot, 'remote', 'get-url', 'origin']);
  const here = remote.code === 0 ? parseRemoteRepo(remote.stdout) : null;
  const expected = pull.repo ? normalizeRepo(pull.repo) : null;
  if (expected && here && expected !== here) {
    warnings.push(`este clon es ${here} pero el plan es de ${expected}; la rama se creó aquí de todos modos`);
  }

  await exec(git, ['-C', repoRoot, 'fetch', 'origin', '--prune']);
  let base = pull.baseBranch;
  if (!base) {
    const head = await exec(git, ['-C', repoRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    base = (head.code === 0 ? parseDefaultBranch(head.stdout) : null) ?? 'main';
  }

  const dirty = await exec(git, ['-C', repoRoot, 'status', '--porcelain']);
  if (dirty.code === 0 && dirty.stdout.trim()) {
    warnings.push('tenías cambios sin commit; se llevaron a la rama nueva');
  }

  const has = async (ref: string) => (await exec(git, ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', ref])).code === 0;
  let createdBranch = false;
  if (await has(`refs/heads/${pull.branch}`)) {
    await run(exec, git, ['-C', repoRoot, 'checkout', pull.branch]);
  } else if (await has(`refs/remotes/origin/${pull.branch}`)) {
    await run(exec, git, ['-C', repoRoot, 'checkout', '--track', '-b', pull.branch, `origin/${pull.branch}`]);
    createdBranch = true;
  } else {
    const start = (await has(`refs/remotes/origin/${base}`)) ? `origin/${base}` : 'HEAD';
    await run(exec, git, ['-C', repoRoot, 'checkout', '--no-track', '-b', pull.branch, start]);
    createdBranch = true;
  }

  const planPath = path.join(repoRoot, PLAN_FILE);
  const content = pull.planMd?.trim() ? pull.planMd : fallbackPlanMd(pull.identifier, pull.issue.title, pull.issue.url);
  if (fs.exists(planPath)) warnings.push(`${PLAN_FILE} ya existía y se reemplazó`);
  await fs.write(planPath, content.endsWith('\n') ? content : content + '\n');

  return { pull, repoRoot, branch: pull.branch, planPath, createdBranch, warnings };
}
