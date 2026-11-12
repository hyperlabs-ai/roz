// Referencias viejas (ROZ-123) después de migrar las tareas nativas a Linear. La fila de work_item
// es la misma, pero su `identifier` ahora es el de Linear (HYP-45) y el viejo quedó en
// `legacy_identifier` (migración 0037). Quien resuelve un identificador escrito en una rama, commit
// o PR debe pasar por aquí para que "feat/ROZ-123" siga llevando a su tarea.
import { db } from '../db/supabase.js';
import { linearSourceOfTruth } from './enabled.js';

/**
 * id del work_item por identificador, actual o viejo. El actual gana: si un HYP-45 nuevo coincide
 * con el legacy de otra fila (no debería: los prefijos son distintos), manda el vigente. TOLERANTE:
 * sin la columna (0037 sin aplicar) cae a buscar solo por `identifier`.
 */
export async function findWorkItemIdByIdentifier(identifier: string): Promise<string | null> {
  const supabase = db();
  const { data: current } = await supabase.from('work_item').select('id').eq('identifier', identifier).maybeSingle();
  if (current) return (current as { id: string }).id;
  const { data: legacy, error } = await supabase.from('work_item').select('id').eq('legacy_identifier', identifier).maybeSingle();
  if (error) return null;
  return (legacy as { id: string } | null)?.id ?? null;
}

/** Identificador VIGENTE de una referencia (vieja o nueva). null = no existe. */
export async function currentIdentifier(identifier: string): Promise<string | null> {
  const id = await findWorkItemIdByIdentifier(identifier);
  if (!id) return null;
  const { data } = await db().from('work_item').select('identifier').eq('id', id).maybeSingle();
  return (data as { identifier: string } | null)?.identifier ?? null;
}

/**
 * Normaliza la referencia que trae una rama, commit o PR antes de buscar su tarea. Con el flag
 * apagado devuelve lo mismo (cero consultas extra: comportamiento de siempre); encendido, traduce un
 * identificador viejo (ROZ-123) al vigente de Linear y deja igual lo que no reconoce.
 */
export async function resolveReference(identifier: string | null): Promise<string | null> {
  if (!identifier || !linearSourceOfTruth()) return identifier;
  return (await currentIdentifier(identifier)) ?? identifier;
}
