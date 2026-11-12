// Token del runner: `rozr_` + 32 bytes base64url. Se muestra UNA vez (al crearlo en Configuración) y
// en la base solo queda su sha256 (para autenticar) y su prefijo (para reconocerlo en la lista).
import { createHash, randomBytes } from 'node:crypto';

export const RUNNER_TOKEN_PREFIX = 'rozr_';

export function generateRunnerToken(): string {
  return RUNNER_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function hashRunnerToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function runnerTokenPrefix(token: string): string {
  return token.slice(0, 12);
}

/** Forma válida antes de ir a la base (descarta basura sin consultar). */
export function looksLikeRunnerToken(token: string): boolean {
  return /^rozr_[A-Za-z0-9_-]{43}$/.test(token);
}
