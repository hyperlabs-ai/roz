// Puente Ops ⇄ roz. Las dos apps son independientes y siguen siéndolo: Ops no conoce a roz. Es roz
// quien JALA de public.tasks (schema de HyperOps) con el cliente de solo lectura dbPublic(), igual
// que ya hace con github_repositories en projects/resolve.ts.
//
// Criterio de bajada: una tarea de Ops cruza a roz cuando está ASIGNADA A UN DEV ACTIVO y sigue
// abierta. La asignación real vive en public.task_assignees (tabla puente, N asignados), no en
// tasks.assignee_id — ese campo casi no se usa en Ops.
//
// Gracias a la migración 0020 los dos modelos comparten nombres y vocabulario (name, description,
// status, priority, due_date), así que el mapeo es copia directa: no hay capa de traducción que se
// desincronice. Lo único que se traduce es la identidad —public.user_profiles ↔ roz.dev— vía
// dev.ops_user_id, que es un join, no una forma distinta.
//
// De vuelta (pushStatusToOps) roz escribe SOLO status y completed_at. El título, las fechas y la
// prioridad son de Ops: pisarlos desde aquí sería pérdida de datos silenciosa.
import { db, dbPublic } from '../db/supabase.js';
import { isClosedState, transitionTimestamps } from '../tasks/states.js';

/** Estados de Ops que consideramos trabajo vivo (mismo vocabulario a ambos lados). */
const OPEN = ['planificada', 'pendiente', 'en_progreso', 'revision'];

type OpsTask = {
  id: string;
  task_number: number | null;
  name: string;
  description: string | null;
  status: string | null;
  priority: string | null;
  due_date: string | null;
  project_id: string | null;
  created_at: string | null;
};

export type SyncResult = {
  scanned: number;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
};

/**
 * Trae de Ops las tareas abiertas asignadas a devs activos, junto al dev al que corresponden.
 * Devuelve una fila por (tarea, dev): una tarea con dos devs baja una vez, con el primero como
 * responsable primario (roz ya modela múltiples en work_item_assignee).
 */
async function fetchAssignedOpsTasks(): Promise<Map<string, { task: OpsTask; devIds: string[] }>> {
  const roz = db();
  const ops = dbPublic();

  // 1. Devs activos con su usuario de Ops (ops_user_id lo materializó la migración 0020).
  const { data: devs, error: devErr } = await roz
    .from('dev')
    .select('id, ops_user_id')
    .eq('active', true)
    .not('ops_user_id', 'is', null);
  if (devErr) throw devErr;

  const devByOpsUser = new Map<string, string>();
  for (const d of (devs ?? []) as { id: string; ops_user_id: string }[]) {
    devByOpsUser.set(d.ops_user_id, d.id);
  }
  if (devByOpsUser.size === 0) return new Map();

  // 2. Asignaciones de Ops que apuntan a esos usuarios.
  const { data: assignments, error: asgErr } = await ops
    .from('task_assignees')
    .select('task_id, user_id')
    .in('user_id', [...devByOpsUser.keys()]);
  if (asgErr) throw asgErr;

  const devsByTask = new Map<string, string[]>();
  for (const a of (assignments ?? []) as { task_id: string; user_id: string }[]) {
    const devId = devByOpsUser.get(a.user_id);
    if (!devId) continue;
    const list = devsByTask.get(a.task_id) ?? [];
    if (!list.includes(devId)) list.push(devId);
    devsByTask.set(a.task_id, list);
  }
  if (devsByTask.size === 0) return new Map();

  // 3. Las tareas en sí, solo las abiertas.
  const { data: tasks, error: taskErr } = await ops
    .from('tasks')
    .select('id, task_number, name, description, status, priority, due_date, project_id, created_at')
    .in('id', [...devsByTask.keys()])
    .in('status', OPEN);
  if (taskErr) throw taskErr;

  const out = new Map<string, { task: OpsTask; devIds: string[] }>();
  for (const t of (tasks ?? []) as OpsTask[]) {
    out.set(t.id, { task: t, devIds: devsByTask.get(t.id) ?? [] });
  }
  return out;
}

/** Proyecto de roz vinculado al proyecto de Ops, si lo hay. */
async function resolveProject(opsProjectId: string | null): Promise<{ id: string; key: string } | null> {
  if (!opsProjectId) return null;
  const { data } = await db()
    .from('project')
    .select('id, key')
    .eq('hyperops_project_id', opsProjectId)
    .maybeSingle();
  return (data as { id: string; key: string } | null) ?? null;
}

/**
 * Ops → roz. Idempotente: reprocesar no duplica (upsert por ops_task_id) y solo escribe cuando
 * algo cambió de verdad.
 */
