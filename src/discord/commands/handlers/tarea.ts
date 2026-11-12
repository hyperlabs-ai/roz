// /roz tarea <buscar> [persona] y los componentes de la ficha de tarea (Tomar, Cambiar estado).
// Dueño: agente "trabajo". Contrato: docs/discord-commands-contract.md §5.1.
//
//   · autocomplete: `buscar` → tareas por texto, ID (WAT-44) o persona (searchTasks de
//     src/chat/tasks.ts, filtrado por `persona` si ya está llena); `persona` → devs de roz.
//     value = work_item.id (uuid); name = "WAT-44 · Título — Responsable" (≤ 100).
//   · run: publica la ficha (taskCardMessage de embeds.ts) en el canal. Público.
//   · tarea.tomar: asigna al actor según las reglas de tareas (con ROZ_LINEAR_SOT, en Linear) y
//     actualiza la ficha (update).
//   · tarea.estado: cambia al estado elegido (values[0]) con las reglas de tareas y actualiza la ficha.
//
// También exporta lo que comparten los demás handlers de trabajo (ticket, status, crear tarea,
// citar): cargar fichas por id, el nombre de un choice de tarea y la resolución de lo que escribió la
// persona (uuid, identificador vigente o viejo, o texto).
import { db } from '../../../db/supabase.js';
import { searchTasks, tasksByIds } from '../../../chat/tasks.js';
import type { ChatTaskRef } from '../../../chat/model.js';
import { updateTask } from '../../../dashboard/queries.js';
import { latestDecision } from '../../../assign/decisions.js';
import { isOverride } from '../../../assign/rules.js';
import { updateIssue } from '../../../adapters/linear.js';
import { reassignIssue } from '../../../linear/issues.js';
import { assertTasksWritable, linearSourceOfTruth } from '../../../linear/enabled.js';
import { findWorkItemIdByIdentifier } from '../../../linear/legacy.js';
import { stateForStatus } from '../../../linear/links.js';
import { upsertMirrorFromLinear } from '../../../linear/mirror.js';
import { CLOSED_STATES, STATE_LABEL, STATE_ORDER, type TaskState } from '../../../tasks/states.js';
import { AppError, NotFoundError } from '../../../utils/errors.js';
import { taskCardFromRef, taskCardMessage, type TaskCardInput } from '../embeds.js';
import { NOT_LINKED_CHOICE_VALUE, clip, ephemeral, publicMessage, updateMessage } from '../respond.js';
import type { AutocompleteChoice, CommandActor, HandlerModule } from '../types.js';
import { notice } from '../v2.js';

// ================================================================ piezas compartidas

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Identificador de tarea escrito tal cual (WAT-44, HYP-12, ROZ-123). */
export const TASK_IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** Valor de una opción como texto (los valores de autocompletado llegan como string). */
export function optionText(v: string | number | boolean | undefined): string {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return s === NOT_LINKED_CHOICE_VALUE ? '' : s;
}

export function foldText(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

export interface DevLite {
  id: string;
  name: string;
  githubLogin: string | null;
}

/** Nombre y login de GitHub de esos devs (una consulta). */
export async function loadDevs(ids: string[]): Promise<Map<string, DevLite>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, DevLite>();
  if (!unique.length) return out;
  const { data, error } = await db().from('dev').select('id, name, github_login').in('id', unique);
  if (error) throw error;
  for (const d of (data ?? []) as { id: string; name: string; github_login: string | null }[]) {
    out.set(d.id, { id: d.id, name: d.name, githubLogin: d.github_login ?? null });
  }
  return out;
}

/** URL del issue en Linear de cada tarea espejo (las nativas no tienen). Tolerante: sin columnas → vacío. */
async function linearUrls(taskIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!taskIds.length) return out;
  const { data, error } = await db().from('work_item').select('id, url, linear_id').in('id', taskIds);
  if (error) return out;
  for (const r of (data ?? []) as { id: string; url: string | null; linear_id: string | null }[]) {
    if (r.linear_id && r.url && /^https?:\/\//.test(r.url)) out.set(r.id, r.url);
  }
  return out;
}

/** Tarjetas → fichas (responsable con foto y link a Linear), en el orden de `refs`. */
export async function cardsFromRefs(refs: ChatTaskRef[]): Promise<TaskCardInput[]> {
  if (!refs.length) return [];
  const [devs, urls] = await Promise.all([loadDevs(refs.flatMap((r) => r.assigneeDevIds.slice(0, 1))), linearUrls(refs.map((r) => r.id))]);
  return refs.map((r) => taskCardFromRef(r, devs, urls.get(r.id) ?? null));
}

