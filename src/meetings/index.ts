// Juntas (roz v2): REGISTRO de juntas (texto pegado, archivo o Granola) que se consulta desde roz y
// desde Claude por el MCP de zeus. Punto de entrada para el outbox, el cron y las rutas:
//   paste.ts       autollenado del texto pegado (título, fecha, asistentes)
//   transcript.ts  texto → texto normalizado (vtt/srt con hablantes)
//   domains.ts     proyecto por dominio del correo de los asistentes
//   store.ts       filas → HTTP/MCP, búsqueda por texto
//   service.ts     lo que llaman las rutas, Discord y el MCP (crear, buscar, editar, borrar)
//   granola.ts     sondeo + importación de Granola
//
// El extractor de tareas con IA (extract.ts, quotes.ts, rules.ts, pipeline.ts) ya NO corre: las
// juntas no proponen tareas. Sus archivos quedan solo porque juntas viejas tienen candidatas y
// decisiones en el brain (relinkMeetingAtoms) y /roz decisión reusa el formato de rules.ts.
import type { GranolaImportPayload } from '../types/roz-v2.js';
import { importGranolaNote } from './granola.js';

export { pollGranola, importGranolaNote } from './granola.js';
export * from './service.js';

/**
 * Handler del outbox para `meeting.extract`: no-op. Los eventos que quedaron encolados de antes se
 * cierran sin llamar a Claude.
 */
export async function handleMeetingExtract(
  payload: Record<string, unknown>,
  ctx: { attempt: number; maxAttempts: number; log?: (msg: string, data: Record<string, unknown>) => void },
): Promise<{ status: 'omitida' }> {
  ctx.log?.('juntas: extracción omitida (las juntas ya no extraen tareas)', { meetingId: String(payload.meetingId ?? '') });
  return { status: 'omitida' };
}

/** Handler del outbox para `granola.import`. */
export async function handleGranolaImport(payload: Record<string, unknown>): Promise<void> {
  await importGranolaNote({ noteId: String(payload.noteId ?? '') } as GranolaImportPayload);
}
