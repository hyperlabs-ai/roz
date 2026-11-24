// Caché en memoria de lo que zeus le pide a Linear (tickets de cada persona, equipos, estados,
// usuarios…). Aparte de src/zeus/linear.ts para que el webhook la invalide sin cargar todo zeus.
//
// zeus corre en UNA réplica (ver ARCHITECTURE), así que una caché en proceso basta: el webhook de
// Linear la limpia en el mismo proceso que la sirve.
import { config } from '../config.js';

const cache = new Map<string, { at: number; value: unknown }>();

export const CATALOG_TTL_MS = 10 * 60_000;

/**
 * Cuánto se guardan los tickets de una persona. Con el webhook configurado, Linear avisa de cada
 * cambio y la copia se borra al instante: puede durar más (y ahorrar llamadas). Sin webhook, un
 * minuto: es lo más que un cambio hecho en Linear tarda en verse.
 */
export function boardTtlMs(): number {
  return config.linear.webhookSecret ? 5 * 60_000 : 60_000;
}

export async function cached<T>(key: string, load: () => Promise<T>, ttl = CATALOG_TTL_MS): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function forget(key: string): void {
  cache.delete(key);
}

/** Todo fuera (pruebas, o un cambio de equipos/estados/usuarios en Linear). */
export function clearLinearCache(): void {
  cache.clear();
}

/** Entidades de Linear cuyo cambio vuelve viejo el catálogo (equipos, estados, etiquetas, usuarios…). */
const CATALOG_ENTITIES = new Set(['Team', 'WorkflowState', 'IssueLabel', 'User', 'Project']);

/**
 * Lo que hace un aviso del webhook: un cambio de issue (o de un comentario/adjunto suyo) borra las
 * copias de tickets de TODAS las personas (puede haber cambiado de asignado: le afecta a dos), y un
 * cambio de catálogo borra todo. Devuelve cuántas entradas se fueron.
 */
export function invalidateFromWebhook(type: string): number {
  let n = 0;
  if (CATALOG_ENTITIES.has(type)) {
    n = cache.size;
    cache.clear();
    return n;
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith('board:')) {
      cache.delete(key);
      n++;
    }
  }
  return n;
}
