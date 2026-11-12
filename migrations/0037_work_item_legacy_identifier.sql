-- 0037 — roz v2: el identificador viejo de una tarea nativa que se migró a Linear.
--
-- Al encender ROZ_LINEAR_SOT, scripts/migrate-tasks-to-linear.ts crea en Linear las tareas nativas
-- abiertas y convierte la MISMA fila de work_item en el espejo del issue nuevo: `identifier` pasa a
-- ser el de Linear (HYP-45). Las ramas, commits y PRs que ya decían "ROZ-123" no se reescriben, así
-- que el identificador viejo se guarda aquí y src/linear/legacy.ts lo usa como respaldo al resolver
-- referencias. Una fila de historial (completada) nunca se migra, y por eso nunca lo llena.
--
-- Aditiva e idempotente.

alter table roz.work_item add column if not exists legacy_identifier text;

create unique index if not exists uq_roz_work_item_legacy_identifier
  on roz.work_item (legacy_identifier) where legacy_identifier is not null;

notify pgrst, 'reload schema';
