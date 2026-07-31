-- 0021 — Puente Ops ⇄ roz EN VIVO, con triggers. Sustituye al sync por cron: como las dos apps
-- comparten la misma base, no hace falta una pasada periódica — la escritura en un schema propaga
-- al otro dentro de la misma transacción. Asignas en Ops y el dev lo ve al instante.
--
-- Cubre los tres eventos en ambos sentidos:
--   Ops → roz : asignar crea · editar actualiza · desasignar/borrar quita (o cancela si ya hubo trabajo)
--   roz → Ops : cambiar estado actualiza · borrar borra
--
-- Dos garantías que hacen esto seguro:
--
-- 1. NINGÚN trigger puede impedir una escritura. Todos envuelven su cuerpo en
--    `exception when others then return ...`: si el lado remoto falla, la operación local se
--    completa igual. Un problema en roz nunca debe dejarte sin guardar una tarea en Ops.
--
-- 2. NO hay bucle infinito. tasks→work_item→tasks se cortaría solo por la comparación de valores,
--    pero además se corta explícito con pg_trigger_depth(): las funciones solo propagan en el
--    primer nivel. Es la guarda estándar para pares de triggers espejo.
--
-- Ojo con el borrado: por decisión de producto, borrar en roz BORRA la tarea en Ops (simetría
-- total). En cambio, desasignar/borrar en Ops solo elimina el work item si nunca se trabajó
-- (sin PR, commits, comentarios ni actores); si ya hubo trabajo se cancela, para no perder la
-- atribución del dev.

-- ============================================================================
-- 1. HELPERS
-- ============================================================================

-- ¿El work item ya acumuló trabajo real? Si sí, nunca se borra: se cancela.
create or replace function roz.work_item_has_work(p_id uuid)
returns boolean language sql stable as $$
  select
    exists (select 1 from roz.commit             where work_item_id = p_id)
    or exists (select 1 from roz.work_item_comment where work_item_id = p_id)
    or exists (select 1 from roz.work_item_actor   where work_item_id = p_id)
    or exists (select 1 from roz.work_item where id = p_id and (pr_number is not null or head_ref is not null));
$$;

-- Materializa (crea o actualiza) el work item de una tarea de Ops. Idempotente.
-- Devuelve el id del work item, o null si la tarea no califica (sin dev activo asignado).
create or replace function roz.sync_ops_task(p_task_id uuid)
returns uuid language plpgsql security definer as $$
declare
  v_task        public.tasks%rowtype;
  v_dev_id      uuid;
  v_project_id  uuid;
  v_project_key text;
  v_wi_id       uuid;
  v_number      int;
  v_identifier  text;
begin
  select * into v_task from public.tasks where id = p_task_id;
  if not found then return null; end if;

  -- Responsable: el primer dev ACTIVO entre los asignados en Ops. La asignación real vive en
  -- task_assignees (tabla puente), no en tasks.assignee_id.
  select d.id into v_dev_id
  from public.task_assignees ta
  join roz.dev d on d.ops_user_id = ta.user_id and d.active
  where ta.task_id = p_task_id
  order by d.name
  limit 1;

  select id into v_wi_id from roz.work_item where ops_task_id = p_task_id;

  -- Sin dev activo: no califica. Si ya existía, lo resuelve el trigger de desasignación.
  if v_dev_id is null then return v_wi_id; end if;

  -- Proyecto: solo si el de Ops está vinculado. Si no, el work item entra sin proyecto —
  -- mejor visible sin clasificar que invisible.
  select p.id, p.key into v_project_id, v_project_key
  from roz.project p where p.hyperops_project_id = v_task.project_id;

  if v_wi_id is null then
    if v_project_id is not null then
      v_number := roz.next_work_item_number(v_project_id);
      v_identifier := v_project_key || '-' || v_number;
    else
      v_identifier := 'OPS-' || coalesce(v_task.task_number::text, extract(epoch from now())::bigint::text);
    end if;

    insert into roz.work_item (
      linear_id, identifier, number, project_id, name, description, status, priority,
      due_date, source, ops_task_id, assignee_dev_id, documented, created_at, updated_at,
      started_at, completed_at
    ) values (
      null, v_identifier, v_number, v_project_id, v_task.name, v_task.description,
      coalesce(v_task.status, 'pendiente'), v_task.priority, v_task.due_date,
      'ops', p_task_id, v_dev_id, true, coalesce(v_task.created_at, now()), now(),
      case when v_task.status in ('en_progreso','revision') then now() end,
      case when v_task.status = 'completada' then coalesce(v_task.completed_at, now()) end
    )
    returning id into v_wi_id;

    insert into roz.work_item_assignee (work_item_id, dev_id)
    select v_wi_id, d.id
    from public.task_assignees ta
    join roz.dev d on d.ops_user_id = ta.user_id and d.active
    where ta.task_id = p_task_id
    on conflict do nothing;
  else
    update roz.work_item set
      name = v_task.name,
      description = v_task.description,
      status = coalesce(v_task.status, status),
      priority = v_task.priority,
      due_date = v_task.due_date,
      project_id = coalesce(v_project_id, project_id),
      assignee_dev_id = coalesce(v_dev_id, assignee_dev_id),
      updated_at = now(),
      started_at = case when v_task.status in ('en_progreso','revision') then coalesce(started_at, now()) else started_at end,
      completed_at = case when v_task.status = 'completada' then coalesce(completed_at, v_task.completed_at, now()) else null end
    where id = v_wi_id;
  end if;

  return v_wi_id;
