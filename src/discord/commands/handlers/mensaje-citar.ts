// Acción de mensaje "Citar tareas". Dueño: agente "trabajo".
// Contrato: docs/discord-commands-contract.md §6.3.
//
//   · run: detecta IDs (WAT-44, HYP-12, ROZ-123) en el texto del mensaje, los resuelve (vigentes con
//     tasksByIdentifier de src/chat/tasks.ts; viejos de antes de Linear con findWorkItemIdByIdentifier
//     de src/linear/legacy.ts) y responde con sus fichas. Público. Sin IDs: efímero.
//
// En Discord los IDs se escriben sueltos (WAT-44), no con `#` como en el chat interno: por eso aquí
// no basta extractTaskIdentifiers. Con hasta MAX_WITH_BUTTONS fichas, cada una va en su propio
// mensaje con sus botones (Tomar/Cambiar estado editan SOLO su mensaje: con todas juntas, tomar una
// borraría las demás). Con más, un solo mensaje con todas las fichas y sin botones.
import { tasksByIdentifier } from '../../../chat/tasks.js';
import { findWorkItemIdByIdentifier } from '../../../linear/legacy.js';
import { taskCardMessage, taskListMessage } from '../embeds.js';
import { ephemeral, followup, publicMessage } from '../respond.js';
import type { DiscordApiEmbed } from '../../../adapters/discord.js';
import type { HandlerModule } from '../types.js';
import { flattenV2, notice } from '../v2.js';
import { loadTaskCards } from './tarea.js';

/** Máximo de tareas citadas en un mensaje. */
export const MAX_CITED = 10;
/** Hasta cuántas fichas van en mensajes separados con botones. */
export const MAX_WITH_BUTTONS = 3;

// Prefijo de 1-10 letras/dígitos que empieza con letra, guion y número. Sin pegarse a otra palabra,
// a una ruta (feat/WAT-44 sí cuenta: la rama dice la tarea) ni a un número más largo.
const ID_RE = /(^|[^A-Za-z0-9_-])([A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})(?![A-Za-z0-9_]|-\d)/g;

/** IDs de tarea en el texto, en mayúsculas, sin repetir y en orden de aparición. Puro. */
export function findTaskIdentifiers(text: string | null | undefined, max = MAX_CITED): string[] {
  const out: string[] = [];
  // Sin bloques de código ni URLs: un hash o una ruta con guiones no es una cita.
  const clean = (text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  for (const m of clean.matchAll(ID_RE)) {
    const id = m[2]!.toUpperCase();
    if (!out.includes(id)) out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Texto donde buscar: el contenido y, si es un mensaje del bot o de un webhook, sus embeds y los
 * textos de sus componentes (las fichas de roz en Components V2 no traen ni content ni embeds).
 */
function messageText(target: { content?: string; embeds?: DiscordApiEmbed[]; components?: unknown[] }): string {
  const embeds = (target.embeds ?? []).map((e) => [e.title, e.description, ...(e.fields ?? []).map((f) => `${f.name} ${f.value}`)].filter(Boolean).join('\n'));
  // Los IDs de las fichas van en `código`: se quitan los backticks para que la búsqueda los vea.
  const components = flattenV2(target.components).text.replace(/`/g, ' ');
  return [target.content ?? '', ...embeds, components].join('\n');
}

/** IDs → ids de work_item en el mismo orden (vigentes primero; los viejos por legacy_identifier). */
async function resolveIdentifiers(identifiers: string[]): Promise<string[]> {
  const current = await tasksByIdentifier(identifiers);
  const ids: string[] = [];
  for (const ident of identifiers) {
    const hit = current.get(ident)?.id ?? (await findWorkItemIdByIdentifier(ident));
    if (hit && !ids.includes(hit)) ids.push(hit);
  }
  return ids;
}

export const handlers: HandlerModule = {
  message: {
    'citar-tareas': {
      defer: 'public',
      async run(ctx) {
        const identifiers = findTaskIdentifiers(messageText(ctx.target));
        if (!identifiers.length) return ephemeral(notice('off', 'No encontré IDs de tarea (como WAT-44) en ese mensaje.'));
        const cards = await loadTaskCards(await resolveIdentifiers(identifiers));
        if (!cards.length) return ephemeral(notice('off', 'Ninguna de esas tareas existe en roz.', identifiers.join(', ')));

        if (cards.length <= MAX_WITH_BUTTONS) {
          const [first, ...rest] = cards;
          return publicMessage(
            taskCardMessage(first!),
            rest.map((c) => followup(taskCardMessage(c), { ephemeral: false })),
          );
        }
        return publicMessage(taskListMessage(cards, `${cards.length} tareas citadas`, 'Usa /roz tarea para la ficha con botones.'));
      },
    },
  },
};
