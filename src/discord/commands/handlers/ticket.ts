// /roz ticket [proyecto] → modal (título, descripción[, proyecto]) → ticket inteligente.
// Dueño: agente "trabajo". Contrato: docs/discord-commands-contract.md §5.2.
//
//   · autocomplete: `proyecto` → proyectos activos (value = project.id).
//   · run: SIEMPRE abre el modal (primera respuesta; defer 'never'). custom_id
//     `ticket.modal:<projectId|_>`: con `_` (sin opción y sin proyecto mapeado al canal) el modal
//     trae un select `proyecto`.
//   · ticket.modal: crea el ticket por el MISMO camino que /ticket de roz (src/tickets/smart.ts:
//     previewTicket + createTicket; Jev + política p2; con ROZ_LINEAR_SOT el issue nace en Linear).
//     Público: la ficha + quién quedó asignado.
//
// También exporta lo de proyectos que usa "Crear tarea con roz": el proyecto mapeado al canal (o al
// canal padre de un hilo) y las opciones de proyecto para un select de modal.
import { db } from '../../../db/supabase.js';
import { tasksByIdentifier } from '../../../chat/tasks.js';
import { autoAssignEnabled } from '../../../assign/enabled.js';
import { createTicket, previewTicket, type TicketUser } from '../../../tickets/smart.js';
import { AppError, ValidationError } from '../../../utils/errors.js';
import { buildCustomId } from '../custom-id.js';
import { taskCardMessage } from '../embeds.js';
import { followup, modal, openModal, publicMessage, selectField, textField, LIMITS } from '../respond.js';
import type { AutocompleteChoice, CommandActor, FollowupMessage, HandlerModule, SelectOption } from '../types.js';
import { dot, notice, text, v2Message } from '../v2.js';
import { cardsFromRefs, foldText, isUuid, loadDevs, optionText } from './tarea.js';

// ================================================================ proyectos

export interface ProjectLite {
  id: string;
  name: string;
}

export async function activeProjects(): Promise<ProjectLite[]> {
  const { data, error } = await db().from('project').select('id, name, active').eq('active', true).order('name');
  if (error) throw error;
  return ((data ?? []) as { id: string; name: string }[]).map((p) => ({ id: p.id, name: p.name }));
}

/** Proyecto mapeado al canal (discord_project_channel); en un hilo, el de su canal padre. */
export async function channelProjectId(channelId: string | null): Promise<string | null> {
  if (!channelId) return null;
  const ids = [channelId];
  const { data: ch } = await db().from('discord_channel').select('id, parent_id').eq('id', channelId).maybeSingle();
  const parent = (ch as { parent_id: string | null } | null)?.parent_id ?? null;
  if (parent) ids.push(parent);
  const { data, error } = await db().from('discord_project_channel').select('project_id, channel_id').in('channel_id', ids);
  if (error) throw error;
  const rows = (data ?? []) as { project_id: string; channel_id: string }[];
  // El canal mismo gana sobre el padre.
  return (rows.find((r) => r.channel_id === channelId) ?? rows[0])?.project_id ?? null;
}

/** Proyecto activo por id, o null. */
export async function activeProject(projectId: string | null | undefined): Promise<ProjectLite | null> {
  if (!isUuid(projectId)) return null;
  return (await activeProjects()).find((p) => p.id === projectId.toLowerCase()) ?? null;
}

/** Opciones para el select de proyecto de un modal (≤ 25): el preseleccionado primero, luego por nombre. */
export function projectSelectOptions(projects: ProjectLite[], selectedId: string | null): SelectOption[] {
  const sorted = [...projects].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId) || a.name.localeCompare(b.name));
  return sorted.slice(0, LIMITS.selectOptions).map((p) => ({ label: p.name, value: p.id, ...(p.id === selectedId ? { default: true } : {}) }));
}

/** Autocompletado de proyecto: los que coinciden con lo escrito; el del canal primero. */
export async function projectChoices(query: string, channelId: string | null): Promise<AutocompleteChoice[]> {
  const [projects, mapped] = await Promise.all([activeProjects(), channelProjectId(channelId).catch(() => null)]);
  const q = foldText(query.trim());
  return projects
    .filter((p) => !q || foldText(p.name).includes(q))
    .sort((a, b) => Number(b.id === mapped) - Number(a.id === mapped) || a.name.localeCompare(b.name))
    .slice(0, 25)
    .map((p) => ({ name: p.name, value: p.id }));
}

/** Valor de un campo de modal (texto o primera opción de un select). */
export function fieldText(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return (v[0] ?? '').trim();
  return (v ?? '').trim();
}

// ================================================================ ticket

