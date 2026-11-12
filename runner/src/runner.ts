// El bucle de `roz-runner start`:
//   register → latido cada heartbeatIntervalMs (manda los planes corriendo y su avance; obedece `stop`)
//   → polling saliente a next-job con backoff (retry.ts) mientras haya cupo (--max).
// Ctrl+C: aborta todo con motivo 'shutdown' (cada trabajo reporta `released` y vuelve a la cola).
import os from 'node:os';
import path from 'node:path';
import type { RozClient } from './api.js';
import type { RunnerConfig } from './config.js';
import type { Exec } from './exec.js';
import type { FileOps, Logger } from './fsops.js';
import { SHUTDOWN, runJob, type JobDeps, type JobOutcome, type JobProgress } from './job.js';
import { Backoff, classifyError, decidePoll, errorMessage } from './retry.js';
import { describeSchedule } from './schedule.js';
import type { RunnerJob, RunnerRegisterResponse, RunnerSchedule } from './types.js';
import { VERSION } from './version.js';

export interface RunnerOptions {
  maxConcurrent: number;
  schedule?: RunnerSchedule;
}

interface Active {
  job: RunnerJob;
  controller: AbortController;
  progress: JobProgress;
  startedAt: string;
  done: Promise<JobOutcome>;
}

export interface RunnerDeps {
  api: Pick<RozClient, 'register' | 'heartbeat' | 'nextJob' | 'progress'>;
  exec: Exec;
  fs: FileOps;
  log: Logger;
  cfg: RunnerConfig;
  home: string;
  /** Inyectable para pruebas. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Estado para `roz-runner status` (archivo local). */
  writeState?: (state: RunnerStateFile) => Promise<void>;
}

export interface RunnerStateFile {
  pid: number;
  startedAt: string;
  runnerName: string;
  maxConcurrent: number;
  running: { planId: string; identifier: string; phase: string; step: string | null; message: string | null; since: string }[];
  updatedAt: string;
}

export function statePath(home: string): string {
  return path.join(home, 'state.json');
}

