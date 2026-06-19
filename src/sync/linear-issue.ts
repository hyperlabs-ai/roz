// Espejo bidireccional: refleja en roz cualquier issue de Linear, venga del chat (roz lo
// creó) o creado DIRECTO en Linear. Linear es la fuente de verdad del trabajo; roz no
// mantiene estado paralelo, lo refleja. Upsert idempotente por linear_id.
//
// No emite efectos por sí mismo (para no acoplarse al outbox): devuelve qué notificar y el
// dispatch decide. Así, crear un issue en Linear y asignarlo a un dev conocido dispara la
// misma notificación por correo que el flujo del chat — sin doble aviso (idempotencia).
import { db } from '../db/supabase.js';
import { linearToPriority } from '../adapters/linear.js';
import { resolveProjectByLinear } from '../projects/resolve.js';

export interface SyncResult {
  skipped?: boolean;
  workItemId?: string;
  identifier?: string;
  created?: boolean;
  /** Si hay un nuevo asignado mapeable a un dev de roz, a quién notificar. */
  assigneeToNotify?: { workItemId: string; devId: string; identifier: string } | null;
}

/** Extrae el id del assignee del payload de webhook (Linear varía entre versiones). */
function assigneeUserId(data: any): string | null {
  return data?.assignee?.id ?? data?.assigneeId ?? null;
}

/** Upsert del work_item espejo desde el `data` de un webhook Issue (create/update). */
export async function syncIssueFromWebhook(data: any): Promise<SyncResult> {
  const supabase = db();
  const linearId: string | undefined = data?.id;
  if (!linearId || !data?.identifier) return { skipped: true };

  // Mapear al roz.project por Linear Project (un team con varios projects); fallback a team.
  const teamId = data.team?.id ?? data.teamId ?? null;
  const linearProjectId = data.project?.id ?? data.projectId ?? null;
  const proj = await resolveProjectByLinear(linearProjectId, teamId);
  const projectId: string | null = proj?.id ?? null;

  // Mapear assignee de Linear a un dev de roz por linear_user_id.
  const userId = assigneeUserId(data);
  let devId: string | null = null;
  if (userId) {
    const { data: d } = await supabase
      .from('dev')
      .select('id')
      .eq('linear_user_id', userId)
      .maybeSingle();
    devId = d?.id ?? null;
  }

  const stateType: string = data.state?.type ?? 'backlog';
  const priority = linearToPriority(data.priority);
  const description: string | null = data.description ?? null;

  // ¿Ya existe el espejo?
  const { data: existing } = await supabase
    .from('work_item')
    .select('id, assignee_dev_id')
    .eq('linear_id', linearId)
    .maybeSingle();

  const row: Record<string, unknown> = {
    linear_id: linearId,
    identifier: data.identifier,
    project_id: projectId,
    title: data.title ?? '(sin título)',
    state: stateType,
    priority,
    assignee_dev_id: devId,
  };
  if (data.url) row.url = data.url;
  // No pisar la spec rica de roz con una descripción vacía de Linear.
  if (description != null && description.trim() !== '') row.spec = description;

  // Campos de Linear para la sección de Tickets (solo si vienen en el payload, para no
  // sobrescribir con vacíos en updates parciales).
  if (data.number != null) row.number = data.number;
  if (data.state?.name) row.state_name = data.state.name;
  if ('estimate' in data) row.estimate = data.estimate ?? null;
  if ('dueDate' in data) row.due_date = data.dueDate ?? null;
  if (data.creator?.name || data.creator?.displayName) row.creator_name = data.creator.name ?? data.creator.displayName;
  if (data.createdAt) row.linear_created_at = data.createdAt;
  if (data.updatedAt) row.linear_updated_at = data.updatedAt;
  // Labels: el webhook a veces manda nombres en labels.nodes; si no, no tocar (el backfill ya
  // los tiene). Nunca sobrescribir con vacío.
  const labelNames = (data.labels?.nodes ?? []).map((l: any) => l?.name).filter(Boolean);
  if (labelNames.length) row.labels = labelNames;

  // Timestamps de transición (para el dashboard: tickets resueltos por período + cycle time).
  // Linear los incluye en el payload del Issue (null cuando no aplica). Solo se escriben si la
  // clave viene en el payload, para no borrarlos en updates parciales que la omitan.
  if ('startedAt' in data) row.started_at = data.startedAt ?? null;
  if ('completedAt' in data) row.completed_at = data.completedAt ?? null;
  if ('canceledAt' in data) row.canceled_at = data.canceledAt ?? null;

  let workItemId: string;
  let created = false;
  let assigneeChanged = false;

  if (existing) {
    await supabase.from('work_item').update(row).eq('id', existing.id);
    workItemId = existing.id;
    assigneeChanged = !!devId && devId !== existing.assignee_dev_id;
  } else {
    const { data: ins, error } = await supabase
      .from('work_item')
      .insert(row)
      .select('id')
      .single();
    if (error) {
      // Carrera con confirm_proposal (mismo linear_id, unique): reintenta como update.
      if ((error as { code?: string }).code === '23505') {
        const { data: again } = await supabase
          .from('work_item')
          .select('id, assignee_dev_id')
          .eq('linear_id', linearId)
          .single();
        await supabase.from('work_item').update(row).eq('id', again!.id);
        workItemId = again!.id;
        assigneeChanged = !!devId && devId !== again!.assignee_dev_id;
        return notifyResult(workItemId, data.identifier, false, assigneeChanged, devId);
      }
      throw error;
    }
    workItemId = ins.id;
    created = true;
    assigneeChanged = !!devId; // creado con asignado = asignación nueva
  }

  return notifyResult(workItemId, data.identifier, created, assigneeChanged, devId);
}

function notifyResult(
  workItemId: string,
  identifier: string,
  created: boolean,
  assigneeChanged: boolean,
  devId: string | null,
): SyncResult {
  return {
    workItemId,
    identifier,
    created,
    assigneeToNotify: assigneeChanged && devId ? { workItemId, devId, identifier } : null,
  };
}

/** Issue eliminado en Linear: quita el espejo (no es fuente de verdad). */
export async function removeMirror(linearId: string): Promise<void> {
  if (!linearId) return;
  await db().from('work_item').delete().eq('linear_id', linearId);
}
