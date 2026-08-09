import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiGet, type QueuePulse } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { usePoll } from '@/lib/usePoll';

interface QueueLive {
  pulse: QueuePulse | null;
  /** Varios sondeos fallidos seguidos: el indicador se apaga en vez de mentir. */
  stale: boolean;
  /** Fuerza un sondeo inmediato (lo usa la sección al montar). */
  refresh: () => void;
}

const Ctx = createContext<QueueLive>({ pulse: null, stale: false, refresh: () => {} });

/** Fallos seguidos tras los cuales se declara "sin contacto". */
const STALE_AFTER = 3;

/**
 * Estado GLOBAL de la cola de procesamiento. Vive en el root del dashboard porque el indicador del
 * header aparece en TODAS las pantallas, y la sección lee de aquí lo que está en vuelo — así el
 * indicador y la sección nunca se contradicen ni duplican peticiones.
 *
 * Sondea `/queue/pulse`, que es deliberadamente ligero (salud + hasta 5 eventos en vuelo, sin
 * historial).
 *
 * Cadencia con decaimiento, no fija: la app se deja abierta todo el día y sondear cada 3s serían
 * decenas de miles de invocaciones diarias por nada. Se acelera cuando hay movimiento y se va
 * calmando cuando no, pero NUNCA se apaga del todo — si se apagara, un push llegado durante la
 * calma no aparecería hasta que alguien tocara algo.
 */
export function QueueProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [pulse, setPulse] = useState<QueuePulse | null>(null);
  const [fails, setFails] = useState(0);
  // Sondeos consecutivos sin nada que reportar. Sube la cadencia poco a poco.
  const [quiet, setQuiet] = useState(0);
  const inflightReq = useRef(false);

  const poll = useCallback(async () => {
    // Con la red lenta, dos sondeos podrían solaparse y llegar desordenados.
    if (inflightReq.current) return;
    inflightReq.current = true;
    try {
      const p = await apiGet<QueuePulse>('/queue/pulse');
      setPulse(p);
      setFails(0);
      const busy = p.counts.pending + p.counts.processing + p.counts.dead + p.counts.failed > 0;
      setQuiet((q) => (busy ? 0 : q + 1));
    } catch {
      setFails((f) => f + 1);
    } finally {
      inflightReq.current = false;
    }
  }, []);

  const stale = fails >= STALE_AFTER;
  const busy = !!pulse && pulse.counts.pending + pulse.counts.processing + pulse.counts.dead + pulse.counts.failed > 0;

  const ms = useMemo(() => {
    if (!user) return null; // sin sesión no hay nada que sondear
    if (stale) return 30_000;
    if (busy) return 5_000;
    if (quiet < 4) return 15_000;
    if (quiet < 12) return 30_000;
    return 60_000;
  }, [user, stale, busy, quiet]);

  // Primer sondeo al entrar: `usePoll` solo dispara al cumplirse el intervalo, y esperar 15s a
  // que aparezca el indicador se sentiría roto.
  useEffect(() => {
    if (user) void poll();
  }, [user, poll]);

  usePoll(poll, ms);

  const refresh = useCallback(() => {
    setQuiet(0);
    void poll();
  }, [poll]);

  const value = useMemo<QueueLive>(() => ({ pulse, stale, refresh }), [pulse, stale, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useQueueLive = () => useContext(Ctx);
