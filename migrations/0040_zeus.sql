-- zeus: gestión de contexto unificado del equipo.
--
-- Qué guarda:
--   1. Jerarquía: a quién reporta cada dev y quién administra zeus.
--   2. El grafo de contexto: nodos (ADR, specs, cambios, docs, design system, reglas, recursos) y
--      aristas tipadas entre ellos y hacia personas/proyectos/equipos.
--   3. Fuentes: repos de los que se importan ADR y OpenSpec (zeus es la fuente de verdad; git solo
--      importa lo nuevo).
--   4. Acceso por persona: tokens de zeus (MCP y CLI), uno o varios por dev.
--   5. Bandeja: mensajes y solicitudes (accesos, permisos) entre devs y agentes.
--   6. Actividad: quién consultó o cambió qué (alimenta los pulsos del grafo y mide si el contexto
--      de verdad se usa).
--   7. Bóveda de llaves: variables de entorno por proyecto, cifradas EN EL CLIENTE. zeus solo guarda
--      texto cifrado y la llave del entorno envuelta para la llave pública de cada equipo: ni la base
--      ni el back pueden leer un secreto.
--   8. Paquete de contexto de cada plan del agente.
--
-- Decisión de diseño: el grafo NO es un mecanismo de recuperación. La recuperación es un índice corto
-- + búsqueda de texto + traer el documento por id; las aristas sirven para navegar y para relaciones
-- que sí importan (reemplaza a, depende de, dueño).

-- ---------- 1. Jerarquía ----------
alter table roz.dev add column if not exists reports_to uuid references roz.dev(id) on delete set null;
-- Administra zeus: aprueba solicitudes sin dueño, da y quita acceso a la bóveda, edita la jerarquía.
alter table roz.dev add column if not exists zeus_admin boolean not null default false;

do $$ begin
  alter table roz.dev add constraint dev_reports_to_not_self check (reports_to is null or reports_to <> id);
exception when duplicate_object then null; end $$;

