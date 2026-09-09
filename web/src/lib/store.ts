// Caché stale-while-revalidate compartida entre montajes. Mismo patrón (casero, sin dependencias)
// que hyperflow-app/src/hooks/use-api.ts:8-24.
//
// El problema que resuelve: `useApi` guardaba los datos en el estado de CADA instancia, así que
// entrar a una sección, salir y volver arrancaba siempre en `loading = true` → skeletons y refetch,
// aunque los datos tuvieran dos segundos de vida. Con esto, volver pinta al instante y revalida en
// silencio.
//
// Tres invariantes que hay que respetar o esto se rompe:
//   1. Cada escritura CREA una entrada nueva; nunca se muta en sitio. `useSyncExternalStore`
//      compara por identidad: una mutación no notificaría, y recrear en el getter sería un bucle
//      infinito de renders.
//   2. La clave lleva el id del usuario (`scope`) dentro. Es el primer cerrojo para que la caché
//      no pueda servir datos de otra cuenta.
//   3. Una respuesta en vuelo se descarta si el `scope` cambió mientras viajaba (contador de
//      generación). Es el segundo cerrojo del mismo riesgo.

export interface Entry<T> {
  data: T | null;
  error: string | null;
  /** epoch ms en que se resolvió. 0 = nunca cargada, o invalidada. */
  at: number;
  /** Hay una petición en vuelo para esta clave. */
  pending: boolean;
}

/** Entrada vacía COMPARTIDA: devolver un objeto nuevo aquí sería un bucle de renders (invariante 1). */
const EMPTY: Entry<never> = { data: null, error: null, at: 0, pending: false };

const entries = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const subs = new Map<string, Set<() => void>>();

/** Tope de entradas. Al pasarse se desalojan las más viejas SIN suscriptores (nunca las montadas). */
const MAX_ENTRIES = 80;

let scope = '';
let generation = 0;

/** Claves que empiezan así son privadas de una instancia de `useApi` (llamada sin `key`): no se
 *  comparten con nadie y se borran al desmontar. */
const PRIVATE = '#';

function notify(key: string): void {
  const set = subs.get(key);
  if (!set) return;
  for (const cb of [...set]) cb();
}

function write(key: string, next: Entry<unknown>): void {
  entries.set(key, next);
  if (entries.size > MAX_ENTRIES) {
    for (const k of entries.keys()) {
      if (entries.size <= MAX_ENTRIES) break;
      if (k !== key && !subs.get(k)?.size) entries.delete(k);
    }
  }
  notify(key);
}

/** Clave interna: `scope|nombre|deps`. El nombre es el namespace que escribe quien llama. */
export function keyFor(name: string, deps: unknown[]): string {
  return `${scope}|${name}|${JSON.stringify(deps)}`;
}

export function getEntry<T>(key: string): Entry<T> {
  return (entries.get(key) as Entry<T> | undefined) ?? (EMPTY as Entry<T>);
}

export function subscribe(key: string, cb: () => void): () => void {
  let set = subs.get(key);
  if (!set) subs.set(key, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size) return;
    subs.delete(key);
    // Sin suscriptores y privada: no la va a reusar nadie, así que se libera ya.
    if (key.includes(`|${PRIVATE}`)) {
      entries.delete(key);
      inflight.delete(key);
    }
  };
}

/** ¿Los datos de esta entrada son lo bastante recientes para servirlos sin ir a la red? */
export function isFresh(e: Entry<unknown>, ttl: number): boolean {
  return e.at > 0 && Date.now() - e.at < ttl;
}

/**
 * Lanza (o reusa) la petición de una clave. Dos componentes con la misma clave comparten una sola
 * petición; `force` ignora la que esté en vuelo (lo usa `reload()`).
 */
export function fetchEntry<T>(key: string, fn: () => Promise<T>, force = false): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running && !force) return running;

  const gen = generation;
  write(key, { ...getEntry<T>(key), pending: true } as Entry<unknown>);

  const p: Promise<T> = fn().then(
    (data) => {
      // Cambió la cuenta mientras viajaba: se tira el dato (invariante 3).
      if (gen === generation) write(key, { data, error: null, at: Date.now(), pending: false });
      return data;
    },
    (err: unknown) => {
      if (gen === generation) {
        const prev = getEntry<T>(key);
        // Se CONSERVAN los datos viejos junto al error: las páginas ya pintan el ErrorCard encima,
        // así que degradan a "datos de hace un rato + aviso" en vez de a pantalla vacía.
        write(key, { ...prev, error: String((err as Error)?.message ?? err), pending: false });
      }
      throw err;
    },
  );
  const tracked = p.finally(() => {
    if (inflight.get(key) === tracked) inflight.delete(key);
  }) as Promise<T>;
  inflight.set(key, tracked);
  return tracked;
}

/**
 * Marca stale por clave o por PREFIJO, para usar tras una mutación: `invalidate('/projects')` pega
 * en `/projects` y en `/projects/detail`. Lo que tiene componentes montados revalida en silencio;
 * lo que no, se borra.
 */
export function invalidate(prefix: string): void {
  const full = `${scope}|${prefix}`;
  for (const key of [...entries.keys()]) {
    if (!key.startsWith(full)) continue;
    if (subs.get(key)?.size) write(key, { ...getEntry(key), at: 0 });
    else entries.delete(key);
  }
}

/**
 * Como `invalidate`, pero SIN arrastrar las rutas hijas: `/skills` no toca `/skills/matrix`.
 * (La clave interna es `scope|nombre|deps`, así que el `|` corta el nombre exacto.)
 */
export const invalidateOnly = (name: string): void => invalidate(`${name}|`);

/** Cuántas entradas cachea ahora mismo (para depurar). */
export const cacheSize = (): number => entries.size;

/**
 * Fija el usuario dueño de la caché. Si cambió, TIRA todo y sube la generación.
 * Se llama desde el cuerpo de render de `AuthProvider` (no desde un efecto: un efecto corre después
 * de que los hijos pintaron, y quedaría un frame con datos del usuario anterior en pantalla).
 * Idempotente, así que el doble render de StrictMode no molesta.
 */
export function resetScope(userId: string | null): void {
  const next = userId ?? '';
  if (next === scope) return;
  scope = next;
  generation++;
  entries.clear();
  inflight.clear();
  // Fuera del render: notificar en pleno render de otro componente provocaría el clásico
  // "Cannot update a component while rendering a different component".
  const keys = [...subs.keys()];
  queueMicrotask(() => keys.forEach(notify));
}

export const currentScope = (): string => scope;
