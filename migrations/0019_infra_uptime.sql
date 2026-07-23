-- 0019 — Agregación server-side para el timeline de disponibilidad (status page) del dashboard.
-- Motivo: leer los snapshots crudos (roz.service_snapshot ≈ 2000 filas/día) topa con el límite de
-- filas de PostgREST (~1000), así que el cliente solo veía ~medio día. Esta función agrega en la
-- base y devuelve ~p_buckets filas (una por bucket de tiempo), inmune a ese límite.
--
-- Buckets de ancho uniforme: el ancho se calcula para apuntar a ~p_buckets barras en el rango,
-- redondeado a horas (mínimo 1h). Devuelve conteos por estado; el umbral anti-ruido y el relleno
-- de huecos los aplica la capa de app (dashboard/queries.ts:getInfraUptime).

create or replace function roz.infra_uptime(
  p_from timestamptz,
  p_to timestamptz,
  p_buckets int default 90
)
returns table (
  bucket_start timestamptz,
  down bigint,
  degraded bigint,
  healthy bigint,
  paused bigint,
  total bigint
)
language sql
stable
as $func$
  with cfg as (
    select greatest(
      3600,
      (ceil(extract(epoch from (p_to - p_from)) / greatest(p_buckets, 1) / 3600) * 3600)
    )::bigint as sec
  )
  select
    to_timestamp(floor(extract(epoch from s.captured_at) / cfg.sec) * cfg.sec) as bucket_start,
    count(*) filter (where s.status = 'down')     as down,
    count(*) filter (where s.status = 'degraded') as degraded,
    count(*) filter (where s.status = 'healthy')  as healthy,
    count(*) filter (where s.status = 'paused')   as paused,
    count(*)                                       as total
  from roz.service_snapshot s
  cross join cfg
  where s.captured_at >= p_from and s.captured_at <= p_to
  group by 1, cfg.sec
  order by 1;
$func$;

grant execute on function roz.infra_uptime(timestamptz, timestamptz, int) to service_role;
