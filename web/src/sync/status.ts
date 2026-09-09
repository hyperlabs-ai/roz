// Predicados del estado de sincronización de un repo, en UN solo sitio.
//
// Existen porque el front comparaba contra 'completada' (vocabulario del dominio de tareas) cuando
// el backend escribe 'done' (`src/reconcile/backfill.ts:168`, dominio en la migración 0014). El
// resultado: el widget nunca mostraba el ✓, la barra nunca llegaba al 100% en verde y el detalle
// del proyecto NUNCA se recargaba al terminar un backfill — o sea, la app se quedaba con datos
// viejos indefinidamente aunque el trabajo ya estuviera hecho. Con los predicados aquí, el literal
// aparece una vez y no puede volver a divergir.
import type { RepoSyncStatus } from '@/lib/api';

/** En cola o trayendo commits: hay trabajo en curso. */
export const isRunning = (s: RepoSyncStatus): boolean => s.status === 'queued' || s.status === 'syncing';

/** Terminó bien. */
export const isSyncDone = (s: RepoSyncStatus): boolean => s.status === 'done';

/** Terminó mal. */
export const isSyncError = (s: RepoSyncStatus): boolean => s.status === 'error';
