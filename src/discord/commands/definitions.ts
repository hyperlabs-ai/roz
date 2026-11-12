// Definición de los comandos de roz en Discord (fuente ÚNICA): el comando de barra /roz con sus
// subcomandos y las tres acciones de mensaje (clic derecho → Apps). Se registran como comandos de
// SERVIDOR (guild) para que un cambio se vea al instante (register.ts / npm run discord:commands).
//
// Reglas de Discord que se respetan aquí (y que test/discord-commands-definitions.test.ts verifica):
//   · nombres de comando de barra, subcomando y opción: 1-32, minúsculas, `^[-_'\p{L}\p{N}]+$`;
//   · nombres de comandos de MENSAJE: 1-32, pueden llevar espacios y mayúsculas; descripción vacía;
//   · descripciones de barra/opción: 1-100 caracteres;
//   · ≤ 25 opciones por nivel, las requeridas antes que las opcionales; autocompletado sin `choices`;
//   · ≤ 4000 caracteres sumando nombres, descripciones y valores de un comando;
//   · ≤ 5 comandos de mensaje por servidor.
//
// El hash (definitionsHash) es lo que decide si hay que volver a registrar: register.ts compara el
// hash de esto contra el de lo que Discord tiene registrado, normalizado igual.
import { createHash } from 'node:crypto';
import { COMMAND_TYPE, OPTION_TYPE } from './types.js';

export const ROZ_COMMAND_NAME = 'roz';

export const ROZ_SUBCOMMANDS = ['tarea', 'ticket', 'status', 'plan', 'pulso', 'infra', 'junta'] as const;
export type RozSubcommand = (typeof ROZ_SUBCOMMANDS)[number];

export const MESSAGE_COMMAND_KEYS = ['crear-tarea', 'decision', 'citar-tareas'] as const;
export type MessageCommandKey = (typeof MESSAGE_COMMAND_KEYS)[number];

/** Nombre visible (el que Discord muestra en Apps) → clave interna, y al revés. */
export const MESSAGE_COMMAND_NAMES: Record<MessageCommandKey, string> = {
  'crear-tarea': 'Crear tarea con roz',
  decision: 'Guardar como decisión',
  'citar-tareas': 'Citar tareas',
};

export function messageCommandKeyOf(name: string): MessageCommandKey | null {
  for (const key of MESSAGE_COMMAND_KEYS) if (MESSAGE_COMMAND_NAMES[key] === name) return key;
  return null;
}

export function isRozSubcommand(name: string): name is RozSubcommand {
  return (ROZ_SUBCOMMANDS as readonly string[]).includes(name);
}

// ---------------------------------------------------------------- forma de la API

export interface CommandOptionDef {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  autocomplete?: boolean;
  min_length?: number;
  max_length?: number;
  choices?: { name: string; value: string | number }[];
  options?: CommandOptionDef[];
}

export interface CommandDef {
  type: number;
  name: string;
  /** Vacía en comandos de mensaje (Discord la exige vacía). */
  description: string;
  options?: CommandOptionDef[];
}

const str = (name: string, description: string, extra: Partial<CommandOptionDef> = {}): CommandOptionDef => ({
  type: OPTION_TYPE.STRING,
  name,
  description,
  ...extra,
});

const sub = (name: RozSubcommand, description: string, options: CommandOptionDef[] = []): CommandOptionDef => ({
  type: OPTION_TYPE.SUB_COMMAND,
  name,
  description,
  ...(options.length ? { options } : {}),
});

/**
 * Subcomandos de /roz. El ORDEN es el del desplegable de Discord. Las opciones con autocompletado
 * mandan como `value` un id (uuid de roz) o un identificador (WAT-44), nunca un nombre: el handler
 * resuelve el valor sin adivinar.
 */
export const ROZ_SUBCOMMAND_DEFS: Record<RozSubcommand, CommandOptionDef> = {
  tarea: sub('tarea', 'Busca una tarea y publica su ficha en el canal', [
    str('buscar', 'Texto, ID (WAT-44) o persona', { required: true, autocomplete: true, max_length: 100 }),
    str('persona', 'Solo tareas de esta persona', { autocomplete: true, max_length: 100 }),
  ]),
  ticket: sub('ticket', 'Crea un ticket inteligente: roz propone prioridad y responsable', [
    str('proyecto', 'Proyecto del ticket (si no, el del canal)', { autocomplete: true, max_length: 100 }),
  ]),
  status: sub('status', 'Tu daily: elige tus tareas y publica su estado en el canal'),
  plan: sub('plan', 'Plan del agente de un issue (sin issue: tus planes)', [
    str('issue', 'Issue del plan, p. ej. WAT-44', { autocomplete: true, max_length: 100 }),
  ]),
  pulso: sub('pulso', 'Quién trabaja en qué ahora (solo lo ves tú)', [
    str('persona', 'Ver el detalle de una persona', { autocomplete: true, max_length: 100 }),
  ]),
  infra: sub('infra', 'Estado de los servicios (solo lo ves tú)', [
    str('proyecto', 'Solo los servicios de este proyecto', { autocomplete: true, max_length: 100 }),
  ]),
  junta: sub('junta', 'Pega notas o el transcript de una junta para la bandeja de Juntas', [
    str('proyecto', 'Proyecto de la junta (opcional)', { autocomplete: true, max_length: 100 }),
  ]),
};

