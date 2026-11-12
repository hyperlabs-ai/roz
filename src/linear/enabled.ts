// ¿Linear es la fuente de verdad de las tareas? (roz v2). Depende SOLO de configuración
// (ROZ_LINEAR_SOT), nunca de fallos en caliente: si Linear no responde, crear un issue falla visible
// — no cae en silencio a una tarea nativa que después nadie reconcilia. Va en su propio módulo para
// que rutas, MCP y dashboard lo consulten sin importar el cliente de Linear.
import { config } from '../config.js';
import { AppError } from '../utils/errors.js';

export function linearSourceOfTruth(): boolean {
  return config.linear.sourceOfTruth;
}

/** Código del error que devuelve cualquier escritura de tareas con el flag encendido. */
export const TASKS_READ_ONLY_CODE = 'TASKS_READ_ONLY';

/**
 * Guardia de toda escritura de tareas nativas (crear, editar, mover, asignar, borrar, comentar). Con
 * Linear como fuente de verdad, `work_item` es un espejo: escribirlo aquí se perdería con el
 * siguiente webhook. Lanza 409 con un mensaje que dice a dónde ir.
 */
export function assertTasksWritable(): void {
  if (!linearSourceOfTruth()) return;
  throw new AppError(
    TASKS_READ_ONLY_CODE,
    'Las tareas viven en Linear: créalas o edítalas allá (o con /ticket). roz solo refleja lo que hay en Linear.',
    409,
  );
}
