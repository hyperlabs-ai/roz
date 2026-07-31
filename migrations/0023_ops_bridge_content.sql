-- 0023 — El puente Ops ⇄ roz llega al CONTENIDO de la tarea: adjuntos, comentarios y etiquetas.
--
-- La migración 0021 sincroniza la fila de la tarea (nombre, estado, prioridad, fechas,
-- responsables). Todo lo que cuelga de ella vivía en tablas paralelas sin ningún vínculo, así que
-- una imagen subida en Ops simplemente no existía para roz. Ese es el hueco que se cierra aquí.
--
-- Lo que hace posible espejar los adjuntos es que AMBAS apps ya suben al MISMO bucket público
-- (`task-attachments`): el archivo físico es común, solo faltaba espejar la fila que lo referencia.
-- Aquí no se copia ni un byte — solo metadatos.
--
-- Correspondencias (los nombres difieren en cada lado; el contenido es el mismo):
--
--   adjuntos     public.task_attachments        roz.work_item_attachment
--                file_name                   →  name
--                file_path                   →  storage_path + url   (¡formatos distintos, ver abajo!)
--                file_type                   →  content_type
--                file_size                   →  size
--                thumbnail_path              →  (no existe en roz; al volver se rellena con la url)
--
--   comentarios  public.task_comments           roz.work_item_comment
--                content                     →  body
--                (resuelto de user_profiles) →  author_name
--                updated_at                  →  (no existe en roz)
--
--   etiquetas    task_labels + assignments   →  work_item.labels (text[])
--                relacional, con color          array de nombres; al volver se crea la etiqueta
--                                               que falte con el color por defecto
--
-- TRES GARANTÍAS, cada una por un fallo real que se vio en pruebas:
--
--  1. NINGÚN trigger puede impedir una escritura (`exception when others`). Un problema en el lado
--     remoto nunca debe dejarte sin guardar un adjunto.
--
--  2. GUARDA POR IDENTIDAD contra la duplicación. `pg_trigger_depth()` corta el eco entre pares de
--     triggers, pero NO cuando el INSERT lo hace el repair a profundidad 0: ahí el trigger del otro
--     lado corría y devolvía la fila (2 adjuntos → 4). La guarda real es preguntar si esta fila YA
--     es el espejo de la otra (`ops_*_id` / `roz_*_id` no nulo) y, si lo es, no propagarla. No
--     depende de quién originó la escritura.
--
--  3. RUTAS NORMALIZADAS. Cada lado guarda la ruta en un formato distinto:
--       · Ops → `file_path` es la URL pública COMPLETA (así la mete en el <img> de la descripción)
--       · roz → `storage_path` es el path relativo y `url` va aparte
--     Copiar directo daba `.../task-attachments/https://.../task-attachments/...` en un sentido y
--     un `<img src="wi/uuid.png">` que no resuelve en el otro.

-- ============================================================================
-- 1. Columnas de vínculo — lo que hace la deduplicación posible
-- ============================================================================
-- Sin un ancla explícita, el backfill no puede distinguir "ya lo espejé" de "es nuevo" y cada
-- pasada duplicaría. El índice único parcial lo vuelve imposible por construcción.
alter table roz.work_item_attachment add column if not exists ops_attachment_id uuid;
alter table roz.work_item_comment    add column if not exists ops_comment_id    uuid;

create unique index if not exists idx_roz_attachment_ops
  on roz.work_item_attachment (ops_attachment_id) where ops_attachment_id is not null;
create unique index if not exists idx_roz_comment_ops
  on roz.work_item_comment (ops_comment_id) where ops_comment_id is not null;

-- Y en el sentido inverso, para reconocer lo que nació en roz.
alter table public.task_attachments add column if not exists roz_attachment_id uuid;
alter table public.task_comments    add column if not exists roz_comment_id    uuid;

create unique index if not exists idx_ops_attachment_roz
  on public.task_attachments (roz_attachment_id) where roz_attachment_id is not null;
