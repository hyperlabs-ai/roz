// Trabajo que sigue después de responder. En Vercel, `waitUntil` mantiene viva la función hasta que
// la promesa termina (sin él, el runtime puede congelarla en cuanto sale la respuesta y el push o el
// broadcast se pierden). En local (node-server) no hay contexto: la promesa simplemente sigue.
import { waitUntil } from '@vercel/functions';

/** Corre `task` sin bloquear la respuesta. Best-effort: los errores se reportan y se tragan. */
export function inBackground(task: () => Promise<unknown>, onError?: (err: unknown) => void): void {
  const p = Promise.resolve()
    .then(task)
    .catch((err) => onError?.(err));
  try {
    waitUntil(p);
  } catch {
    /* sin contexto de Vercel: la promesa sigue sola */
  }
}
