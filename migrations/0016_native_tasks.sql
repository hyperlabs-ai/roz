-- 0016 — Tareas nativas. roz deja de depender de Linear como gestor de tareas: ahora se crean y
-- gestionan DESDE la app. Se reusa roz.work_item (hereda toda la atribución por PR y la UI) en vez
-- de una tabla nueva; una tarea nativa es un work_item con source='native' y sin linear_id.
--
-- · linear_id pasa a nullable (las nativas no nacen en Linear).
-- · Agendado tipo calendario: scheduled_start/end (bloques con hora). due_date ya existe (0007).
-- · Jerarquía de subtareas (parent_id) y autoría del dashboard (created_by = auth.users.id).
-- · Estado de código EN VIVO: pr_state + head_ref (antes solo se guardaba el PR mergeado).
-- · commit.work_item_id: liga cada commit a su tarea → esfuerzo real (commits/líneas/hyperpoints).
-- · work_item_comment: comentarios nativos. work_item_counter + RPC: identificador local por proyecto.
-- Idempotente, como el resto.

-- linear_id ya no es obligatorio: las tareas nativas no tienen origen en Linear. El unique se
-- mantiene (varios NULL conviven en Postgres). identifier sigue NOT NULL UNIQUE y se genera local.
alter table roz.work_item alter column linear_id drop not null;

-- source ya es text libre (0011): 'native' entra sin cambio de dominio. Nuevas columnas:
alter table roz.work_item add column if not exists scheduled_start timestamptz;  -- inicio del bloque en el calendario
alter table roz.work_item add column if not exists scheduled_end   timestamptz;  -- fin del bloque
alter table roz.work_item add column if not exists parent_id       uuid references roz.work_item(id) on delete cascade; -- subtareas
alter table roz.work_item add column if not exists created_by      uuid;         -- auth.users.id (usuario del dashboard, no roz.dev)
alter table roz.work_item add column if not exists pr_state        text;         -- 'open' | 'merged' | 'closed' (estado del PR ligado, en vivo)
alter table roz.work_item add column if not exists head_ref        text;         -- rama de trabajo (headRef del PR / rama creada)

create index if not exists idx_roz_work_item_scheduled on roz.work_item(scheduled_start);
create index if not exists idx_roz_work_item_parent    on roz.work_item(parent_id);
create index if not exists idx_roz_work_item_assignee  on roz.work_item(assignee_dev_id);

-- Liga el commit a su tarea (por convención ROZ-123 en el mensaje). Permite sumar el esfuerzo real.
alter table roz.commit add column if not exists work_item_id uuid references roz.work_item(id) on delete set null;
create index if not exists idx_roz_commit_work_item on roz.commit(work_item_id);

-- ---------- Comentarios de tarea ----------
create table if not exists roz.work_item_comment (
  id            uuid primary key default gen_random_uuid(),
  work_item_id  uuid not null references roz.work_item(id) on delete cascade,
  author_id     uuid,                                   -- auth.users.id de quien comenta
  author_name   text,                                   -- nombre resuelto al momento (defensivo)
  body          text not null,
  mentions      uuid[] not null default '{}',           -- devs mencionados (@)
  created_at    timestamptz not null default now()
);
create index if not exists idx_roz_wic_work_item on roz.work_item_comment(work_item_id);

-- ---------- Generador de identificador nativo por proyecto ----------
-- Un contador por proyecto. Se siembra con el max(number) existente para NO colisionar con los
-- HYP-N históricos de Linear: las tareas nativas continúan la numeración a partir del último.
create table if not exists roz.work_item_counter (
  project_id   uuid primary key references roz.project(id) on delete cascade,
  last_number  int not null default 0
);

insert into roz.work_item_counter (project_id, last_number)
select project_id, max(number)
from roz.work_item
where project_id is not null and number is not null
group by project_id
on conflict (project_id) do nothing;

-- Devuelve el siguiente número para el proyecto, de forma atómica (el UPDATE toma el row lock).
-- Si el proyecto aún no tiene contador, lo inicializa desde el max(number) actual (o 0).
create or replace function roz.next_work_item_number(p_project_id uuid)
returns int
language plpgsql
set search_path = roz, public
as $$
declare
  n int;
begin
  insert into roz.work_item_counter (project_id, last_number)
  values (
    p_project_id,
    coalesce((select max(number) from roz.work_item where project_id = p_project_id), 0) + 1
  )
  on conflict (project_id)
  do update set last_number = roz.work_item_counter.last_number + 1
  returning last_number into n;
  return n;
end;
$$;

-- ---------- Permisos (además de los default privileges de 0001) ----------
grant all on roz.work_item_comment to service_role;
grant all on roz.work_item_counter to service_role;
grant execute on function roz.next_work_item_number(uuid) to service_role;

-- RLS deny-all (sin políticas) como el resto de tablas de roz: el service_role la bypassa (todo el
-- backend corre con él), anon/authenticated no tienen grants → nadie más las lee. Consistente con
-- el hardening. Idempotente.
alter table roz.work_item_comment enable row level security;
alter table roz.work_item_counter enable row level security;
