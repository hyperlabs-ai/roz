-- 0038 — Chat de roz sobre el servidor REAL de Discord de la empresa (detrás de ROZ_DISCORD_CHAT).
--
-- El problema: el equipo conversa en Discord, y el chat interno de roz (0030) era un segundo lugar
-- donde escribir — lo que se decía en uno no existía en el otro. Con el flag encendido, el chat de
-- roz deja de ser una base propia y pasa a ser una VENTANA al servidor de Discord: mismos canales,
-- mismos mensajes, en tiempo real, con el diseño de roz y lo que roz agrega (fichas de tarea, crear
-- issue desde un mensaje, avisos de /ticket).
--
-- Cómo llegan los datos (contrato completo en docs/discord-chat-contracts.md):
--   · Un servicio puente (discord-bridge/, Railway) mantiene la conexión al gateway de Discord y
--     ESPEJA aquí el servidor: estructura (categorías, canales, hilos, permisos), roles, miembros,
--     emojis y mensajes. Escribe directo con service_role y luego avisa a roz para el tiempo real.
--   · roz (Vercel) escribe en Discord con un webhook por canal (nombre y foto del dev) y registra
--     aquí su propio envío; el eco del gateway cae sobre la MISMA fila (id = snowflake de Discord).
--
-- Decisiones:
--   · Todos los ids de Discord son snowflakes y se guardan como TEXT (64 bits sin signo no caben
--     garantizados en bigint con signo, y el cliente los maneja como string de todas formas).
--   · Los bitfields de permisos también van como TEXT decimal (crecen: hoy pasan del bit 40).
--   · Borrado SUAVE (`deleted_at`) en todo lo espejado: para decidir quién debe enterarse de que un
--     canal o un mensaje desapareció hace falta saber quién lo podía ver ANTES de borrarse.
--   · Sin llaves foráneas entre tablas espejo (canal → padre, mensaje → canal): el gateway entrega
--     eventos en cualquier orden (un hilo puede llegar antes que su canal en un backfill) y una FK
--     rechazaría datos válidos. Las FK que sí hay apuntan a tablas de roz (dev, project, work_item).
--   · Los tokens de webhook se guardan CIFRADOS (src/utils/crypto.ts, AES-256-GCM): quien tiene el
--     token puede publicar en el canal sin bot.
--
-- Aditiva e idempotente, como el resto. RLS deny-all: solo el backend (service_role) lee y escribe.

-- ---------- Servidor ----------
create table if not exists roz.discord_guild (
  id               text primary key,
  name             text not null,
  icon             text,                       -- hash del ícono (CDN), no URL
  owner_id         text not null,              -- el dueño tiene TODOS los permisos (permissions.ts)
  description      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz                 -- el bot salió del servidor
);

-- ---------- Canales, categorías e hilos ----------
-- En Discord los tres son "canales": la categoría es type=4, los hilos 10/11/12 con parent_id = el
-- canal donde viven. Ver DISCORD_CHANNEL_TYPE en src/types/discord.ts.
create table if not exists roz.discord_channel (
  id                   text primary key,
  guild_id             text not null,
  type                 int  not null,
  name                 text not null default '',
  topic                text,
  position             int  not null default 0,
  -- Canal → su categoría; hilo → el canal donde vive. Null = sin categoría.
  parent_id            text,
  nsfw                 boolean not null default false,
  -- Overwrites del canal tal cual los manda Discord: [{id, type: 0 rol | 1 miembro, allow, deny}]
  -- con allow/deny como string decimal. Un canal "sincronizado" con su categoría trae una copia
  -- idéntica (Discord no hereda en tiempo de cálculo: copia).
  overwrites           jsonb not null default '[]'::jsonb,
  rate_limit_per_user  int  not null default 0,
  -- Solo hilos:
  archived             boolean not null default false,
  locked               boolean not null default false,
  archived_at          timestamptz,
  owner_id             text,                   -- quien abrió el hilo
  -- Miembros de un hilo PRIVADO (type=12): sin estar aquí (o sin MANAGE_THREADS) no se ve.
  member_ids           text[] not null default '{}',
  -- Mensaje del que nació el hilo (en un hilo público el id del hilo coincide con el del mensaje,
  -- pero se guarda explícito para no depender de esa coincidencia).
  starter_message_id   text,
  message_count        int,
  last_message_id      text,
  last_message_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);
create index if not exists idx_roz_discord_channel_guild on roz.discord_channel(guild_id) where deleted_at is null;
create index if not exists idx_roz_discord_channel_parent on roz.discord_channel(parent_id) where parent_id is not null;

