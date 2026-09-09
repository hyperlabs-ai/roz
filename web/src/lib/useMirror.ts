import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

/**
 * Copia local espejo de una lista del servidor, con mutaciones optimistas.
 *
 * Es la extracción de lo que arregló Tareas (commits 9d02178 / 3ca647a) y que ninguna otra sección
 * copiaba porque costaba ~25 líneas por sitio. El síntoma que resuelve, tal como se reportó: haces
 * clic, sale un toast diciendo "guardado", la pantalla sigue idéntica uno a tres segundos y de
 * pronto la sección entera se repinta. Eso pasaba porque cada mutación hacía `reload()` de todo y
 * `useApi` revalida en silencio.
 *
 * Las cinco reglas que implementa, para que un call site sean 3 líneas:
 *   1. Se pinta `items` (el espejo), NUNCA `data.x` directo.
 *   2. El cambio se ve en el frame del clic (optimista) y se sustituye UNA fila, sin recargar nada.
 *   3. Encadena por entidad: dos clics seguidos en la misma fila se aplican en orden, no compiten.
 *   4. Si el servidor devuelve la entidad, se ADOPTA (así el front deja de inventar lo que el
 *      backend ya calculó); si devuelve void, se queda el optimista.
 *   5. Si falla, revierte SOLO las claves que ese patch tocó (revertir la fila entera pisaría un
 *      cambio posterior de la misma cadena) y avisa con un toast de error.
 */

export type Note = string | { title: string; description?: string };

export interface Notes {
  /** Toast de éxito. `false` = ninguno: si el cambio ya se ve en pantalla, un toast es ruido. */
  success?: Note | false;
  /** Título del toast de error. */
  error?: string;
}

export interface MirrorOptions<T> {
  /** Clave estable de cada elemento. Default: `item.id`. En la matriz de skills es compuesta. */
  key?: (item: T) => string;
  /** Dónde cae lo creado. `'start'` por defecto: es el fix de "creé algo y no lo veo". */
  insert?: 'start' | 'end';
  /** Cuánto dura el resaltado de lo recién creado. Default 2.5 s. */
  freshMs?: number;
}

export interface Mirror<T> {
  /** Lo que hay que pintar. */
  items: T[];
  /** Reemplazo total (para reordenamientos del padre, p.ej. arrastrar tarjetas). */
  reset: (next: T[]) => void;
  /** ¿Esa entidad tiene algo en vuelo? Va al `disabled` y al spinner DE ESA FILA. */
  isBusy: (id: string) => boolean;
  /** Mutaciones en vuelo en toda la lista (para deshabilitar una barra completa). */
  busyCount: number;
  /** ¿Recién creada? Para el anillo de resaltado y el scroll. */
  isFresh: (id: string) => boolean;
  patch: (item: T, optimistic: Partial<T>, send: (item: T) => Promise<T | void>, notes?: Notes) => Promise<void>;
  create: (draft: T, send: () => Promise<T>, notes?: Notes) => Promise<T | null>;
  remove: (item: T, send: (item: T) => Promise<unknown>, notes?: Notes) => Promise<void>;
}

function showSuccess(note: Notes['success']): void {
  if (note === false || note === undefined) return;
  if (typeof note === 'string') toast.success(note);
  else toast.success(note.title, { description: note.description });
}

function showError(title: string | undefined, err: unknown): void {
  toast.error(title ?? 'No se pudo guardar', { description: String((err as Error)?.message ?? err) });
}

