// Emisión de los eventos de outbox de roz v2 (linear.*, plan.*). Va aparte porque `emit` todavía
// tipa solo los eventos viejos (OutboxEventType): hasta que src/events/outbox.ts sume
// RozV2OutboxEventType a su unión, el cast vive en UN lugar y no regado por el módulo.
import { emit, type EmitOptions, type OutboxEventType } from '../events/outbox.js';
import type { RozV2OutboxEventType } from '../types/roz-v2.js';

export function emitV2(type: RozV2OutboxEventType, payload: object, opts: EmitOptions = {}): Promise<string | null> {
  return emit(type as unknown as OutboxEventType, payload as Record<string, unknown>, opts);
}