export async function syncOpsTasks(): Promise<SyncResult> {
  const supabase = db();
  const result: SyncResult = { scanned: 0, created: 0, updated: 0, skipped: 0, errors: [] };

  const wanted = await fetchAssignedOpsTasks();
  result.scanned = wanted.size;
  if (wanted.size === 0) return result;

  // Lo que ya bajó antes.
  const { data: existingRows, error: exErr } = await supabase
    .from('work_item')
    .select('id, ops_task_id, name, description, status, priority, due_date, project_id')
    .in('ops_task_id', [...wanted.keys()]);
  if (exErr) throw exErr;

  const existing = new Map<string, any>();
  for (const w of (existingRows ?? []) as any[]) existing.set(w.ops_task_id, w);

  for (const [opsTaskId, { task, devIds }] of wanted) {
    try {
      const project = await resolveProject(task.project_id);
      const primaryDev = devIds[0] ?? null;

      // Mismo vocabulario a ambos lados: copia directa.
      const shared = {
        name: task.name,
        description: task.description,
        status: task.status ?? 'pendiente',
        priority: task.priority,
        due_date: task.due_date,
        // Si el proyecto de Ops no está vinculado en roz, el work item entra sin proyecto en lugar
        // de descartarse: mejor visible sin clasificar que invisible.
        project_id: project?.id ?? null,
      };

      const prev = existing.get(opsTaskId);

      if (!prev) {
        // Identificador local KEY-N. Sin proyecto no hay contador: cae a OPS-<task_number>.
        let identifier: string;
        let number: number | null = null;
        if (project) {
          const { data: num, error: nerr } = await supabase.rpc('next_work_item_number', {
            p_project_id: project.id,
          });
          if (nerr) throw nerr;
          number = Number(num);
          identifier = `${project.key}-${number}`;
        } else {
          identifier = `OPS-${task.task_number ?? Date.now()}`;
        }

        const { data: inserted, error: insErr } = await supabase
          .from('work_item')
          .insert({
            ...shared,
            linear_id: null,
            identifier,
            number,
            source: 'ops',
            ops_task_id: opsTaskId,
            assignee_dev_id: primaryDev,
            documented: true,
            created_at: task.created_at ?? new Date().toISOString(),
            ...transitionTimestamps(shared.status),
          })
          .select('id')
          .single();
        if (insErr) throw insErr;

        if (devIds.length && inserted) {
          await supabase
            .from('work_item_assignee')
            .upsert(
              devIds.map((devId) => ({ work_item_id: (inserted as { id: string }).id, dev_id: devId })),
              { onConflict: 'work_item_id,dev_id', ignoreDuplicates: true },
            );
        }
        result.created++;
        continue;
      }

      // Solo escribir si cambió algo (evita updated_at ruidoso en cada corrida).
      const changed = (Object.keys(shared) as (keyof typeof shared)[]).some(
        (k) => (prev[k] ?? null) !== (shared[k] ?? null),
      );
      if (!changed) {
        result.skipped++;
        continue;
      }

      const { error: updErr } = await supabase
        .from('work_item')
        .update({
          ...shared,
          assignee_dev_id: primaryDev ?? prev.assignee_dev_id,
          updated_at: new Date().toISOString(),
          ...transitionTimestamps(shared.status),
        })
        .eq('id', prev.id);
      if (updErr) throw updErr;
      result.updated++;
    } catch (e) {
      result.errors.push(`${opsTaskId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

/**
 * roz → Ops. Se llama cuando un work item con ops_task_id cambia de estado (por PR, rama o cambio
 * manual en el dashboard). Escribe SOLO status y completed_at: el resto de la tarea es de Ops.
 */
export async function pushStatusToOps(workItemId: string): Promise<{ pushed: boolean; opsTaskId?: string }> {
  const { data: wi, error } = await db()
    .from('work_item')
    .select('id, ops_task_id, status, completed_at')
    .eq('id', workItemId)
    .maybeSingle();
  if (error) throw error;

  const item = wi as { ops_task_id: string | null; status: string; completed_at: string | null } | null;
  if (!item?.ops_task_id) return { pushed: false };

  const patch: Record<string, unknown> = { status: item.status };
  if (isClosedState(item.status)) {
    patch.completed_at = item.completed_at ?? new Date().toISOString();
  } else {
    patch.completed_at = null;
  }

  const { error: opsErr } = await dbPublic().from('tasks').update(patch).eq('id', item.ops_task_id);
  if (opsErr) throw opsErr;

  return { pushed: true, opsTaskId: item.ops_task_id };
}
