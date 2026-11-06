// Texto de los mensajes del chat. Módulo PURO (sin base ni red): lo usan el backend y los tests.
//
// El cuerpo de un mensaje es markdown con dos tokens de mención que el cliente escribe al elegir
// en el autocompletado:
//   · <@devId>  → mención a una persona (el id es el de roz.dev)
//   · <!canal>  → mención a todos los miembros de la conversación
// Se guardan ids y no nombres para que renombrar a alguien no rompa mensajes viejos, y para que
// las menciones se puedan derivar del texto en el servidor en vez de confiar en una lista aparte
// que mande el cliente.

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const MENTION_RE = new RegExp(`<@(${UUID})>`, 'g');
export const CHANNEL_TOKEN = '<!canal>';
// Proyecto mencionado: `<@proyecto:id|Nombre>` (lo arma el compositor; ver web/src/lib/chat-text.ts).
// No es una persona: no entra en `extractMentions` ni avisa a nadie. El nombre va en el token.
const PROJECT_RE = new RegExp(`<@proyecto:${UUID}\\|([^>|\\n]{1,120})>`, 'g');

// Citas de tareas: `#ROZ-12` (el identificador canónico, ver ARCHITECTURE: KEY-N). No se guarda un
// token aparte: el identificador ya es estable y legible, así que el texto se queda como lo escribió
// la persona y la tarjeta se resuelve al leer. El `#` tiene que ir pegado (`# Título` es markdown).
const TASK_REF_RE = /(^|[^\w#/-])#([A-Za-z][A-Za-z0-9_]*-\d+)(?![\w-])/g;
/** Máximo de tarjetas por mensaje: más que eso deja de ser una cita y se vuelve un listado. */
export const MAX_CITED_TASKS = 6;

/** Identificadores citados (`#ROZ-12`), en mayúsculas, sin repetir y en orden de aparición. */
export function extractTaskIdentifiers(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(TASK_REF_RE)) {
    const id = m[2]!.toUpperCase();
    if (!out.includes(id)) out.push(id);
    if (out.length >= MAX_CITED_TASKS) break;
  }
  return out;
}

/** Máximo de tareas en un bloque Status (el `@tarea` suelto se queda en MAX_CITED_TASKS). */
export const MAX_STATUS_TASKS = 30;

/** Ids de tarea de un bloque Status; [] si el mensaje no es un status. */
export function statusTaskIds(meta: Record<string, unknown> | null | undefined): string[] {
  if (meta?.type !== 'status' || !Array.isArray(meta.taskIds)) return [];
  return meta.taskIds.filter((x): x is string => typeof x === 'string');
}

/** Máximo de caracteres de un mensaje. Holgado para pegar un log, corto para no abusar del push. */
export const MAX_MESSAGE_LENGTH = 8000;

/** Ids de dev mencionados en el cuerpo, sin repetir y en minúsculas, en orden de aparición. */
export function extractMentions(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const id = m[1]!.toLowerCase();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function hasChannelMention(body: string): boolean {
  return body.includes(CHANNEL_TOKEN);
}

/**
 * Texto plano y corto para el cuerpo de una notificación: menciones con nombre, sin sintaxis de
 * markdown y en una sola línea. Un push no renderiza markdown; mostrar `**hola**` o `<@3f2…>` se lee
 * como un error.
 */
export function previewText(body: string, nameOf: (devId: string) => string | undefined, max = 140): string {
  const text = body
    .replace(PROJECT_RE, (_, name: string) => `@${name}`)
    .replace(MENTION_RE, (_, id: string) => `@${nameOf(id.toLowerCase()) ?? 'alguien'}`)
    .replaceAll(CHANNEL_TOKEN, '@canal')
    .replace(/```[\s\S]*?```/g, ' [código] ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|$)/g, '$1$2')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Primera línea útil del mensaje, para el nombre de una tarea creada desde él. */
export function firstLine(body: string, nameOf: (devId: string) => string | undefined, max = 120): string {
  const line = body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return previewText(line, nameOf, max);
}
