-- 0009 — Observabilidad de infraestructura (fase "solo datos"). Mapea cada roz.project a sus
-- servicios externos (Vercel / Railway / Supabase) y guarda un histórico de sondeos. roz NO
-- ejecuta detección de anomalías aún: solo persiste el estado tal cual lo reportan las APIs
-- (estado de deploy, salud, activo/pausado, métricas) para mostrarlo en el dashboard. Los
-- umbrales/alertas son una fase posterior y no requieren cambiar este esquema.

-- ---------- Mapeo proyecto → servicio externo ----------
-- Análogo a roz.project_repo, pero para plataformas de despliegue/datos. `external_ref` es el
-- id del recurso en el proveedor (Vercel projectId, Railway serviceId, Supabase project ref).
-- `config` guarda lo extra que necesita el adapter (teamId de Vercel, environmentId de Railway…).
create table if not exists roz.project_service (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references roz.project(id) on delete cascade,
  provider     text not null,                        -- 'vercel' | 'railway' | 'supabase'
  external_ref text not null,                         -- id/ref del recurso en el proveedor
  label        text,                                  -- nombre legible (para el dashboard)
  config       jsonb not null default '{}'::jsonb,    -- { teamId?, environmentId?, ... }
  created_at   timestamptz not null default now(),
  unique (provider, external_ref)
);
create index if not exists idx_roz_project_service_project on roz.project_service(project_id);

-- ---------- Histórico de sondeos ----------
-- Un row por servicio por ciclo del cron (cada pocos minutos). El dashboard lee el más reciente
-- por servicio; el histórico queda disponible para gráficas y para la futura fase de umbrales.
--   status (normalizado): 'healthy' | 'degraded' | 'down' | 'paused' | 'unknown'
--   ok: la llamada a la API del proveedor tuvo éxito (false = token faltante o error de red/API)
create table if not exists roz.service_snapshot (
  id                 uuid primary key default gen_random_uuid(),
  project_service_id uuid not null references roz.project_service(id) on delete cascade,
  captured_at        timestamptz not null default now(),
  ok                 boolean not null default true,
  status             text not null default 'unknown',
  provider_status    text,                                 -- estado nativo del proveedor
  active             boolean,
  deploy             jsonb,                                 -- { state, url, sha, createdAt }
  metrics            jsonb,                                 -- { requests, ... } (best-effort)
  error              text,
  raw                jsonb                                  -- payload crudo (debug)
);
create index if not exists idx_roz_service_snapshot_latest
  on roz.service_snapshot(project_service_id, captured_at desc);

grant all on roz.project_service to service_role;
grant all on roz.service_snapshot to service_role;
