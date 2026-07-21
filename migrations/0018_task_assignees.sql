-- 0018 — Multi-responsable en tareas. Una tarea puede tener VARIOS responsables. Se agrega una
-- tabla junction; `work_item.assignee_dev_id` se conserva como responsable PRIMARIO (el primero de
-- la lista) para no romper lo existente (workload, perfil de dev, notificaciones, resúmenes que ya
-- leen assignee_dev_id). Aditiva.

create table if not exists roz.work_item_assignee (
  work_item_id uuid not null references roz.work_item(id) on delete cascade,
  dev_id       uuid not null references roz.dev(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (work_item_id, dev_id)
);
create index if not exists idx_roz_wi_assignee_dev on roz.work_item_assignee(dev_id);

grant all on roz.work_item_assignee to service_role;
alter table roz.work_item_assignee enable row level security;

-- Backfill: los responsables únicos actuales se reflejan en la junction para consistencia.
insert into roz.work_item_assignee (work_item_id, dev_id)
select id, assignee_dev_id from roz.work_item where assignee_dev_id is not null
on conflict do nothing;