create unique index if not exists idx_ops_comment_roz
  on public.task_comments (roz_comment_id) where roz_comment_id is not null;

-- ============================================================================
-- 2. Helpers
-- ============================================================================

-- URL pública del bucket compartido. El host es el del proyecto Supabase: si algún día se migra
-- de proyecto, este es el único punto a tocar.
create or replace function roz.public_attachment_url(p_path text)
returns text language sql immutable as $$
  select 'https://wluhhftyedxwcwrxlipk.supabase.co/storage/v1/object/public/task-attachments/' || p_path;
$$;

-- Aceptan cualquiera de los dos formatos (URL completa o path relativo) y devuelven el que pide el
-- destino. Ver garantía 3 en la cabecera.
create or replace function roz.attachment_path(p text)
returns text language sql immutable as $$
  select case
    when p is null then null
    when position('/task-attachments/' in p) > 0
      then substring(p from position('/task-attachments/' in p) + 18)
    else p
  end;
$$;

create or replace function roz.attachment_url(p text)
returns text language sql immutable as $$
  select case
    when p is null then null
    when p like 'http%' then p
    else roz.public_attachment_url(p)
  end;
$$;

-- Nombre legible de un usuario de Ops (para author_name, que roz muestra sin joins).
create or replace function roz.ops_user_name(p_user_id uuid)
returns text language sql stable as $$
  select coalesce(full_name, email) from public.user_profiles where user_id = p_user_id;
$$;

-- ============================================================================
-- 3. ADJUNTOS
-- ============================================================================

create or replace function roz.on_ops_attachment_change()
returns trigger language plpgsql security definer as $$
declare v_wi uuid;
begin
  -- El vínculo se sigue en LOS DOS sentidos: esta fila puede ser el original (su espejo apunta a
  -- ella con ops_attachment_id) o el espejo (ella apunta al original con roz_attachment_id).
  -- Mirar solo un lado dejaba huérfano lo que había nacido en el otro.
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    delete from roz.work_item_attachment where ops_attachment_id = old.id;
    if old.roz_attachment_id is not null then
      delete from roz.work_item_attachment where id = old.roz_attachment_id;
    end if;
    return old;
  end if;

  if new.roz_attachment_id is not null then return new; end if;  -- ya es espejo de roz
  if pg_trigger_depth() > 1 then return new; end if;

  -- Solo si la tarea existe en roz. Si aún no bajó (sin dev activo), no hay dónde colgarlo; el
  -- backfill lo recoge cuando la tarea aparezca.
  select id into v_wi from roz.work_item where ops_task_id = new.task_id;
  if v_wi is null then return new; end if;

  insert into roz.work_item_attachment (
    work_item_id, storage_path, url, name, content_type, size, uploaded_by, created_at, ops_attachment_id
  ) values (
    v_wi,
    roz.attachment_path(new.file_path),  -- roz espera el path relativo…
    roz.attachment_url(new.file_path),   -- …y la URL aparte
    new.file_name, new.file_type, new.file_size, new.uploaded_by,
    coalesce(new.created_at, now()), new.id
  )
  on conflict (ops_attachment_id) where ops_attachment_id is not null do nothing;

  return new;
exception when others then
  raise warning '[roz bridge] adjunto ops % : %', coalesce(new.id, old.id), sqlerrm;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_roz_ops_attachment on public.task_attachments;
create trigger trg_roz_ops_attachment
  after insert or delete on public.task_attachments
  for each row execute function roz.on_ops_attachment_change();

