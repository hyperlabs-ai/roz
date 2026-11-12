// /roz status — el daily. Dueño: agente "trabajo". Contrato: docs/discord-commands-contract.md §5.3.
//
//   · run: EFÍMERO con un select múltiple (`status.elegir`, hasta 25) de las tareas abiertas del actor
//     y un botón "Buscar otras" (`status.buscar`).
//   · status.buscar: abre un modal (`status.buscar.modal`, campo `buscar`). defer 'never'.
//   · status.buscar.modal: rehace el mensaje efímero con el select de lo encontrado (update).
//   · status.elegir: con los values (work_item.id) publica en el canal el embed de status
//     (statusMessage de embeds.ts) como followup PÚBLICO y deja el efímero en "Publicado".
//
// Igual que el bloque Status del chat interno: cada tarjeta sale con su estado ACTUAL al publicar.
import type { ChatTaskRef } from '../../../chat/model.js';
import { searchTasks } from '../../../chat/tasks.js';
import { STATE_LABEL, type TaskState } from '../../../tasks/states.js';
import { todayLocal } from '../../../utils/team-time.js';
import { buildCustomId } from '../custom-id.js';
import { githubAvatar, statusMessage } from '../embeds.js';
import { button, clip, ephemeral, followup, modal, openModal, row, stringSelect, textField, updateMessage, LIMITS } from '../respond.js';
import type { CommandActor, HandlerModule, OutgoingMessage } from '../types.js';
import { header, notice, v2Message } from '../v2.js';
import { findTasks, loadTaskCards } from './tarea.js';
import { fieldText } from './ticket.js';

/** Mensaje efímero del selector: las tareas como opciones (las en curso marcadas) + "Buscar otras". */
export function statusPicker(refs: ChatTaskRef[], title: string, subtitle?: string | null): OutgoingMessage {
  const search = button({ label: 'Buscar otras', customId: buildCustomId('status.buscar'), style: 'secondary' });
  const options = refs.slice(0, LIMITS.selectOptions).map((r) => ({
    label: clip(`${r.identifier} · ${r.name}`, LIMITS.selectLabel),
    value: r.id,
    description: STATE_LABEL[r.status as TaskState] ?? r.status,
    ...(r.status === 'en_progreso' ? { default: true } : {}),
  }));
  if (!options.length) {
    return v2Message([header(title, subtitle ?? 'No encontré tareas. Busca otras para armar tu status.'), row(search)]);
  }
  return v2Message([
    header(title, subtitle ?? 'Elige las tareas y se publican en el canal con su estado actual.'),
    row(
      stringSelect({
        customId: buildCustomId('status.elegir'),
        placeholder: 'Tareas de tu status',
        options,
        minValues: 1,
        maxValues: options.length,
      }),
    ),
    row(search),
  ]);
}

/** El daily de `actor` con esas tareas (agrupadas por estado). */
export async function buildStatusMessage(actor: Pick<CommandActor, 'devName' | 'githubLogin'>, taskIds: string[]): Promise<OutgoingMessage | null> {
  const cards = await loadTaskCards(taskIds);
  if (!cards.length) return null;
  return statusMessage({ person: { name: actor.devName, avatarUrl: githubAvatar(actor.githubLogin) }, cards, day: todayLocal() });
}

export const handlers: HandlerModule = {
  slash: {
    status: {
      defer: 'ephemeral',
      async run(ctx) {
        // Sin texto: lo abierto donde participa quien pregunta.
        const refs = await searchTasks(ctx.actor.devId, '', LIMITS.selectOptions);
        return ephemeral(statusPicker(refs, 'Tu status'));
      },
    },
  },
  components: {
    'status.elegir': {
      defer: 'update',
      async run(ctx) {
        const status = await buildStatusMessage(ctx.actor, ctx.values);
        if (!status) return ephemeral(notice('off', 'Esas tareas ya no existen.', 'Vuelve a usar /roz status.'));
        return updateMessage(notice('ok', 'Publicado en el canal.'), [followup(status, { ephemeral: false })]);
      },
    },
    'status.buscar': {
      defer: 'never',
      async run() {
        return openModal(
          modal(buildCustomId('status.buscar.modal'), 'Buscar tareas para tu status', [
            textField({ customId: 'buscar', label: 'Buscar', maxLength: 100, placeholder: 'Texto, ID (WAT-44) o persona' }),
          ]),
        );
      },
    },
  },
  modals: {
    'status.buscar.modal': {
      defer: 'update',
      async run(ctx) {
        const q = fieldText(ctx.fields.buscar).replace(/^#/, '');
        const refs = await findTasks(ctx.actor.devId, q, null, LIMITS.selectOptions);
        return updateMessage(statusPicker(refs, 'Tu status', q ? (refs.length ? `Resultados para "${clip(q, 60)}"` : `Nada para "${clip(q, 60)}". Busca otra cosa.`) : null));
      },
    },
  },
};
