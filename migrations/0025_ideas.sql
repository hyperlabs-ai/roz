-- 0025 — Ideas: espacio para capturar y ATERRIZAR ideas de proyecto.
--
-- El problema que resuelve: una idea nace en un documento en blanco que no pregunta nada, así que
-- se queda difusa y no hay forma de saber si ya está lo bastante definida para empezar. Aquí la
-- idea tiene campos guiados (problema, para quién, valor, alcance, fuera de alcance, riesgos,
-- criterio de éxito, siguiente paso) de los que el front deriva un "medidor de definición", más
-- bloques libres para lo que no cabe en un campo (notas, conversaciones pegadas de un LLM, links,
-- preguntas abiertas).
--
-- Deliberadamente SIN vínculo a project ni a work_item: esta fase es solo captura. Cuando exista el
-- puente idea → tareas, se añade la columna en una migración aparte.
--
-- Privacidad: la idea nace PRIVADA de su autor (`shared = false`). El filtrado real vive en el
-- backend (src/dashboard/ideas.ts), no en RLS, porque el backend entra con service_role — igual que
-- el resto de `roz`. Aditiva e idempotente.

-- ---------- La idea y sus campos guiados ----------
create table if not exists roz.idea (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  pitch           text,                       -- una frase: "X para Y que Z"
  status          text not null default 'semilla',
  -- Los 7 campos guiados. Markdown, todos opcionales: una idea a medio aterrizar es válida, y de
  -- cuáles están llenos sale el porcentaje de definición.
  problem         text,                       -- ¿qué duele hoy?
  audience        text,                       -- ¿para quién es?
  value           text,                       -- ¿por qué vale la pena / por qué ahora?
  success         text,                       -- ¿cómo sabré que funcionó?
  out_of_scope    text,                       -- lo que la idea NO es (lo que más aterriza)
  risks           text,                       -- qué puede salir mal
  next_step       text,                       -- la siguiente acción concreta
  tags            text[] not null default '{}',
  shared          boolean not null default false,  -- false = solo su autor la ve
  created_by      uuid not null,              -- auth.users.id (igual que work_item.created_by)
  created_by_name text,                       -- snapshot: pintar al autor sin join a public
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

do $$ begin
  alter table roz.idea add constraint idea_status_check
    check (status in ('semilla', 'explorando', 'definida', 'en_pausa', 'descartada'));
exception when duplicate_object then null; end $$;

create index if not exists idx_roz_idea_created_by on roz.idea(created_by);
create index if not exists idx_roz_idea_shared on roz.idea(shared) where shared;
create index if not exists idx_roz_idea_updated on roz.idea(updated_at desc);

-- ---------- Alcance: features con MoSCoW ----------
-- 'descartada' no es basura: marcar explícitamente lo que queda fuera es parte de aterrizar.
create table if not exists roz.idea_feature (
  id         uuid primary key default gen_random_uuid(),
  idea_id    uuid not null references roz.idea(id) on delete cascade,
  title      text not null,
  detail     text,
  priority   text not null default 'deseable',
  position   int not null default 0,
  created_at timestamptz not null default now()
);

do $$ begin
  alter table roz.idea_feature add constraint idea_feature_priority_check
    check (priority in ('imprescindible', 'deseable', 'opcional', 'descartada'));
exception when duplicate_object then null; end $$;

create index if not exists idx_roz_idea_feature_idea on roz.idea_feature(idea_id, position);

-- ---------- Bloques libres ----------
-- Una sola tabla con discriminador `kind` en vez de una tabla por tipo: los cinco tipos comparten
-- forma (título + cuerpo markdown + orden) y así el CRUD es uno solo. `source` guarda de dónde
-- salió el contenido ("Claude", "ChatGPT", el dominio del link); `resolved` solo aplica a
-- kind='pregunta'.
create table if not exists roz.idea_block (
  id         uuid primary key default gen_random_uuid(),
  idea_id    uuid not null references roz.idea(id) on delete cascade,
  kind       text not null default 'nota',
  title      text,
  body       text,
  source     text,
  url        text,
  resolved   boolean not null default false,
  position   int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$ begin
  alter table roz.idea_block add constraint idea_block_kind_check
    check (kind in ('nota', 'chat', 'link', 'referencia', 'pregunta'));
exception when duplicate_object then null; end $$;

create index if not exists idx_roz_idea_block_idea on roz.idea_block(idea_id, position);

-- ---------- Adjuntos (imágenes: mockups, capturas, diagramas) ----------
-- Mismo mecanismo que los adjuntos de tareas (0017): el backend (service_role) sube al bucket y
-- guarda aquí la fila con la URL pública para renderizar directo.
create table if not exists roz.idea_attachment (
  id           uuid primary key default gen_random_uuid(),
  idea_id      uuid not null references roz.idea(id) on delete cascade,
  storage_path text not null,          -- ruta dentro del bucket (para borrar del Storage)
  url          text not null,          -- URL pública (bucket público)
  name         text not null,
  content_type text,
  size         int,
  uploaded_by  uuid,                   -- auth.users.id
  created_at   timestamptz not null default now()
);
create index if not exists idx_roz_idea_attach_idea on roz.idea_attachment(idea_id);

insert into storage.buckets (id, name, public)
values ('idea-attachments', 'idea-attachments', true)
on conflict (id) do nothing;

-- ---------- Permisos ----------
-- RLS deny-all como el resto de roz: el service_role (backend) la bypassa; anon/authenticated no
-- tienen grants, así que nadie lee la tabla directo. La visibilidad por autor se aplica en el
-- backend, que es quien sabe qué usuario hizo la petición.
grant all on roz.idea to service_role;
grant all on roz.idea_feature to service_role;
grant all on roz.idea_block to service_role;
grant all on roz.idea_attachment to service_role;

alter table roz.idea enable row level security;
alter table roz.idea_feature enable row level security;
alter table roz.idea_block enable row level security;
alter table roz.idea_attachment enable row level security;
