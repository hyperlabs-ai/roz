import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { fetchEntry, getEntry, isFresh, keyFor, subscribe } from './store';

/**
 * Fetch declarativo con loading/error y recarga manual. `deps` controla el refetch.
 *
 * Estrategia stale-while-revalidate: `loading` es SOLO cuando no hay nada que mostrar. Con datos
 * (propios o de la caché), la actualización ocurre en silencio (`refetching`), sin skeletons. Así
 * una mutación con update optimista + revalidación no provoca parpadeo (se siente como Kanban).
 *
 * La caché (`lib/store.ts`) es OPT-IN por `opts.key`:
 *   · SIN `key` → los datos mueren con la instancia, exactamente como antes.
 *   · CON `key` → se comparten entre montajes y entre páginas, así que volver a una sección pinta
 *     al instante y revalida en segundo plano.
 *
 * `deps` DEBE contener solo primitivos: se serializa para formar la clave de caché (junto al
 * `key` y al id del usuario), y ahí es donde salen gratis las variantes por filtro o período.
 */

/** Antigüedad por defecto para servir sin revalidar. Corta a propósito: lo mutable manda. */
const DEFAULT_TTL = 30_000;

export interface ApiOptions {
  /** Namespace de caché; por convención, la ruta de la API (`'/projects'`). Sin esto, no se cachea. */
  key?: string;
  /** Antigüedad máxima (ms) para servir sin ir a la red. Default 30 s. */
  ttl?: number;
}

let uid = 0;

export function useApi<T>(fn: () => Promise<T>, deps: unknown[], opts: ApiOptions = {}) {
  const { key, ttl = DEFAULT_TTL } = opts;
  const [tick, setTick] = useState(0);

  // Sin `key`, cada instancia usa una clave privada (prefijo `#`) que el store borra al desmontar:
  // un solo camino de código para los dos comportamientos.
  const privateKey = useRef<string>();
  if (!privateKey.current) privateKey.current = `#${++uid}`;
  const cacheKey = keyFor(key ?? privateKey.current, deps);

  const entry = useSyncExternalStore(
    useCallback((cb: () => void) => subscribe(cacheKey, cb), [cacheKey]),
    useCallback(() => getEntry<T>(cacheKey), [cacheKey]),
  );

  // `fn` en un ref: los call sites pasan una arrow nueva en cada render y no debe reprogramar nada
  // (por eso tampoco está en las deps del efecto).
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const lastTick = useRef(tick);

  // `entry.at` en las deps es lo que hace funcionar a `invalidate()`: marcar una entrada como vieja
  // (at = 0) tiene que volver a disparar ESTE efecto, o el componente montado se quedaría con datos
  // viejos para siempre. No hay bucle: al resolver, `at` pasa a ser reciente, el efecto vuelve a
  // correr y sale por "está fresca". Y un fallo no cambia `at`, así que no hay tormenta de reintentos.
  useEffect(() => {
    const forced = lastTick.current !== tick; // reload() explícito: ignora el TTL
    lastTick.current = tick;
    if (!forced && isFresh(getEntry(cacheKey), ttl)) return; // servido de caché: cero red
    // El error se guarda en la entrada; aquí se traga para no dejar un rechazo sin manejar.
    fetchEntry(cacheKey, () => fnRef.current(), forced).catch(() => {});
  }, [cacheKey, tick, ttl, entry.at]);

  const data = entry.data as T | null;
  return {
    data,
    /** Primera carga sin nada que pintar. Con datos cacheados nunca es true: no hay skeleton. */
    loading: data === null && entry.error === null,
    /** Revalidación con datos en pantalla. Píntalo (RefreshButton / Revalidating) o el usuario no
     *  sabe que algo está pasando: era la causa de "no sabes si están async". */
    refetching: data !== null && entry.pending,
    error: entry.error,
    reload: useCallback(() => setTick((t) => t + 1), []),
    /** Cuándo se resolvió lo que se está viendo (para "datos de hace X"). */
    updatedAt: entry.at || null,
  };
}
