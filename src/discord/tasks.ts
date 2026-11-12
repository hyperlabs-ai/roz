// "Crear issue desde un mensaje" de Discord (contrato §B.11). Lo mismo que el chat interno, con el
// mensaje de Discord como origen: con ROZ_LINEAR_SOT el issue nace en Linear (createIssueFromTicket);
// sin él, tarea nativa (createTask). En ambos casos work_item.discord_message_id guarda el origen,
// que es lo que hace aparecer la ficha en el mensaje (src/discord/views.ts).
//
// Después, el BOT responde de forma nativa en el canal ("↪ Se creó HYP-45 a partir de este
// mensaje", sin menciones con sonido) y se retransmite el mensaje original para que pinte la ficha.
import { db } from '../db/supabase.js';
import { buildAllowedMentions, sendBotMessage } from '../adapters/discord.js';
import { createTask, getTicketById } from '../dashboard/queries.js';
import { createIssueFromTicket } from '../linear/issues.js';
import { linearSourceOfTruth } from '../linear/enabled.js';
import { inBackground } from '../utils/background.js';
import type { TaskState } from '../tasks/states.js';
import { ROZ_PRIORITY_TO_LINEAR, type RozPriority } from '../types/roz-v2.js';
import type { Viewer } from './access.js';
import { loadVisibleMessage } from './messages.js';
import { broadcastMessage } from './realtime.js';
import { messageLink } from './reply.js';
import { buildMessageViews } from './views.js';

export interface DiscordTaskInput {
  projectId: string;
  name: string;
  description?: string | null;
  status?: TaskState;
  priority?: RozPriority | null;
  assigneeDevId?: string | null;
  assigneeDevIds?: string[];
  dueDate?: string | null;
  labels?: string[];
  estimate?: number | null;
  solutionTypeId?: string | null;
}

export interface DiscordTaskResult {
  task: unknown;
  identifier: string;
  workItemId: string;
  linear: { linearIssueId: string; url: string; warnings: string[] } | null;
}

/** Texto del aviso del bot. Puro. */
export function taskCreatedNotice(identifier: string): string {
  return `↪ Se creó ${identifier} a partir de este mensaje`;
}

type OnError = (err: unknown) => void;

export async function createTaskFromDiscordMessage(
  viewer: Viewer,
  messageId: string,
  input: DiscordTaskInput,
  requestedBy: string | null,
  onError?: OnError,
): Promise<DiscordTaskResult> {
  const { row } = await loadVisibleMessage(viewer, messageId);
  const link = messageLink(row.guild_id, row.channel_id, row.id);
  const assignees = [...new Set((input.assigneeDevIds ?? (input.assigneeDevId ? [input.assigneeDevId] : [])).filter(Boolean))];

  let created: { id: string; identifier: string };
  let linear: DiscordTaskResult['linear'] = null;
  if (linearSourceOfTruth()) {
    const description = [input.description?.trim(), `Desde un mensaje de Discord: ${link}`].filter(Boolean).join('\n\n');
    const issue = await createIssueFromTicket({
      projectId: input.projectId,
      title: input.name,
      description,
      solutionTypeId: input.solutionTypeId ?? null,
      estimate: input.estimate ?? null,
      priority: input.priority ? ROZ_PRIORITY_TO_LINEAR[input.priority] ?? null : null,
      assigneeDevId: assignees[0] ?? null,
      dueDate: input.dueDate ?? null,
      origin: 'ticket',
      requestedBy,
    });
    created = { id: issue.workItemId, identifier: issue.identifier };
    linear = { linearIssueId: issue.linearIssueId, url: issue.url, warnings: issue.warnings };
  } else {
    created = await createTask({
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      status: input.status,
      priority: input.priority ?? null,
      assigneeDevIds: assignees,
      dueDate: input.dueDate ?? null,
      labels: input.labels,
      estimate: input.estimate ?? null,
      solutionTypeId: input.solutionTypeId ?? null,
      createdBy: requestedBy,
    });
  }
  const { error } = await db().from('work_item').update({ discord_message_id: row.id }).eq('id', created.id);
  if (error) throw error;

  // Best-effort: la tarea ya existe; si Discord o Realtime fallan, la ficha aparece al recargar.
  inBackground(async () => {
    await sendBotMessage(row.channel_id, {
      content: taskCreatedNotice(created.identifier),
      allowedMentions: buildAllowedMentions([]),
      replyToMessageId: row.id,
    }).catch((err) => onError?.(err));
    const [view] = await buildMessageViews([row], viewer.snap, { refreshAttachments: false });
    if (view) await broadcastMessage(viewer.snap, 'discord.message.updated', view);
  }, onError);

  return { task: (await getTicketById(created.id)) ?? created, identifier: created.identifier, workItemId: created.id, linear };
}