end $$;

-- Quita el work item de una tarea de Ops: lo borra si nunca se trabajó, si no lo cancela.
create or replace function roz.retire_ops_task(p_task_id uuid)
returns void language plpgsql security definer as $$
declare v_wi_id uuid;
begin
  select id into v_wi_id from roz.work_item where ops_task_id = p_task_id;
  if v_wi_id is null then return; end if;

  if roz.work_item_has_work(v_wi_id) then
    update roz.work_item
      set status = 'cancelada', canceled_at = coalesce(canceled_at, now()), updated_at = now()
      where id = v_wi_id;
  else
    delete from roz.work_item where id = v_wi_id;
  end if;
end $$;

-- ============================================================================
-- 2. Ops → roz
-- ============================================================================

-- Asignación creada: si el usuario es un dev activo, la tarea baja al instante.
create or replace function roz.on_ops_assignee_change()
returns trigger language plpgsql security definer as $$
begin
  if pg_trigger_depth() > 1 then return coalesce(new, old); end if;

  if tg_op = 'INSERT' then
    perform roz.sync_ops_task(new.task_id);
    return new;
  end if;

  -- DELETE: si ya no queda ningún dev activo asignado, se retira de roz.
  if not exists (
    select 1 from public.task_assignees ta
    join roz.dev d on d.ops_user_id = ta.user_id and d.active
    where ta.task_id = old.task_id
  ) then
    perform roz.retire_ops_task(old.task_id);
  else
    perform roz.sync_ops_task(old.task_id);  -- quedan otros: refrescar el responsable
  end if;
  return old;
exception when others then
  raise warning '[roz bridge] assignee % : %', coalesce(new.task_id, old.task_id), sqlerrm;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_roz_ops_assignee on public.task_assignees;
create trigger trg_roz_ops_assignee
  after insert or delete on public.task_assignees
  for each row execute function roz.on_ops_assignee_change();

-- Tarea editada o borrada en Ops.
create or replace function roz.on_ops_task_change()
returns trigger language plpgsql security definer as $$
begin
  if pg_trigger_depth() > 1 then return coalesce(new, old); end if;

  if tg_op = 'DELETE' then
    perform roz.retire_ops_task(old.id);
    return old;
  end if;

  -- UPDATE: solo si cambió algo que roz refleja (evita ruido por updated_at).
  if new.name is distinct from old.name
     or new.description is distinct from old.description
     or new.status is distinct from old.status
     or new.priority is distinct from old.priority
     or new.due_date is distinct from old.due_date
     or new.project_id is distinct from old.project_id then
    perform roz.sync_ops_task(new.id);
  end if;
  return new;
exception when others then
  raise warning '[roz bridge] task % : %', coalesce(new.id, old.id), sqlerrm;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_roz_ops_task on public.tasks;
create trigger trg_roz_ops_task
  after update or delete on public.tasks
  for each row execute function roz.on_ops_task_change();

-- ============================================================================
-- 3. roz → Ops
-- ============================================================================

-- El dev mueve o borra la tarea en roz. Solo aplica a las que vinieron de Ops.
create or replace function roz.on_work_item_change()
returns trigger language plpgsql security definer as $$
begin
  if pg_trigger_depth() > 1 then return coalesce(new, old); end if;

  if tg_op = 'DELETE' then
    -- Simetría total por decisión de producto: borrar aquí borra la tarea en Ops.
    if old.ops_task_id is not null then
      delete from public.tasks where id = old.ops_task_id;
    end if;
    return old;
  end if;

  -- UPDATE: solo el estado vuelve a Ops. Nombre, fechas y prioridad son de Ops; pisarlos desde
  -- aquí sería pérdida silenciosa.
  if new.ops_task_id is not null and new.status is distinct from old.status then
    update public.tasks set
      status = new.status,
      completed_at = case when new.status in ('completada','cancelada')
                          then coalesce(new.completed_at, now()) else null end,
      updated_at = now()
    where id = new.ops_task_id;
  end if;
  return new;
exception when others then
  raise warning '[roz bridge] work_item % : %', coalesce(new.id, old.id), sqlerrm;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_roz_work_item_to_ops on roz.work_item;
create trigger trg_roz_work_item_to_ops
  after update or delete on roz.work_item
  for each row execute function roz.on_work_item_change();
