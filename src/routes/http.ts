// Respuestas de error compartidas por las rutas del dashboard (y del chat, montado dentro de él).
import { AppError } from '../utils/errors.js';

// Mensaje legible de cualquier error. Los errores de Supabase (PostgrestError) son objetos planos
// (sin toString útil) → String(err) daría "[object Object]"; extraemos message/details/hint.
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as { message?: string; details?: string; hint?: string; code?: string };
    const parts = [e.message, e.details, e.hint].filter(Boolean);
    if (parts.length) return e.code ? `${parts.join(' — ')} (${e.code})` : parts.join(' — ');
    try {
      return JSON.stringify(err);
    } catch {
      return 'error desconocido';
    }
  }
  return String(err);
}

export function fail(c: any, err: unknown) {
  // Un AppError es una decisión deliberada del dominio (403 de una idea ajena, 404 de algo que no
  // existe), no una falla: devolverlo como 500 haría que el front lo tratara como "se cayó roz".
  if (err instanceof AppError) {
    c.get('logger')?.warn({ code: err.code, err: err.message }, 'dashboard app error');
    return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
  }
  c.get('logger')?.error({ err }, 'dashboard error');
  return c.json({ error: { code: 'INTERNAL', message: errMessage(err) } }, 500);
}
