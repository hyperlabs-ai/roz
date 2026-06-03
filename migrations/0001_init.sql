-- roz — schema inicial (Supabase Postgres + pgvector).
-- Dominio portado de roz-legacy-api. Dimensión de embedding = 1536 (OpenAI
-- text-embedding-3-small). Si cambias de modelo, ajusta vector(N) y ROZ_EMBEDDING_DIM.

create extension if not exists vector;
create extension if not exists pgcrypto; -- gen_random_uuid

-- ---------- Proyectos y trabajo (espejo de Linear) ----------
create table if not exists project (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  key             text not null unique,           -- p.ej. "ROZ"
  linear_team_id  text,
  github_repo     text,                            -- "owner/name"
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_project_linear_team on project(linear_team_id);
create index if not exists idx_project_github_repo on project(github_repo);

-- ---------- Router de devs ----------
create table if not exists dev (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  email           text,
  whatsapp        text,                            -- E.164
  linear_user_id  text,
  github_login    text,
  active          boolean not null default true,
  availability    real not null default 1.0,       -- 0..1 (carga real se deriva de Linear)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_dev_linear_user on dev(linear_user_id);
create index if not exists idx_dev_github_login on dev(github_login);

create table if not exists skill (
  id           uuid primary key default gen_random_uuid(),
  tag          text not null unique,
  description  text,
  embedding    vector(1536),                       -- perfil de skill, para match con la spec
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists dev_skill (
  id        uuid primary key default gen_random_uuid(),
  dev_id    uuid not null references dev(id) on delete cascade,
  skill_id  uuid not null references skill(id) on delete cascade,
  level     int not null default 3,                -- 1..5
  unique (dev_id, skill_id)
);

-- ---------- Propuestas (borrador antes de Linear) ----------
create table if not exists proposal (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references project(id),
  title       text not null,
  spec        text not null,
  requester   text,                                -- quién la origina (para notificar al cerrar)
  optimality  text,                                -- veredicto de Claude
  status      text not null default 'evaluated',   -- evaluated | promoted | discarded
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists work_item (
  id              uuid primary key default gen_random_uuid(),
  linear_id       text not null unique,            -- identidad canónica
  identifier      text not null unique,            -- ROZ-123
  project_id      uuid references project(id),
  title           text not null,
  spec            text,
  state           text not null default 'backlog',
  requester       text,
  assignee_dev_id uuid references dev(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_work_item_linear on work_item(linear_id);

-- ---------- Second brain ----------
create table if not exists knowledge_atom (
  id               uuid primary key default gen_random_uuid(),
  scope            text not null default 'project',  -- project | shared
  project_id       uuid references project(id),
  status           text not null default 'active',   -- active | superseded | deprecated
  title            text not null,
  body             text not null,                     -- markdown
  provenance       text[] not null default '{}',      -- claves de issue Linear (ROZ-123)
  embedding        vector(1536),
  embedding_model  text,
  content_hash     text,                              -- para no reindexar si no cambió
  superseded_by    uuid references knowledge_atom(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_atom_project on knowledge_atom(project_id);
create index if not exists idx_atom_status on knowledge_atom(status);
-- Full-text para el lado keyword/BM25 del retrieval híbrido.
create index if not exists idx_atom_fts
  on knowledge_atom using gin (to_tsvector('spanish', title || ' ' || body));

create table if not exists atom_edge (
  id        uuid primary key default gen_random_uuid(),
  src_id    uuid not null references knowledge_atom(id) on delete cascade,
  dst_id    uuid not null references knowledge_atom(id) on delete cascade,
  kind      text not null,                          -- references | derived_from | project
  created_at timestamptz not null default now(),
  unique (src_id, dst_id, kind)
);

-- ---------- Notificaciones ----------
create table if not exists notification (
  id           uuid primary key default gen_random_uuid(),
  channel      text not null,                       -- whatsapp | email
  to_dev_id    uuid references dev(id),
  to_address   text,
  template     text,                                -- ContentSid de plantilla aprobada
  audio_asset  text,
  body         text,
  variables    jsonb not null default '{}'::jsonb,
  status       text not null default 'pending',     -- pending | sent | failed
  provider_id  text,                                -- sid de Twilio
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------- Núcleo de eventos: outbox + idempotencia ----------
create table if not exists outbox_event (
  id               uuid primary key default gen_random_uuid(),
  type             text not null,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'pending', -- pending | processing | done | failed | dead
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),  -- backoff: cuándo es elegible para (re)intentar
  idempotency_key  text unique,
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- El drain (Vercel Cron) busca por (status, next_attempt_at): índice compuesto.
create index if not exists idx_outbox_drain on outbox_event(status, next_attempt_at);

create table if not exists idempotency_key (
  key         text primary key,
  scope       text not null,                        -- commit | doc | notify | ...
  created_at  timestamptz not null default now()
);

-- ---------- Retrieval híbrido: keyword (FTS) + semántico (pgvector) + RRF ----------
-- p_embedding puede ser null (degrada a solo keyword). RRF con k=60.
create or replace function search_atoms_hybrid(
  p_project_id uuid,
  p_query      text,
  p_embedding  vector(1536),
  p_limit      int default 8
)
returns table (id uuid, title text, body text, score real)
language sql stable
as $$
  with kw as (
    select a.id,
           row_number() over (
             order by ts_rank(to_tsvector('spanish', a.title || ' ' || a.body),
                              plainto_tsquery('spanish', p_query)) desc
           ) as rnk
    from knowledge_atom a
    where a.project_id = p_project_id and a.status = 'active'
      and to_tsvector('spanish', a.title || ' ' || a.body) @@ plainto_tsquery('spanish', p_query)
    limit 50
  ),
  vec as (
    select a.id,
           row_number() over (order by a.embedding <=> p_embedding) as rnk
    from knowledge_atom a
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
  from fused f join knowledge_atom a on a.id = f.id
  order by f.score desc
  limit p_limit;
$$;
