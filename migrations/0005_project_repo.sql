-- 0005 — Mapeo directo repo → proyecto en roz (para el dashboard). Hasta ahora el repo→proyecto
-- solo se resolvía vía public.github_repositories de HyperOps (repos de cliente). Esta tabla
-- permite mapear CUALQUIER repo (incluidos internos: roz, hyperflow, etc.) a un roz.project,
-- sin depender de HyperOps. resolveProjectByRepo consulta esto primero y cae al de HyperOps.
create table if not exists roz.project_repo (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references roz.project(id) on delete cascade,
  repo        text not null unique,   -- full_name "owner/name", igual al repository.full_name del webhook
  created_at  timestamptz not null default now()
);
create index if not exists idx_roz_project_repo_repo on roz.project_repo(repo);

grant all on roz.project_repo to service_role;