create or replace function roz.on_roz_attachment_change()
returns trigger language plpgsql security definer as $$
declare v_task uuid; v_uploader uuid; v_url text;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    delete from public.task_attachments where roz_attachment_id = old.id;
    if old.ops_attachment_id is not null then
      delete from public.task_attachments where id = old.ops_attachment_id;
    end if;
    return old;
  end if;

  if new.ops_attachment_id is not null then return new; end if;  -- ya es espejo de Ops
  if pg_trigger_depth() > 1 then return new; end if;

  select ops_task_id into v_task from roz.work_item where id = new.work_item_id;
  if v_task is null then return new; end if;  -- tarea nativa de roz: no tiene par en Ops

  -- `uploaded_by` es NOT NULL en Ops y nullable en roz. Se cae a quien creó la tarea; sin eso no
  -- se puede insertar, y el audit lo reporta como faltante en vez de perderlo en silencio.
  v_uploader := coalesce(new.uploaded_by, (select created_by from public.tasks where id = v_task));
  if v_uploader is null then return new; end if;

  -- Ops guarda la URL en file_path y la reusa como thumbnail de las imágenes.
  v_url := roz.attachment_url(coalesce(new.url, new.storage_path));

  insert into public.task_attachments (
    task_id, file_name, file_path, file_type, file_size, thumbnail_path, uploaded_by, created_at, roz_attachment_id
  ) values (
    v_task, new.name, v_url, coalesce(new.content_type, 'application/octet-stream'), new.size,
    case when coalesce(new.content_type, '') like 'image/%' then v_url end,
    v_uploader, coalesce(new.created_at, now()), new.id
  )
  on conflict (roz_attachment_id) where roz_attachment_id is not null do nothing;

  return new;
exception when others then
  raise warning '[roz bridge] adjunto roz % : %', coalesce(new.id, old.id), sqlerrm;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_roz_attachment_to_ops on roz.work_item_attachment;
create trigger trg_roz_attachment_to_ops
  after insert or delete on roz.work_item_attachment
  for each row execute function roz.on_roz_attachment_change();

-- ============================================================================
-- 4. COMENTARIOS
-- ============================================================================

create or replace function roz.on_ops_comment_change()
returns trigger language plpgsql security definer as $$
declare v_wi uuid;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    delete from roz.work_item_comment where ops_comment_id = old.id;
    if old.roz_comment_id is not null then
      delete from roz.work_item_comment where id = old.roz_comment_id;
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if pg_trigger_depth() > 1 then return new; end if;
    update roz.work_item_comment set body = new.content
     where ops_comment_id = new.id or id = new.roz_comment_id;
    return new;
  end if;

  if new.roz_comment_id is not null then return new; end if;
  if pg_trigger_depth() > 1 then return new; end if;

  select id into v_wi from roz.work_item where ops_task_id = new.task_id;
  if v_wi is null then return new; end if;

  insert into roz.work_item_comment (
    work_item_id, author_id, author_name, body, mentions, created_at, ops_comment_id
  ) values (
    v_wi, new.author_id, roz.ops_user_name(new.author_id), new.content,
    coalesce(new.mentions, '{}'::uuid[]), coalesce(new.created_at, now()), new.id
  )
  on conflict (ops_comment_id) where ops_comment_id is not null do nothing;

  return new;
exception when others then
  raise warning '[roz bridge] comentario ops % : %', coalesce(new.id, old.id), sqlerrm;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_roz_ops_comment on public.task_comments;
create trigger trg_roz_ops_comment
  after insert or update or delete on public.task_comments
  for each row execute function roz.on_ops_comment_change();

create or replace function roz.on_roz_comment_change()
returns trigger language plpgsql security definer as $$
declare v_task uuid; v_author uuid;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
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

  -- `author_id` es NOT NULL en Ops. Mismo criterio que en adjuntos.
  v_author := coalesce(new.author_id, (select created_by from public.tasks where id = v_task));
  if v_author is null then return new; end if;

  insert into public.task_comments (task_id, author_id, content, mentions, created_at, roz_comment_id)
  values (v_task, v_author, new.body, coalesce(new.mentions, '{}'::uuid[]),
          coalesce(new.created_at, now()), new.id)
  on conflict (roz_comment_id) where roz_comment_id is not null do nothing;

  return new;
