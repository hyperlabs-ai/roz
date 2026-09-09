-- 0028 — Interruptores de notificaciones (killswitch de equipo + preferencia por persona).
--
-- El problema: cuando el proveedor de correo se rompe o se agota (dominio sin verificar, cuota
-- consumida), roz sigue intentando enviar en cada drain hasta agotar los 5 intentos y llenar el
-- dead-letter de eventos "Aviso sin enviar". La única forma de pararlo era borrar RESEND_API_KEY de
-- Vercel y redesplegar — o sea, un cambio de infraestructura para un problema temporal.
--
-- La solución: un interruptor en DATOS, no en env. Dos alcances:
--   · global  → apaga TODO el correo (Resend) y/o todo el push de roz, para todo el entorno.
--   · dev     → cada persona silencia SUS propios avisos, sin afectar al resto.
-- El envío requiere que ambos estén encendidos. Vive en la base (no en env) para que apagarlo sea
-- inmediato y sin redeploy, y para que quede registro de quién lo apagó y cuándo.
--
-- Nota sobre el push: el toggle "en este dispositivo" (roz.push_subscription) sigue siendo el
-- control fino de cada navegador. `push_enabled` de alcance `dev` es el "silénciame en todos mis
-- dispositivos", y el global es el killswitch del equipo.
--
-- Aditiva e idempotente, como el resto.

create table if not exists roz.notification_switch (
  id             uuid primary key default gen_random_uuid(),
  -- 'global' = todo el entorno; 'dev' = una persona (dev_id).
  scope          text not null check (scope in ('global', 'dev')),
  dev_id         uuid unique references roz.dev(id) on delete cascade,
  email_enabled  boolean not null default true,
  push_enabled   boolean not null default true,
  -- Quién movió el interruptor (email del dashboard) y cuándo. Sin esto, "¿por qué nadie recibe
  -- correos?" es indistinguible de una falla del proveedor.
  updated_by     text,
  updated_at     timestamptz not null default now(),
  -- El alcance determina si hay dev: global sin dev_id, dev con dev_id. Sin este check, un
  -- 'global' con dev_id sería una fila que el código nunca leería (apagado fantasma).
  constraint notification_switch_scope_shape
    check ((scope = 'global' and dev_id is null) or (scope = 'dev' and dev_id is not null))
);

-- Una sola fila global. Índice PARCIAL porque `dev_id unique` no puede garantizarlo (en Postgres
-- los NULL no colisionan entre sí, así que sin esto cabrían N filas globales contradictorias).
create unique index if not exists idx_roz_notification_switch_global
  on roz.notification_switch (scope)
  where scope = 'global';

-- Fila global sembrada encendida: el estado por defecto de roz es "notifica".
insert into roz.notification_switch (scope, email_enabled, push_enabled)
values ('global', true, true)
on conflict do nothing;

-- ---------- Permisos ----------
-- RLS deny-all como el resto de roz: el service_role (backend) la bypassa; anon/authenticated no
-- tienen grants. El dashboard lee y escribe por /api/dashboard, nunca la tabla directo.
grant all on roz.notification_switch to service_role;

alter table roz.notification_switch enable row level security;