/** Quién pide el ticket. createTicket necesita el usuario de auth (requested_by / created_by). */
export function ticketUser(actor: CommandActor): TicketUser {
  if (!actor.authUserId) {
    throw new AppError('NOT_REGISTERED', 'tu perfil de roz no tiene usuario para iniciar sesión. Entra una vez a roz y vuelve a intentarlo.', 403);
  }
  return { userId: actor.authUserId, devId: actor.devId };
}

function ticketsReady(): void {
  if (!autoAssignEnabled()) {
    throw new AppError('AUTO_ASSIGN_DISABLED', 'los tickets inteligentes están apagados en roz (falta TypeSafe)', 409);
  }
}

/** Usuario de Discord ligado a un dev (para que suene la mención), o null. */
export async function discordUserOf(devId: string | null): Promise<string | null> {
  if (!devId) return null;
  const { data } = await db().from('discord_link').select('discord_user_id').eq('dev_id', devId).maybeSingle();
  return (data as { discord_user_id: string } | null)?.discord_user_id ?? null;
}

export const TITLE_MAX = 200;

export const handlers: HandlerModule = {
  slash: {
    ticket: {
      defer: 'never',
      async autocomplete(ctx) {
        if (ctx.focused.name !== 'proyecto') return [];
        return projectChoices(ctx.focused.value, ctx.channelId);
      },
      async run(ctx) {
        // Antes de pedir el formulario: que no llene todo para luego enterarse de que no se puede.
        ticketsReady();
        ticketUser(ctx.actor);
        const chosen = optionText(ctx.options.proyecto);
        const project = (await activeProject(chosen)) ?? (await activeProject(await channelProjectId(ctx.channelId)));
        const fields = [
          textField({ customId: 'titulo', label: 'Título', maxLength: TITLE_MAX, placeholder: 'Qué hay que hacer' }),
          textField({
            customId: 'descripcion',
            label: 'Descripción',
            paragraph: true,
            required: false,
            placeholder: 'Contexto, criterio de hecho, links…',
          }),
        ];
        if (!project) {
          const projects = await activeProjects();
          if (!projects.length) throw new AppError('NO_PROJECTS', 'no hay proyectos activos en roz', 409);
          fields.push(selectField({ customId: 'proyecto', label: 'Proyecto', options: projectSelectOptions(projects, null), placeholder: 'Elige el proyecto' }));
        }
        const title = project ? `Ticket en ${project.name}` : 'Nuevo ticket';
        return openModal(modal(buildCustomId('ticket.modal', project?.id ?? null), title, fields));
      },
    },
  },
  modals: {
    'ticket.modal': {
      defer: 'public',
      async run(ctx) {
        ticketsReady();
        const user = ticketUser(ctx.actor);
        const projectId = ctx.customId.args[0] ?? fieldText(ctx.fields.proyecto);
        if (!(await activeProject(projectId))) throw new ValidationError('elige un proyecto activo');
        const title = fieldText(ctx.fields.titulo).slice(0, TITLE_MAX);
        if (!title) throw new ValidationError('el ticket necesita un título');
        const description = fieldText(ctx.fields.descripcion);
        const log = (msg: string, data: Record<string, unknown>) => ctx.log(msg, data);

        // Mismo camino que /ticket del dashboard: vista previa (Jev + política) y crear con el
        // responsable que propuso roz; si escaló, sin responsable.
        const preview = await previewTicket(user, { title, projectId: projectId.toLowerCase(), description }, { log });
        const assignee = preview.outcome === 'assigned' ? preview.chosenDevId : null;
        const created = await createTicket(
          user,
          { title, projectId: projectId.toLowerCase(), description, previewId: preview.previewId, assigneeDevId: assignee },
          { log },
        );

        const ref = (await tasksByIdentifier([created.identifier])).get(created.identifier.toUpperCase());
        const [card] = ref ? await cardsFromRefs([ref]) : [];
        const assigneeName = assignee ? (await loadDevs([assignee])).get(assignee)?.name ?? 'alguien' : null;
        const discordId = await discordUserOf(assignee);
        const who = assignee ? (discordId ? `<@${discordId}>` : `**${assigneeName}**`) : null;
        const lead = who
          ? `${dot('ok')} Ticket \`${created.identifier}\` creado · asignado a ${who}`
          : `${dot('wait')} Ticket \`${created.identifier}\` creado sin responsable\n-# ${preview.reason ?? 'roz no encontró a quién asignarlo'}`;
        const extra: FollowupMessage[] = created.linear?.warnings.length
          ? [followup(notice('wait', 'Avisos de Linear', created.linear.warnings.join(' · ')), { ephemeral: true })]
          : [];
        const message = card ? taskCardMessage(card, lead) : v2Message([text(lead)]);
        return publicMessage({ ...message, mentionUserIds: discordId ? [discordId] : [] }, extra);
      },
    },
  },
};
