// Planificador en proceso: sustituye a los crons de Vercel ahora que zeus es un proceso de larga vida.
//
// No duplica lógica: cada job sigue siendo su ruta GET /v1/internal/<job> (con su registro de
// corridas, sus flags y su auth por CRON_SECRET). El planificador solo decide CUÁNDO y la invoca en
// memoria contra el mismo app, sin salir a la red. Las rutas siguen sirviendo para dispararlas a mano.
//
// Supone UNA sola instancia de zeus (el gateway de Discord tampoco admite réplicas). Con dos, los
// jobs correrían doble: el outbox lo aguanta (claim optimista), el resto es idempotente pero gastaría
// llamadas a APIs externas.
import { config } from '../config.js';

type AppFetch = (req: Request) => Response | Promise<Response>;

export interface ScheduledJob {
  /** Ruta bajo /v1/internal. */
  path: string;
  /** Expresión cron de 5 campos, en UTC (igual que los crons de Vercel que reemplaza). */
  cron: string;
}

/** Los mismos horarios que tenía vercel.json. El drain va aparte: corre en su propio ciclo corto. */
export const JOBS: readonly ScheduledJob[] = [
  { path: 'infra-poll', cron: '*/15 * * * *' },
  { path: 'calendar-poll', cron: '*/5 * * * *' },
  { path: 'brain-sweep', cron: '0 9 * * *' },
  { path: 'ops-bridge', cron: '*/30 * * * *' },
  { path: 'weekly-digest', cron: '0 3 * * 6' },
  { path: 'linear-reconcile', cron: '*/30 * * * *' },
  { path: 'granola-poll', cron: '*/5 * * * *' },
  { path: 'plan-watchdog', cron: '*/5 * * * *' },
  { path: 'task-reminders', cron: '0 15 * * 1-5' },
  { path: 'zeus-sweep', cron: '*/10 * * * *' },
];

/** Cada cuánto se drena el outbox. En Vercel era cada minuto (el mínimo de un cron). */
export const DRAIN_EVERY_MS = 15_000;

function fieldMatches(field: string, value: number, min: number): boolean {
  return field.split(',').some((part) => {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = Number.POSITIVE_INFINITY;
    } else if (range!.includes('-')) {
      const [a, b] = range!.split('-').map(Number);
      lo = a!;
      hi = b!;
    } else {
      lo = Number(range);
      // "5/15" = desde 5, cada 15; "5" = exactamente 5.
      hi = stepRaw ? Number.POSITIVE_INFINITY : lo;
    }
    if (!Number.isFinite(lo)) return false;
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

/** True si la expresión cron (5 campos, UTC) cae en el minuto de `date`. */
export function cronMatches(cron: string, date: Date): boolean {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const dow = date.getUTCDay();
  return (
    fieldMatches(f[0]!, date.getUTCMinutes(), 0) &&
    fieldMatches(f[1]!, date.getUTCHours(), 0) &&
    fieldMatches(f[2]!, date.getUTCDate(), 1) &&
    fieldMatches(f[3]!, date.getUTCMonth() + 1, 1) &&
    // 0 y 7 son domingo.
    (fieldMatches(f[4]!, dow, 0) || (dow === 0 && fieldMatches(f[4]!, 7, 0)))
  );
}

export interface Scheduler {
  stop(): Promise<void>;
}

export interface SchedulerOptions {
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
  jobs?: readonly ScheduledJob[];
  drainEveryMs?: number;
}

export function startScheduler(appFetch: AppFetch, opts: SchedulerOptions = {}): Scheduler {
  const log = opts.log ?? (() => undefined);
  const jobs = opts.jobs ?? JOBS;
  const running = new Map<string, Promise<void>>();
  let stopped = false;

  const run = (path: string): void => {
    // Una corrida a la vez por job: si la anterior sigue, este tick se salta (no se apilan).
    if (stopped || running.has(path)) return;
    const t0 = Date.now();
    const p = (async () => {
      try {
        const res = await appFetch(
          new Request(`http://zeus.internal/v1/internal/${path}`, {
            headers: { authorization: `Bearer ${config.cron.secret}` },
          }),
        );
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          log('error', 'job falló', { job: path, status: res.status, ms: Date.now() - t0, body: body.slice(0, 300) });
        } else if (path !== 'drain') {
          log('info', 'job', { job: path, ms: Date.now() - t0 });
        }
      } catch (err) {
        log('error', 'job lanzó', { job: path, err: err instanceof Error ? err.message : String(err) });
      }
    })().finally(() => running.delete(path));
    running.set(path, p);
  };

  const drainTimer = setInterval(() => run('drain'), opts.drainEveryMs ?? DRAIN_EVERY_MS);

  // Tick alineado al inicio de cada minuto, para que "0 9 * * *" corra a las 9:00 y no a las 9:00:37.
  let minuteTimer: NodeJS.Timeout | null = null;
  const tick = () => {
    if (stopped) return;
    const now = new Date();
    for (const j of jobs) if (cronMatches(j.cron, now)) run(j.path);
    minuteTimer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
  };
  minuteTimer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);

  log('info', 'planificador en marcha', { jobs: jobs.length, drainEveryMs: opts.drainEveryMs ?? DRAIN_EVERY_MS });

  return {
    stop: async () => {
      stopped = true;
      clearInterval(drainTimer);
      if (minuteTimer) clearTimeout(minuteTimer);
      // Lo que esté a medias termina (con tope): cortar un drain a la mitad deja eventos en
      // `processing` hasta que el reaper los rescate cinco minutos después.
      await Promise.race([Promise.allSettled([...running.values()]), new Promise((r) => setTimeout(r, 25_000))]);
    },
  };
}
