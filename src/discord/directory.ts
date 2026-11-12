// Miembros, emojis y roles para el compositor y para pintar menciones (contrato §B.8). Lectura del
// espejo; nada pega a Discord.
import { db } from '../db/supabase.js';
import { emojiUrl, memberAvatarUrl, userAvatarUrl } from '../adapters/discord.js';
import type { DiscordEmojiRow, DiscordEmojiView, DiscordMemberRow, DiscordMemberView, DiscordRoleView } from '../types/discord.js';
import { MEMBER_COLUMNS, guildId, loadAllLinks, selectIn } from './store.js';
import { githubAvatar } from './views.js';

const MAX_MEMBERS = 50;

function fold(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** ¿El miembro calza con la búsqueda? Busca en apodo, nombre global, usuario y el nombre del dev ligado. Puro. */
export function memberMatches(m: Pick<DiscordMemberRow, 'nick' | 'global_name' | 'username'>, devName: string | null, query: string): boolean {
  const q = fold(query).trim();
  if (!q) return true;
  return [m.nick, m.global_name, m.username, devName].some((v) => fold(v).includes(q));
}

export async function searchMembers(query: string, limit = 20): Promise<DiscordMemberView[]> {
  const { data, error } = await db().from('discord_member').select(MEMBER_COLUMNS).eq('guild_id', guildId()).is('left_at', null);
  if (error) throw error;
  const members = (data ?? []) as DiscordMemberRow[];
  const links = await loadAllLinks();
  const devByUser = new Map(links.map((l) => [l.discord_user_id, l.dev_id]));
  const devs = new Map(
    (await selectIn<{ id: string; name: string; github_login: string | null }>('dev', 'id, name, github_login', 'id', links.map((l) => l.dev_id))).map(
      (d) => [d.id, d],
    ),
  );
  const max = Math.min(Math.max(Math.trunc(limit) || 20, 1), MAX_MEMBERS);
  return members
    .map((m) => {
      const devId = devByUser.get(m.user_id) ?? null;
      const dev = devId ? devs.get(devId) : undefined;
      return { m, devId, dev };
    })
    .filter(({ m, dev }) => memberMatches(m, dev?.name ?? null, query))
    .sort((a, b) => Number(a.m.bot) - Number(b.m.bot) || fold(a.m.nick ?? a.m.global_name ?? a.m.username).localeCompare(fold(b.m.nick ?? b.m.global_name ?? b.m.username)))
    .slice(0, max)
    .map(({ m, devId, dev }) => ({
      discordUserId: m.user_id,
      displayName: m.nick ?? m.global_name ?? m.username,
      username: m.username,
      avatarUrl: m.guild_avatar
        ? memberAvatarUrl(m.guild_id, m.user_id, m.guild_avatar)
        : githubAvatar(dev?.github_login) ?? userAvatarUrl(m.user_id, m.avatar),
      bot: m.bot,
      devId,
    }));
}

export async function listEmojis(): Promise<DiscordEmojiView[]> {
  const { data, error } = await db()
    .from('discord_emoji')
    .select('id, guild_id, name, animated, available, roles, created_at, updated_at, deleted_at')
    .eq('guild_id', guildId())
    .is('deleted_at', null);
  if (error) throw error;
  return ((data ?? []) as DiscordEmojiRow[])
    .filter((e) => e.available)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ id: e.id, name: e.name, animated: e.animated, url: emojiUrl(e.id, e.animated) }));
}

export async function listRoles(): Promise<DiscordRoleView[]> {
  const { data, error } = await db()
    .from('discord_role')
    .select('id, name, color, position')
    .eq('guild_id', guildId())
    .is('deleted_at', null);
  if (error) throw error;
  return ((data ?? []) as DiscordRoleView[]).sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position }));
}