-- ---------- 2. Grafo ----------
create table if not exists roz.zeus_node (
  id            uuid primary key default gen_random_uuid(),
  -- adr | spec | change | doc | design | rule | resource | team
  kind          text not null,
  -- Identificador legible y estable dentro de su alcance (proyecto u organización).
  slug          text not null,
  title         text not null,
  -- Una línea: es lo que entra al índice que el agente carga siempre.
  summary       text not null default '',
  body          text not null default '',
  -- NULL = aplica a toda la organización.
  project_id    uuid references roz.project(id) on delete cascade,
  -- draft | active | superseded | archived
  status        text not null default 'active',
  -- Procedencia: manual (creado en zeus) | git (importado de un repo). Todos se editan en zeus.
  source        text not null default 'manual',
  source_repo   text,
  source_path   text,
  -- sha del blob en git de la versión que se importó (o se volvió a traer a pedido).
  source_sha    text,
  source_url    text,
  owner_dev_id  uuid references roz.dev(id) on delete set null,
  tags          text[] not null default '{}',
  -- Datos propios del tipo (estado nativo del ADR, tipo de recurso, url…).
  meta          jsonb not null default '{}'::jsonb,
  -- Entra al índice siempre cargado aunque no coincida con la búsqueda.
  pinned        boolean not null default false,
  -- Fecha para revisar si sigue vigente (el contexto viejo es peor que no tener contexto).
  review_after  date,
  version       int not null default 1,
  created_by    uuid references roz.dev(id) on delete set null,
  updated_by    uuid references roz.dev(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Búsqueda bilingüe: 'spanish' para raíces en español, 'simple' para que el inglés y los
  -- identificadores de código coincidan tal cual.
  fts tsvector generated always as (
    setweight(to_tsvector('spanish', title), 'A') ||
    setweight(to_tsvector('simple', title), 'A') ||
    setweight(to_tsvector('spanish', summary), 'B') ||
    setweight(to_tsvector('spanish', body), 'C') ||
    setweight(to_tsvector('simple', body), 'D')
  ) stored,
  constraint zeus_node_kind_check check (kind in ('adr', 'spec', 'change', 'doc', 'design', 'rule', 'resource', 'team')),
  constraint zeus_node_status_check check (status in ('draft', 'active', 'superseded', 'archived')),
  constraint zeus_node_source_check check (source in ('manual', 'git'))
);

create unique index if not exists uq_zeus_node_slug
  on roz.zeus_node (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, slug);
create unique index if not exists uq_zeus_node_source
  on roz.zeus_node (source_repo, source_path) where source = 'git';
create index if not exists idx_zeus_node_fts on roz.zeus_node using gin (fts);
create index if not exists idx_zeus_node_project on roz.zeus_node (project_id, kind) where status <> 'archived';
create index if not exists idx_zeus_node_updated on roz.zeus_node (updated_at desc);

-- Historial de ediciones (manuales y de git): quién cambió qué y por dónde.
create table if not exists roz.zeus_node_revision (
  id          uuid primary key default gen_random_uuid(),
  node_id     uuid not null references roz.zeus_node(id) on delete cascade,
  version     int not null,
  title       text not null,
  summary     text not null default '',
  body        text not null default '',
  edited_by   uuid references roz.dev(id) on delete set null,
  -- web | mcp | git
  edited_via  text not null default 'web',
  created_at  timestamptz not null default now(),
  unique (node_id, version)
);

-- Aristas. Los extremos son referencias de texto porque el grafo mezcla nodos guardados con
-- entidades que ya viven en otras tablas: 'node:<uuid>', 'dev:<uuid>', 'project:<uuid>',
-- 'repo:<owner/name>', 'runner:<uuid>'.
create table if not exists roz.zeus_edge (
  id          uuid primary key default gen_random_uuid(),
  src_ref     text not null,
  dst_ref     text not null,
  -- supersedes | depends_on | relates_to | implements | owns | applies_to | part_of | connects_to | documents
  kind        text not null,
  -- manual | git
  source      text not null default 'manual',
  note        text,
  created_by  uuid references roz.dev(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (src_ref, dst_ref, kind),
  constraint zeus_edge_kind_check check (kind in ('supersedes', 'depends_on', 'relates_to', 'implements', 'owns', 'applies_to', 'part_of', 'connects_to', 'documents')),
  constraint zeus_edge_not_self check (src_ref <> dst_ref)
);
create index if not exists idx_zeus_edge_src on roz.zeus_edge (src_ref);
create index if not exists idx_zeus_edge_dst on roz.zeus_edge (dst_ref);

-- ---------- 3. Fuentes (repos indexados) ----------
create table if not exists roz.zeus_source (
  repo            text primary key,
  project_id      uuid references roz.project(id) on delete set null,
  default_branch  text,
  -- sha del commit de la última ingesta completa.
  last_sha        text,
  last_synced_at  timestamptz,
  last_error      text,
  node_count      int not null default 0,
  -- Pedido de lectura del repo (webhook de push o botón): la barrida lo atiende y lo limpia.
  dirty           boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------- 4. Tokens por persona ----------
create table if not exists roz.zeus_token (
  id            uuid primary key default gen_random_uuid(),
  dev_id        uuid not null references roz.dev(id) on delete cascade,
  -- Para qué/dónde se usa ("claude code laptop", "cli").
  name          text not null,
  -- sha256 hex del token. El token en claro se muestra UNA vez al crearlo.
  token_hash    text not null unique,
  token_prefix  text not null,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_zeus_token_dev on roz.zeus_token (dev_id) where revoked_at is null;

-- ---------- 5. Bandeja ----------
create table if not exists roz.zeus_request (
  id                uuid primary key default gen_random_uuid(),
  -- access | permission | review | change | other
  kind              text not null default 'access',
  requester_dev_id  uuid not null references roz.dev(id) on delete cascade,
  -- A quién le toca resolver (dueño del recurso, o su jefe, o un admin). NULL = cualquier admin.
  approver_dev_id   uuid references roz.dev(id) on delete set null,
  -- Sobre qué: referencia del grafo ('node:…', 'project:…') o NULL si es texto libre.
  resource_ref      text,
  title             text not null,
  detail            text not null default '',
  -- Por qué se le envió a ese aprobador (para que se entienda la ruta).
  routed_because    text,
  -- pending | approved | denied | cancelled
  status            text not null default 'pending',
  resolution_note   text,
  resolved_by       uuid references roz.dev(id) on delete set null,
  resolved_at       timestamptz,
  -- mcp | web | cli
  via               text not null default 'mcp',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint zeus_request_kind_check check (kind in ('access', 'permission', 'review', 'change', 'other')),
  constraint zeus_request_status_check check (status in ('pending', 'approved', 'denied', 'cancelled'))
);
create index if not exists idx_zeus_request_approver on roz.zeus_request (approver_dev_id, status);
create index if not exists idx_zeus_request_requester on roz.zeus_request (requester_dev_id, created_at desc);

create table if not exists roz.zeus_message (
  id           uuid primary key default gen_random_uuid(),
  -- NULL = lo manda zeus (avisos del sistema).
  from_dev_id  uuid references roz.dev(id) on delete set null,
  to_dev_id    uuid not null references roz.dev(id) on delete cascade,
  subject      text,
  body         text not null,
  -- Contexto del mensaje: 'node:…', 'plan:…', 'request:…'.
  ref          text,
  request_id   uuid references roz.zeus_request(id) on delete cascade,
  -- mcp | web | cli | system
  via          text not null default 'mcp',
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_zeus_message_inbox on roz.zeus_message (to_dev_id, created_at desc);
create index if not exists idx_zeus_message_unread on roz.zeus_message (to_dev_id) where read_at is null;

-- ---------- 6. Actividad ----------
create table if not exists roz.zeus_activity (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  dev_id   uuid references roz.dev(id) on delete set null,
  -- mcp | web | cli | git | runner | system
  actor    text not null,
  -- search | get | index | write | link | message | request | resolve | ingest | env.pull | env.push | …
  action   text not null,
  -- Referencia del grafo tocada (para animar el nodo) o NULL.
  ref      text,
  detail   jsonb not null default '{}'::jsonb
);
create index if not exists idx_zeus_activity_at on roz.zeus_activity (at desc);

-- ---------- 7. Bóveda ----------
-- Llave pública de un EQUIPO de un dev (X25519). La privada nunca sale de esa PC.
create table if not exists roz.zeus_vault_key (
  id            uuid primary key default gen_random_uuid(),
  dev_id        uuid not null references roz.dev(id) on delete cascade,
  name          text not null,
  -- 32 bytes en base64url.
  public_key    text not null unique,
  -- sha256 de la pública, recortado: para compararla en voz alta antes de dar acceso.
  fingerprint   text not null,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_zeus_vault_key_dev on roz.zeus_vault_key (dev_id) where revoked_at is null;

-- Un entorno de un proyecto (development, preview, production…). Tiene UNA llave de datos (DEK)
-- vigente, identificada por dek_version; rotarla sube la versión.
create table if not exists roz.zeus_vault_env (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references roz.project(id) on delete cascade,
  name         text not null,
  dek_version  int not null default 1,
  -- Se le quitó el acceso a alguien que ya había visto los valores: toca rotar la llave.
  needs_rotation boolean not null default false,
  created_by   uuid references roz.dev(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (project_id, name)
);

-- La DEK de un entorno, envuelta para la llave pública de un equipo. Quien tiene una fila vigente
-- aquí puede leer y escribir los secretos de ese entorno.
create table if not exists roz.zeus_vault_grant (
  id           uuid primary key default gen_random_uuid(),
  env_id       uuid not null references roz.zeus_vault_env(id) on delete cascade,
  key_id       uuid not null references roz.zeus_vault_key(id) on delete cascade,
  dek_version  int not null,
  -- Caja sellada (zv1.…): solo la privada de key_id la abre.
  wrapped_dek  text not null,
  granted_by   uuid references roz.dev(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (env_id, key_id, dek_version)
);
create index if not exists idx_zeus_vault_grant_key on roz.zeus_vault_grant (key_id);

create table if not exists roz.zeus_vault_secret (
  id           uuid primary key default gen_random_uuid(),
  env_id       uuid not null references roz.zeus_vault_env(id) on delete cascade,
  name         text not null,
  -- AES-256-GCM con la DEK (zs1.…). El back no puede descifrarlo.
  ciphertext   text not null,
  dek_version  int not null,
  version      int not null default 1,
  updated_by   uuid references roz.dev(id) on delete set null,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (env_id, name)
);

create table if not exists roz.zeus_vault_audit (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  dev_id   uuid references roz.dev(id) on delete set null,
  key_id   uuid references roz.zeus_vault_key(id) on delete set null,
  env_id   uuid references roz.zeus_vault_env(id) on delete set null,
  -- key.add | key.revoke | env.create | grant | revoke | pull | push | delete | rotate
  action   text not null,
  detail   jsonb not null default '{}'::jsonb
);
create index if not exists idx_zeus_vault_audit_at on roz.zeus_vault_audit (at desc);

-- ---------- 8. Paquete de contexto del plan ----------
-- Lo que el agente necesita para resolver ESTE plan: referencias (no el texto) elegidas al encolar.
-- { generatedAt, query, items: [{ ref, kind, title, summary, why }] }
alter table roz.agent_plan add column if not exists context_pack jsonb;

-- ---------- Búsqueda ----------
-- Texto primero (rank de tsvector); si la consulta no produce términos útiles, cae a coincidencia
-- por título. Devuelve un recorte del cuerpo para que el agente decida si vale la pena traerlo.
create or replace function roz.zeus_search(
  p_query text,
  p_project_id uuid default null,
  p_kinds text[] default null,
  p_include_org boolean default true,
  p_limit int default 12
)
returns table (
  id uuid, kind text, slug text, title text, summary text, project_id uuid, status text,
  source text, source_url text, pinned boolean, updated_at timestamptz, rank real, snippet text
)
language sql stable
set search_path = roz, public, extensions
as $$
  with q as (
    select
      websearch_to_tsquery('spanish', p_query) || websearch_to_tsquery('simple', p_query) as tsq,
      '%' || replace(replace(p_query, '%', ''), '_', '') || '%' as pat
  )
  select n.id, n.kind, n.slug, n.title, n.summary, n.project_id, n.status, n.source, n.source_url,
         n.pinned, n.updated_at,
         (ts_rank(n.fts, q.tsq) + case when n.title ilike q.pat then 0.5 else 0 end)::real as rank,
         ts_headline('simple', left(n.body, 20000), q.tsq,
           'MaxWords=40, MinWords=15, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … ", StartSel="", StopSel=""') as snippet
  from roz.zeus_node n, q
  where n.status in ('active', 'draft')
    and (p_kinds is null or n.kind = any (p_kinds))
    and (
      p_project_id is null
      or n.project_id = p_project_id
      or (p_include_org and n.project_id is null)
    )
    and (n.fts @@ q.tsq or n.title ilike q.pat)
  order by rank desc, n.updated_at desc
  limit greatest(1, least(p_limit, 50));
$$;

-- ---------- Rotación de la llave de un entorno ----------
-- Todo o nada: cambiar la DEK a medias dejaría secretos cifrados con una llave que nadie tiene
-- envuelta. Recibe los grants nuevos y TODOS los secretos re-cifrados; si falta alguno, aborta.
create or replace function roz.zeus_vault_rotate(
  p_env_id uuid,
  p_from_version int,
  p_grants jsonb,   -- [{ "keyId": uuid, "wrappedDek": text }]
  p_secrets jsonb,  -- [{ "name": text, "ciphertext": text }]
  p_dev_id uuid
)
returns int
language plpgsql
set search_path = roz, public
as $$
declare
  v_current int;
  v_new int := p_from_version + 1;
  v_existing int;
  v_matched int;
begin
  select dek_version into v_current from roz.zeus_vault_env where id = p_env_id for update;
  if v_current is null then
    raise exception 'ZEUS_VAULT_ENV_NOT_FOUND';
  end if;
  if v_current <> p_from_version then
    raise exception 'ZEUS_VAULT_STALE';
  end if;
  if jsonb_array_length(p_grants) = 0 then
    raise exception 'ZEUS_VAULT_NO_GRANTS';
  end if;

  select count(*) into v_existing from roz.zeus_vault_secret where env_id = p_env_id;
  select count(*) into v_matched
  from roz.zeus_vault_secret s
  join jsonb_to_recordset(p_secrets) as n(name text, ciphertext text) on n.name = s.name
  where s.env_id = p_env_id;
  if v_matched <> v_existing or jsonb_array_length(p_secrets) <> v_existing then
    raise exception 'ZEUS_VAULT_INCOMPLETE';
  end if;

  delete from roz.zeus_vault_grant where env_id = p_env_id;
  insert into roz.zeus_vault_grant (env_id, key_id, dek_version, wrapped_dek, granted_by)
  select p_env_id, g."keyId", v_new, g."wrappedDek", p_dev_id
  from jsonb_to_recordset(p_grants) as g("keyId" uuid, "wrappedDek" text)
  join roz.zeus_vault_key k on k.id = g."keyId" and k.revoked_at is null;

  update roz.zeus_vault_secret s
  set ciphertext = n.ciphertext, dek_version = v_new, version = s.version + 1, updated_by = p_dev_id, updated_at = now()
  from jsonb_to_recordset(p_secrets) as n(name text, ciphertext text)
  where s.env_id = p_env_id and s.name = n.name;

  update roz.zeus_vault_env
  set dek_version = v_new, needs_rotation = false, updated_at = now()
  where id = p_env_id;
  return v_new;
end;
$$;

-- ---------- Permisos ----------
-- RLS deny-all como el resto de roz: solo el service_role (zeus) las toca.
grant all on roz.zeus_node, roz.zeus_node_revision, roz.zeus_edge, roz.zeus_source, roz.zeus_token,
  roz.zeus_request, roz.zeus_message, roz.zeus_activity, roz.zeus_vault_key, roz.zeus_vault_env,
  roz.zeus_vault_grant, roz.zeus_vault_secret, roz.zeus_vault_audit
  to service_role;
grant usage, select on all sequences in schema roz to service_role;

alter table roz.zeus_node enable row level security;
alter table roz.zeus_node_revision enable row level security;
alter table roz.zeus_edge enable row level security;
alter table roz.zeus_source enable row level security;
alter table roz.zeus_token enable row level security;
alter table roz.zeus_request enable row level security;
alter table roz.zeus_message enable row level security;
alter table roz.zeus_activity enable row level security;
alter table roz.zeus_vault_key enable row level security;
alter table roz.zeus_vault_env enable row level security;
alter table roz.zeus_vault_grant enable row level security;
alter table roz.zeus_vault_secret enable row level security;
alter table roz.zeus_vault_audit enable row level security;

revoke execute on function roz.zeus_search(text, uuid, text[], boolean, int) from public, anon, authenticated;
revoke execute on function roz.zeus_vault_rotate(uuid, int, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function roz.zeus_vault_rotate(uuid, int, jsonb, jsonb, uuid) to service_role;
grant execute on function roz.zeus_search(text, uuid, text[], boolean, int) to service_role;

notify pgrst, 'reload schema';
