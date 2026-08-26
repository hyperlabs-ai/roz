import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiGet, type DevPresence, type PresenceResponse, type PresenceStatus } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { usePoll } from '@/lib/usePoll';

/**
 * Presencia del equipo (ocupado / libre según Google Calendar), global porque el punto de estado
 * aparece en cualquier avatar del dashboard. Mismo molde que `QueueContext`.
 *
 * La diferencia que importa: aquí el sondeo NO tiene que ser rápido. El backend devuelve `busyUntil`
 * y `nextStartsAt`, así que el momento exacto en que alguien sale de una junta se calcula contra el
 * reloj local — un tick de 15 s sin red. La petición cada minuto solo sirve para enterarse de
 * eventos nuevos o movidos.
 */
interface PresenceLive {
  /** Estado ya reevaluado contra el reloj local. `undefined` = dev sin calendario conectado. */
  presenceOf: (devId: string) => DevPresence | undefined;
  stale: boolean;
  refresh: () => void;
}

const Ctx = createContext<PresenceLive>({ presenceOf: () => undefined, stale: false, refresh: () => {} });

/** Fallos seguidos tras los cuales se declara "sin contacto" y el indicador se apaga. */
const STALE_AFTER = 3;
const POLL_MS = 60_000;
const TICK_MS = 15_000;

/**
 * Reevalúa un estado servido contra el reloj de ESTE navegador.
 *
 * Sin esto, alguien con el dashboard abierto seguiría viendo la junta de hace un rato hasta el
 * siguiente sondeo. No se adivina nada: la respuesta se recalcula sobre `upcoming`, que es la agenda
 * que el servidor ya mandó — las mismas reglas, solo que contra la hora de aquí.
 *
 * Recalcular sobre la lista (en vez de apagar la ocupación cuando vence `busyUntil`) es lo que evita
 * el parpadeo entre dos juntas seguidas: al terminar la primera, la segunda ya está en la lista y
 * toma el relevo en el mismo tick, sin pasar por "sin actividad".
 */
function reevaluate(p: DevPresence, nowMs: number): DevPresence {
  const upcoming = p.upcoming
    .filter((b) => Date.parse(b.endsAt) > nowMs)
    .map((b) => ({ ...b, current: Date.parse(b.startsAt) <= nowMs }));

  const activos = upcoming.filter((b) => b.current);
  const siguiente = upcoming.find((b) => Date.parse(b.startsAt) > nowMs) ?? null;

  if (!activos.length) {
    return {
      ...p,
      status: 'free' as PresenceStatus,
      title: siguiente?.title ?? null,
      busyUntil: null,
      nextStartsAt: siguiente?.startsAt ?? null,
      nextTitle: siguiente?.title ?? null,
      upcoming,
    };
  }

  // Mismo criterio que el servidor: de los solapados manda el que empezó más tarde.
  const actual = activos.reduce((a, b) => (Date.parse(b.startsAt) >= Date.parse(a.startsAt) ? b : a));
  return {
    ...p,
    status: 'busy' as PresenceStatus,
    title: actual.title,
    busyUntil: actual.endsAt,
    nextStartsAt: siguiente?.startsAt ?? null,
    nextTitle: siguiente?.title ?? null,
    upcoming,
  };
}

export function PresenceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [devs, setDevs] = useState<DevPresence[]>([]);
  const [fails, setFails] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inflightReq = useRef(false);

  const poll = useCallback(async () => {
    if (inflightReq.current) return;
    inflightReq.current = true;
    try {
      const res = await apiGet<PresenceResponse>('/presence');
      setDevs(res.devs ?? []);
      setFails(0);
    } catch {
      setFails((f) => f + 1);
    } finally {
      inflightReq.current = false;
    }
  }, []);

  const stale = fails >= STALE_AFTER;

  useEffect(() => {
    if (user) void poll();
    else setDevs([]);
  }, [user, poll]);

  usePoll(poll, user ? POLL_MS : null);

  // Tick local: mueve el reloj contra el que se reevalúan los estados. Barato (no toca la red) y es
  // lo que hace que el indicador cambie en el segundo exacto en que termina una junta.
  useEffect(() => {
    if (!user) return;
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [user]);

  const byDev = useMemo(() => {
    const map = new Map<string, DevPresence>();
    if (stale) return map; // sin contacto: mejor no pintar nada que pintar algo viejo
    for (const p of devs) {
      const live = reevaluate(p, now);
      // Un estado que el propio backend marcó viejo tampoco se muestra.
      if (!live.stale && live.status !== 'unknown') map.set(live.devId, live);
    }
    return map;
  }, [devs, now, stale]);

  const value = useMemo<PresenceLive>(
    () => ({
      presenceOf: (devId: string) => byDev.get(devId),
      stale,
      refresh: () => void poll(),
    }),
    [byDev, stale, poll],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const usePresence = () => useContext(Ctx);

/** Atajo para el caso común: el estado de un dev concreto. */
export function useDevPresence(devId: string | null | undefined): DevPresence | undefined {
  const { presenceOf } = usePresence();
  return devId ? presenceOf(devId) : undefined;
}
