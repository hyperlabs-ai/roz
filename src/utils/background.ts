// Trabajo que sigue después de responder (push, broadcast, completar una interacción de Discord).
//
// zeus es un proceso de larga vida, así que la promesa simplemente sigue corriendo. Lo único que hay
// que cuidar es el apagado: al redesplegar llega SIGTERM y lo que esté en vuelo se perdería, por eso
// se lleva la cuenta y `drainBackground` las espera (con tope) antes de salir.
const pending = new Set<Promise<unknown>>();

/** Corre `task` sin bloquear la respuesta. Best-effort: los errores se reportan y se tragan. */
export function inBackground(task: () => Promise<unknown>, onError?: (err: unknown) => void): void {
  const p = Promise.resolve()
    .then(task)
    .catch((err) => onError?.(err))
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** Cuántas tareas siguen en vuelo (para /health y pruebas). */
export function backgroundPending(): number {
  return pending.size;
}

/** Espera lo que esté en vuelo, hasta `timeoutMs`. Se llama una vez, al apagar. */
export async function drainBackground(timeoutMs = 10_000): Promise<void> {
  if (!pending.size) return;
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, timeoutMs))]);
}
