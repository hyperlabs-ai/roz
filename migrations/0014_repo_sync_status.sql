-- 0014 — Estado de sincronización (backfill del historial) por repo, para mostrar progreso en el
-- dashboard. Hasta ahora el backfill era una caja negra (se encolaba y corría en segundo plano sin
-- señal); estas columnas lo hacen visible: la UI muestra en cola → sincronizando (barra) → listo.
--   sync_status: idle | queued | syncing | done | error
--   sync_pages / sync_commits: progreso de la corrida actual (páginas de 100 procesadas / commits persistidos)
--   sync_total_pages: total estimado de páginas (del header Link de GitHub); null = progreso indeterminado
--   sync_error: último error (solo cuando status=error, tras agotar reintentos)
alter table roz.project_repo
  add column if not exists sync_status text not null default 'idle',
  add column if not exists sync_pages int not null default 0,
  add column if not exists sync_commits int not null default 0,
  add column if not exists sync_total_pages int,
  add column if not exists sync_error text,
  add column if not exists sync_started_at timestamptz,
  add column if not exists sync_updated_at timestamptz;
