-- 0024 — Tres fallos del puente que solo aparecieron usándolo de verdad. Los tres borraban o
-- perdían datos del usuario, así que van juntos.
--
-- ============================================================================
-- FALLO A — Guardar una tarea en Ops borraba sus imágenes (en AMBOS lados)
-- ============================================================================
-- El PATCH de /api/tasks/[id] en Ops hace `delete` + `insert` de TODOS los assignees en cada
-- guardado. Ese delete deja la tarea sin dev activo por un instante, y `retire_ops_task` lo
-- interpretaba como "ya no le interesa a roz": borraba el work item → el ON DELETE CASCADE se
-- llevaba work_item_attachment y work_item_comment → y el trigger propagaba ESE borrado a Ops.
-- Resultado: pulsar "Guardar" destruía los adjuntos originales. Reproducido y verificado.
--
-- El criterio nuevo: DESASIGNAR NO ES BORRAR. Mientras la tarea exista en Ops, el work item se
-- conserva (solo se queda sin responsable). El único borrado legítimo es que la tarea desaparezca.
--
-- ============================================================================
-- FALLO B — El puente solo funcionaba en un sentido, y por permisos
-- ============================================================================
-- Síntoma: subir una imagen desde roz aparecía en los dos lados; subirla desde Ops, en ninguno.
--
-- En 0022/0023 revoqué EXECUTE a `public, anon, authenticated` sobre todas las funciones del
-- puente. Correcto para las `security definer` que escriben; equivocado para las que solo
-- construyen o parsean una cadena. Esas son `language sql immutable`, así que Postgres las INLINEA
-- en la consulta que las usa, y entonces el permiso se comprueba con el rol de la SESIÓN, no con el
-- de la función `security definer` que las llama. Por eso la asimetría exacta:
--     · roz  → service_role  → tenía permiso → espejaba
--     · Ops  → authenticated → `permission denied for function public_attachment_url`
--       → el trigger caía en su `exception when others` → no espejaba, sin ruido
--
-- ============================================================================
-- FALLO C — Un CASCADE interno de roz borraba archivos en Ops
-- ============================================================================
-- Si el work item se va (retirado, recreado, limpieza), sus adjuntos y comentarios caen por
-- CASCADE. Propagar ese borrado a Ops destruía los originales. Ahora se distingue: si el work item
-- ya no existe, es una cascada interna y Ops no se toca.

-- ============================================================================
-- Bitácora — porque `raise warning` no se ve
-- ============================================================================
-- El fallo B fue invisible durante horas: el trigger lo capturaba y avisaba con `raise warning`,
-- que no llega al cliente ni de forma fiable a los logs. Una tabla deja rastro consultable de cada
-- decisión, y es lo que permitió encontrarlo.
create table if not exists roz.bridge_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  origen text not null,
  decision text not null,
  detalle text,
  rol text default current_user,
  profundidad int default pg_trigger_depth()
);

-- Sin grants para anon/authenticated (solo postgres y service_role la ven) y con RLS activo, igual
-- que el resto de roz: si en el futuro alguien concediera permisos por error, RLS sin políticas
-- sigue cerrando la puerta.
alter table roz.bridge_log enable row level security;

-- ============================================================================
-- FALLO A
-- ============================================================================

-- Un adjunto o un comentario son trabajo humano: pesan lo mismo que un commit.
create or replace function roz.work_item_has_work(p_id uuid)
returns boolean language sql stable as $$
  select
    exists (select 1 from roz.commit                  where work_item_id = p_id)
    or exists (select 1 from roz.work_item_comment    where work_item_id = p_id)
    or exists (select 1 from roz.work_item_attachment where work_item_id = p_id)
    or exists (select 1 from roz.work_item_actor      where work_item_id = p_id)
    or exists (select 1 from roz.work_item where id = p_id and (pr_number is not null or head_ref is not null));
$$;

create or replace function roz.retire_ops_task(p_task_id uuid)
returns void language plpgsql security definer as $$
declare v_wi_id uuid;
begin
  select id into v_wi_id from roz.work_item where ops_task_id = p_task_id;
  if v_wi_id is null then return; end if;

  -- La tarea sigue en Ops (solo se quedó sin dev activo, quizá a mitad de un delete+insert):
  -- se conserva TODO y solo se desasigna.
  if exists (select 1 from public.tasks where id = p_task_id) then
    update roz.work_item set assignee_dev_id = null, updated_at = now() where id = v_wi_id;
    return;
  end if;

  -- La tarea ya no existe en Ops: ahí sí se retira.
  if roz.work_item_has_work(v_wi_id) then
    update roz.work_item
      set status = 'cancelada', canceled_at = coalesce(canceled_at, now()), updated_at = now(), ops_task_id = null
      where id = v_wi_id;
  else
    delete from roz.work_item where id = v_wi_id;
  end if;
