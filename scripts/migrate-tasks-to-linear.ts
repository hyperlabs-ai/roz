/**
 * roz v2: pasa las tareas NATIVAS abiertas a Linear (fuente de verdad con ROZ_LINEAR_SOT=true).
 *
 *   npx tsx scripts/migrate-tasks-to-linear.ts                    # dry-run: imprime el plan, no escribe nada
 *   npx tsx scripts/migrate-tasks-to-linear.ts --sync-links       # dry-run, refrescando antes linear_link (lee Linear)
 *   npx tsx scripts/migrate-tasks-to-linear.ts --apply            # crea los issues y convierte cada fila en su espejo
 *   opciones: --project=KEY (solo un proyecto) · --limit=N · --encolar-planes (con --apply: encola el plan
 *             del agente y manda el aviso de asignación de cada issue; por defecto NO, para no inundar)
 *
 * Qué hace con --apply, por tarea (source='native', sin linear_id, status abierto):
 *   1. Crea el issue en el equipo de Linear del proyecto: título, descripción (+ "Migrada desde roz:
 *      ROZ-123"), proyecto, etiqueta del tipo de solución, estimación, prioridad 1-4, asignado por
 *      correo y el estado equivalente a su status.
 *   2. Convierte la MISMA fila de work_item en el espejo del issue: guarda el identificador viejo en
 *      `legacy_identifier` (migración 0037) para que ramas/commits/PRs con "ROZ-123" sigan resolviendo, y
 *      pone `linear_id`. Así comentarios, adjuntos, decisiones de asignación y actores se conservan.
 *   3. upsertMirrorFromLinear escribe el resto (identifier nuevo, estado, asignado…).
 *
 * Lo que NO migra: comentarios y adjuntos (se quedan en roz, ligados a la misma fila) y la jerarquía de
 * subtareas (cada subtarea abierta entra como issue suelto). Una tarea cerrada nunca se migra.
 *
 * Si el paso 2 fallara después de crear el issue, el script se detiene y dice cuál: correrlo de nuevo
 * crearía un duplicado de ESA tarea en Linear (las demás están protegidas porque ya tienen linear_id).
 *
 * Usa SUPABASE_* y LINEAR_API_KEY de .env (o LINEAR_TEAM_ID para proyectos sin equipo propio).
 */
import 'dotenv/config';
import { db } from '../src/db/supabase.js';
import { config } from '../src/config.js';
import { createIssue } from '../src/adapters/linear.js';
import { issueDescription } from '../src/linear/issues.js';
import { labelForSolutionType, linearUserForDev, stateForStatus, syncLinearLinks, teamForProject } from '../src/linear/links.js';
import { upsertMirrorFromLinear } from '../src/linear/mirror.js';
import { OPEN_STATES, type TaskState } from '../src/tasks/states.js';
import { ROZ_PRIORITY_TO_LINEAR, type RozPriority } from '../src/types/roz-v2.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const syncLinks = args.includes('--sync-links');
const enqueuePlans = args.includes('--encolar-planes');
const projectKey = args.find((a) => a.startsWith('--project='))?.split('=')[1] ?? null;
const limitArg = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
const limit = limitArg ? Math.max(1, Number(limitArg)) : 1000;

interface NativeTask {
  id: string;
  identifier: string;
  name: string;
  description: string | null;
  status: TaskState;
  priority: string | null;
  estimate: number | null;
  due_date: string | null;
  solution_type_id: string | null;
  assignee_dev_id: string | null;
  project_id: string | null;
  parent_id: string | null;
}

interface Planned {
  task: NativeTask;
  teamId: string | null;
  teamKey: string | null;
  stateId: string | null;
  assigneeId: string | null;
  labelId: string | null;
  linearProjectId: string | null;
  problems: string[];
}