export const ROZ_COMMAND: CommandDef = {
  type: COMMAND_TYPE.CHAT_INPUT,
  name: ROZ_COMMAND_NAME,
  description: 'roz: tareas, tickets, daily, planes del agente, pulso, infra y juntas',
  options: ROZ_SUBCOMMANDS.map((s) => ROZ_SUBCOMMAND_DEFS[s]),
};

export const MESSAGE_COMMANDS: CommandDef[] = MESSAGE_COMMAND_KEYS.map((key) => ({
  type: COMMAND_TYPE.MESSAGE,
  name: MESSAGE_COMMAND_NAMES[key],
  description: '',
}));

/** Todo lo que se registra en el servidor (cuerpo de PUT /applications/{app}/guilds/{guild}/commands). */
export function commandDefinitions(): CommandDef[] {
  return [ROZ_COMMAND, ...MESSAGE_COMMANDS];
}

// ---------------------------------------------------------------- normalización y hash

/**
 * Deja un comando (nuestro o el que devuelve Discord) en la forma comparable: solo los campos que
 * definimos, sin `false`/`null`/vacíos (Discord los omite o los rellena según el caso) y sin ids ni
 * versiones. Dos definiciones equivalentes normalizan idéntico.
 */
export function normalizeCommand(raw: any): CommandDef {
  const out: CommandDef = { type: Number(raw?.type ?? COMMAND_TYPE.CHAT_INPUT), name: String(raw?.name ?? ''), description: String(raw?.description ?? '') };
  const options = normalizeOptions(raw?.options);
  if (options.length) out.options = options;
  return out;
}

function normalizeOptions(raw: unknown): CommandOptionDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o: any) => {
    const opt: CommandOptionDef = { type: Number(o.type), name: String(o.name), description: String(o.description ?? '') };
    if (o.required) opt.required = true;
    if (o.autocomplete) opt.autocomplete = true;
    if (typeof o.min_length === 'number') opt.min_length = o.min_length;
    if (typeof o.max_length === 'number') opt.max_length = o.max_length;
    if (Array.isArray(o.choices) && o.choices.length) opt.choices = o.choices.map((c: any) => ({ name: String(c.name), value: c.value }));
    const children = normalizeOptions(o.options);
    if (children.length) opt.options = children;
    return opt;
  });
}