end $$;

-- ============================================================================
-- FALLO C
-- ============================================================================

create or replace function roz.on_roz_attachment_change()
returns trigger language plpgsql security definer as $$
declare v_task uuid; v_uploader uuid; v_url text;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    -- Cascada interna de roz: Ops conserva sus archivos.
    if not exists (select 1 from roz.work_item where id = old.work_item_id) then
      insert into roz.bridge_log(origen, decision, detalle)
      values ('roz_attachment', 'cascada: Ops intacto', old.name);
      return old;
    end if;
    delete from public.task_attachments where roz_attachment_id = old.id;
    if old.ops_attachment_id is not null then
      delete from public.task_attachments where id = old.ops_attachment_id;
    end if;
    return old;
  end if;

  if new.ops_attachment_id is not null then return new; end if;  -- ya es espejo de Ops
  if pg_trigger_depth() > 1 then return new; end if;

  select ops_task_id into v_task from roz.work_item where id = new.work_item_id;
  if v_task is null then return new; end if;
  v_uploader := coalesce(new.uploaded_by, (select created_by from public.tasks where id = v_task));
  if v_uploader is null then return new; end if;
  v_url := roz.attachment_url(coalesce(new.url, new.storage_path));

  insert into public.task_attachments (task_id, file_name, file_path, file_type, file_size, thumbnail_path, uploaded_by, created_at, roz_attachment_id)
  values (v_task, new.name, v_url, coalesce(new.content_type,'application/octet-stream'), new.size,
          case when coalesce(new.content_type,'') like 'image/%' then v_url end,
          v_uploader, coalesce(new.created_at, now()), new.id)
  on conflict (roz_attachment_id) where roz_attachment_id is not null do nothing;
  return new;
exception when others then
  insert into roz.bridge_log(origen, decision, detalle)
  values ('roz_attachment', 'ERROR: ' || sqlerrm, coalesce(new.name, old.name));
  return coalesce(new, old);
end $$;

create or replace function roz.on_roz_comment_change()
returns trigger language plpgsql security definer as $$
declare v_task uuid; v_author uuid;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    if not exists (select 1 from roz.work_item where id = old.work_item_id) then return old; end if;
    delete from public.task_comments where roz_comment_id = old.id;
    if old.ops_comment_id is not null then
      delete from public.task_comments where id = old.ops_comment_id;
    end if;
    return old;
  end if;

  if new.ops_comment_id is not null then return new; end if;
  if pg_trigger_depth() > 1 then return new; end if;

  select ops_task_id into v_task from roz.work_item where id = new.work_item_id;
  if v_task is null then return new; end if;
  v_author := coalesce(new.author_id, (select created_by from public.tasks where id = v_task));
  if v_author is null then return new; end if;

  insert into public.task_comments (task_id, author_id, content, mentions, created_at, roz_comment_id)
  values (v_task, v_author, new.body, coalesce(new.mentions,'{}'::uuid[]), coalesce(new.created_at, now()), new.id)
  on conflict (roz_comment_id) where roz_comment_id is not null do nothing;
  return new;
exception when others then
  insert into roz.bridge_log(origen, decision, detalle)
  values ('roz_comment', 'ERROR: ' || sqlerrm, left(coalesce(new.body, old.body), 40));
  return coalesce(new, old);
end $$;

-- ============================================================================
-- FALLO B — permisos de las funciones puras
-- ============================================================================
-- Tienen que ser ejecutables por el rol con el que llega la petición de Ops (`authenticated`), o el
-- trigger muere por ese camino. `anon` NO se incluye: ningún flujo de Ops corre sin sesión.
--
-- Las tres primeras solo construyen o parsean una cadena. `ops_user_name` sí lee user_profiles,
-- pero es SECURITY INVOKER: respeta el RLS de quien llama (la política exige `auth.uid() is not
-- null`), así que no expone ningún dato que ese usuario no pudiera leer ya.
grant execute on function roz.public_attachment_url(text) to authenticated, service_role;
grant execute on function roz.attachment_path(text)       to authenticated, service_role;
grant execute on function roz.attachment_url(text)        to authenticated, service_role;
grant execute on function roz.ops_user_name(uuid)         to authenticated, service_role;

-- Las que escriben siguen cerradas: ahí el criterio de 0022/0023 era el correcto.
--   ops_bridge_audit / ops_bridge_repair / ops_bridge_content_* / sync_ops_* / push_labels_to_ops

notify pgrst, 'reload schema';