/** Fichas por id de tarea, en el orden pedido. Las que no existen no vuelven. */
export async function loadTaskCards(ids: string[]): Promise<TaskCardInput[]> {
  const unique = [...new Set(ids.filter(isUuid).map((id) => id.toLowerCase()))];
  if (!unique.length) return [];
  const refs = await tasksByIds(unique);
  const byLower = new Map([...refs.values()].map((r) => [r.id.toLowerCase(), r]));
  return cardsFromRefs(unique.map((id) => byLower.get(id)).filter((r): r is ChatTaskRef => !!r));
}

export async function loadTaskCard(id: string): Promise<TaskCardInput> {
  const [card] = await loadTaskCards([id]);
  if (!card) throw new NotFoundError('esa tarea ya no existe');
  return card;
}

/** "WAT-44 · Título — Responsable" (≤ 100). */
export function taskChoiceName(ref: Pick<ChatTaskRef, 'identifier' | 'name' | 'assigneeDevIds'>, devs: Map<string, DevLite>): string {
  const who = ref.assigneeDevIds[0] ? devs.get(ref.assigneeDevIds[0])?.name ?? null : null;
  const tail = ` — ${who ?? 'Sin responsable'}`;
  const head = `${ref.identifier} · `;
  return `${head}${clip(ref.name, Math.max(10, 100 - head.length - tail.length))}${tail}`.slice(0, 100);
}

/** Choices de tareas (value = id). */
export async function taskChoices(refs: ChatTaskRef[]): Promise<AutocompleteChoice[]> {
  const devs = await loadDevs(refs.flatMap((r) => r.assigneeDevIds.slice(0, 1)));
  return refs.map((r) => ({ name: taskChoiceName(r, devs), value: r.id }));
}

/**
 * Búsqueda de tareas para quien busca, opcionalmente solo las de `personaId`. Con persona, el nombre de
 * esa persona entra en la consulta (searchTasks lo usa para acotar por responsable) y luego se filtra
 * exacto, porque un nombre de pila puede coincidir con más de un dev.
 */
export async function findTasks(actorDevId: string, text: string, personaId: string | null, limit = 25): Promise<ChatTaskRef[]> {
  if (!personaId) return searchTasks(actorDevId, text, limit);
  const persona = (await loadDevs([personaId])).get(personaId);
  if (!persona) return [];
  const refs = await searchTasks(actorDevId, `${persona.name} ${text}`.trim(), 40);
  return refs.filter((r) => r.assigneeDevIds.includes(personaId)).slice(0, limit);
}

/**
 * Lo que escribió la persona → id de tarea: uuid (eligió del autocompletado), identificador vigente o
 * viejo (ROZ-123 tras migrar a Linear), o la primera coincidencia de la búsqueda. null = nada.
 */
