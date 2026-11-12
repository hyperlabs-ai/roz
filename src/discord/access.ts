// Quién es el dev en Discord y qué puede ver/hacer (contrato §B.0). Toda ruta de
// /api/dashboard/discord/* que toca un canal pasa por aquí: el dev sale SIEMPRE de la sesión, y lo
// que no puede ver responde 404 (no se confirma ni que exista), como el chat interno.
import { AppError, NotFoundError } from '../utils/errors.js';
import type { DiscordChannelRow, DiscordLinkRow, DiscordMemberRow } from '../types/discord.js';
import { channelAbilities, type ChannelAbilities, type PermissionContext } from './permissions.js';
import { contextFor, loadLink, loadMember, loadSnapshot, type GuildSnapshot } from './store.js';

export const DISCORD_NOT_LINKED = 'DISCORD_NOT_LINKED';
export const DISCORD_NOT_MEMBER = 'DISCORD_NOT_MEMBER';

export interface Viewer {
  devId: string;
  link: DiscordLinkRow;
  member: DiscordMemberRow;
  snap: GuildSnapshot;
  ctx: PermissionContext;
}

export function notLinkedError(): AppError {
  return new AppError(DISCORD_NOT_LINKED, 'Liga tu cuenta de Discord para ver los canales.', 403);
}

export function notMemberError(): AppError {
  return new AppError(DISCORD_NOT_MEMBER, 'Tu cuenta de Discord no está en el servidor de la empresa.', 403);
}

/** Contexto del dev: vínculo + miembro activo + snapshot del servidor. */
export async function loadViewer(devId: string, snap?: GuildSnapshot): Promise<Viewer> {
  const link = await loadLink(devId);
  if (!link) throw notLinkedError();
  const s = snap ?? (await loadSnapshot());
  const member = await loadMember(link.discord_user_id, s.guildId);
  if (!member || member.left_at) throw notMemberError();
  return { devId, link, member, snap: s, ctx: contextFor(s, member) };
}

export function abilitiesIn(viewer: Viewer, channelId: string): ChannelAbilities {
  return channelAbilities(viewer.ctx, channelId);
}

/** Canal/hilo vigente y visible para el dev, o 404. */
export function assertChannelVisible(viewer: Viewer, channelId: string): { channel: DiscordChannelRow; abilities: ChannelAbilities } {
  const channel = viewer.snap.channelRows.get(channelId);
  if (!channel || channel.deleted_at) throw new NotFoundError('el canal no existe');
  const abilities = abilitiesIn(viewer, channelId);
  if (!abilities.view) throw new NotFoundError('el canal no existe');
  return { channel, abilities };
}
