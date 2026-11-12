// Qué evento (si alguno) hay entre el sondeo anterior y el nuevo. Puro, sin base ni red.
//
// Tres eventos distintos, de mayor a menor gravedad:
//   - 'down'          el SERVICIO dejó de atender (caído o pausado).
//   - 'deploy_failed' un intento de deploy falló pero producción sigue arriba con el anterior.
//   - 'up'            el servicio volvió a atender.
import type { DeployRef, FailureInfo } from './types.js';

export type TransitionKind = 'down' | 'up' | 'deploy_failed';

export interface SnapshotState {
  status: string;
  details: Record<string, unknown> | null;
}

const DOWN_STATES = new Set(['down', 'paused']);

export function lastDeployOf(details: Record<string, unknown> | null | undefined): DeployRef | null {
  const d = details?.lastDeploy as DeployRef | null | undefined;
  return d && typeof d === 'object' ? d : null;
}
export function servingOf(details: Record<string, unknown> | null | undefined): DeployRef | null {
  const d = details?.serving as DeployRef | null | undefined;
  return d && typeof d === 'object' ? d : null;
}
export function failureOf(details: Record<string, unknown> | null | undefined): FailureInfo | null {
  const f = details?.failure as FailureInfo | null | undefined;
  return f && typeof f === 'object' ? f : null;
}

/** ¿El snapshot ya se guardó con el modelo que separa servicio y deploy? */
function hasDeployModel(details: Record<string, unknown> | null | undefined): boolean {
  return !!details && 'lastDeploy' in details;
}

/**
 * `prev` = último estado REAL guardado (sin 'unknown'); null = primer sondeo del servicio, que
 * nunca avisa. `provider` solo importa para no avisar de recuperaciones falsas al estrenar el
 * modelo (ver abajo).
 */
export function detectTransition(prev: SnapshotState | null, now: SnapshotState, provider: string): TransitionKind | null {
  if (!prev) return null;
  const wasDown = DOWN_STATES.has(prev.status);
  const isDown = DOWN_STATES.has(now.status);

  if (isDown && !wasDown) return 'down';

  if (now.status === 'healthy' && wasDown) {
    // Antes un build fallido se guardaba como 'down'. El primer sondeo con el modelo nuevo lo ve
    // 'healthy' sin que nada se haya recuperado: no es noticia.
    if (prev.status === 'down' && provider !== 'supabase' && !hasDeployModel(prev.details)) return null;
    return 'up';
  }

  // Deploy fallido con producción arriba: avisa una vez por intento (por id; sin id, por cambio de
  // estado). Requiere que el sondeo anterior ya traiga el modelo, para no avisar de fallos viejos.
  const last = lastDeployOf(now.details);
  if (!isDown && last?.state === 'failed' && hasDeployModel(prev.details)) {
    const before = lastDeployOf(prev.details);
    const sameAttempt = before?.state === 'failed' && (last.id ? before.id === last.id : before.sha === last.sha);
    if (!sameAttempt) return 'deploy_failed';
  }
  return null;
}
