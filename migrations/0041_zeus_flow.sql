-- 0041 — zeus: historial de variables, encargos y planes compartidos en la bandeja.
--
-- 1. Historial de la bóveda. Cada vez que una variable cambia o se borra, el valor que deja de
--    estar vigente pasa a roz.zeus_vault_secret_revision (cifrado igual que siempre: el servidor
--    sigue sin poder leerlo). Se conservan las últimas versiones de cada nombre para ver quién
--    cambió qué y para restaurar. La rotación re-cifra también el historial (el CLI lo manda).
-- 2. La bandeja deja de ser solo "leído / no leído": un mensaje puede ser un ENCARGO (task) o un
--    PLAN de implementación compartido, con estado propio (pendiente → aceptado → hecho, etc.), y
--    los avisos de cambios de variables llegan como kind 'env_change'.
--
-- Idempotente. No toca filas existentes salvo para darles kind = 'message'.

-- ---------- 1. Historial de variables ----------
create table if not exists roz.zeus_vault_secret_revision (
  id           bigint generated always as identity primary key,
  env_id       uuid not null references roz.zeus_vault_env(id) on delete cascade,
  name         text not null,
  -- La versión que TENÍA la variable mientras este valor estuvo vigente.
  version      int not null,
  -- AES-256-GCM con la DEK (zs1.…). NULL = en esta versión la variable se borró.
  ciphertext   text,
  dek_version  int not null,
  set_by       uuid references roz.dev(id) on delete set null,
  set_at       timestamptz not null,
  -- Quién la reemplazó o borró, y cuándo.
  replaced_by  uuid references roz.dev(id) on delete set null,
  replaced_at  timestamptz not null default now(),
  unique (env_id, name, version)
);
create index if not exists idx_zeus_vault_revision_env on roz.zeus_vault_secret_revision (env_id, name, version desc);

grant all on roz.zeus_vault_secret_revision to service_role;
alter table roz.zeus_vault_secret_revision enable row level security;

-- Rotación con historial: además de los secretos vigentes, re-cifra las versiones anteriores que
-- se podían leer con la llave vigente. Las que ya eran ilegibles (de una llave aún más vieja) se
-- descartan: nadie podría abrirlas. Todo o nada, como antes.
-- p_revisions NULL = un CLI anterior al historial: rota igual y el historial legible se descarta
-- (no se puede re-cifrar sin la llave). Un CLI nuevo manda el arreglo y debe venir completo.
drop function if exists roz.zeus_vault_rotate(uuid, int, jsonb, jsonb, uuid);
create or replace function roz.zeus_vault_rotate(
  p_env_id uuid,
  p_from_version int,
  p_grants jsonb,     -- [{ "keyId": uuid, "wrappedDek": text }]
  p_secrets jsonb,    -- [{ "name": text, "ciphertext": text }]
  p_dev_id uuid,
  p_revisions jsonb default null  -- [{ "name": text, "version": int, "ciphertext": text }]
)
returns int
language plpgsql
set search_path = roz, public
as $$
declare
  v_current int;
  v_new int := p_from_version + 1;
  v_existing int;
  v_matched int;
  v_rev_existing int;
  v_rev_matched int;
