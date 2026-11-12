// Aviso de /ticket al responsable con ROZ_DISCORD_CHAT encendido (contrato §B.11). Reemplaza el DM
// interno de src/tickets/smart.ts:
//   1. canal del proyecto (roz.discord_project_channel) que el responsable VE → mensaje del BOT
//      mencionándolo;
//   2. sin canal (o el canal ya no existe, o el responsable no lo ve) → DM del bot al responsable;
//   3. responsable sin cuenta ligada → no hay aviso por Discord (se registra; la tarea queda igual).
// Nunca lanza: un aviso fallido no debe deshacer ni ensuciar la creación del ticket.
import { db } from '../db/supabase.js';
import { discordAssignedLine } from '../notify/copy.js';
import { DISCORD_ERROR, buildAllowedMentions, createDmChannel, isDiscordError, sendBotMessage } from '../adapters/discord.js';
import { TEXT_CHANNEL_TYPES } from '../types/discord.js';
import { discordBotConfigured } from './enabled.js';
import { canViewChannel } from './permissions.js';
import { contextFor, loadMember, loadSnapshot } from './store.js';

export interface TicketDiscordNotice {
  /** roz.dev.id del responsable. */
  assigneeDevId: string;
  projectId: string;
  /** HYP-45 / ROZ-123. */
  identifier: string;
  title: string;
}

export type TicketDiscordOutcome =
  | 'channel'        // se publicó en el canal del proyecto
  | 'dm'             // se mandó por DM del bot
  | 'not_linked'     // el responsable no ligó su cuenta
  | 'cannot_dm'      // tiene los DMs cerrados al bot
  | 'not_configured' // sin bot
  | 'error';

export interface TicketDiscordResult {
  messageSent: boolean;
  via: TicketDiscordOutcome;
  /** Canal (o DM) donde quedó el aviso, si se mandó. */
  channelId: string | null;
  messageId: string | null;
}

const MAX_TITLE = 180;

/** Texto del aviso. Puro: el título se acorta y se le quitan menciones/backticks que romperían el formato. */
export function ticketNoticeContent(discordUserId: string, identifier: string, title: string): string {
  const clean = title
    .replace(/[`]/g, "'")
    .replace(/<[@#][!&]?\d+>/g, '')
    .replace(/@(everyone|here)/gi, '@​$1')
    .replace(/\s+/g, ' ')
    .trim();
  const short = clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1).trimEnd()}…` : clean;
  // Habla Roz-bot, en primera persona. La redacción (determinística por tarea) vive en notify/copy.ts.
  return `<@${discordUserId}> ${discordAssignedLine({ seed: identifier, identifier, title: short })}`;
}

type Log = (msg: string, extra?: Record<string, unknown>) => void;

/** ¿El usuario de Discord ve el canal? Mismo algoritmo de permisos que el chat. */
async function assigneeSees(discordUserId: string, channelId: string): Promise<boolean> {
  const snap = await loadSnapshot();
  const member = await loadMember(discordUserId, snap.guildId);
  if (!member || member.left_at) return false;
  return canViewChannel(contextFor(snap, member), channelId);
}

export async function notifyTicketAssigneeOnDiscord(input: TicketDiscordNotice, log?: Log): Promise<TicketDiscordResult> {
  const none = (via: TicketDiscordOutcome): TicketDiscordResult => ({ messageSent: false, via, channelId: null, messageId: null });
  if (!discordBotConfigured()) return none('not_configured');
  try {
    const { data: link } = await db().from('discord_link').select('discord_user_id').eq('dev_id', input.assigneeDevId).maybeSingle();
    const userId = (link as { discord_user_id: string } | null)?.discord_user_id;
    if (!userId) {
      log?.('ticket: el responsable no ligó su cuenta de Discord; sin aviso', { identifier: input.identifier });
      return none('not_linked');
    }
    const content = ticketNoticeContent(userId, input.identifier, input.title);
    const allowedMentions = buildAllowedMentions([userId]);

    const { data: map } = await db().from('discord_project_channel').select('channel_id').eq('project_id', input.projectId).maybeSingle();
    const mapped = (map as { channel_id: string } | null)?.channel_id;
    if (mapped) {
      const { data: ch } = await db().from('discord_channel').select('id, type, deleted_at').eq('id', mapped).maybeSingle();
      const channel = ch as { id: string; type: number; deleted_at: string | null } | null;
      // Solo si el responsable VE ese canal en Discord: mencionarlo en un canal privado al que no
      // tiene acceso no le avisa de nada (y el aviso se perdería). Si no lo ve, va por DM.
      if (channel && !channel.deleted_at && TEXT_CHANNEL_TYPES.has(channel.type) && (await assigneeSees(userId, channel.id))) {
        try {
          const msg = await sendBotMessage(channel.id, { content, allowedMentions });
          return { messageSent: true, via: 'channel', channelId: channel.id, messageId: msg.id };
        } catch (err) {
          // Canal inaccesible para el bot: se intenta por DM antes de rendirse.
          log?.('ticket: no se pudo publicar en el canal del proyecto; se intenta por DM', {
            identifier: input.identifier,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    try {
      const dm = await createDmChannel(userId);
      const msg = await sendBotMessage(dm.id, { content, allowedMentions });
      return { messageSent: true, via: 'dm', channelId: dm.id, messageId: msg.id };
    } catch (err) {
      if (isDiscordError(err, DISCORD_ERROR.CANNOT_DM_USER)) {
        log?.('ticket: el responsable tiene los DMs cerrados al bot', { identifier: input.identifier });
        return none('cannot_dm');
      }
      throw err;
    }
  } catch (err) {
    log?.('ticket: no se pudo avisar por Discord', { identifier: input.identifier, error: err instanceof Error ? err.message : String(err) });
    return none('error');
  }
}
