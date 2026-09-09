import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { Note } from './useMirror';

/**
 * Un verbo que va a la red y no tiene una fila local que pintar: re-sincronizar, reintentar un
 * evento, subir un archivo, borrar con confirmación, mover un interruptor.
 *
 * Lo que resuelve, además del spinner: **la reentrada**. Doce botones de la app disparaban su
 * petición sin `disabled`, así que un doble clic mandaba dos DELETE, creaba dos bloques o encolaba
 * dos backfills. Aquí la clave es el candado: mientras `key` esté en vuelo, un segundo clic se
 * ignora en silencio. El `disabled` visual sigue siendo deseable, pero ya no es lo único que
 * protege.
 */

export interface RunOptions<R> {
  /** Toast al terminar bien. `false` = ninguno (si la pantalla ya lo muestra). */
  success?: Note | false;
  /** Título del toast de error. */
  error?: string;
  /** Solo si resolvió: insertar la fila, cerrar el diálogo, navegar. */
  onDone?: (result: R) => void;
  /** Siempre, haya ido bien o mal: cerrar un popover que debe cerrarse igual. */
  onSettled?: () => void;
}

export interface Action {
  run: <R>(key: string, fn: () => Promise<R>, opts?: RunOptions<R>) => Promise<R | undefined>;
  /** ¿Esa clave está en vuelo? Va al `disabled` y al spinner. */
  busy: (key: string) => boolean;
  /** ¿Cualquiera de ellas? Para deshabilitar una barra de acciones completa. */
  anyBusy: boolean;
}

/** Convención de claves: `'<verbo>:<id>'` — `'unlink:svc_123'`, `'resync:org/repo'`, `'del:skill_9'`. */
export function useAction(): Action {
  // Dos estructuras a propósito: el `Set` en un ref es el candado REAL, porque se lee y escribe de
  // forma síncrona en el mismo tick del clic. El array en estado es solo para pintar. Un `useState`
  // no sirve de candado: su updater corre en el render, así que dos clics en el mismo tick pasarían
  // los dos — que es exactamente el doble DELETE que se quiere impedir.
  const lock = useRef(new Set<string>());
  const [running, setRunning] = useState<string[]>([]);

  const run = useCallback(
    async <R,>(key: string, fn: () => Promise<R>, opts?: RunOptions<R>): Promise<R | undefined> => {
      if (lock.current.has(key)) return undefined; // ya en vuelo: se ignora la reentrada
      lock.current.add(key);
      setRunning((prev) => (prev.includes(key) ? prev : [...prev, key]));

      try {
        const result = await fn();
        if (opts?.success !== false && opts?.success !== undefined) {
          const note = opts.success;
          if (typeof note === 'string') toast.success(note);
          else toast.success(note.title, { description: note.description });
        }
        opts?.onDone?.(result);
        return result;
      } catch (err) {
        toast.error(opts?.error ?? 'No se pudo completar la acción', {
          description: String((err as Error)?.message ?? err),
        });
        return undefined;
      } finally {
        lock.current.delete(key);
        setRunning((prev) => prev.filter((k) => k !== key));
        opts?.onSettled?.();
      }
    },
    [],
  );

  const busy = useCallback((key: string) => running.includes(key), [running]);
  const anyBusy = useMemo(() => running.length > 0, [running]);

  return { run, busy, anyBusy };
}