/** JSON con llaves ordenadas (el orden de los ARREGLOS sí importa: es el del desplegable). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Hash de un conjunto de comandos, independiente del orden en que Discord los liste. */
export function commandsHash(commands: unknown[]): string {
  const normalized = commands
    .map(normalizeCommand)
    .sort((a, b) => a.type - b.type || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash('sha256').update(canonical(normalized)).digest('hex');
}

/** Hash de la definición actual de roz. */
export function definitionsHash(): string {
  return commandsHash(commandDefinitions());
}

// ---------------------------------------------------------------- validación (reglas de Discord)

/** Nombre de comando de barra / subcomando / opción. */
export const CHAT_INPUT_NAME_RE = /^[-_'\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

/** Caracteres que cuentan para el tope de 4000 por comando. */
export function commandCharCount(cmd: CommandDef): number {
  const optionChars = (opts: CommandOptionDef[] | undefined): number =>
    (opts ?? []).reduce(
      (n, o) =>
        n +
        o.name.length +
        o.description.length +
        (o.choices ?? []).reduce((m, c) => m + c.name.length + String(c.value).length, 0) +
        optionChars(o.options),
      0,
    );
  return cmd.name.length + cmd.description.length + optionChars(cmd.options);
}

/** Problemas de la definición según las reglas de Discord. Vacío = válida. */
export function validateDefinitions(commands: CommandDef[] = commandDefinitions()): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  let messageCount = 0;

  const checkOptions = (path: string, opts: CommandOptionDef[] | undefined, depth: number) => {
    if (!opts) return;
    if (opts.length > 25) problems.push(`${path}: más de 25 opciones`);
    const names = new Set<string>();
    let optionalSeen = false;
    for (const o of opts) {
      const p = `${path} ${o.name}`;
      if (!CHAT_INPUT_NAME_RE.test(o.name) || o.name !== o.name.toLowerCase()) problems.push(`${p}: nombre inválido`);
      if (names.has(o.name)) problems.push(`${p}: nombre repetido`);
      names.add(o.name);
      if (o.description.length < 1 || o.description.length > 100) problems.push(`${p}: descripción fuera de 1-100`);
      const isSub = o.type === OPTION_TYPE.SUB_COMMAND || o.type === OPTION_TYPE.SUB_COMMAND_GROUP;
      if (isSub) {
        if (depth > 1) problems.push(`${p}: subcomando anidado de más`);
        if (o.required !== undefined) problems.push(`${p}: un subcomando no lleva required`);
        checkOptions(p, o.options, depth + 1);
        continue;
      }
      if (o.required) {
        if (optionalSeen) problems.push(`${p}: requerida después de una opcional`);
      } else optionalSeen = true;
      if (o.autocomplete && o.choices?.length) problems.push(`${p}: autocomplete y choices no se combinan`);
      if (o.choices && o.choices.length > 25) problems.push(`${p}: más de 25 choices`);
      if (o.min_length !== undefined && (o.min_length < 0 || o.min_length > 6000)) problems.push(`${p}: min_length fuera de 0-6000`);
      if (o.max_length !== undefined && (o.max_length < 1 || o.max_length > 6000)) problems.push(`${p}: max_length fuera de 1-6000`);
    }
    // Discord no deja mezclar subcomandos con opciones normales en el mismo nivel.
    const subs = opts.filter((o) => o.type === OPTION_TYPE.SUB_COMMAND || o.type === OPTION_TYPE.SUB_COMMAND_GROUP).length;
    if (subs && subs !== opts.length) problems.push(`${path}: mezcla subcomandos y opciones`);
  };

  for (const cmd of commands) {
    const key = `${cmd.type}:${cmd.name}`;
    if (seen.has(key)) problems.push(`${cmd.name}: comando repetido`);
    seen.add(key);
    if (cmd.type === COMMAND_TYPE.CHAT_INPUT) {
      if (!CHAT_INPUT_NAME_RE.test(cmd.name) || cmd.name !== cmd.name.toLowerCase()) problems.push(`${cmd.name}: nombre inválido`);
      if (cmd.description.length < 1 || cmd.description.length > 100) problems.push(`${cmd.name}: descripción fuera de 1-100`);
      checkOptions(`/${cmd.name}`, cmd.options, 1);
    } else if (cmd.type === COMMAND_TYPE.MESSAGE || cmd.type === COMMAND_TYPE.USER) {
      if (cmd.type === COMMAND_TYPE.MESSAGE) messageCount++;
      if (cmd.name.length < 1 || cmd.name.length > 32) problems.push(`${cmd.name}: nombre fuera de 1-32`);
      if (cmd.description !== '') problems.push(`${cmd.name}: un comando de mensaje no lleva descripción`);
      if (cmd.options?.length) problems.push(`${cmd.name}: un comando de mensaje no lleva opciones`);
    } else {
      problems.push(`${cmd.name}: tipo desconocido ${cmd.type}`);
    }
    if (commandCharCount(cmd) > 4000) problems.push(`${cmd.name}: más de 4000 caracteres`);
  }
  if (messageCount > 5) problems.push('más de 5 comandos de mensaje');
  return problems;
}

// ---------------------------------------------------------------- menú del compositor de roz

export interface CommandMenuItem {
  /** Lo que se ve y se escribe: "/roz tarea". */
  command: string;
  subcommand: RozSubcommand;
  description: string;
  options: { name: string; description: string; required: boolean }[];
}

/**
 * Menú "/" del compositor del chat de Discord dentro de roz (paridad con Discord): la MISMA lista
 * que el desplegable de Discord, para que los dos no diverjan.
 */
export function commandMenu(): CommandMenuItem[] {
  return ROZ_SUBCOMMANDS.map((s) => {
    const def = ROZ_SUBCOMMAND_DEFS[s];
    return {
      command: `/${ROZ_COMMAND_NAME} ${s}`,
      subcommand: s,
      description: def.description,
      options: (def.options ?? []).map((o) => ({ name: o.name, description: o.description, required: !!o.required })),
    };
  });
}
