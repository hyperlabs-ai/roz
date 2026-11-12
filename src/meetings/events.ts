// Emisión de los eventos de outbox de juntas (`meeting.extract`, `granola.import`). Los tipos de roz
// v2 se suman a OutboxEventType en src/events/outbox.ts al integrar; mientras tanto (y para no
// depender del orden de integración) el cast vive solo aquí.
import { emit } from '../events/outbox.js';
import type { GranolaImportPayload, MeetingExtractPayload } from '../types/roz-v2.js';

type OutboxType = Parameters<typeof emit>[0];

export function emitMeetingExtract(p: MeetingExtractPayload, idempotencyKey: string): Promise<string | null> {
  return emit('meeting.extract' as OutboxType, { ...p }, { idempotencyKey });
}

export function emitGranolaImport(p: GranolaImportPayload): Promise<string | null> {
  return emit('granola.import' as OutboxType, { ...p }, { idempotencyKey: `granola:${p.noteId}` });
}
