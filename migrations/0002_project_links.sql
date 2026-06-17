-- 0002 — Alinea roz.project con el modelo de anclaje canónico (Linear Project + HyperOps).
-- Idempotente: seguro de correr sobre cualquier entorno, ya esté en el esquema viejo
-- (con github_repo) o ya migrado. La DB de HyperOps ya está en el estado final; esta
-- migración existe para entornos creados desde la versión inicial de 0001.

-- Columnas nuevas (el repo dejó de vivir aquí; se resuelve en vivo vía github_repositories).
alter table roz.project add column if not exists linear_project_id   text;
alter table roz.project add column if not exists hyperops_project_id uuid;
alter table roz.project add column if not exists active              boolean not null default true;

-- Columna obsoleta: el mapeo repo→proyecto ya no se guarda en project.
alter table roz.project drop column if exists github_repo;
drop index if exists roz.idx_roz_project_github_repo;

-- Índices del nuevo modelo.
create index if not exists idx_roz_project_hyperops on roz.project(hyperops_project_id);
create unique index if not exists uq_roz_project_linear_project
  on roz.project(linear_project_id) where linear_project_id is not null;
