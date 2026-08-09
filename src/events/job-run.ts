// Latido de los jobs periódicos (migración 0026). Hasta ahora ningún cron dejaba rastro: si
// /v1/internal/drain dejara de invocarse, nadie se enteraría. Y como la cola sana está vacía casi
// siempre, "al día" y "el drain lleva horas muerto" se ven idénticos desde fuera. Registrar cada
// corrida es la única forma honesta de que el dashboard afirme que el pipeline está vivo.
//
// Todo aquí es best-effort: la observabilidad NUNCA debe tumbar el trabajo que observa.
import { db } from '../db/supabase.js';

export interface JobRun {
  job: string;
  lastRunAt: string;
  durationMs: number | null;
  error: string | null;
}

/** Registra (upsert) la última corrida de un job. Silencioso ante fallos, a propósito. */
export async function recordJobRun(
  job: string,
  run: { durationMs: number; result?: unknown; error?: string | null },
): Promise<void> {
  await db()
    .from('job_run')
    .upsert(
      {
        job,
        last_run_at: new Date().toISOString(),
        duration_ms: Math.round(run.durationMs),
        result: run.result ?? null,
        error: run.error ?? null,
      },
      { onConflict: 'job' },
    )
    .then(undefined, () => {});
}

/** Última corrida conocida de un job, o null si nunca corrió (o si la tabla aún no existe). */
export async function lastJobRun(job: string): Promise<JobRun | null> {
  const { data, error } = await db()
    .from('job_run')
    .select('job, last_run_at, duration_ms, error')
    .eq('job', job)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { job: string; last_run_at: string; duration_ms: number | null; error: string | null };
  return { job: row.job, lastRunAt: row.last_run_at, durationMs: row.duration_ms, error: row.error };
}
