-- 0029 — Capacidad del equipo: quién es cada quien, en qué está, y cuánto le queda.
--
-- El problema que resuelve: el reparto de trabajo vivía en una tabla de un documento, fuera de
-- roz. Ahí "Proyecto / Enfoque Principal" era texto suelto, así que no se podía cruzar con los
-- proyectos ni los repos que roz ya conoce, y el "Estado de Carga" se escribía a mano — es decir,
-- envejecía en cuanto cambiaba cualquier otra celda.
--
-- Dos ejes SEPARADOS para describir a una persona, y es a propósito:
--   · `role`       — el puesto (ceo, pm, account_manager, dev, designer, intern).
--   · `commitment` — la dedicación (full_time / part_time). De AQUÍ cuelga la regla de negocio:
--                    full_time admite hasta 2 asignaciones principales, part_time solo 1.
-- Mezclarlos en una sola lista ('fulltime' junto a 'ceo') haría imposible expresar un intern de
-- tiempo completo o un PM de medio tiempo sin volver a tocar el esquema.
--
-- `profile` guarda el matiz que ningún enum captura ("Dev Junior / Frontend", "Account Manager &
-- Operations Lead"): es lo que se lee en la columna "Perfil / Rol".
--
-- Aditiva e idempotente, como el resto de migraciones de roz.

-- ---------- 1. Perfil y dedicación del dev ----------
alter table roz.dev add column if not exists role         text not null default 'dev';
alter table roz.dev add column if not exists commitment   text not null default 'part_time';
alter table roz.dev add column if not exists profile      text;
-- Horas semanales REALES de la persona. NULL = usar el default de su dedicación (ver
-- WEEKLY_HOURS en src/dashboard/capacity.ts): así el caso normal no se llena a mano, pero el
-- becario que entra 15 h y el que entra 24 caben sin tocar código.
alter table roz.dev add column if not exists weekly_hours int;
-- Lo que el cálculo no sabe. El % de carga sale de las asignaciones; esta nota es para el matiz
-- que no es una cifra ("Foco Comercial / En Crecimiento").
alter table roz.dev add column if not exists load_note    text;
-- "Cambios Menores / Tareas Continuas": el trabajo de mantenimiento que la persona absorbe al
-- margen de sus proyectos. Se escribe a mano, pero la pantalla lo muestra junto a sus skills y
-- niveles (roz.dev_skill) — que es lo que de verdad dice qué cambios puede tomar.
alter table roz.dev add column if not exists continuous_work text;

do $$ begin
  alter table roz.dev add constraint dev_role_check
    check (role in ('ceo', 'pm', 'account_manager', 'dev', 'designer', 'intern'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table roz.dev add constraint dev_commitment_check
    check (commitment in ('full_time', 'part_time'));
exception when duplicate_object then null; end $$;

-- Horas: 0 no es un dato, es "no trabaja". Se deja NULL para heredar el default.
do $$ begin
  alter table roz.dev add constraint dev_weekly_hours_check
    check (weekly_hours is null or (weekly_hours > 0 and weekly_hours <= 80));
exception when duplicate_object then null; end $$;

-- ---------- 2. Asignaciones: dónde está puesta la capacidad ----------
-- Una fila por foco de trabajo. `kind` distingue principal de secundario porque la regla de
-- cuántas caben sólo aplica a las principales.
--
-- `repo_id` es OPCIONAL y existe por Hyperflow: un proyecto con varios repos donde cada dev tiene
-- el suyo. En un proyecto de un solo repo se deja NULL y se sobreentiende. Va como FK a
-- project_repo (no como texto) para que renombrar un repo no deje asignaciones apuntando al vacío.
--
-- `load_pct` es la parte de la capacidad de esa persona que se lleva esta asignación. La suma de
-- sus filas ES su carga: de ahí sale el porcentaje y la etiqueta, sin que nadie los escriba.
create table if not exists roz.dev_assignment (
  id          uuid primary key default gen_random_uuid(),
  dev_id      uuid not null references roz.dev(id) on delete cascade,
  kind        text not null default 'principal',
  project_id  uuid references roz.project(id) on delete set null,
  repo_id     uuid references roz.project_repo(id) on delete set null,
  -- El enfoque dentro del proyecto ("Infraestructura a AI", "Endpoints y Lógica"): dos devs en el
  -- mismo repo no hacen lo mismo, y el nombre del proyecto solo no lo dice.
  focus       text,
  load_pct    int not null default 0,
  sort_order  int not null default 0,   -- orden dentro de su tipo (principal #1, #2)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

do $$ begin
  alter table roz.dev_assignment add constraint dev_assignment_kind_check
    check (kind in ('principal', 'secondary'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table roz.dev_assignment add constraint dev_assignment_load_check
    check (load_pct >= 0 and load_pct <= 100);
exception when duplicate_object then null; end $$;

create index if not exists idx_roz_dev_assignment_dev on roz.dev_assignment(dev_id);
create index if not exists idx_roz_dev_assignment_project on roz.dev_assignment(project_id);
create index if not exists idx_roz_dev_assignment_repo on roz.dev_assignment(repo_id);

-- El repo tiene que ser DE ese proyecto. Sin esto se puede guardar "proyecto Propi, repo de
-- Hyperflow" y la tabla miente sin que nada se queje. Va como trigger y no como check porque un
-- check no puede consultar otra tabla.
create or replace function roz.dev_assignment_repo_matches_project()
returns trigger
language plpgsql
security definer
set search_path = roz, pg_temp
as $$
declare
  owner_project uuid;
begin
  if new.repo_id is null then
    return new;
  end if;
  select project_id into owner_project from roz.project_repo where id = new.repo_id;
  if owner_project is null then
    raise exception 'El repo % no existe', new.repo_id;
  end if;
  if new.project_id is null then
    -- Un repo sin proyecto no tiene sentido: se adopta el del repo en vez de rechazar.
    new.project_id := owner_project;
  elsif new.project_id <> owner_project then
    raise exception 'El repo no pertenece al proyecto asignado';
  end if;
  return new;
end $$;

drop trigger if exists trg_dev_assignment_repo_project on roz.dev_assignment;
create trigger trg_dev_assignment_repo_project
  before insert or update on roz.dev_assignment
  for each row execute function roz.dev_assignment_repo_matches_project();

-- ---------- 3. Semilla de roles ----------
-- Se aplica SOLO donde el rol sigue en su default, para que volver a correr la migración no pise
-- lo que ya se haya editado a mano en la pantalla.
--
-- El match es por nombre EXACTO o por primer nombre ('fer' / 'fer …'), nunca por prefijo suelto:
-- un `ilike 'fer%'` haría CEO a cualquier Fernanda que entre al equipo, y en silencio. Si algún
-- nombre de roz.dev no coincide, el rol se pone en un clic desde /app/capacity — que para eso la
-- pantalla es editable.
update roz.dev set role = 'ceo', commitment = 'full_time'
  where role = 'dev' and (name ilike 'fer' or name ilike 'fer %');

update roz.dev set role = 'pm', commitment = 'full_time'
  where role = 'dev' and (
    name ilike 'crix' or name ilike 'crix %' or
    name ilike 'cris' or name ilike 'cris %' or
    name ilike 'cristian' or name ilike 'cristian %'
  );

update roz.dev set commitment = 'full_time'
  where role = 'dev' and commitment = 'part_time' and (name ilike 'alan' or name ilike 'alan %');

-- El resto del equipo entra como intern de medio tiempo. Alan queda fuera por su commitment ya
-- puesto arriba; CEO y PM, por su rol.
update roz.dev set role = 'intern'
  where role = 'dev' and commitment = 'part_time';

-- ---------- Permisos ----------
-- RLS deny-all como el resto de roz: el backend entra con service_role y la bypassa; anon y
-- authenticated no tienen grants, así que nadie lee la tabla directo.
grant all on roz.dev_assignment to service_role;
alter table roz.dev_assignment enable row level security;
