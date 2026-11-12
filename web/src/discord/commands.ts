// Menú "/" del compositor del chat de Discord dentro de roz (contrato de comandos §9): los subcomandos
// de /roz con el MISMO orden y descripciones que el desplegable de Discord. La fuente es la API
// (GET /discord/commands → commandMenu() de src/discord/commands/definitions.ts); FALLBACK_MENU es
// solo para pintar el menú al instante mientras llega (test/discord-commands-composer.test.ts
// verifica que sea idéntico a commandMenu()).
import type { DiscordCommandMenuItem, DiscordRozSubcommand } from '@/lib/api';

export const FALLBACK_MENU: DiscordCommandMenuItem[] = [
  {
    command: '/roz tarea',
    subcommand: 'tarea',
    description: 'Busca una tarea y publica su ficha en el canal',
    options: [
      { name: 'buscar', description: 'Texto, ID (WAT-44) o persona', required: true },
      { name: 'persona', description: 'Solo tareas de esta persona', required: false },
    ],
  },
  {
    command: '/roz ticket',
    subcommand: 'ticket',
    description: 'Crea un ticket inteligente: roz propone prioridad y responsable',
    options: [{ name: 'proyecto', description: 'Proyecto del ticket (si no, el del canal)', required: false }],
  },
  { command: '/roz status', subcommand: 'status', description: 'Tu daily: elige tus tareas y publica su estado en el canal', options: [] },
  {
    command: '/roz plan',
    subcommand: 'plan',
    description: 'Plan del agente de un issue (sin issue: tus planes)',
    options: [{ name: 'issue', description: 'Issue del plan, p. ej. WAT-44', required: false }],
  },
  {
    command: '/roz pulso',
    subcommand: 'pulso',
    description: 'Quién trabaja en qué ahora (solo lo ves tú)',
    options: [{ name: 'persona', description: 'Ver el detalle de una persona', required: false }],
  },
  {
    command: '/roz infra',
    subcommand: 'infra',
    description: 'Estado de los servicios (solo lo ves tú)',
    options: [{ name: 'proyecto', description: 'Solo los servicios de este proyecto', required: false }],
  },
  {
    command: '/roz junta',
    subcommand: 'junta',
    description: 'Pega notas o el transcript de una junta para la bandeja de Juntas',
    options: [{ name: 'proyecto', description: 'Proyecto de la junta (opcional)', required: false }],
  },
];

/** Subcomandos que en Discord abren un modal: aquí el diálogo pide además estos campos. */
export const COMMAND_FIELDS: Partial<Record<DiscordRozSubcommand, { name: string; label: string; multiline: boolean; required: boolean; max: number; placeholder: string }[]>> = {
  ticket: [
    { name: 'titulo', label: 'Título', multiline: false, required: true, max: 200, placeholder: 'Qué hay que hacer' },
    { name: 'descripcion', label: 'Descripción', multiline: true, required: false, max: 4000, placeholder: 'Contexto, pasos, criterios de aceptación…' },
  ],
  junta: [
    { name: 'titulo', label: 'Título', multiline: false, required: true, max: 200, placeholder: 'Junta semanal, kickoff con el cliente…' },
    { name: 'notas', label: 'Notas o transcript', multiline: true, required: true, max: 4000, placeholder: 'Pega aquí las notas o el transcript' },
  ],
};

/** Etiqueta de una opción en el diálogo (sin mono: es una etiqueta de interfaz). */
export const OPTION_LABEL: Record<string, string> = {
  buscar: 'Tarea',
  persona: 'Persona',
  proyecto: 'Proyecto',
  issue: 'Issue',
};

/** Los que solo devuelven algo para quien los usa (en Discord, efímeros). */
export const PRIVATE_COMMANDS: ReadonlySet<DiscordRozSubcommand> = new Set(['pulso', 'infra', 'junta']);

/** Status de Discord = un select: hasta 25 tareas. */
export const STATUS_MAX_TASKS = 25;

function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/**
 * ¿El compositor está escribiendo un comando? Acepta `/`, `/roz`, `/roz ta`, `/tarea login`. Devuelve
 * los subcomandos que coinciden y el texto que sigue al subcomando (prellena su primera opción o el
 * título). null = no es un comando (o nada coincide: Enter envía el texto tal cual).
 */
export function matchSlash(text: string, items: DiscordCommandMenuItem[]): { items: DiscordCommandMenuItem[]; rest: string } | null {
  if (!text.startsWith('/') || text.includes('\n')) return null;
  // "/roz tarea login" → ['roz', 'tarea', 'login']; "/roz " → ['roz', ''].
  const words = text.slice(1).split(/\s+/);
  const first = fold(words[0] ?? '');
  let i = 0;
  let sub: string;
  if (first === 'roz' && words.length > 1) {
    i = 1;
    sub = fold(words[1] ?? '');
  } else if (words.length === 1 && 'roz'.startsWith(first) && !items.some((it) => it.subcommand.startsWith(first))) {
    // "/r", "/ro", "/roz" a solas: todavía escribiendo el comando → todos los subcomandos.
    sub = '';
  } else {
    sub = first;
  }
  // Hay algo después del subcomando (aunque sea un espacio): ya lo eligió.
  const typedFull = words.length > i + 1;
  const exact = items.find((it) => it.subcommand === sub);
  if (typedFull) {
    if (!exact) return null;
    return { items: [exact], rest: words.slice(i + 1).join(' ').trim() };
  }
  const list = items.filter((it) => it.subcommand.startsWith(sub));
  return list.length ? { items: list, rest: '' } : null;
}