export function useMirror<T>(data: T[] | null | undefined, options: MirrorOptions<T> = {}): Mirror<T> {
  const { insert = 'start', freshMs = 2_500 } = options;
  const keyOf = useMemo(
    () => options.key ?? ((item: T) => String((item as { id?: unknown }).id)),
    [options.key],
  );
  const keyRef = useRef(keyOf);
  keyRef.current = keyOf;

  const [items, setItems] = useState<T[]>(data ?? []);
  const [busy, setBusy] = useState<Record<string, number>>({});
  const [fresh, setFresh] = useState<string[]>([]);

  /** Cadena por entidad: la promesa pendiente de cada id. */
  const chains = useRef(new Map<string, Promise<unknown>>());
  /** Ids nacidos en este cliente que el servidor todavía no ha devuelto en un GET. */
  const local = useRef(new Set<string>());
  /** Ids con una mutación en vuelo: sus filas no las pisa una respuesta del servidor. */
  const inflight = useRef(new Set<string>());

  // Adopción de lo que llega del servidor. NO es un `setItems(data)` a secas: si una respuesta
  // aterriza mientras hay un PATCH viajando, sustituirla mostraría el valor viejo un instante (y
  // volvería a "parpadear" al llegar el nuestro).
  useEffect(() => {
    if (!data) return;
    setItems((prev) => {
      const k = keyRef.current;
      if (!inflight.current.size && !local.current.size) return data;
      const held = new Map(prev.filter((x) => inflight.current.has(k(x))).map((x) => [k(x), x]));
      const served = new Set(data.map(k));
      // Lo creado aquí que el GET aún no incluye (salió antes que nuestro POST) no se pierde.
      const orphans = prev.filter((x) => local.current.has(k(x)) && !served.has(k(x)));
      const merged = data.map((x) => held.get(k(x)) ?? x);
      for (const id of served) local.current.delete(id);
      return insert === 'start' ? [...orphans, ...merged] : [...merged, ...orphans];
    });
  }, [data, insert]);

  const mark = useCallback((id: string, delta: number) => {
    setBusy((b) => {
      const next = (b[id] ?? 0) + delta;
      const copy = { ...b };
      // Contador, no booleano: dos patches encadenados sobre la misma fila no deben apagar el
      // spinner a mitad de camino.
      if (next <= 0) delete copy[id];
      else copy[id] = next;
      return copy;
    });
  }, []);

  const markFresh = useCallback((id: string) => {
    setFresh((f) => (f.includes(id) ? f : [...f, id]));
    setTimeout(() => setFresh((f) => f.filter((x) => x !== id)), freshMs);
  }, [freshMs]);

  /** Encola `run` detrás de lo que ya haya pendiente para ese id. */
  const chain = useCallback(<R,>(id: string, run: () => Promise<R>): Promise<R> => {
    const prev = chains.current.get(id) ?? Promise.resolve();
    // `then(run, run)`: la cadena continúa aunque el eslabón anterior fallara.
    const next = prev.then(run, run);
    // Se guarda la versión "silenciada" (sin rechazo) y se compara CONTRA ELLA al limpiar: guardar
    // una y comparar la otra dejaba la entrada colgada para siempre.
    const link = next.catch(() => {});
    chains.current.set(id, link);
    void link.then(() => {
      if (chains.current.get(id) === link) chains.current.delete(id);
    });
    return next;
  }, []);

  const replace = useCallback((id: string, updater: (item: T) => T) => {
    setItems((prev) => prev.map((x) => (keyRef.current(x) === id ? updater(x) : x)));
  }, []);

  const patch = useCallback(
    async (item: T, optimistic: Partial<T>, send: (item: T) => Promise<T | void>, notes?: Notes) => {
      const id = keyRef.current(item);
      replace(id, (x) => ({ ...x, ...optimistic }));
      mark(id, 1);
      inflight.current.add(id);
      await chain(id, async () => {
        try {
          const served = await send({ ...item, ...optimistic });
          if (served) replace(id, () => served);
          showSuccess(notes?.success);
        } catch (err) {
          // Rollback PARCIAL: solo las claves de este patch.
          const revert = Object.fromEntries(
            Object.keys(optimistic).map((k) => [k, (item as Record<string, unknown>)[k]]),
          ) as Partial<T>;
          replace(id, (x) => ({ ...x, ...revert }));
          showError(notes?.error, err);
        } finally {
          inflight.current.delete(id);
          mark(id, -1);
        }
      });
    },
    [chain, mark, replace],
  );

  const create = useCallback(
    async (draft: T, send: () => Promise<T>, notes?: Notes): Promise<T | null> => {
      const draftId = keyRef.current(draft);
      local.current.add(draftId);
      inflight.current.add(draftId);
      mark(draftId, 1);
      setItems((prev) => (insert === 'start' ? [draft, ...prev] : [...prev, draft]));
      markFresh(draftId);
      try {
        const served = await send();
        const servedId = keyRef.current(served);
        // El servidor puede darle otro id (o normalizar campos): se adopta y se re-etiqueta.
        setItems((prev) => prev.map((x) => (keyRef.current(x) === draftId ? served : x)));
        if (servedId !== draftId) {
          local.current.delete(draftId);
          local.current.add(servedId);
          markFresh(servedId);
        }
        showSuccess(notes?.success);
        return served;
      } catch (err) {
        setItems((prev) => prev.filter((x) => keyRef.current(x) !== draftId));
        local.current.delete(draftId);
        showError(notes?.error, err);
        return null;
      } finally {
        inflight.current.delete(draftId);
        mark(draftId, -1);
      }
    },
    [insert, mark, markFresh],
  );

  const remove = useCallback(
    async (item: T, send: (item: T) => Promise<unknown>, notes?: Notes) => {
      const id = keyRef.current(item);
      // La posición se calcula ANTES del setState: el updater de React corre en el render, así que
      // leerla desde dentro podría llegar tarde y la fila reaparecería al final tras un fallo.
      const index = items.findIndex((x) => keyRef.current(x) === id);
      setItems((prev) => prev.filter((x) => keyRef.current(x) !== id));
      mark(id, 1);
      inflight.current.add(id);
      try {
        await send(item);
        showSuccess(notes?.success);
      } catch (err) {
        // Vuelve A SU POSICIÓN, no al final: reaparecer en otro sitio se lee como otro cambio.
        setItems((prev) => {
          const at = index < 0 ? prev.length : index;
          return [...prev.slice(0, at), item, ...prev.slice(at)];
        });
        showError(notes?.error, err);
      } finally {
        inflight.current.delete(id);
        mark(id, -1);
      }
    },
    [items, mark],
  );

  const reset = useCallback((next: T[]) => setItems(next), []);
  const isBusy = useCallback((id: string) => !!busy[id], [busy]);
  const isFresh = useCallback((id: string) => fresh.includes(id), [fresh]);
  const busyCount = useMemo(() => Object.keys(busy).length, [busy]);

  return { items, reset, isBusy, busyCount, isFresh, patch, create, remove };
}
