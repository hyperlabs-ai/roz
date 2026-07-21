import { useEffect, useRef, useState } from 'react';

/**
 * Fetch declarativo con loading/error y recarga manual. `deps` controla el refetch.
 *
 * Estrategia stale-while-revalidate: `loading` es SOLO la carga inicial (aún sin datos). En una
 * recarga (`reload()`) o cambio de `deps` cuando YA hay datos, estos se mantienen visibles y la
 * actualización ocurre en silencio (`refetching`), sin mostrar skeletons. Así una mutación con
 * update optimista + reload() no provoca el "parpadeo" de recarga completa (se siente como Kanban).
 */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refetching, setRefetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const hasData = useRef(false);

  useEffect(() => {
    let alive = true;
    // Con datos previos → revalidación silenciosa; sin datos → carga inicial (skeletons).
    if (hasData.current) setRefetching(true);
    else setLoading(true);
    setError(null);
    fn()
      .then((d) => {
        if (!alive) return;
        hasData.current = true;
        setData(d);
        setLoading(false);
        setRefetching(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e?.message ?? e));
        setLoading(false);
        setRefetching(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, loading, refetching, error, reload: () => setTick((t) => t + 1) };
}
