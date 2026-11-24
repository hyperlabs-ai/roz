-- 0043 — zeus: dar acceso a la bóveda desde la web ("aprobar en la web, cifrar en el CLI").
--
-- El navegador no tiene (ni debe tener) la DEK de un entorno, así que no puede dar acceso por sí
-- mismo. Lo que sí puede es dejar registrada la DECISIÓN: "Fer aprueba que Ana entre a
-- api-hyperhub-production". Esa aprobación queda abierta hasta que alguien con acceso corre
-- `zeus env grant --pending` en su PC: el CLI muestra la huella de cada equipo de Ana, pide
-- confirmación y envuelve la DEK para sus llaves públicas. Al quedar cubiertas todas las llaves
-- vigentes de Ana, la aprobación se marca cumplida.
--
-- La tabla NO guarda material criptográfico: solo quién aprobó a quién, y cuándo se cumplió o se
-- canceló. Idempotente.

create table if not exists roz.zeus_vault_grant_intent (
  id            uuid primary key default gen_random_uuid(),
  env_id        uuid not null references roz.zeus_vault_env(id) on delete cascade,
  to_dev_id     uuid not null references roz.dev(id) on delete cascade,
  -- Quien aprobó (tenía acceso vigente al entorno en ese momento).
  approved_by   uuid references roz.dev(id) on delete set null,
  created_at    timestamptz not null default now(),
  -- Cuándo quedaron cubiertas todas las llaves vigentes del destinatario, y quién cifró.
  fulfilled_at  timestamptz,
  fulfilled_by  uuid references roz.dev(id) on delete set null,
  cancelled_at  timestamptz,
  cancelled_by  uuid references roz.dev(id) on delete set null,
  constraint zeus_vault_grant_intent_one_end check (fulfilled_at is null or cancelled_at is null)
);

-- Una sola aprobación ABIERTA por (entorno, persona): aprobar dos veces no duplica.
create unique index if not exists uq_zeus_vault_grant_intent_open
  on roz.zeus_vault_grant_intent (env_id, to_dev_id)
  where fulfilled_at is null and cancelled_at is null;
create index if not exists idx_zeus_vault_grant_intent_dev on roz.zeus_vault_grant_intent (to_dev_id);

-- RLS deny-all como el resto de roz: solo el service_role (zeus) la toca.
grant all on roz.zeus_vault_grant_intent to service_role;
alter table roz.zeus_vault_grant_intent enable row level security;