export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export class Runner {
  private readonly active = new Map<string, Active>();
  private readonly stopController = new AbortController();
  private readonly backoff = new Backoff();
  private registration: RunnerRegisterResponse | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private readonly startedAt = new Date().toISOString();
  private fatal: string | null = null;

  constructor(
    private readonly deps: RunnerDeps,
    private readonly opts: RunnerOptions,
  ) {}

  get running(): number {
    return this.active.size;
  }

  /** Corre hasta que se llame `stop()` o haya un error fatal (token revocado). Devuelve el motivo fatal, si hubo. */
  async start(): Promise<string | null> {
    const { api, log, cfg } = this.deps;
    const sleep = this.deps.sleep ?? sleepAbortable;
    const signal = this.stopController.signal;

    // register con reintentos (la red puede no estar lista al arrancar la PC).
    while (!signal.aborted && !this.registration) {
      try {
        this.registration = await api.register({
          name: cfg.name,
          version: VERSION,
          platform: `${process.platform}-${process.arch} node${process.versions.node} ${os.release()}`,
          ...(this.opts.schedule ? { schedule: this.opts.schedule } : {}),
          maxConcurrent: this.opts.maxConcurrent,
        });
      } catch (err) {
        const decision = decidePoll({ kind: 'error', error: err }, this.backoff);
        if (decision.action === 'stop') return decision.reason;
        log.warn(`no se pudo registrar: ${decision.reason}; reintento en ${Math.round(decision.waitMs / 1000)} s`);
        await sleep(decision.waitMs, signal);
      }
    }
    if (!this.registration) return null;
    this.backoff.reset();

    const reg = this.registration;
    log.info(
      `runner "${reg.runner.name}" de ${reg.dev.name} listo · máx ${this.opts.maxConcurrent} plan(es) · ${describeSchedule(reg.runner.schedule)}`,
    );
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), Math.max(10_000, reg.heartbeatIntervalMs));
    await this.saveState();

    // ---- polling
    while (!signal.aborted && !this.fatal) {
      if (this.active.size >= this.opts.maxConcurrent) {
        await this.waitForSlot(signal);
        continue;
      }
      let waitMs: number;
      try {
        const res = await api.nextJob();
        if (res.job) {
          this.launch(res.job);
          const d = decidePoll({ kind: 'job' }, this.backoff);
          waitMs = d.action === 'wait' ? d.waitMs : 0;
        } else {
          const d = decidePoll({ kind: 'empty', retryAfterMs: res.retryAfterMs }, this.backoff);
          waitMs = d.action === 'wait' ? d.waitMs : 0;
          log.debug(`sin trabajo; siguiente consulta en ${Math.round(waitMs / 1000)} s`);
        }
      } catch (err) {
        const d = decidePoll({ kind: 'error', error: err }, this.backoff);
        if (d.action === 'stop') {
          this.fatal = d.reason;
          break;
        }
        waitMs = d.waitMs;
        log.warn(`next-job: ${d.reason}; reintento en ${Math.round(waitMs / 1000)} s`);
      }
      await sleep(waitMs, signal);
    }

    if (this.fatal) {
      log.error(this.fatal);
      await this.shutdown();
    }
    return this.fatal;
  }

  /** Ctrl+C: aborta los trabajos (regresan a la cola) y espera a que reporten. */
  async shutdown(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.stopController.abort();
    for (const a of this.active.values()) a.controller.abort(SHUTDOWN);
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
    await this.deps.fs.rm(statePath(this.deps.home)).catch(() => undefined);
  }

  private launch(job: RunnerJob): void {
    const { log } = this.deps;
    const controller = new AbortController();
    const entry: Active = {
      job,
      controller,
      progress: { step: 'tomado', message: null, pct: 0 },
      startedAt: new Date().toISOString(),
      done: Promise.resolve('stopped' as JobOutcome),
    };
    log.info(`${job.identifier} · tomado (fase ${job.phase}, riesgo ${job.risk}) — ${job.issue.title}`);
    const jobDeps: JobDeps = {
      exec: this.deps.exec,
      fs: this.deps.fs,
      api: this.deps.api,
      cfg: this.deps.cfg,
      home: this.deps.home,
      mcpUrl: this.registration!.mcpUrl,
      log,
      onProgress: (p) => {
        entry.progress = p;
        void this.saveState();
      },
    };
    entry.done = runJob(job, jobDeps, controller.signal)
      .catch((err) => {
        log.error(`${job.identifier} · error inesperado: ${errorMessage(err)}`);
        return 'failed' as JobOutcome;
      })
      .finally(() => {
        this.active.delete(job.planId);
        void this.saveState();
        this.wake?.();
      });
    this.active.set(job.planId, entry);
    void this.saveState();
  }

  private async waitForSlot(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = () => {
        this.wake = null;
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.wake = done;
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /** Un latido: avance de cada plan corriendo; detiene los que el servidor diga. */
  async heartbeat(): Promise<void> {
    const { api, log } = this.deps;
    try {
      const res = await api.heartbeat({
        running: [...this.active.values()].map((a) => ({
          planId: a.job.planId,
          leaseId: a.job.leaseId,
          progress: { step: a.progress.step, message: a.progress.message, pct: a.progress.pct },
        })),
        version: VERSION,
      });
      for (const s of res.stop) {
        const a = this.active.get(s.planId);
        if (!a) continue;
        log.warn(`${a.job.identifier} · roz pidió detenerlo (${s.reason})`);
        a.controller.abort(`stop:${s.reason}`);
      }
    } catch (err) {
      if (classifyError(err) === 'fatal') {
        this.fatal = errorMessage(err);
        this.stopController.abort();
        return;
      }
      log.debug(`latido falló: ${errorMessage(err)}`);
    }
  }

  private async saveState(): Promise<void> {
    if (!this.deps.writeState) return;
    const state: RunnerStateFile = {
      pid: process.pid,
      startedAt: this.startedAt,
      runnerName: this.registration?.runner.name ?? this.deps.cfg.name,
      maxConcurrent: this.opts.maxConcurrent,
      running: [...this.active.values()].map((a) => ({
        planId: a.job.planId,
        identifier: a.job.identifier,
        phase: a.job.phase,
        step: a.progress.step,
        message: a.progress.message,
        since: a.startedAt,
      })),
      updatedAt: new Date().toISOString(),
    };
    await this.deps.writeState(state).catch(() => undefined);
  }
}
