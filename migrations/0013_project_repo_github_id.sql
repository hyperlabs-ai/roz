-- 0013 — Ancla inmutable repo→proyecto por id numérico de GitHub. El full_name ("owner/name") cambia
-- al renombrar o transferir un repo en GitHub; su id numérico NO. Guardarlo permite (a) reconciliar
-- el rename sin perder el vínculo ni el historial y (b) auto-sanar el mapeo aunque el webhook de
-- rename se pierda: el siguiente push trae el id y resolveProjectByRepo corrige el nombre solo.
alter table roz.project_repo add column if not exists github_repo_id bigint;

-- Único cuando está presente (un id de GitHub ↔ una fila); las filas viejas sin id no chocan
-- (un índice único parcial ignora los null, así que conviven las ya vinculadas sin id).
create unique index if not exists idx_roz_project_repo_github_id
  on roz.project_repo(github_repo_id) where github_repo_id is not null;
