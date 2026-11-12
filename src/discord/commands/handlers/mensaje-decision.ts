// Acción de mensaje "Guardar como decisión". Dueño: agente "visibilidad".
// Contrato: docs/discord-commands-contract.md §6.2.
//
//   · run: si el canal está mapeado a un proyecto (discord_project_channel), guarda el texto del
//     mensaje como átomo de decisión del brain de ese proyecto (con el link al mensaje como fuente) y
//     confirma EFÍMERO. Si no, responde EFÍMERO con el select `msg.decision.proyecto:<canal>:<mensaje>`.
//   · msg.decision.proyecto: guarda en el proyecto elegido (values[0]) y deja el efímero en "Guardado".
//
// El átomo tiene el mismo formato que las decisiones de juntas (src/meetings/pipeline.ts
// saveDecisionAtom): scope 'project', título, cuerpo con la cita y de dónde salió, procedencia
// `discord:<messageId>`, embedding best-effort (si falla, lo rellena el brain-sweep) y dedup por
// content_hash dentro de esa procedencia: guardar dos veces el mismo mensaje no duplica.
//
// Visibilidad: quien guarda tiene que VER el mensaje en Discord (loadVisibleMessage / el canal con
// assertChannelVisible). El select viaja con canal + mensaje en el custom_id, que se puede inventar:
// por eso ahí se vuelve a revisar todo con el espejo.
import { createHash } from 'node:crypto';
import type { DiscordApiMessage } from '../../../adapters/discord.js';
import { embed, embeddingModel } from '../../../adapters/embeddings.js';
import { config } from '../../../config.js';
import { db } from '../../../db/supabase.js';
import { quoteBlock, shortDate } from '../../../meetings/rules.js';
import type { DiscordMessageRow } from '../../../types/discord.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { assertChannelVisible, loadViewer, type Viewer } from '../../access.js';
import { loadMessageRow, loadVisibleMessage } from '../../messages.js';
import { messageLink } from '../../reply.js';
import { buildCustomId } from '../custom-id.js';
import { clip, ephemeral, row, stringSelect, updateMessage } from '../respond.js';
import type { HandlerModule, OutgoingMessage } from '../types.js';
import { header, notice, v2Message } from '../v2.js';
import { projectForChannel } from './junta.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_MAX = 120;
/** La cita del cuerpo: el texto completo de un mensaje de Discord cabe (≤ 4000 con Nitro). */
const QUOTE_MAX = 4000;

export interface DecisionSource {
  guildId: string;
  channelId: string;
  channelName: string | null;
  messageId: string;
  authorName: string | null;
  content: string;
  /** ISO del mensaje. */
  createdAt: string;
}

