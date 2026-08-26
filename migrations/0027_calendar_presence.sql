-- 0027 — Presencia en vivo desde Google Calendar.
--
-- El problema: roz no sabe si un dev está disponible salvo por `roz.dev.availability`, un slider
-- manual que casi nadie mueve. Antes de asignar una tarea o interrumpir a alguien no hay forma de
-- saber si esa persona está en una junta o en clase.
--
-- La solución reusa el patrón que ya funciona para infraestructura (roz.service_snapshot): un cron
-- sondea la API externa y guarda un snapshot; el dashboard lee el snapshot y NUNCA le pega a Google.
--
-- El detalle que hace que esto se sienta "en vivo" pese a un cron de 5 minutos: aquí se cachea la
-- AGENDA (bloques con hora de inicio y fin), no el ESTADO. Ocupado/libre se deriva de now() contra
-- esos bloques en cada lectura, así que el instante en que una junta empieza o termina es exacto al
-- segundo. Lo único que puede tardar hasta 5 min en aparecer es un evento recién creado o movido.
--
-- Alcance deliberado: solo ocupado/libre, sin categorías junta/clase — el título del evento ya lo
-- comunica. Y NO alimenta al router de asignación: `dev.availability` sigue siendo manual.
--
-- Aditiva e idempotente, como el resto.

-- ---------- Cuenta de Google conectada, una por dev ----------
-- Análoga a roz.push_subscription: credenciales de un servicio externo por persona, con el mismo
-- puente de identidades — `auth_user_id` (quién autorizó, desde el JWT del dashboard) y `dev_id`
-- (a qué developer corresponde).
--
-- Los tokens se guardan CIFRADOS (AES-256-GCM, src/utils/crypto.ts). Es la primera credencial de
-- larga vida y por-persona que roz almacena: un refresh_token de Google en claro daría acceso a la
-- agenda de alguien a cualquiera que leyera un backup.
create table if not exists roz.dev_calendar_account (
  id                 uuid primary key default gen_random_uuid(),
  dev_id             uuid not null unique references roz.dev(id) on delete cascade,
  auth_user_id       text,                    -- id de Supabase auth (c.get('user').id)
  google_email       text,                    -- cuenta conectada, para mostrarla en Configuración
  refresh_token_enc  text not null,           -- cifrado; el que sobrevive entre sesiones
  access_token_enc   text,                    -- cifrado; vida ~1h, se renueva solo
  access_expires_at  timestamptz,
  scope              text,
  -- active   = funcionando
  -- revoked  = el usuario quitó el acceso en Google (invalid_grant); hay que reconectar
  -- error    = fallo repetido que no es revocación (se reintenta en la siguiente corrida)
  status             text not null default 'active',
  last_error         text,
  last_synced_at     timestamptz,             -- si esto envejece, el estado se reporta como "stale"
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_roz_dev_calendar_account_status on roz.dev_calendar_account(status);

-- ---------- `state` de un solo uso del flujo OAuth ----------
-- El SPA se autentica con Bearer JWT, no con cookies; pero el redirect de Google al callback es una
-- navegación normal del browser que NO lleva ese header. Este `state` es lo que transporta la
-- identidad del dev entre las dos patas del flujo — y de paso es la defensa contra CSRF.
--
-- De un solo uso (`used_at`) y de vida corta (`expires_at`): un state reutilizable permitiría a
-- quien lo interceptara colgar SU cuenta de Google del dev equivocado.
create table if not exists roz.oauth_state (
  state         text primary key,             -- 32 bytes aleatorios en hex
  provider      text not null default 'google',
  dev_id        uuid not null references roz.dev(id) on delete cascade,
  auth_user_id  text,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_roz_oauth_state_expires on roz.oauth_state(expires_at);

-- ---------- La agenda cacheada ----------
-- Un bloque = una instancia de evento ya resuelta (`singleEvents=true` en la API, así que las
-- recurrencias vienen expandidas y cada una trae su propio id).
--
-- Solo se guarda lo mínimo para decir "ocupado hasta las 11:30 · <título>". Nada de invitados,
-- ubicación, descripción ni adjuntos: lo que no se guarda no se puede filtrar por accidente.
create table if not exists roz.calendar_block (
  id               uuid primary key default gen_random_uuid(),
  dev_id           uuid not null references roz.dev(id) on delete cascade,
  calendar_id      text not null,
  google_event_id  text not null,
  title            text,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  -- Los eventos de todo el día se guardan pero NO cuentan como ocupado: un cumpleaños o unas
  -- vacaciones marcadas de 00:00 a 00:00 no significan estar en junta ahora mismo.
  all_day          boolean not null default false,
  event_status     text,                      -- confirmed | tentative (cancelled no se guarda)
  -- Marca de la corrida que lo escribió. El poll borra lo que quedó con un synced_at viejo: así los
  -- eventos borrados o movidos desaparecen SIN abrir un hueco en el que el dev se vea libre a media
  -- junta (que es lo que pasaría con un delete-then-insert).
  synced_at        timestamptz not null default now(),
  -- calendar_id va en la llave porque el mismo evento puede aparecer en dos calendarios del usuario.
  unique (dev_id, calendar_id, google_event_id)
);
-- La única consulta en caliente: los bloques de todos los devs en la ventana vigente.
create index if not exists idx_roz_calendar_block_window on roz.calendar_block(dev_id, starts_at, ends_at);

-- ---------- Permisos ----------
-- RLS deny-all como el resto de roz: el service_role (backend) la bypassa; anon/authenticated no
-- tienen grants, así que nadie lee estas tablas directo. Importa más que de costumbre: aquí viven
-- tokens de Google y títulos de eventos de agendas personales.
grant all on roz.dev_calendar_account to service_role;
grant all on roz.oauth_state to service_role;
grant all on roz.calendar_block to service_role;

alter table roz.dev_calendar_account enable row level security;
alter table roz.oauth_state enable row level security;
alter table roz.calendar_block enable row level security;
