-- 0044 — zeus: conectar una PC aprobando en el navegador (estilo "device authorization", RFC 8628).
--
-- `zeus setup` ya no pide copiar un token: el CLI abre una solicitud (device_code secreto + user_code
-- corto que se lee en la terminal), la persona la aprueba en roz (/conectar, con su sesión) y el CLI,
-- que estaba consultando, recibe UNA vez un token zeus_… normal (fila en zeus_token) a nombre de
-- quien aprobó.
--
-- La tabla NO guarda nada que sirva para entrar:
--   · device_code: solo su sha256 (como zeus_token). Un volcado no permite cobrar la aprobación.
--   · el token: no existe hasta la entrega. Se crea en el momento en que el CLI (con el device_code
--     en claro) cobra la solicitud aprobada, y la fila pasa a 'delivered' en la misma operación
--     condicional: un segundo cobro ya no encuentra nada que entregar.
-- Expiran a los 10 minutos (expires_at). Idempotente.

create table if not exists roz.zeus_device_auth (
  id                uuid primary key default gen_random_uuid(),
  -- sha256 hex del device_code (secreto que solo conoce el CLI).
  device_code_hash  text not null unique,
  -- Código corto que la persona compara entre la terminal y la web (XXXX-XXXX, sin vocales ni
  -- caracteres ambiguos). Único solo mientras está pendiente.
  user_code         text not null,
  -- Lo que el CLI dice de sí mismo (para que la persona reconozca el equipo al aprobar).
  client_name       text not null default '',
  client_platform   text,
  client_version    text,
  client_ip         text,
  -- pending → approved → delivered, o pending → denied. La expiración se mira con expires_at.
  status            text not null default 'pending',
  -- Quién aprobó o rechazó (el token se emite a su nombre).
  dev_id            uuid references roz.dev(id) on delete cascade,
  decided_at        timestamptz,
  -- El token que se entregó (solo su fila: el token en claro nunca se guarda).
  token_id          uuid references roz.zeus_token(id) on delete set null,
  delivered_at      timestamptz,
  -- Última consulta del CLI (para el "slow_down" del intervalo).
  last_poll_at      timestamptz,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  constraint zeus_device_auth_status_check check (status in ('pending', 'approved', 'denied', 'delivered'))
);

-- Un user_code identifica UNA solicitud viva: dos pendientes con el mismo código no pueden convivir.
create unique index if not exists uq_zeus_device_auth_user_code_pending
  on roz.zeus_device_auth (user_code)
  where status = 'pending';
create index if not exists idx_zeus_device_auth_expires on roz.zeus_device_auth (expires_at);

-- RLS deny-all como el resto de roz: solo el service_role (zeus) la toca.
grant all on roz.zeus_device_auth to service_role;
alter table roz.zeus_device_auth enable row level security;