exception when others then
  raise warning '[roz bridge] comentario roz % : %', coalesce(new.id, old.id), sqlerrm;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_roz_comment_to_ops on roz.work_item_comment;
create trigger trg_roz_comment_to_ops
  after insert or delete on roz.work_item_comment
  for each row execute function roz.on_roz_comment_change();

-- ============================================================================
-- 5. ETIQUETAS
-- ============================================================================
-- Ops las modela relacionalmente (catálogo con color + tabla de asignación); roz guarda un array
-- de nombres en la propia tarea. El nombre es la identidad común.

create or replace function roz.sync_ops_labels(p_task_id uuid)
returns void language plpgsql security definer as $$
declare v_wi uuid;
begin
  select id into v_wi from roz.work_item where ops_task_id = p_task_id;
  if v_wi is null then return; end if;

  update roz.work_item
     set labels = coalesce((
           select array_agg(l.name order by l.name)
           from public.task_label_assignments a
           join public.task_labels l on l.id = a.label_id
           where a.task_id = p_task_id
         ), '{}'::text[])
   where id = v_wi;
end $$;

create or replace function roz.on_ops_label_change()
returns trigger language plpgsql security definer as $$
begin
  if pg_trigger_depth() > 1 then return coalesce(new, old); end if;
  perform roz.sync_ops_labels(coalesce(new.task_id, old.task_id));
  return coalesce(new, old);
exception when others then
  raise warning '[roz bridge] etiqueta ops : %', sqlerrm;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_roz_ops_label on public.task_label_assignments;
create trigger trg_roz_ops_label
  after insert or delete on public.task_label_assignments
  for each row execute function roz.on_ops_label_change();

-- Vuelta: el array de roz manda sobre las asignaciones de Ops. Las etiquetas que no existan en el
-- catálogo se crean con el color por defecto — mejor eso que descartar la etiqueta.
create or replace function roz.push_labels_to_ops(p_work_item_id uuid)
returns void language plpgsql security definer as $$
declare v_task uuid; v_names text[]; v_name text; v_label uuid;
begin
  select ops_task_id, coalesce(labels, '{}'::text[]) into v_task, v_names
  from roz.work_item where id = p_work_item_id;
  if v_task is null then return; end if;

  foreach v_name in array v_names loop
    if length(trim(v_name)) = 0 then continue; end if;
    select id into v_label from public.task_labels where name = v_name;
    if v_label is null then
      insert into public.task_labels (name) values (v_name)
      on conflict (name) do nothing returning id into v_label;
      if v_label is null then select id into v_label from public.task_labels where name = v_name; end if;
    end if;
    insert into public.task_label_assignments (task_id, label_id)
    values (v_task, v_label) on conflict (task_id, label_id) do nothing;
  end loop;

  -- Quita en Ops las que ya no están en roz.
  delete from public.task_label_assignments a
   using public.task_labels l
   where a.label_id = l.id and a.task_id = v_task and not (l.name = any(v_names));
end $$;

create or replace function roz.on_roz_labels_change()
returns trigger language plpgsql security definer as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if new.ops_task_id is null then return new; end if;
  if new.labels is distinct from old.labels then
    perform roz.push_labels_to_ops(new.id);
  end if;
  return new;
exception when others then
  raise warning '[roz bridge] etiquetas roz % : %', new.id, sqlerrm;
  return new;
end $$;

drop trigger if exists trg_roz_labels_to_ops on roz.work_item;
create trigger trg_roz_labels_to_ops
  after update of labels on roz.work_item
  for each row execute function roz.on_roz_labels_change();

-- ============================================================================
-- 6. Auditoría y reparación del contenido
-- ============================================================================
-- Igual que 0022 hace con la tarea: los triggers cubren eventos, no el estado que ya existía.
-- Caso típico: se sube un adjunto cuando la tarea aún no había bajado a roz.

