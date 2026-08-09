import { useEffect, useRef } from 'react';

/**
 * Sondeo periódico con pausa automática cuando la pestaña no se ve.
 *
 * Generaliza el patrón que `SyncContext` ya usaba a mano. Dos detalles que importan:
 *
 *  · `ms === null` pausa. Así el llamador decide la cadencia (p.ej. más rápida mientras hay algo
 *    en vuelo) sin montar y desmontar el hook.
 *  · Al volver a la pestaña se dispara un sondeo INMEDIATO antes de re-armar el intervalo. Sin
 *    esto, regresar a una pestaña dormida te deja mirando datos viejos hasta el siguiente ciclo,
 *    que es justo el momento en que más quieres ver algo fresco.
 *
 * La función se guarda en un ref: cambiarla no reinicia el intervalo (evita que un callback nuevo
 * en cada render reprograme el timer para siempre).
 */
export function usePoll(fn: () => void, ms: number | null) {
  const saved = useRef(fn);
  saved.current = fn;

  useEffect(() => {
    if (ms == null) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer == null) timer = setInterval(() => saved.current(), ms);
    };
    const stop = () => {
      if (timer != null) clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        saved.current();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms]);
}
