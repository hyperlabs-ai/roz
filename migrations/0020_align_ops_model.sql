-- 0020 — Alinea roz.work_item con public.tasks (HyperOps) para que las tareas se puedan
-- intercambiar sin traducir campos. Ops y roz siguen siendo apps independientes: esto solo
-- hace que hablen el mismo idioma cuando una tarea cruza de un lado al otro.
--
-- Motivo: Ops asigna trabajo a un dev y ese trabajo debe aparecer en roz; el avance del dev
-- (PR, estado) debe volver a Ops. Con nombres y vocabularios distintos, cada cruce exigía una
-- capa de parseo que se desincroniza sola. Renombramos en roz porque tiene menos superficie
-- (13 archivos tocan work_item) y porque Ops arrancó sus tareas desde cero.
--
-- · Renombres: title→name, spec→description, state→status (RENAME conserva las 304 filas).
-- · Vocabulario de estado: el de Ops (español). Los 6 estados mapean 1:1, incluido review.
-- · assignee_dev_id NO se renombra: apunta a roz.dev, mientras que tasks.assignee_id apunta a
--   user_profiles. Mismo nombre para entidades distintas sería peor que nombres distintos.
-- · Vínculo: work_item.ops_task_id + dev.ops_user_id (materializa el mapeo por email).
-- Idempotente, como el resto.

-- ---------- 1. Renombres (solo si aún no se aplicaron) ----------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='roz' and table_name='work_item' and column_name='title') then
    alter table roz.work_item rename column title to name;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema='roz' and table_name='work_item' and column_name='spec') then
    alter table roz.work_item rename column spec to description;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema='roz' and table_name='work_item' and column_name='state') then
    alter table roz.work_item rename column state to status;
  end if;
end $$;

-- ---------- 2. Vocabulario de estado: el de Ops ----------
-- Mapeo 1:1. 'triage' y 'done' son legados de los espejos de Linear (0007) y caen en el
-- equivalente más cercano. El check se agrega DESPUÉS de convertir, para no rechazar los datos.
update roz.work_item set status = case status
  when 'backlog'   then 'planificada'
  when 'triage'    then 'pendiente'
  when 'unstarted' then 'pendiente'
  when 'started'   then 'en_progreso'
  when 'review'    then 'revision'
  when 'completed' then 'completada'
  when 'done'      then 'completada'
  when 'canceled'  then 'cancelada'
  else status
end
where status in ('backlog','triage','unstarted','started','review','completed','done','canceled');

alter table roz.work_item drop constraint if exists work_item_status_check;
alter table roz.work_item add constraint work_item_status_check
  check (status in ('planificada','pendiente','en_progreso','revision','completada','cancelada'));

-- state_name guardaba la etiqueta legible ('Por hacer', 'En curso'). Ya no hace falta: la
-- etiqueta se deriva del status en la capa de presentación, igual que en Ops.
alter table roz.work_item drop column if exists state_name;

-- ---------- 3. Vínculo con Ops ----------
-- ops_task_id ancla el work item a su tarea de Ops. Sin FK entre schemas a propósito: roz no
-- debe romperse si Ops borra una tarea; el sync reconcilia.
alter table roz.work_item add column if not exists ops_task_id uuid;

create unique index if not exists idx_roz_work_item_ops_task
  on roz.work_item(ops_task_id) where ops_task_id is not null;

-- Materializa el mapeo dev↔usuario de Ops, que hoy es implícito (se resolvía por email en cada
-- consulta). Se rellena abajo con los emails que ya coinciden 1:1.
alter table roz.dev add column if not exists ops_user_id uuid;

update roz.dev d
set ops_user_id = up.user_id
from public.user_profiles up
where lower(up.email) = lower(d.email)
  and d.ops_user_id is null;

create index if not exists idx_roz_dev_ops_user on roz.dev(ops_user_id) where ops_user_id is not null;

-- ---------- 4. Índice para el sync ----------
-- El reconciliador busca por origen: 'ops' entra al dominio de source (text libre desde 0011).
create index if not exists idx_roz_work_item_source_status on roz.work_item(source, status);
