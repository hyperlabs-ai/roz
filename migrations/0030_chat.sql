-- 0030 — Chat del equipo (canales, grupos privados y mensajes directos), con hilos, adjuntos,
-- menciones y vínculo directo con las tareas de roz.
--
-- El problema: la coordinación del día a día vivía fuera de roz, así que lo que se acordaba en una
-- conversación había que copiarlo a mano a una tarea (o se perdía). El chat lo trae adentro y une
-- las dos cosas: un mensaje puede originar una tarea, y la tarea apunta de vuelta al mensaje.
--
-- Decisiones:
--   · Identidad = roz.dev (como el resto del dashboard: requireDashboardAuth entrega devId).
--   · Un MD es una conversación `kind='dm'` con `dm_key` = ids de dev ordenados → abrir el mismo MD
--     dos veces devuelve el mismo, nunca un duplicado.
--   · Hilos: `parent_id` apunta al mensaje raíz; el raíz lleva `reply_count`/`last_reply_at`
--     (trigger) para pintar "N respuestas" sin contar en cada lectura.
--   · Borrado de mensajes = suave (`deleted_at`): un raíz con respuestas no puede desaparecer sin
--     dejar el hilo huérfano.
--   · Tiempo real: Supabase Realtime Broadcast en canales PRIVADOS, un buzón por dev
--     (`chat:dev:<devId>`). El backend publica con service_role; cada cliente solo puede escuchar
--     SU buzón, por la policy de abajo sobre realtime.messages.
--   · Adjuntos en un bucket PRIVADO (a diferencia de task-attachments): una conversación privada no
--     puede servir sus archivos por URL pública. El backend firma URLs temporales al leer.
--
-- Aditiva e idempotente, como el resto. RLS deny-all en las tablas nuevas: solo el backend
-- (service_role) lee y escribe.

