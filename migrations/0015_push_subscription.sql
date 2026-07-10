-- 0015 — Suscripciones Web Push (notificaciones a la PWA). Cada navegador/dispositivo que un
-- usuario del dashboard autoriza para recibir notificaciones guarda aquí su suscripción push.
-- Las notificaciones (hoy: alertas de infraestructura, las mismas que van por correo) se envían
-- a estas suscripciones además del email.
--
-- Puente de identidades: quien se suscribe es un usuario de auth (Supabase auth.users, vía el
-- JWT del dashboard); las alertas apuntan a roz.dev (por email). Guardamos ambos: `auth_user_id`
-- (quién autorizó) y `dev_id` (a qué developer corresponde, resuelto por email) para poder
-- disparar el push por el mismo dev que ya itera el bucle de alertas.
create table if not exists roz.push_subscription (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  text not null,                          -- id de Supabase auth (c.get('user').id)
  dev_id        uuid references roz.dev(id) on delete set null,  -- developer (por email), si existe
  email         text,                                   -- email del usuario al suscribirse
  endpoint      text not null unique,                   -- endpoint del push service (único por suscripción)
  p256dh        text not null,                          -- clave pública del cliente (cifrado del payload)
  auth          text not null,                          -- secreto de autenticación del cliente
  user_agent    text,                                   -- para distinguir dispositivos en la UI
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index if not exists idx_roz_push_subscription_dev on roz.push_subscription(dev_id);
create index if not exists idx_roz_push_subscription_user on roz.push_subscription(auth_user_id);

grant all on roz.push_subscription to service_role;
