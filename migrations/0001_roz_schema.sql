-- roz — schema canónico. Refleja exactamente lo desplegado en la DB de HyperOps, en su
-- propio schema `roz` (aislado de las tablas de producción).
--
-- Embeddings alineados con el RAG de hyperflow-llm: text-embedding-3-large / 3072 dims.
-- 3072 > 2000 → SIN índice ANN (HNSW/ivfflat); roz usa KNN exacto (suficiente a su escala).
-- Cada vector float4 = 4 bytes → 3072 × 4 ≈ 12 KB por embedding.

create schema if not exists roz;
create extension if not exists vector with schema extensions;

-- ---------- Proyectos y trabajo (espejo de Linear) ----------
-- El repo NO vive aquí: el mapeo repo→proyecto se resuelve EN VIVO contra
-- public.github_repositories de HyperOps (ver src/projects/resolve.ts), por eso el ancla
-- canónica es `hyperops_project_id`. `linear_project_id` ancla el lado de Linear.
create table if not exists roz.project (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  key                 text not null unique,
  linear_team_id      text,
  linear_project_id   text,
  hyperops_project_id uuid,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_roz_project_linear_team on roz.project(linear_team_id);
create index if not exists idx_roz_project_hyperops on roz.project(hyperops_project_id);
-- Un Linear Project ↔ un roz.project (parcial: permite varios proyectos sin enlazar).
create unique index if not exists uq_roz_project_linear_project
  on roz.project(linear_project_id) where linear_project_id is not null;

-- ---------- Router de devs ----------
create table if not exists roz.dev (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  email           text,
  whatsapp        text,                 -- contacto (notificación futura; hoy se usa email)
  linear_user_id  text,
  github_login    text,
  github_email    text,                 -- email de commits, para reconciliación (fase 5)
  active          boolean not null default true,
  availability    real not null default 1.0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_roz_dev_linear_user on roz.dev(linear_user_id);
create index if not exists idx_roz_dev_github_login on roz.dev(github_login);
create index if not exists idx_roz_dev_github_email on roz.dev(github_email);

create table if not exists roz.skill (
  id           uuid primary key default gen_random_uuid(),
  tag          text not null unique,
  description  text,
  embedding    extensions.vector(3072),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists roz.dev_skill (
  id        uuid primary key default gen_random_uuid(),
  dev_id    uuid not null references roz.dev(id) on delete cascade,
  skill_id  uuid not null references roz.skill(id) on delete cascade,
  level     int not null default 3,
  unique (dev_id, skill_id)
);

-- ---------- Propuestas (borrador antes de Linear) ----------
create table if not exists roz.proposal (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references roz.project(id),
  title       text not null,
  spec        text not null,
  requester   text,
  optimality  text,
  priority    text,
  status      text not null default 'evaluated',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists roz.work_item (
  id              uuid primary key default gen_random_uuid(),
  linear_id       text not null unique,
  identifier      text not null unique,
  project_id      uuid references roz.project(id),
  title           text not null,
  spec            text,
  state           text not null default 'backlog',
  priority        text,
  documented      boolean not null default false,
  url             text,
  requester       text,
  assignee_dev_id uuid references roz.dev(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_roz_work_item_linear on roz.work_item(linear_id);

-- ---------- Second brain ----------
create table if not exists roz.knowledge_atom (
  id               uuid primary key default gen_random_uuid(),
  scope            text not null default 'project',
  project_id       uuid references roz.project(id),
  status           text not null default 'active',
  title            text not null,
  body             text not null,
  provenance       text[] not null default '{}',
  embedding        extensions.vector(3072),
  embedding_model  text,
  content_hash     text,
  superseded_by    uuid references roz.knowledge_atom(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_roz_atom_project on roz.knowledge_atom(project_id);
create index if not exists idx_roz_atom_status on roz.knowledge_atom(status);
create index if not exists idx_roz_atom_fts
  on roz.knowledge_atom using gin (to_tsvector('spanish', title || ' ' || body));

create table if not exists roz.atom_edge (
  id        uuid primary key default gen_random_uuid(),
  src_id    uuid not null references roz.knowledge_atom(id) on delete cascade,
  dst_id    uuid not null references roz.knowledge_atom(id) on delete cascade,
  kind      text not null,
  created_at timestamptz not null default now(),
  unique (src_id, dst_id, kind)
);

-- ---------- Notificaciones (email / Resend) ----------
create table if not exists roz.notification (
  id           uuid primary key default gen_random_uuid(),
  channel      text not null,
  to_dev_id    uuid references roz.dev(id),
  to_address   text,
  template     text,
  audio_asset  text,
  body         text,
  variables    jsonb not null default '{}'::jsonb,
  status       text not null default 'pending',
  provider_id  text,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------- Núcleo de eventos: outbox + idempotencia ----------
create table if not exists roz.outbox_event (
  id               uuid primary key default gen_random_uuid(),
  type             text not null,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'pending',
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  idempotency_key  text unique,
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_roz_outbox_drain on roz.outbox_event(status, next_attempt_at);

create table if not exists roz.idempotency_key (
  key         text primary key,
  scope       text not null,
  created_at  timestamptz not null default now()
);

-- ---------- Retrieval híbrido (keyword + vector + RRF) ----------
create or replace function roz.search_atoms_hybrid(
  p_project_id uuid,
  p_query      text,
  p_embedding  extensions.vector(3072),
  p_limit      int default 8
)
returns table (id uuid, title text, body text, score real)
language sql stable
set search_path = roz, public, extensions
as $$
  with kw as (
    select a.id,
           row_number() over (
             order by ts_rank(to_tsvector('spanish', a.title || ' ' || a.body),
                              plainto_tsquery('spanish', p_query)) desc
           ) as rnk
    from roz.knowledge_atom a
    where a.project_id = p_project_id and a.status = 'active'
      and to_tsvector('spanish', a.title || ' ' || a.body) @@ plainto_tsquery('spanish', p_query)
    limit 50
  ),
  vec as (
    select a.id,
           row_number() over (order by a.embedding <=> p_embedding) as rnk
    from roz.knowledge_atom a
    where a.project_id = p_project_id and a.status = 'active'
      and p_embedding is not null and a.embedding is not null
    limit 50
  ),
  fused as (
    select coalesce(kw.id, vec.id) as id,
           coalesce(1.0 / (60 + kw.rnk), 0) + coalesce(1.0 / (60 + vec.rnk), 0) as score
    from kw full outer join vec on kw.id = vec.id
  )
  select a.id, a.title, a.body, f.score::real
  from fused f join roz.knowledge_atom a on a.id = f.id
  order by f.score desc
  limit p_limit;
$$;

-- ---------- Permisos para el service_role (roz corre server-side) ----------
grant usage on schema roz to service_role, anon, authenticated;
grant all on all tables in schema roz to service_role;
grant all on all sequences in schema roz to service_role;
grant execute on all routines in schema roz to service_role;
alter default privileges in schema roz grant all on tables to service_role;
alter default privileges in schema roz grant execute on routines to service_role;
