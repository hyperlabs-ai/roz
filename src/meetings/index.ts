// Juntas (roz v2): de una junta (texto pegado, archivo o Granola) a candidatas verificadas en la
// bandeja. Punto de entrada para el outbox, el cron y las rutas; los detalles viven en:
//   transcript.ts  texto → texto normalizado (vtt/srt con hablantes)
//   quotes.ts      verificación literal de citas
//   domains.ts     proyecto por dominio del correo de los asistentes
//   extract.ts     Claude → JSON validado (1 reintento)
//   rules.ts       duplicados, prioridad, rastros
//   pipeline.ts    el evento meeting.extract completo
//   service.ts     lo que llaman las rutas (crear, listar, aceptar, descartar)
//   granola.ts     sondeo + importación de Granola
import type { GranolaImportPayload, MeetingExtractPayload } from '../types/roz-v2.js';
import { importGranolaNote } from './granola.js';
import { processMeetingExtract, type ExtractResult } from './pipeline.js';

export { pollGranola, importGranolaNote } from './granola.js';
export { processMeetingExtract } from './pipeline.js';
export * from './service.js';

/** Handler del outbox para `meeting.extract`. */
export async function handleMeetingExtract(
  payload: Record<string, unknown>,
  ctx: { attempt: number; maxAttempts: number; log?: (msg: string, data: Record<string, unknown>) => void },
): Promise<ExtractResult> {
  return processMeetingExtract({ meetingId: String(payload.meetingId ?? '') } as MeetingExtractPayload, ctx);
}

/** Handler del outbox para `granola.import`. */
export async function handleGranolaImport(payload: Record<string, unknown>): Promise<void> {
  await importGranolaNote({ noteId: String(payload.noteId ?? '') } as GranolaImportPayload);
}