/** Título y cuerpo del átomo. Puro. */
export function decisionAtomFromMessage(src: DecisionSource): { title: string; body: string } {
  const text = src.content.trim();
  const firstLine = text.split('\n').find((l) => l.trim())?.trim() ?? text;
  const title = clip(firstLine.replace(/^[#>*\-\s]+/, '').trim() || firstLine, TITLE_MAX);
  const where = src.channelName ? `Discord, #${src.channelName}` : 'Discord';
  const who = src.authorName ? `, mensaje de ${src.authorName}` : '';
  const body = [
    title,
    '',
    quoteBlock(clip(text, QUOTE_MAX)),
    '',
    `Decidido en ${where} (${shortDate(src.createdAt)})${who}: ${messageLink(src.guildId, src.channelId, src.messageId)}`,
  ].join('\n');
  return { title, body };
}

export function decisionProvenance(messageId: string): string {
  return `discord:${messageId}`;
}

async function tryEmbed(text: string): Promise<number[] | null> {
  if (!config.openai.apiKey) return null;
  try {
    return await embed(text);
  } catch {
    return null;
  }
}

/** Guarda (o reconoce) la decisión en el brain del proyecto. */
export async function saveDiscordDecision(projectId: string, src: DecisionSource): Promise<{ atomId: string; created: boolean }> {
  const { title, body } = decisionAtomFromMessage(src);
  const hash = createHash('sha256').update(`${title}\n${body}`).digest('hex');
  const provenance = decisionProvenance(src.messageId);

  const { data: existing, error: exErr } = await db()
    .from('knowledge_atom')
    .select('id, project_id, provenance')
    .eq('content_hash', hash)
    .eq('status', 'active');
  if (exErr) throw exErr;
  const dup = ((existing ?? []) as { id: string; project_id: string | null; provenance: string[] | null }[]).find(
    (a) => a.project_id === projectId && (a.provenance ?? []).includes(provenance),
  );
  if (dup) return { atomId: dup.id, created: false };

  const vector = await tryEmbed(`${title}\n${body}`);
  const { data, error } = await db()
    .from('knowledge_atom')
    .insert({
      scope: 'project',
      project_id: projectId,
      status: 'active',
      title,
      body,
      provenance: [provenance],
      embedding: vector ? `[${vector.join(',')}]` : null,
      embedding_model: vector ? embeddingModel : null,
      content_hash: hash,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { atomId: (data as { id: string }).id, created: true };
}

function authorOf(row: DiscordMessageRow | null, target: DiscordApiMessage | null): string | null {
  return row?.author_global_name || row?.author_username || target?.author?.global_name || target?.author?.username || null;
}

/**
 * Lo que se guarda, validando que el actor ve el mensaje. Si el mensaje está en el espejo manda el
 * espejo (y su visibilidad); si todavía no llegó al espejo (recién escrito), basta con ver el canal y
 * se usa el mensaje que trajo la interacción.
 */
async function sourceFor(viewer: Viewer, messageId: string, target: DiscordApiMessage | null, channelHint: string | null): Promise<DecisionSource> {
  const mirrored = await loadMessageRow(messageId);
  if (mirrored) {
    const { row, channel } = await loadVisibleMessage(viewer, messageId);
    return {
      guildId: row.guild_id,
      channelId: row.channel_id,
      channelName: channel.name ?? null,
      messageId: row.id,
      authorName: authorOf(row, target),
      content: (target?.content ?? '').trim() || row.content,
      createdAt: row.created_at,
    };
  }
  const channelId = target?.channel_id ?? channelHint;
  if (!target || !channelId) throw new NotFoundError('el mensaje no existe (todavía no llega a roz; intenta en unos segundos)');
  const { channel } = assertChannelVisible(viewer, channelId);
  return {
    guildId: viewer.snap.guildId,
    channelId,
    channelName: channel.name ?? null,
    messageId,
    authorName: authorOf(null, target),
    content: target.content ?? '',
    createdAt: target.timestamp || new Date().toISOString(),
  };
}

async function projectName(projectId: string): Promise<string> {
  const { data, error } = await db().from('project').select('id, name, active').eq('id', projectId).maybeSingle();
  if (error) throw error;
  const p = data as { name: string; active: boolean | null } | null;
  if (!p || p.active === false) throw new NotFoundError('el proyecto no existe');
  return p.name;
}

function savedMessage(name: string, created: boolean): OutgoingMessage {
  return created
    ? notice('ok', `Guardado como decisión en el brain de **${name}**`, 'roz lo usará como contexto del proyecto.')
    : notice('ok', `Ese mensaje ya estaba guardado como decisión en el brain de **${name}**`);
}

export const handlers: HandlerModule = {
  message: {
    decision: {
      defer: 'ephemeral',
      async run(ctx) {
        const viewer = await loadViewer(ctx.actor.devId);
        const src = await sourceFor(viewer, ctx.target.id, ctx.target, ctx.channelId);
        if (!src.content.trim()) throw new ValidationError('ese mensaje no tiene texto que guardar como decisión');

        const parentId = viewer.snap.channelRows.get(src.channelId)?.parent_id ?? null;
        const mapped = await projectForChannel(src.channelId, parentId);
        if (mapped) {
          const name = await projectName(mapped);
          const saved = await saveDiscordDecision(mapped, src);
          ctx.log('discord: decisión guardada', { atomId: saved.atomId, projectId: mapped, created: saved.created });
          return ephemeral(savedMessage(name, saved.created));
        }

        // Canal sin proyecto: que elija. Hasta 25 (tope de Discord), por nombre.
        const { data, error } = await db().from('project').select('id, name, active').eq('active', true);
        if (error) throw error;
        const projects = ((data ?? []) as { id: string; name: string }[]).sort((a, b) => a.name.localeCompare(b.name, 'es'));
        if (!projects.length) return ephemeral(notice('off', 'No hay proyectos activos en roz donde guardar la decisión.'));
        return ephemeral(
          v2Message([
            header(
              'Guardar como decisión',
              `Este canal no está ligado a un proyecto: ¿en el brain de cuál la guardo?${
                projects.length > 25 ? ' Solo caben 25 en la lista; liga el canal a su proyecto en roz → Discord para saltarte este paso.' : ''
              }`,
            ),
            row(
              stringSelect({
                customId: buildCustomId('msg.decision.proyecto', src.channelId, src.messageId),
                placeholder: 'Elige el proyecto',
                options: projects.slice(0, 25).map((p) => ({ label: p.name, value: p.id })),
              }),
            ),
          ]),
        );
      },
    },
  },
  components: {
    'msg.decision.proyecto': {
      defer: 'update',
      async run(ctx) {
        const [channelId, messageId] = ctx.customId.args as [string, string];
        const projectId = ctx.values[0];
        if (!projectId || !UUID_RE.test(projectId)) throw new ValidationError('elige un proyecto de la lista');
        const viewer = await loadViewer(ctx.actor.devId);
        // Sin el mensaje de la interacción: el texto sale del espejo (que además revisa que lo ve).
        const mirrored = await loadMessageRow(messageId);
        if (!mirrored || mirrored.channel_id !== channelId) throw new NotFoundError('el mensaje no existe (todavía no llega a roz; intenta en unos segundos)');
        const src = await sourceFor(viewer, messageId, null, channelId);
        if (!src.content.trim()) throw new ValidationError('ese mensaje no tiene texto que guardar como decisión');
        const name = await projectName(projectId);
        const saved = await saveDiscordDecision(projectId, src);
        ctx.log('discord: decisión guardada', { atomId: saved.atomId, projectId, created: saved.created });
        return updateMessage(savedMessage(name, saved.created));
      },
    },
  },
};