create or replace function roz.ops_bridge_content_audit()
returns table (issue text, task_id uuid, detail text) language sql stable as $$
  select 'adjunto_falta_en_roz'::text, a.task_id, a.file_name
  from public.task_attachments a
  join roz.work_item w on w.ops_task_id = a.task_id
  where a.roz_attachment_id is null
    and not exists (select 1 from roz.work_item_attachment x where x.ops_attachment_id = a.id)

  union all
  select 'adjunto_falta_en_ops', w.ops_task_id, a.name
  from roz.work_item_attachment a
  join roz.work_item w on w.id = a.work_item_id
  where w.ops_task_id is not null and a.ops_attachment_id is null
    and not exists (select 1 from public.task_attachments x where x.roz_attachment_id = a.id)

  union all
  select 'comentario_falta_en_roz', c.task_id, left(c.content, 60)
  from public.task_comments c
  join roz.work_item w on w.ops_task_id = c.task_id
  where c.roz_comment_id is null
    and not exists (select 1 from roz.work_item_comment x where x.ops_comment_id = c.id)

  union all
  select 'comentario_falta_en_ops', w.ops_task_id, left(c.body, 60)
  from roz.work_item_comment c
  join roz.work_item w on w.id = c.work_item_id
  where w.ops_task_id is not null and c.ops_comment_id is null
    and not exists (select 1 from public.task_comments x where x.roz_comment_id = c.id)

  union all
  -- Como conjuntos ordenados: el orden del array no es significativo.
  select 'etiquetas_distintas', w.ops_task_id,
         coalesce(array_to_string(w.labels, ','), '') || ' ≠ ' || coalesce((
           select string_agg(l.name, ',' order by l.name)
           from public.task_label_assignments a join public.task_labels l on l.id = a.label_id
           where a.task_id = w.ops_task_id), '')
  from roz.work_item w
  where w.ops_task_id is not null
    and coalesce((select array_agg(l.name order by l.name)
                  from public.task_label_assignments a join public.task_labels l on l.id = a.label_id
                  where a.task_id = w.ops_task_id), '{}'::text[])
        is distinct from coalesce((select array_agg(x order by x) from unnest(w.labels) x), '{}'::text[]);
$$;

