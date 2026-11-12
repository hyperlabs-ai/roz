-- 0039 — Corrige el histórico de roz.service_snapshot: un deploy fallido NO es una caída.
--
-- Hasta ahora el sondeo guardaba como estado del servicio el del ÚLTIMO intento de deploy: un build
-- en ERROR/FAILED quedaba 'down' y uno en curso 'degraded', aunque el deploy anterior siguiera
-- atendiendo producción. Desde este cambio el estado sale del deploy que sirve (ver
-- src/infra/types.ts) y el intento va aparte en details.lastDeploy.
--
-- Esta migración solo re-etiqueta los snapshots viejos (los que no traen details.lastDeploy) para
-- que la disponibilidad y los incidentes de los últimos 14 días no cuenten esos falsos positivos.
-- Criterio determinístico: el propio snapshot lista en details.recent un deploy exitoso (READY en
-- Vercel, SUCCESS en Railway), o sea que había uno sirviendo. Un CRASHED de Railway SÍ es caída y
-- no se toca. Es idempotente y no cambia el esquema.

update roz.service_snapshot s
set status = 'healthy',
    active = true
from roz.project_service ps
where ps.id = s.project_service_id
  and s.status in ('down', 'degraded')
  and s.details is not null
  and not (s.details ? 'lastDeploy')
  and (
    (
      ps.provider = 'vercel'
      and upper(coalesce(s.provider_status, '')) in ('ERROR', 'BUILDING', 'QUEUED', 'INITIALIZING')
      and s.details -> 'recent' @> '[{"state":"READY"}]'::jsonb
    )
    or (
      ps.provider = 'railway'
      and upper(coalesce(s.provider_status, '')) in ('FAILED', 'BUILDING', 'DEPLOYING', 'INITIALIZING', 'WAITING', 'QUEUED')
      and s.details -> 'recent' @> '[{"state":"SUCCESS"}]'::jsonb
    )
  );