-- ---------- Roles ----------
create table if not exists roz.discord_role (
  id               text primary key,           -- el rol @everyone tiene id = guild_id
  guild_id         text not null,
  name             text not null,
  color            int  not null default 0,
  position         int  not null default 0,
  permissions      text not null default '0',  -- bitfield decimal
  hoist            boolean not null default false,
  mentionable      boolean not null default false,
  managed          boolean not null default false,
  icon             text,
  unicode_emoji    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index if not exists idx_roz_discord_role_guild on roz.discord_role(guild_id) where deleted_at is null;

-- ---------- Miembros ----------
create table if not exists roz.discord_member (
  guild_id                      text not null,
  user_id                       text not null,
  username                      text not null,
  global_name                   text,
  nick                          text,
  avatar                        text,          -- hash del avatar de la cuenta
  guild_avatar                  text,          -- hash del avatar propio del servidor (gana si existe)
  bot                           boolean not null default false,
  -- Ids de rol del miembro (sin @everyone: ese lo tienen todos y se aplica aparte).
  roles                         text[] not null default '{}',
  joined_at                     timestamptz,
  -- Aislado (timeout): mientras no venza solo conserva VIEW_CHANNEL y READ_MESSAGE_HISTORY.
  communication_disabled_until  timestamptz,
  pending                       boolean not null default false,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  left_at                       timestamptz,   -- salió/lo sacaron: no ve nada
  primary key (guild_id, user_id)
);
create index if not exists idx_roz_discord_member_user on roz.discord_member(user_id);

-- ---------- Emojis del servidor ----------
create table if not exists roz.discord_emoji (
  id               text primary key,
  guild_id         text not null,
  name             text not null,
  animated         boolean not null default false,
  available        boolean not null default true,
  -- Roles que pueden usarlo; vacío = todos.
  roles            text[] not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index if not exists idx_roz_discord_emoji_guild on roz.discord_emoji(guild_id) where deleted_at is null;

-- ---------- Mensajes ----------
-- `channel_id` es el canal O el hilo donde está el mensaje (en Discord un hilo es un canal).
-- La fila la escriben dos lados y NINGUNO pisa lo del otro (ver "eco" en el contrato):
--   · el puente: todo lo que viene de Discord (contenido, autor, adjuntos, reacciones, ediciones…);
--     nunca escribe dev_id ni client_nonce.
--   · roz: al enviar por webhook upsertea la fila con dev_id + client_nonce + reply_to_id.
create table if not exists roz.discord_message (
  id                   text primary key,
  guild_id             text not null,
  channel_id           text not null,
  type                 int  not null default 0,
  -- Autor tal como lo ve Discord. Para un mensaje de webhook es el "usuario" falso del webhook
  -- (username = nombre que puso roz), y webhook_id viene lleno.
  author_id            text not null,
  author_username      text not null default '',
  author_global_name   text,
  author_avatar        text,
  author_bot           boolean not null default false,
  webhook_id           text,
  -- Dev de roz que lo envió (solo mensajes salidos de roz). Es lo que permite editarlo/borrarlo
  -- desde roz y pintarlo con su ficha en vez de como "APP".
  dev_id               uuid references roz.dev(id) on delete set null,
  -- Id que generó el cliente para reconciliar su envío optimista con el eco del tiempo real.
  client_nonce         text,
  content              text not null default '',
  -- Formas normalizadas (ver DiscordAttachment/DiscordEmbed/DiscordReaction en src/types/discord.ts).
  attachments          jsonb not null default '[]'::jsonb,
  embeds               jsonb not null default '[]'::jsonb,
  stickers             jsonb not null default '[]'::jsonb,
  -- [{id, username, globalName}] de los usuarios mencionados.
  mentions             jsonb not null default '[]'::jsonb,
  mention_roles        text[] not null default '{}',
  mention_everyone     boolean not null default false,
  -- [{emoji: {id, name, animated}, count, burstCount, userIds?}] — solo lectura en roz.
  reactions            jsonb not null default '[]'::jsonb,
  -- Mensaje al que responde. Para mensajes normales sale de message_reference; para los de roz
  -- (webhook, que no admite message_reference) del prefijo de respuesta (src/discord/reply.ts).
  reply_to_id          text,
  -- Hilo que NACIÓ de este mensaje (Discord: message.thread), para pintar "N respuestas".
  thread_id            text,
  flags                int  not null default 0,
  pinned               boolean not null default false,
  created_at           timestamptz not null,   -- timestamp de Discord, no de la inserción
  edited_at            timestamptz,
  deleted_at           timestamptz,
  synced_at            timestamptz not null default now()
);
-- Paginación del historial: (channel_id, created_at desc, id desc).
create index if not exists idx_roz_discord_message_channel on roz.discord_message(channel_id, created_at desc, id desc);
create index if not exists idx_roz_discord_message_dev on roz.discord_message(dev_id) where dev_id is not null;
create index if not exists idx_roz_discord_message_reply on roz.discord_message(reply_to_id) where reply_to_id is not null;

-- ---------- Webhooks de roz (uno por canal de texto) ----------
-- Los hilos usan el webhook de su canal padre con ?thread_id=. Lo crea/reutiliza la API de roz con
-- el bot (MANAGE_WEBHOOKS) la primera vez que alguien escribe en el canal.
create table if not exists roz.discord_webhook (
  channel_id       text primary key,
  guild_id         text not null,
  webhook_id       text not null unique,
  token_enc        text not null,              -- encryptSecret(token); NUNCA en claro ni en logs
  name             text not null default 'roz',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------- Cuenta de Discord de cada dev ----------
-- Se liga con OAuth2 (scope identify) desde Configuración. Sin vínculo, el dev no ve canales.
create table if not exists roz.discord_link (
  dev_id           uuid primary key references roz.dev(id) on delete cascade,
  discord_user_id  text not null unique,
  username         text not null,
  global_name      text,
  avatar           text,
  linked_at        timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------- Proyecto ↔ canal ----------
-- Dónde se publica el aviso de /ticket al responsable. Sin fila: DM del bot al responsable.
-- Varios proyectos pueden compartir canal; un proyecto tiene un solo canal.
create table if not exists roz.discord_project_channel (
  project_id       uuid primary key references roz.project(id) on delete cascade,
  channel_id       text not null,
  updated_by       uuid references roz.dev(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_roz_discord_project_channel_channel on roz.discord_project_channel(channel_id);

-- ---------- Estado de sincronización por canal ----------
-- Cursor del backfill y de la reconciliación tras una caída: el puente sabe hasta dónde llegó en
-- cada canal y pide solo lo que falta.
create table if not exists roz.discord_sync_state (
  channel_id           text primary key,
  guild_id             text not null,
  -- Mensaje más VIEJO ya traído (el backfill sigue hacia atrás desde aquí hasta llegar a N).
  oldest_message_id    text,
  -- Mensaje más NUEVO visto (al reconectar se pide `after` este id).
  newest_message_id    text,
  backfill_complete    boolean not null default false,
  last_synced_at       timestamptz,
  last_error           text,
  updated_at           timestamptz not null default now()
);

-- ---------- Estado del puente (una fila por servidor) ----------
-- La lee /api/dashboard/discord/status para decir "conectado" / "sin conexión desde las 10:42".
create table if not exists roz.discord_bridge_state (
  guild_id             text primary key,
  status               text not null default 'disconnected'
                       check (status in ('connecting', 'backfilling', 'ready', 'disconnected')),
  connected_at         timestamptz,
  last_ready_at        timestamptz,
  last_heartbeat_at    timestamptz,             -- el puente lo toca cada ~30 s
  last_event_at        timestamptz,
  bridge_version       text,
  last_error           text,
  updated_at           timestamptz not null default now()
);

-- ---------- Adjuntos en tránsito ----------
-- Mismo flujo que src/chat/attachments.ts (subida directa a Storage para esquivar el tope de 4.5 MB
-- de Vercel): pedir URL firmada → subir → confirmar → enviar. Al enviar, roz descarga el objeto y
-- lo manda multipart al webhook; Discord lo hospeda desde ahí (cdn.discordapp.com) y la copia en
-- Storage se borra.
create table if not exists roz.discord_upload (
  id               uuid primary key default gen_random_uuid(),
  dev_id           uuid not null references roz.dev(id) on delete cascade,
  channel_id       text not null,
  bucket           text not null default 'roz-chat',
  storage_path     text not null,
  name             text not null,
  content_type     text,
  size             int,
  completed_at     timestamptz,
  -- Mensaje de Discord al que se adjuntó (null = aún no se envía).
  message_id       text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_roz_discord_upload_dev on roz.discord_upload(dev_id, created_at desc);

-- ---------- Mensaje de Discord → tarea ----------
-- "Crear issue desde un mensaje": la tarea recuerda de qué mensaje de Discord salió.
alter table roz.work_item add column if not exists discord_message_id text;
create index if not exists idx_roz_work_item_discord_message
  on roz.work_item(discord_message_id) where discord_message_id is not null;

-- ---------- Permisos ----------
-- RLS deny-all como el resto de roz: el service_role (backend y puente) la bypassa; anon y
-- authenticated no tienen grants. El tiempo real reutiliza el buzón privado chat:dev:<devId> y su
-- policy (roz.chat_topic_allowed, 0030): no hace falta nada nuevo en realtime.messages.
grant all on roz.discord_guild, roz.discord_channel, roz.discord_role, roz.discord_member, roz.discord_emoji,
  roz.discord_message, roz.discord_webhook, roz.discord_link, roz.discord_project_channel,
  roz.discord_sync_state, roz.discord_bridge_state, roz.discord_upload
  to service_role;
alter table roz.discord_guild enable row level security;
alter table roz.discord_channel enable row level security;
alter table roz.discord_role enable row level security;
alter table roz.discord_member enable row level security;
alter table roz.discord_emoji enable row level security;
alter table roz.discord_message enable row level security;
alter table roz.discord_webhook enable row level security;
alter table roz.discord_link enable row level security;
alter table roz.discord_project_channel enable row level security;
alter table roz.discord_sync_state enable row level security;
alter table roz.discord_bridge_state enable row level security;
alter table roz.discord_upload enable row level security;

notify pgrst, 'reload schema';
