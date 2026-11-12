// Acción de mensaje "Crear tarea con roz". Dueño: agente "trabajo".
// Contrato: docs/discord-commands-contract.md §6.1.
//
//   · run: abre el modal (defer 'never') prellenado con el texto del mensaje (título = primera línea,
//     descripción = el resto). custom_id `msg.tarea.modal:<channelId>:<messageId>`. El proyecto: select
//     en el modal (mapeado del canal preseleccionado).
//   · msg.tarea.modal: crea la tarea con createTaskFromDiscordMessage (src/discord/tasks.ts: valida que
//     el actor ve el mensaje, deja work_item.discord_message_id y el link como evidencia; con
//     ROZ_LINEAR_SOT en Linear). Público: la ficha.
import { loadViewer } from '../../access.js';
import { createTaskFromDiscordMessage } from '../../tasks.js';
import { AppError, NotFoundError, ValidationError } from '../../../utils/errors.js';
import { buildCustomId } from '../custom-id.js';
import { taskCardMessage } from '../embeds.js';
import { clip, followup, modal, openModal, publicMessage, selectField, textField, LIMITS } from '../respond.js';
import type { FollowupMessage, HandlerModule } from '../types.js';
import { dot, notice } from '../v2.js';
import { loadTaskCards } from './tarea.js';
import { activeProject, activeProjects, channelProjectId, fieldText, projectSelectOptions, TITLE_MAX } from './ticket.js';

/** Texto del mensaje → título (primera línea útil, ≤ 200) y descripción (el resto). Puro. */
export function splitMessageText(content: string | null | undefined): { title: string; description: string } {
  const lines = (content ?? '').replace(/\r\n/g, '\n').split('\n');
  const idx = lines.findIndex((l) => l.trim());
  if (idx < 0) return { title: '', description: '' };
  const first = lines[idx]!.trim().replace(/^#{1,6}\s+/, '').replace(/^[-*>]\s+/, '');
  const rest = lines.slice(idx + 1).join('\n').trim();
  if (first.length <= TITLE_MAX) return { title: first, description: rest };
  // Línea larguísima: el título se corta y el texto completo queda en la descripción.
  return { title: clip(first, TITLE_MAX), description: [first, rest].filter(Boolean).join('\n') };
}

export const handlers: HandlerModule = {
  message: {
    'crear-tarea': {
      defer: 'never',
      async run(ctx) {
        const channelId = ctx.target.channel_id || ctx.channelId;
        if (!channelId) throw new AppError('VALIDATION_ERROR', 'no sé de qué canal es ese mensaje', 400);
        const [projects, mapped] = await Promise.all([activeProjects(), channelProjectId(channelId)]);
        if (!projects.length) throw new AppError('NO_PROJECTS', 'no hay proyectos activos en roz', 409);
        const { title, description } = splitMessageText(ctx.target.content);
        return openModal(
          modal(buildCustomId('msg.tarea.modal', channelId, ctx.target.id), 'Crear tarea con roz', [
            textField({ customId: 'titulo', label: 'Título', maxLength: TITLE_MAX, value: title, placeholder: 'Qué hay que hacer' }),
            textField({
              customId: 'descripcion',
              label: 'Descripción',
              paragraph: true,
              required: false,
              maxLength: LIMITS.textInputMax,
              value: description,
              description: 'El link al mensaje se agrega solo como evidencia.',
            }),
            selectField({ customId: 'proyecto', label: 'Proyecto', options: projectSelectOptions(projects, mapped), placeholder: 'Elige el proyecto' }),
          ]),
        );
      },
    },
  },
  modals: {
    'msg.tarea.modal': {
      defer: 'public',
      async run(ctx) {
        const messageId = ctx.customId.args[1]!;
        const project = await activeProject(fieldText(ctx.fields.proyecto));
        if (!project) throw new ValidationError('elige un proyecto activo');
        const name = fieldText(ctx.fields.titulo).slice(0, TITLE_MAX);
        if (!name) throw new ValidationError('la tarea necesita un título');
        const description = fieldText(ctx.fields.descripcion) || null;

        const viewer = await loadViewer(ctx.actor.devId);
        let created: Awaited<ReturnType<typeof createTaskFromDiscordMessage>>;
        try {
          created = await createTaskFromDiscordMessage(viewer, messageId, { projectId: project.id, name, description }, ctx.actor.authUserId, (err) =>
            ctx.log('discord: aviso de tarea creada desde mensaje falló', { err: err instanceof Error ? err.message : String(err) }),
          );
        } catch (err) {
          // El mensaje aún no está en el espejo (el puente no lo ha guardado) o no lo puedes leer.
          if (err instanceof NotFoundError) throw new NotFoundError('roz todavía no tiene ese mensaje o no lo puedes ver. Intenta en unos segundos.');
          throw err;
        }

        const [card] = await loadTaskCards([created.workItemId]);
        const extra: FollowupMessage[] = created.linear?.warnings.length
          ? [followup(notice('wait', 'Avisos de Linear', created.linear.warnings.join(' · ')), { ephemeral: true })]
          : [];
        if (!card) return publicMessage(notice('ok', `Se creó \`${created.identifier}\` a partir del mensaje.`), extra);
        return publicMessage(taskCardMessage(card, `${dot('ok')} Tarea creada desde un mensaje`), extra);
      },
    },
  },
};