export async function resolveTaskId(actorDevId: string, raw: string, personaId: string | null = null): Promise<string | null> {
  const value = raw.trim();
  if (!value) return null;
  if (UUID_RE.test(value)) return value.toLowerCase();
  const bare = value.replace(/^#/, '');
  if (TASK_IDENTIFIER_RE.test(bare)) {
    const id = await findWorkItemIdByIdentifier(bare.toUpperCase());
    if (id) return id;
  }
  const [first] = await findTasks(actorDevId, value, personaId, 1);
  return first?.id ?? null;
}

/** Devs activos cuyo nombre empieza (por palabra) con lo escrito. value = dev.id. */
export async function personaChoices(query: string): Promise<AutocompleteChoice[]> {
  const { data, error } = await db().from('dev').select('id, name, active').order('name');
  if (error) throw error;
  const q = foldText(query.trim());
  return ((data ?? []) as { id: string; name: string; active: boolean | null }[])
    .filter((d) => d.active !== false)
    .filter((d) => !q || foldText(d.name).split(/\s+/).some((p) => p.startsWith(q)) || foldText(d.name).includes(q))
    .slice(0, 25)
    .map((d) => ({ name: d.name, value: d.id }));
}

// ================================================================ acciones de la ficha

function isTaskState(v: string): v is TaskState {
  return (STATE_ORDER as string[]).includes(v);
}

/**
 * "Tomar": el actor queda como responsable principal (los de apoyo se quedan). Con Linear como fuente
 * de verdad, se reasigna el issue allá (el espejo se actualiza en el momento). Quitarle a alguien una
 * tarea que eligió la asignación automática pide un motivo, y ese motivo solo se puede dar en roz.
 */
export async function takeTask(actor: CommandActor, taskId: string): Promise<{ changed: boolean }> {
  const ref = (await tasksByIds([taskId])).get(taskId);
  if (!ref) throw new NotFoundError('esa tarea ya no existe');
  if (CLOSED_STATES.includes(ref.status)) throw new AppError('TASK_CLOSED', `${ref.identifier} ya está ${STATE_LABEL[ref.status as TaskState]?.toLowerCase() ?? 'cerrada'}`, 409);
  const prevPrimary = ref.assigneeDevIds[0] ?? null;
  if (prevPrimary === actor.devId) return { changed: false };

  if (linearSourceOfTruth()) {
    await reassignIssue({ workItemId: taskId, toDevId: actor.devId, reason: 'manual' });
    return { changed: true };
  }

  assertTasksWritable();
  const next = [actor.devId, ...ref.assigneeDevIds.filter((d) => d !== actor.devId && d !== prevPrimary)];
  // Misma regla que el PATCH del dashboard: corregir a la asignación automática exige categoría.
  const latest = await latestDecision(taskId).catch(() => null);
  if (latest && isOverride({ outcome: latest.outcome, chosenDevId: latest.chosen_dev_id, overriddenAt: latest.overridden_at }, prevPrimary, next)) {
    throw new AppError(
      'OVERRIDE_REASON_REQUIRED',
      `roz eligió a otra persona para ${ref.identifier}. Para tomarla, cámbiala desde roz y cuenta por qué (así aprende la asignación).`,
      409,
    );
  }
  await updateTask(taskId, { assigneeDevIds: next });
  return { changed: true };
}

/** "Cambiar estado": mismas reglas que el PATCH del dashboard; con Linear, el estado equivalente allá. */
export async function changeTaskState(taskId: string, state: string): Promise<{ changed: boolean }> {
  if (!isTaskState(state)) throw new AppError('VALIDATION_ERROR', 'ese estado no existe en roz', 400);
  const ref = (await tasksByIds([taskId])).get(taskId);
  if (!ref) throw new NotFoundError('esa tarea ya no existe');
  if (ref.status === state) return { changed: false };

  if (linearSourceOfTruth()) {
    const { data, error } = await db().from('work_item').select('linear_id, linear_team_id').eq('id', taskId).maybeSingle();
    if (error) throw error;
    const w = data as { linear_id: string | null; linear_team_id: string | null } | null;
    if (!w?.linear_id || !w.linear_team_id) {
      throw new AppError('NOT_IN_LINEAR', `${ref.identifier} no está en Linear y las tareas viven allá: no se puede mover desde roz`, 409);
    }
    const stateId = await stateForStatus(w.linear_team_id, state);
    if (!stateId) throw new AppError('LINEAR_STATE_MISSING', `el equipo de Linear de ${ref.identifier} no tiene un estado para "${STATE_LABEL[state]}"`, 422);
    const issue = await updateIssue(w.linear_id, { stateId });
    await upsertMirrorFromLinear(issue, { source: 'create' });
    return { changed: true };
  }

  assertTasksWritable();
  await updateTask(taskId, { status: state });
  return { changed: true };
}

// ================================================================ handlers

export const handlers: HandlerModule = {
  slash: {
    tarea: {
      defer: 'public',
      async autocomplete(ctx) {
        if (ctx.focused.name === 'persona') return personaChoices(ctx.focused.value);
        if (ctx.focused.name !== 'buscar') return [];
        const personaId = isUuid(ctx.options.persona) ? ctx.options.persona : null;
        const text = ctx.focused.value.trim().replace(/^#/, '');
        return taskChoices(await findTasks(ctx.actor.devId, text, personaId, 25));
      },
      async run(ctx) {
        const raw = optionText(ctx.options.buscar);
        const personaId = isUuid(ctx.options.persona) ? ctx.options.persona : null;
        const id = await resolveTaskId(ctx.actor.devId, raw, personaId);
        const [card] = id ? await loadTaskCards([id]) : [];
        if (!card) {
          return ephemeral(
            raw ? notice('off', `No encontré esa tarea («${clip(raw, 80)}»).`, 'Prueba con el ID (WAT-44) o elige una de la lista.') : notice('off', 'Escribe qué tarea buscas.'),
          );
        }
        return publicMessage(taskCardMessage(card));
      },
    },
  },
  components: {
    'tarea.tomar': {
      defer: 'update',
      async run(ctx) {
        const taskId = ctx.customId.args[0]!;
        const { changed } = await takeTask(ctx.actor, taskId);
        const card = await loadTaskCard(taskId);
        if (!changed) return ephemeral(notice('ok', `${card.identifier} ya es tuya.`));
        return updateMessage(taskCardMessage(card));
      },
    },
    'tarea.estado': {
      defer: 'update',
      async run(ctx) {
        const taskId = ctx.customId.args[0]!;
        const state = ctx.values[0] ?? '';
        if (!isTaskState(state)) return ephemeral(notice('bad', 'Ese estado no existe en roz.'));
        await changeTaskState(taskId, state);
        return updateMessage(taskCardMessage(await loadTaskCard(taskId)));
      },
    },
  },
};
