import { useEffect, useRef } from 'react';

/**
 * Sondeo periódico con pausa automática cuando la pestaña no se ve.
 *
 * Dos detalles que importan:
 *
 *  · `ms === null` pausa. Así el llamador decide la cadencia (p.ej. más rápida mientras hay algo
 *    en vuelo) sin montar y desmontar el hook.
 *  · Al volver a la pestaña, el intervalo se re-arma SIEMPRE, y lo que se decide es si además se
 *    sondea de inmediato (`onFocus`). Antes era siempre inmediato, y asomarse dos segundos a otra
 *    pestaña disparaba una ráfaga de peticiones que se leía como "la app se recargó". Con
 *    `'stale'` (el default) solo se pide si los datos ya tienen edad suficiente.
 *
 * La función se guarda en un ref: cambiarla no reinicia el intervalo (evita que un callback nuevo
 * en cada render reprograme el timer para siempre).
 */
export interface PollOptions {
  /**
   * Qué hacer al volver a la pestaña:
   *  · `'stale'`  (default) sondea solo si pasaron ≥ `minAge` ms desde el último sondeo.
   *  · `'always'` sondea siempre — para vistas donde el usuario vuelve JUSTO a ver moverse algo
   *    (el progreso de una sincronización).
   *  · `'never'`  espera al siguiente ciclo del intervalo.
   */
  onFocus?: 'always' | 'stale' | 'never';
  /** Edad mínima para el modo `'stale'`. Por defecto, la propia cadencia. */
  minAge?: number;
}

export function usePoll(fn: () => void, ms: number | null, opts: PollOptions = {}) {
  const { onFocus = 'stale', minAge } = opts;
  const saved = useRef(fn);
  saved.current = fn;
  // Fuera del efecto: así sobrevive a los cambios de cadencia (`ms`), que re-arman el intervalo.
  const lastRun = useRef(0);

  useEffect(() => {
    if (ms == null) return;

    const run = () => {
      lastRun.current = Date.now();
      saved.current();
    };

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer == null) timer = setInterval(run, ms);
    };
    const stop = () => {
      if (timer != null) clearInterval(timer);
      timer = null;
    };

    const shouldRunOnFocus = () => {
      if (onFocus === 'never') return false;
      if (onFocus === 'always') return true;
      return Date.now() - lastRun.current >= (minAge ?? ms);
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
        return;
      }
      if (shouldRunOnFocus()) run();
      start();
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms, onFocus, minAge]);
}
