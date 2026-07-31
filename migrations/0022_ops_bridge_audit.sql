-- 0022 — Auditoría y reparación del puente Ops ⇄ roz.
--
-- Los triggers de 0021 cubren los eventos: asignar, editar, desasignar, borrar. Lo que NO cubren
-- es el estado que ya existía cuando no hubo evento. El caso concreto: activas un dev que estaba
-- inactivo y sus tareas YA asignadas no bajan, porque nadie insertó nada en task_assignees.
--
-- Esto expone la reconciliación como consulta: `roz.ops_bridge_audit()` compara los dos lados y
-- dice qué está desalineado, sin tocar nada. La reparación (`roz.ops_bridge_repair()`) reusa
-- roz.sync_ops_task() — la MISMA función que llaman los triggers, así que backfill y tiempo real
-- no pueden divergir.
--
-- Deduplicación: el insert vive en sync_ops_task(), que primero busca por ops_task_id y solo crea
-- si no encontró nada; encima está el índice único parcial idx_roz_work_item_ops_task. Aun así el
-- audit reporta duplicados explícitamente, porque un índice que nunca dispara no prueba que la
-- lógica esté bien — prueba que la base lo impidió.

-- ============================================================================
-- Diagnóstico (solo lee)
-- ============================================================================
create or replace function roz.ops_bridge_audit()
returns table (
  issue       text,
  task_id     uuid,
  work_item_id uuid,
  detail      text
) language sql stable as $$
  -- 1. Debería estar en roz y no está: tarea de Ops abierta, asignada a un dev activo, sin
  --    work item. Es el caso del dev recién activado.
  select 'falta_en_roz'::text, t.id, null::uuid,
         t.name || ' → ' || coalesce(d.name, '?')
  from public.tasks t
  join public.task_assignees ta on ta.task_id = t.id
  join roz.dev d on d.ops_user_id = ta.user_id and d.active
  where t.status in ('planificada','pendiente','en_progreso','revision')
    and not exists (select 1 from roz.work_item w where w.ops_task_id = t.id)

  union all

  -- 2. Huérfano: el work item apunta a una tarea de Ops que ya no existe. No debería pasar (el
  --    trigger de DELETE lo retira), pero si el trigger estuvo caído queda rastro.
  select 'huerfano_en_roz', w.ops_task_id, w.id, w.identifier
  from roz.work_item w
  where w.ops_task_id is not null
    and not exists (select 1 from public.tasks t where t.id = w.ops_task_id)

  union all

  -- 3. Duplicado: dos work items para la misma tarea. El índice único lo impide; se verifica
  --    igual para no confiar solo en que "no puede pasar".
  select 'duplicado', w.ops_task_id, w.id, w.identifier
  from roz.work_item w
  where w.ops_task_id is not null
    and (select count(*) from roz.work_item x where x.ops_task_id = w.ops_task_id) > 1

  union all

  -- 4. Desincronizado: existe en ambos lados pero con datos distintos.
  select 'datos_distintos', t.id, w.id,
         nullif(concat_ws(', ',
           case when w.name    is distinct from t.name     then 'nombre'    end,
           case when w.status  is distinct from t.status   then 'estado'    end,
           case when w.priority is distinct from t.priority then 'prioridad' end,
           case when w.due_date is distinct from t.due_date then 'fecha'    end
         ), '')
  from roz.work_item w
  join public.tasks t on t.id = w.ops_task_id
  where w.name     is distinct from t.name
     or w.status   is distinct from t.status
     or w.priority is distinct from t.priority
     or w.due_date is distinct from t.due_date;
$$;

-- ============================================================================
-- Reparación (idempotente)
-- ============================================================================
-- p_dry_run = true (default) solo informa: hay que pedir la escritura explícitamente.
create or replace function roz.ops_bridge_repair(p_dry_run boolean default true)
returns table (action text, task_id uuid, detail text)
language plpgsql security definer as $$
declare r record;
begin
  -- Faltantes → materializar con la misma función que usan los triggers.
  for r in
    select distinct t.id, t.name
    from public.tasks t
    join public.task_assignees ta on ta.task_id = t.id
    join roz.dev d on d.ops_user_id = ta.user_id and d.active
    where t.status in ('planificada','pendiente','en_progreso','revision')
      and not exists (select 1 from roz.work_item w where w.ops_task_id = t.id)
  loop
    if not p_dry_run then perform roz.sync_ops_task(r.id); end if;
    action := case when p_dry_run then 'crearia' else 'creado' end;
    task_id := r.id; detail := r.name;
    return next;
  end loop;

  -- Huérfanos → retirar (borra si nunca se trabajó, cancela si sí).
  for r in
    select w.id as wid, w.ops_task_id, w.identifier
    from roz.work_item w
    where w.ops_task_id is not null
      and not exists (select 1 from public.tasks t where t.id = w.ops_task_id)
  loop
    if not p_dry_run then
      if roz.work_item_has_work(r.wid) then
        update roz.work_item
          set status = 'cancelada', canceled_at = coalesce(canceled_at, now()), ops_task_id = null
          where id = r.wid;
      else
        delete from roz.work_item where id = r.wid;
      end if;
    end if;
    action := case when p_dry_run then 'retiraria' else 'retirado' end;
    task_id := r.ops_task_id; detail := r.identifier;
    return next;
  end loop;

  -- Desincronizados → re-materializar. Ops manda en nombre/prioridad/fecha.
  for r in
    select t.id, t.name
    from roz.work_item w
    join public.tasks t on t.id = w.ops_task_id
    where w.name is distinct from t.name
       or w.status is distinct from t.status
       or w.priority is distinct from t.priority
       or w.due_date is distinct from t.due_date
  loop
    if not p_dry_run then perform roz.sync_ops_task(r.id); end if;
    action := case when p_dry_run then 'actualizaria' else 'actualizado' end;
    task_id := r.id; detail := r.name;
    return next;
  end loop;
end $$;

-- ============================================================================
-- Permisos
-- ============================================================================
-- Postgres da EXECUTE a PUBLIC por defecto. En una función `security definer` que borra work
-- items eso significa que anon podría llamarla por PostgREST — hay que quitarlo explícitamente.
-- Se incluyen también las de 0021: nacieron con el mismo default abierto.
revoke all on function roz.ops_bridge_audit()          from public, anon, authenticated;
revoke all on function roz.ops_bridge_repair(boolean)  from public, anon, authenticated;
revoke all on function roz.sync_ops_task(uuid)         from public, anon, authenticated;
revoke all on function roz.retire_ops_task(uuid)       from public, anon, authenticated;
revoke all on function roz.work_item_has_work(uuid)    from public, anon, authenticated;

-- Solo el service role (el que usa roz server-side) las ejecuta.
grant execute on function roz.ops_bridge_audit()         to service_role;
grant execute on function roz.ops_bridge_repair(boolean) to service_role;

-- Los triggers no se ven afectados: sus funciones son `security definer` y corren como el dueño.
notify pgrst, 'reload schema';