async function loadTasks(): Promise<NativeTask[]> {
  let projectId: string | null = null;
  if (projectKey) {
    const { data } = await db().from('project').select('id').eq('key', projectKey).maybeSingle();
    projectId = (data as { id: string } | null)?.id ?? null;
    if (!projectId) throw new Error(`Proyecto desconocido: ${projectKey}`);
  }
  let q = db()
    .from('work_item')
    .select('id, identifier, name, description, status, priority, estimate, due_date, solution_type_id, assignee_dev_id, project_id, parent_id')
    .eq('source', 'native')
    .is('linear_id', null)
    .in('status', OPEN_STATES)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (projectId) q = q.eq('project_id', projectId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as NativeTask[];
}

async function planTask(task: NativeTask): Promise<Planned> {
  const problems: string[] = [];
  const out: Planned = { task, teamId: null, teamKey: null, stateId: null, assigneeId: null, labelId: null, linearProjectId: null, problems };
  if (!task.project_id) {
    problems.push('sin proyecto (no se puede elegir equipo de Linear)');
    return out;
  }
  const team = await teamForProject(task.project_id);
  if (!team) {
    problems.push('el proyecto no tiene equipo de Linear y no hay LINEAR_TEAM_ID');
    return out;
  }
  out.teamId = team.teamId;
  out.teamKey = team.teamKey;
  const { data: p } = await db().from('project').select('linear_project_id').eq('id', task.project_id).maybeSingle();
  out.linearProjectId = (p as { linear_project_id: string | null } | null)?.linear_project_id ?? null;
  out.stateId = await stateForStatus(team.teamId, task.status);
  if (!out.stateId) problems.push(`sin estado de Linear para "${task.status}" (se usará el default del equipo)`);
  if (task.assignee_dev_id) {
    out.assigneeId = await linearUserForDev(task.assignee_dev_id);
    if (!out.assigneeId) problems.push('el responsable no tiene usuario en Linear (queda sin asignado)');
  }
  if (task.solution_type_id) {
    out.labelId = await labelForSolutionType(task.solution_type_id, team.teamId);
    if (!out.labelId) problems.push('el tipo de solución no tiene etiqueta en Linear (queda sin etiqueta)');
  }
  return out;
}

function describe(p: Planned): string {
  const t = p.task;
  const parts = [
    `equipo ${p.teamKey ?? p.teamId ?? '—'}`,
    `estado ${t.status}${p.stateId ? '' : ' (default)'}`,
    `prioridad ${t.priority ?? '—'}`,
    `puntos ${t.estimate ?? '—'}`,
    `asignado ${p.assigneeId ? 'sí' : t.assignee_dev_id ? 'NO (sin usuario)' : '—'}`,
    `etiqueta ${p.labelId ? 'sí' : t.solution_type_id ? 'NO' : '—'}`,
  ];
  return `${t.identifier.padEnd(10)} ${t.name.slice(0, 60)}\n             ${parts.join(' · ')}${t.parent_id ? ' · (subtarea: entra suelta)' : ''}`;
}

async function migrate(p: Planned): Promise<string> {
  const t = p.task;
  const issue = await createIssue({
    teamId: p.teamId!,
    title: t.name,
    description: issueDescription({ description: t.description, origin: 'ticket', source: { requester: null } }) + `\n\nMigrada desde roz: ${t.identifier}`,
    projectId: p.linearProjectId,
    labelIds: p.labelId ? [p.labelId] : [],
    estimate: t.estimate,
    priority: t.priority ? ROZ_PRIORITY_TO_LINEAR[t.priority as RozPriority] ?? 0 : 0,
    assigneeId: p.assigneeId,
    stateId: p.stateId,
    dueDate: t.due_date,
  });
  // La MISMA fila pasa a ser el espejo. Condicional: si otra corrida ya la migró, no se pisa.
  const { data, error } = await db()
    .from('work_item')
    .update({ linear_id: issue.id, legacy_identifier: t.identifier, updated_at: new Date().toISOString() })
    .eq('id', t.id)
    .is('linear_id', null)
    .select('id');
  if (error || !data || data.length === 0) {
    throw new Error(
      `se creó ${issue.identifier} (${issue.url}) pero no se pudo ligar a ${t.identifier}: ${error?.message ?? 'la fila ya tenía linear_id'}. ` +
        'Lígalo a mano (linear_id + legacy_identifier) o archiva el issue antes de reintentar.',
    );
  }
  await upsertMirrorFromLinear(issue, { source: 'create', effects: enqueuePlans });
  return `${issue.identifier} ${issue.url}`;
}

async function main() {
  if (apply && !config.linear.apiKey) throw new Error('Falta LINEAR_API_KEY');
  console.log(apply ? 'Migrando tareas nativas abiertas a Linear…' : 'DRY-RUN: no se escribe nada (usa --apply para migrar).');

  if (syncLinks || apply) {
    const s = await syncLinearLinks();
    console.log(`linear_link: ${s.teams} equipos · ${s.users} usuarios · ${s.labels} etiquetas · ${s.states} estados · ${s.projects} proyectos`);
  } else {
    console.log('(linear_link sin refrescar: usa --sync-links para leer Linear antes)');
  }

  const tasks = await loadTasks();
  console.log(`\n${tasks.length} tareas nativas abiertas${projectKey ? ` en ${projectKey}` : ''}.\n`);

  const planned: Planned[] = [];
  for (const t of tasks) planned.push(await planTask(t));

  let ok = 0;
  let skipped = 0;
  for (const p of planned) {
    console.log(describe(p));
    for (const prob of p.problems) console.log(`             ! ${prob}`);
    if (!p.teamId) {
      console.log('             ✗ se omite');
      skipped++;
      continue;
    }
    if (!apply) continue;
    const res = await migrate(p);
    console.log(`             ✓ ${res}`);
    ok++;
  }

  const blocked = planned.filter((p) => !p.teamId).length;
  console.log(
    apply
      ? `\n${ok} migradas, ${skipped} omitidas.`
      : `\n${planned.length - blocked} se migrarían, ${blocked} se omitirían. DRY-RUN: nada escrito.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