begin
  select dek_version into v_current from roz.zeus_vault_env where id = p_env_id for update;
  if v_current is null then
    raise exception 'ZEUS_VAULT_ENV_NOT_FOUND';
  end if;
  if v_current <> p_from_version then
    raise exception 'ZEUS_VAULT_STALE';
  end if;
  if jsonb_array_length(p_grants) = 0 then
    raise exception 'ZEUS_VAULT_NO_GRANTS';
  end if;

  select count(*) into v_existing from roz.zeus_vault_secret where env_id = p_env_id;
  select count(*) into v_matched
  from roz.zeus_vault_secret s
  join jsonb_to_recordset(p_secrets) as n(name text, ciphertext text) on n.name = s.name
  where s.env_id = p_env_id;
  if v_matched <> v_existing or jsonb_array_length(p_secrets) <> v_existing then
    raise exception 'ZEUS_VAULT_INCOMPLETE';
  end if;

  -- Las versiones anteriores legibles con la llave vigente deben venir todas re-cifradas.
  if p_revisions is not null then
    select count(*) into v_rev_existing
    from roz.zeus_vault_secret_revision
    where env_id = p_env_id and ciphertext is not null and dek_version = p_from_version;
    select count(*) into v_rev_matched
    from roz.zeus_vault_secret_revision r
    join jsonb_to_recordset(p_revisions) as n(name text, version int, ciphertext text)
      on n.name = r.name and n.version = r.version
    where r.env_id = p_env_id and r.ciphertext is not null and r.dek_version = p_from_version;
    if v_rev_matched <> v_rev_existing or jsonb_array_length(p_revisions) <> v_rev_existing then
      raise exception 'ZEUS_VAULT_INCOMPLETE';
    end if;
  end if;

  delete from roz.zeus_vault_grant where env_id = p_env_id;
  insert into roz.zeus_vault_grant (env_id, key_id, dek_version, wrapped_dek, granted_by)
  select p_env_id, g."keyId", v_new, g."wrappedDek", p_dev_id
  from jsonb_to_recordset(p_grants) as g("keyId" uuid, "wrappedDek" text)
  join roz.zeus_vault_key k on k.id = g."keyId" and k.revoked_at is null;

  update roz.zeus_vault_secret s
  set ciphertext = n.ciphertext, dek_version = v_new, version = s.version + 1, updated_by = p_dev_id, updated_at = now()
  from jsonb_to_recordset(p_secrets) as n(name text, ciphertext text)
  where s.env_id = p_env_id and s.name = n.name;

  update roz.zeus_vault_secret_revision r
  set ciphertext = n.ciphertext, dek_version = v_new
  from jsonb_to_recordset(coalesce(p_revisions, '[]'::jsonb)) as n(name text, version int, ciphertext text)
  where r.env_id = p_env_id and r.name = n.name and r.version = n.version;
  -- Lo que quedó con una llave anterior ya no lo abre nadie.
  delete from roz.zeus_vault_secret_revision
  where env_id = p_env_id and ciphertext is not null and dek_version <> v_new;

  update roz.zeus_vault_env
  set dek_version = v_new, needs_rotation = false, updated_at = now()
  where id = p_env_id;
  return v_new;
end;
$$;

-- ---------- 2. Encargos y planes en la bandeja ----------
alter table roz.zeus_message add column if not exists kind text not null default 'message';
-- NULL para mensajes y avisos; los encargos y planes siempre tienen estado.
alter table roz.zeus_message add column if not exists status text;
alter table roz.zeus_message add column if not exists status_note text;
alter table roz.zeus_message add column if not exists status_at timestamptz;
alter table roz.zeus_message add column if not exists status_by uuid references roz.dev(id) on delete set null;
-- Versión anterior de un plan (al mandarlo ajustado) o mensaje al que responde.
alter table roz.zeus_message add column if not exists parent_id uuid references roz.zeus_message(id) on delete set null;
alter table roz.zeus_message add column if not exists project_id uuid references roz.project(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'zeus_message_kind_check') then
    alter table roz.zeus_message add constraint zeus_message_kind_check
      check (kind in ('message', 'task', 'plan', 'env_change'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'zeus_message_status_check') then
    alter table roz.zeus_message add constraint zeus_message_status_check
      check (
        (kind in ('message', 'env_change') and status is null)
        or (kind in ('task', 'plan') and status in ('pending', 'accepted', 'changes_requested', 'declined', 'done', 'cancelled', 'superseded'))
      );
  end if;
end $$;

create index if not exists idx_zeus_message_open on roz.zeus_message (to_dev_id, created_at desc)
  where status in ('pending', 'accepted', 'changes_requested');