create or replace function roz.ops_bridge_content_repair(p_dry_run boolean default true)
returns table (action text, detail text) language plpgsql security definer as $$
declare r record; v_uploader uuid; v_author uuid; v_url text;
begin
  for r in
    select a.*, w.id as wi from public.task_attachments a
    join roz.work_item w on w.ops_task_id = a.task_id
    where a.roz_attachment_id is null
      and not exists (select 1 from roz.work_item_attachment x where x.ops_attachment_id = a.id)
  loop
    if not p_dry_run then
      insert into roz.work_item_attachment (work_item_id, storage_path, url, name, content_type, size, uploaded_by, created_at, ops_attachment_id)
      values (r.wi, roz.attachment_path(r.file_path), roz.attachment_url(r.file_path), r.file_name, r.file_type, r.file_size, r.uploaded_by, coalesce(r.created_at, now()), r.id)
      on conflict (ops_attachment_id) where ops_attachment_id is not null do nothing;
    end if;
    action := case when p_dry_run then 'adjunto→roz (simulado)' else 'adjunto→roz' end; detail := r.file_name; return next;
  end loop;

  for r in
    select a.*, w.ops_task_id as task from roz.work_item_attachment a
    join roz.work_item w on w.id = a.work_item_id
    where w.ops_task_id is not null and a.ops_attachment_id is null
      and not exists (select 1 from public.task_attachments x where x.roz_attachment_id = a.id)
  loop
    v_uploader := coalesce(r.uploaded_by, (select created_by from public.tasks where id = r.task));
    if v_uploader is not null then
      v_url := roz.attachment_url(coalesce(r.url, r.storage_path));
      if not p_dry_run then
        insert into public.task_attachments (task_id, file_name, file_path, file_type, file_size, thumbnail_path, uploaded_by, created_at, roz_attachment_id)
        values (r.task, r.name, v_url, coalesce(r.content_type,'application/octet-stream'), r.size,
                case when coalesce(r.content_type,'') like 'image/%' then v_url end,
                v_uploader, coalesce(r.created_at, now()), r.id)
        on conflict (roz_attachment_id) where roz_attachment_id is not null do nothing;
      end if;
      action := case when p_dry_run then 'adjunto→ops (simulado)' else 'adjunto→ops' end; detail := r.name; return next;
    end if;
  end loop;

  for r in
    select c.*, w.id as wi from public.task_comments c
    join roz.work_item w on w.ops_task_id = c.task_id
    where c.roz_comment_id is null
      and not exists (select 1 from roz.work_item_comment x where x.ops_comment_id = c.id)
  loop
    if not p_dry_run then
      insert into roz.work_item_comment (work_item_id, author_id, author_name, body, mentions, created_at, ops_comment_id)
      values (r.wi, r.author_id, roz.ops_user_name(r.author_id), r.content, coalesce(r.mentions,'{}'::uuid[]), coalesce(r.created_at, now()), r.id)
      on conflict (ops_comment_id) where ops_comment_id is not null do nothing;
    end if;
    action := case when p_dry_run then 'comentario→roz (simulado)' else 'comentario→roz' end; detail := left(r.content,40); return next;
  end loop;

  for r in
    select c.*, w.ops_task_id as task from roz.work_item_comment c
    join roz.work_item w on w.id = c.work_item_id
    where w.ops_task_id is not null and c.ops_comment_id is null
      and not exists (select 1 from public.task_comments x where x.roz_comment_id = c.id)
  loop
    v_author := coalesce(r.author_id, (select created_by from public.tasks where id = r.task));
    if v_author is not null then
      if not p_dry_run then
        insert into public.task_comments (task_id, author_id, content, mentions, created_at, roz_comment_id)
        values (r.task, v_author, r.body, coalesce(r.mentions,'{}'::uuid[]), coalesce(r.created_at, now()), r.id)
        on conflict (roz_comment_id) where roz_comment_id is not null do nothing;
      end if;
      action := case when p_dry_run then 'comentario→ops (simulado)' else 'comentario→ops' end; detail := left(r.body,40); return next;
    end if;
  end loop;

  -- Etiquetas: para una tarea que vino de Ops, Ops es la fuente.
  for r in select task_id from roz.ops_bridge_content_audit() where issue = 'etiquetas_distintas' loop
    if not p_dry_run then perform roz.sync_ops_labels(r.task_id); end if;
    action := case when p_dry_run then 'etiquetas (simulado)' else 'etiquetas' end; detail := r.task_id::text; return next;
  end loop;
end $$;

-- ============================================================================
-- 7. Permisos
-- ============================================================================
-- Postgres da EXECUTE a PUBLIC por defecto; en funciones `security definer` que escriben en las
-- dos apps eso sería alcanzable por anon vía PostgREST.
revoke all on function roz.ops_bridge_content_audit()          from public, anon, authenticated;
revoke all on function roz.ops_bridge_content_repair(boolean)   from public, anon, authenticated;
revoke all on function roz.sync_ops_labels(uuid)                from public, anon, authenticated;
revoke all on function roz.push_labels_to_ops(uuid)             from public, anon, authenticated;
revoke all on function roz.public_attachment_url(text)          from public, anon, authenticated;
revoke all on function roz.attachment_path(text)                from public, anon, authenticated;
revoke all on function roz.attachment_url(text)                 from public, anon, authenticated;
revoke all on function roz.ops_user_name(uuid)                  from public, anon, authenticated;
grant execute on function roz.ops_bridge_content_audit()         to service_role;
grant execute on function roz.ops_bridge_content_repair(boolean) to service_role;

notify pgrst, 'reload schema';