-- ---------- Conversaciones ----------
create table if not exists roz.chat_conversation (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('channel', 'dm')),
  -- Solo canales: slug en minúsculas, único entre canales (índice parcial abajo).
  name             text,
  topic            text,
  description      text,
  is_private       boolean not null default false,
  -- Canal al que todo dev queda unido al entrar (#general). No se puede borrar ni abandonar.
  is_default       boolean not null default false,
  -- Solo MDs: ids de dev ordenados y separados por coma.
  dm_key           text unique,
  created_by       uuid references roz.dev(id) on delete set null,
  last_message_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

do $$ begin
  alter table roz.chat_conversation add constraint chat_conversation_shape check (
    (kind = 'channel' and name is not null and dm_key is null)
    or (kind = 'dm' and dm_key is not null)
  );
exception when duplicate_object then null; end $$;

create unique index if not exists uq_roz_chat_channel_name
  on roz.chat_conversation (lower(name)) where kind = 'channel';

-- ---------- Membresía ----------
create table if not exists roz.chat_member (
  conversation_id  uuid not null references roz.chat_conversation(id) on delete cascade,
  dev_id           uuid not null references roz.dev(id) on delete cascade,
  role             text not null default 'member' check (role in ('owner', 'member')),
  -- Cuándo manda push: 'all' todo mensaje, 'mentions' solo @menciones, 'none' silenciado.
  -- Default por tipo lo pone el backend (MD → all, canal → mentions).
  notify_level     text not null default 'mentions' check (notify_level in ('all', 'mentions', 'none')),
  -- Marca de lectura: todo lo posterior cuenta como no leído. Al unirse arranca en now() para que
  -- el historial previo no aparezca como pendiente.
  last_read_at     timestamptz not null default now(),
  -- MD "cerrado" por la persona: no se lista hasta que llegue un mensaje nuevo.
  hidden           boolean not null default false,
  joined_at        timestamptz not null default now(),
  primary key (conversation_id, dev_id)
);
create index if not exists idx_roz_chat_member_dev on roz.chat_member(dev_id);

-- ---------- Mensajes ----------
create table if not exists roz.chat_message (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references roz.chat_conversation(id) on delete cascade,
  author_dev_id    uuid references roz.dev(id) on delete set null,
  -- Raíz del hilo (null = mensaje del canal). Un hilo tiene un solo nivel.
  parent_id        uuid references roz.chat_message(id) on delete cascade,
  -- 'system' = aviso generado por roz (p. ej. "se creó ROZ-12 a partir de este mensaje").
  kind             text not null default 'user' check (kind in ('user', 'system')),
  -- Markdown con tokens de mención: <@devId> y <!canal>.
  body             text not null default '',
  -- Devs mencionados (derivado del body en el backend; sirve a los no leídos y al push).
  mentions         uuid[] not null default '{}',
  mention_channel  boolean not null default false,
  meta             jsonb,
  -- Id que genera el cliente para reconciliar su envío optimista con el eco del tiempo real.
  client_nonce     text,
  reply_count      int not null default 0,
  last_reply_at    timestamptz,
  edited_at        timestamptz,
  deleted_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists idx_roz_chat_message_conv on roz.chat_message(conversation_id, created_at desc);
create index if not exists idx_roz_chat_message_parent on roz.chat_message(parent_id, created_at) where parent_id is not null;
create index if not exists idx_roz_chat_message_mentions on roz.chat_message using gin (mentions);

-- ---------- Adjuntos ----------
create table if not exists roz.chat_attachment (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references roz.chat_conversation(id) on delete cascade,
  -- Null mientras el archivo está subido pero el mensaje aún no se envía.
  message_id       uuid references roz.chat_message(id) on delete cascade,
  uploader_dev_id  uuid references roz.dev(id) on delete set null,
  storage_path     text not null,
  name             text not null,
  content_type     text,
  size             int,
  created_at       timestamptz not null default now()
);
create index if not exists idx_roz_chat_attachment_message on roz.chat_attachment(message_id);
create index if not exists idx_roz_chat_attachment_conv on roz.chat_attachment(conversation_id);

-- ---------- Mensaje → tarea ----------
-- Un mensaje puede originar varias tareas; cada tarea recuerda de qué mensaje salió.
alter table roz.work_item
  add column if not exists chat_message_id uuid references roz.chat_message(id) on delete set null;
create index if not exists idx_roz_work_item_chat_message
  on roz.work_item(chat_message_id) where chat_message_id is not null;

-- ---------- Contadores del hilo y actividad de la conversación ----------
create or replace function roz.chat_message_after_insert()
returns trigger
language plpgsql
set search_path = roz, public
as $$
begin
  if new.parent_id is null then
    update roz.chat_conversation
       set last_message_at = greatest(coalesce(last_message_at, new.created_at), new.created_at)
     where id = new.conversation_id;
  else
    update roz.chat_message
       set reply_count = reply_count + 1,
           last_reply_at = greatest(coalesce(last_reply_at, new.created_at), new.created_at)
     where id = new.parent_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_roz_chat_message_after_insert on roz.chat_message;
create trigger trg_roz_chat_message_after_insert
  after insert on roz.chat_message
  for each row execute function roz.chat_message_after_insert();

-- ---------- No leídos ----------
-- Por conversación de la persona: mensajes raíz posteriores a su marca de lectura que no escribió
-- ella (`unread`) y menciones directas o @canal (`mentions`, incluye respuestas en hilo). Solo
-- devuelve conversaciones con algo pendiente.
create or replace function roz.chat_unread(p_dev_id uuid)
returns table (conversation_id uuid, unread int, mentions int)
language sql
stable
set search_path = roz, public
as $$
  select m.conversation_id,
         (count(*) filter (where msg.parent_id is null))::int as unread,
         (count(*) filter (
            where p_dev_id = any(msg.mentions) or (msg.mention_channel and msg.parent_id is null)
         ))::int as mentions
    from roz.chat_member m
    join roz.chat_message msg
      on msg.conversation_id = m.conversation_id
     and msg.created_at > m.last_read_at
     and msg.deleted_at is null
     and msg.kind = 'user'
     and msg.author_dev_id is distinct from p_dev_id
   where m.dev_id = p_dev_id
   group by m.conversation_id;
$$;

-- ---------- Tiempo real: cada quien escucha SOLO su buzón ----------
-- Mismo mapeo que requireDashboardAuth (src/auth/verify.ts): primero el vínculo explícito
-- ops_user_id = auth.uid(), y si no hay, el email del JWT. Security definer porque `authenticated`
-- no tiene grants sobre roz.dev; solo devuelve un booleano.
create or replace function roz.chat_topic_allowed(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = roz, public
as $$
  with me as (
    select coalesce(
      (select d.id from roz.dev d where d.ops_user_id = auth.uid() limit 1),
      (select d.id from roz.dev d
        where d.email is not null
          and lower(d.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        limit 1)
    ) as id
  )
  select coalesce(p_topic = 'chat:dev:' || (select id from me)::text, false);
$$;

-- La policy vive en realtime.messages; se protege con un guard para instalaciones sin Realtime.
do $$
begin
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'realtime' and table_name = 'messages'
  ) then
    execute 'drop policy if exists roz_chat_inbox_read on realtime.messages';
    execute $p$
      create policy roz_chat_inbox_read on realtime.messages
        for select to authenticated
        using (
          realtime.messages.extension = 'broadcast'
          and roz.chat_topic_allowed((select realtime.topic()))
        )
    $p$;
  end if;
end $$;

-- ---------- Storage ----------
insert into storage.buckets (id, name, public)
values ('chat-attachments', 'chat-attachments', false)
on conflict (id) do nothing;

-- ---------- Canal por defecto ----------
insert into roz.chat_conversation (kind, name, topic, is_default)
select 'channel', 'general', 'Canal de todo el equipo', true
 where not exists (select 1 from roz.chat_conversation where kind = 'channel' and is_default);

-- ---------- Permisos ----------
grant all on roz.chat_conversation to service_role;
grant all on roz.chat_member to service_role;
grant all on roz.chat_message to service_role;
grant all on roz.chat_attachment to service_role;
alter table roz.chat_conversation enable row level security;
alter table roz.chat_member enable row level security;
alter table roz.chat_message enable row level security;
alter table roz.chat_attachment enable row level security;

-- Postgres concede EXECUTE a PUBLIC por defecto: se revoca y se otorga solo a quien lo usa.
revoke execute on function roz.chat_unread(uuid) from public, anon, authenticated;
grant execute on function roz.chat_unread(uuid) to service_role;
revoke execute on function roz.chat_topic_allowed(text) from public, anon;
grant execute on function roz.chat_topic_allowed(text) to service_role, authenticated;

notify pgrst, 'reload schema';
