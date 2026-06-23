// Comparación de credenciales en tiempo constante (evita timing side-channels al comparar
// tokens/secretos). Centralizado para que webhooks, MCP, intake y crons usen el mismo helper.
import { timingSafeEqual } from 'node:crypto';

/** Compara dos strings en tiempo constante. Devuelve false si difieren en longitud o contenido. */
export function secureEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Extrae el token de un header `Authorization: Bearer <token>` (string vacío si no aplica). */
export function bearerToken(header: string | null | undefined): string {
  const h = header ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
