-- 0003 — Persistencia de commits para el dashboard de visibilidad de ingeniería.
-- Hasta ahora roz procesaba cada commit y lo descartaba (solo quedaba la llave en
-- idempotency_key). El dashboard necesita commits consultables y atribuidos a un dev, con
-- fecha y tamaño, para métricas time-series (commits por dev/proyecto/período).
-- Se llena hacia adelante desde reconcileCommit (sin backfill).

create table if not exists roz.commit (
  id            uuid primary key default gen_random_uuid(),
  sha           text not null,
  repo          text not null,                          -- "owner/name"
  project_id    uuid references roz.project(id),        -- null si el repo no está mapeado aún
  dev_id        uuid references roz.dev(id),            -- autor resuelto a un dev de roz (o null)
  author_login  text,                                   -- login de GitHub del autor
  author_email  text,                                   -- email del commit (git config)
  message       text,
  url           text,
  additions     int,
  deletions     int,
  committed_at  timestamptz,                            -- fecha del commit (de git), para filtros de período
  created_at    timestamptz not null default now(),
  unique (repo, sha)
);
create index if not exists idx_roz_commit_dev          on roz.commit(dev_id);
create index if not exists idx_roz_commit_project      on roz.commit(project_id);
create index if not exists idx_roz_commit_committed_at on roz.commit(committed_at);
create index if not exists idx_roz_commit_repo         on roz.commit(repo);

-- El service_role lo usa roz server-side; default privileges de 0001 ya cubren tablas nuevas,
-- pero lo dejamos explícito por si la migración corre con otro rol.
grant all on roz.commit to service_role;
