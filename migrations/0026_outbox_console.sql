-- 0026 — Consola de la cola de procesamiento (vista "en vivo" del outbox).
--
-- Hasta ahora el pipeline era invisible: roz procesaba commits y PRs en silencio y no había forma
-- de ver qué estaba por atribuirse ni qué había fallado. Esta migración añade lo mínimo para que
-- la cola sea consultable desde el dashboard:
--   · idx_..._recent    → feed cronológico de lo recién procesado, O(log n + N) pese al histórico.
--   · idx_..._dead      → índice PARCIAL: la lista de muertos no paga el coste del histórico 'done'.
--   · roz.job_run       → latido de los crons, reutilizable por todos.
--   · roz.outbox_pulse  → toda la salud de la cola en UNA llamada.
--
-- Nota deliberada: NO se añade ninguna columna a outbox_event. El código nuevo solo LEE columnas
-- que ya existían, así que puede desplegarse antes o después de esta migración sin romper el
-- drain. Una columna nueva escrita en el claim habría detenido el pipeline entero si el deploy
-- se adelantaba a la migración.

-- ---------- 1. Índices ----------
-- El único índice previo es (status, next_attempt_at), pensado para el drain. El feed pregunta
-- otra cosa: "qué acaba de pasar", o sea order by updated_at desc limit N.
create index if not exists idx_roz_outbox_recent
  on roz.outbox_event (updated_at desc);

-- Dead-letter: PARCIAL a propósito. Los muertos son una fracción mínima de la tabla, y sin el
-- predicado la lista pagaría el coste de recorrer todo el histórico de 'done'.
create index if not exists idx_roz_outbox_dead
  on roz.outbox_event (created_at desc)
  where status = 'dead';

-- ---------- 2. Latido de los jobs ----------
-- Una fila por job ('drain', 'infra-poll', ...). Hoy ningún cron deja rastro, y como la cola sana
-- está vacía casi siempre, "al día" y "el drain lleva horas sin invocarse" se ven IDÉNTICOS. Esta
-- tabla es lo que permite distinguirlos.
create table if not exists roz.job_run (
  job          text primary key,
  last_run_at  timestamptz not null default now(),
  duration_ms  int,
  result       jsonb,
  error        text
);

grant all on roz.job_run to service_role;

-- ---------- 3. Pulso de la cola ----------
-- Toda la salud en un solo round-trip: la vista se sondea cada pocos segundos y no puede pagar
-- media docena de consultas por tick.
--
-- Regla de diseño CLAVE: 'done' nunca se cuenta en global. La tabla crece sin límite (no hay
-- purga), así que un count(*) where status='done' degradaría linealmente para siempre. Su volumen
-- se mide solo por ventana, servido por idx_roz_outbox_recent → la vista es inmune al crecimiento.
create or replace function roz.outbox_pulse(p_window_sec int default 3600)
returns jsonb
language sql
stable
as $func$
  with live as (
    -- Cola viva completa: por prefijo de status en idx_roz_outbox_drain, siempre pequeña.
    select status, next_attempt_at, created_at, updated_at
      from roz.outbox_event
     where status in ('pending', 'processing', 'failed', 'dead')
  ),
  recent as (
    select status
      from roz.outbox_event
     where updated_at >= now() - make_interval(secs => p_window_sec)
  ),
  drain as (
    select last_run_at, duration_ms, result, error
      from roz.job_run
     where job = 'drain'
  )
  select jsonb_build_object(
    'now',            now(),
    'windowSec',      p_window_sec,
    'pending',        (select count(*) from live where status = 'pending'),
    'processing',     (select count(*) from live where status = 'processing'),
    'failed',         (select count(*) from live where status = 'failed'),
    'dead',           (select count(*) from live where status = 'dead'),
    -- Listos para ejecutarse ya vs. esperando su backoff: distinguirlos evita leer "10 en cola"
    -- como un atasco cuando en realidad son reintentos programados a futuro.
    'ready',          (select count(*) from live where status in ('pending','failed') and next_attempt_at <= now()),
    'scheduled',      (select count(*) from live where status in ('pending','failed') and next_attempt_at >  now()),
    'oldestReadyAt',  (select min(created_at) from live where status in ('pending','failed') and next_attempt_at <= now()),
    -- Zombis: llevan más de STUCK_PROCESSING_SEC (300s) en `processing`, a la espera del reaper.
    -- En una fila `processing`, updated_at es la hora del claim (lo sella processEvent) — el mismo
    -- criterio que usa el reaper, para que la UI y el drain no discrepen sobre qué está atascado.
    'stuck',          (select count(*) from live where status = 'processing'
                         and updated_at < now() - interval '300 seconds'),
    'doneWindow',     (select count(*) from recent where status = 'done'),
    'deadWindow',     (select count(*) from recent where status = 'dead'),
    'drainLastRunAt', (select last_run_at from drain),
    'drainLastMs',    (select duration_ms from drain),
    'drainLastError', (select error       from drain)
  );
$func$;

grant execute on function roz.outbox_pulse(int) to service_role;
