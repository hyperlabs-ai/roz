// Tareas dentro del chat: las fichas que se pintan en los mensajes (las que nacieron de un mensaje y
// las que se citan con `#ROZ-12`) y la búsqueda del autocompletado `@tarea`.
//
// Una consulta LIGERA a propósito, no `getTicketById`: esa arma la tarea completa del dashboard
// (atribución por PR, esfuerzo, creadores…) y aquí solo hace falta lo que muestra la tarjeta del
// kanban. Un mensaje se pinta muchas veces; la tarjeta tiene que salir barata.
import { db } from '../db/supabase.js';
import { CLOSED_STATES, OPEN_STATES, STATE_LABEL, type TaskState } from '../tasks/states.js';
import type { ChatTaskRef } from './model.js';
import { splitTaskQuery } from './rules.js';

const CARD_COLUMNS = 'id, identifier, name, status, priority, due_date, labels, project_id, assignee_dev_id, updated_at';

interface CardRow {
  id: string;
  identifier: string;
  name: string;
  status: string;
  priority: string | null;
  due_date: string | null;
  labels: string[] | null;
  project_id: string | null;
  assignee_dev_id: string | null;
  updated_at: string | null;
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Misma regla que `isOverdue` del dashboard: fecha límite pasada y la tarea sigue abierta. */
function overdue(dueDate: string | null, status: string): boolean {
  if (!dueDate || CLOSED_STATES.includes(status as TaskState)) return false;
  return dueDate.slice(0, 10) < todayLocal();
}

/** Filas → tarjetas: responsables (primario al frente) y nombre del proyecto, en dos consultas. */
async function toCards(rows: CardRow[]): Promise<Map<string, ChatTaskRef>> {
  const out = new Map<string, ChatTaskRef>();
  if (!rows.length) return out;
  const ids = rows.map((r) => r.id);
  const projectIds = [...new Set(rows.map((r) => r.project_id).filter((x): x is string => !!x))];
  const [{ data: links }, { data: projects }] = await Promise.all([
    db().from('work_item_assignee').select('work_item_id, dev_id').in('work_item_id', ids),
    projectIds.length ? db().from('project').select('id, name').in('id', projectIds) : Promise.resolve({ data: [] }),
  ]);
  const assignees = new Map<string, string[]>();
  for (const l of (links ?? []) as { work_item_id: string; dev_id: string }[]) {
    assignees.set(l.work_item_id, [...(assignees.get(l.work_item_id) ?? []), l.dev_id]);
  }
  const projectName = new Map(((projects ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));

  for (const r of rows) {
    const list = assignees.get(r.id) ?? (r.assignee_dev_id ? [r.assignee_dev_id] : []);
    const ordered = r.assignee_dev_id ? [r.assignee_dev_id, ...list.filter((d) => d !== r.assignee_dev_id)] : list;
    out.set(r.id, {
      id: r.id,
      identifier: r.identifier,
      name: r.name,
      status: r.status,
      statusLabel: STATE_LABEL[r.status as TaskState] ?? r.status,
      priority: r.priority,
      dueDate: r.due_date,
      overdue: overdue(r.due_date, r.status),
      labels: r.labels ?? [],
      projectName: r.project_id ? projectName.get(r.project_id) ?? null : null,
      assigneeDevIds: [...new Set(ordered)],
    });
  }
  return out;
}

/** Tareas creadas a partir de cada mensaje (vínculo `work_item.chat_message_id`). */
export async function tasksByMessage(messageIds: string[]): Promise<Map<string, ChatTaskRef[]>> {
  const map = new Map<string, ChatTaskRef[]>();
  if (!messageIds.length) return map;
  const { data, error } = await db()
    .from('work_item')
    .select(`${CARD_COLUMNS}, chat_message_id, created_at`)
    .in('chat_message_id', messageIds)
    .order('created_at', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as unknown as (CardRow & { chat_message_id: string })[];
  const cards = await toCards(rows);
  for (const r of rows) map.set(r.chat_message_id, [...(map.get(r.chat_message_id) ?? []), cards.get(r.id)!]);
  return map;
}

/** Tarjetas por identificador (`ROZ-12`). Los que no existen simplemente no vuelven. */
export async function tasksByIdentifier(identifiers: string[]): Promise<Map<string, ChatTaskRef>> {
  const out = new Map<string, ChatTaskRef>();
  const ids = [...new Set(identifiers.map((i) => i.toUpperCase()))];
  if (!ids.length) return out;
  const { data, error } = await db().from('work_item').select(CARD_COLUMNS).in('identifier', ids);
  if (error) throw error;
  const cards = await toCards((data ?? []) as unknown as CardRow[]);
  for (const c of cards.values()) out.set(c.identifier.toUpperCase(), c);
  return out;
}

const SEARCH_LIMIT = 8;
const CANDIDATES = 100;

/** Abiertas primero; dentro de cada grupo, lo más reciente. */
function rank(rows: CardRow[]): CardRow[] {
  const open = new Set<string>(OPEN_STATES);
  return [...rows].sort(
    (a, b) =>
      Number(open.has(b.status)) - Number(open.has(a.status)) ||
      String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')),
  );
}

/** Tareas en las que participa alguno de esos devs (primario o en la lista de responsables). */
async function involvedIds(devIds: string[], limit: number): Promise<string[]> {
  const [{ data: links }, { data: primary }] = await Promise.all([
    db()
      .from('work_item_assignee')
      .select('work_item_id, created_at')
      .in('dev_id', devIds)
      .order('created_at', { ascending: false })
      .limit(limit),
    db().from('work_item').select('id').in('assignee_dev_id', devIds).order('updated_at', { ascending: false }).limit(limit),
  ]);
  return [
    ...new Set([
      ...((links ?? []) as { work_item_id: string }[]).map((l) => l.work_item_id),
      ...((primary ?? []) as { id: string }[]).map((p) => p.id),
    ]),
  ].slice(0, limit);
}

/**
 * Búsqueda del autocompletado `@tarea <persona> <texto>`. Cada palabra que coincide con el nombre de
 * un dev filtra por responsable; el resto busca en el nombre y el identificador de la tarea (todas
 * deben aparecer). Sin consulta: las tareas abiertas de quien busca.
 */
export async function searchTasks(devId: string, rawQuery: string): Promise<ChatTaskRef[]> {
  const { data: devRows } = await db().from('dev').select('id, name');
  const { devIds, textWords, empty } = splitTaskQuery(rawQuery, (devRows ?? []) as { id: string; name: string }[]);

  // Sin palabras: lo mío y abierto. Con personas: lo de ellas (sea de quien sea que busca).
  const scopeIds = empty ? await involvedIds([devId], CANDIDATES) : devIds.length ? await involvedIds(devIds, CANDIDATES * 3) : null;
  if (scopeIds && !scopeIds.length) return [];

  // El builder de supabase-js acumula filtros, así que cada consulta se arma de cero.
  const build = () => {
    let q = db().from('work_item').select(CARD_COLUMNS);
    for (const w of textWords) q = q.or(`name.ilike.%${w}%,identifier.ilike.%${w}%`);
    if (empty) q = q.in('status', OPEN_STATES);
    return q;
  };

  let rows: CardRow[] = [];
  if (scopeIds) {
    // Troceado: cientos de ids en un solo `in()` alargan la URL más de lo que PostgREST acepta.
    for (let i = 0; i < scopeIds.length && rows.length < CANDIDATES; i += 100) {
      const { data, error } = await build()
        .in('id', scopeIds.slice(i, i + 100))
        .order('updated_at', { ascending: false })
        .limit(CANDIDATES);
      if (error) throw error;
      rows.push(...((data ?? []) as unknown as CardRow[]));
    }
  } else {
    const { data, error } = await build().order('updated_at', { ascending: false }).limit(CANDIDATES);
    if (error) throw error;
    rows = (data ?? []) as unknown as CardRow[];
  }

  const top = rank(rows).slice(0, SEARCH_LIMIT);
  const cards = await toCards(top);
  return top.map((r) => cards.get(r.id)!);
}
