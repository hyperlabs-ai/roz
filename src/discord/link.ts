// Cuenta de Discord de cada dev (contrato §B.1 y §B.9): estado del chat para el front, ligar con
// OAuth2 (scope identify, state de un solo uso en roz.oauth_state con provider='discord') y desligar.
//
// El token de OAuth NO se guarda: solo sirve para leer /users/@me y se revoca en seguida. Lo que roz
// necesita después (qué ve el dev) sale del espejo del servidor con el id de usuario.
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { secureEqual } from '../utils/secure-compare.js';
import {
  exchangeOAuthCode,
  fetchOAuthUser,
  getGuildMember,
  guildIconUrl,
  oauthAuthorizeUrl,
  revokeOAuthToken,
  userAvatarUrl,
} from '../adapters/discord.js';
import { consumeOAuthState, createOAuthState } from '../calendar/accounts.js';
import { AppError } from '../utils/errors.js';
import type { DiscordBridgeStateRow, DiscordLinkRow, DiscordLinkView, DiscordStatusView } from '../types/discord.js';
import { discordBotConfigured, discordChatEnabled, discordOAuthConfigured } from './enabled.js';
import { sendDiscordEvent } from './realtime.js';
import { guildId, loadGuildRow, loadLink, loadMember } from './store.js';

/** Texto fijo de "Qué no se puede desde roz" (contrato §B.1 y §F). */
export const DISCORD_LIMITS: readonly string[] = [
  'Los mensajes directos personales de Discord no se ven en roz: Discord no los comparte con bots.',
  'Los canales de voz y escenarios aparecen, pero la voz no está disponible en roz.',
  'Lo que escribes sale con tu nombre y tu foto, pero desde roz (Discord le pone la etiqueta APP); no es tu cuenta de Discord.',
  'Las reacciones se ven pero no se pueden poner desde roz.',
  'Los foros se pueden leer y responder en sus publicaciones, pero las publicaciones nuevas se crean en Discord.',
];

/** Sin latido en este tiempo, el puente se da por caído aunque su fila diga 'ready'. */
export const BRIDGE_STALE_MS = 90_000;

export function linkView(row: DiscordLinkRow): DiscordLinkView {
  return {
    discordUserId: row.discord_user_id,
    username: row.username,
    globalName: row.global_name,
    avatarUrl: userAvatarUrl(row.discord_user_id, row.avatar),
    linkedAt: row.linked_at,
  };
}

export function bridgeHealthy(row: Pick<DiscordBridgeStateRow, 'status' | 'last_heartbeat_at'>, now = Date.now()): boolean {
  if (row.status !== 'ready' && row.status !== 'backfilling') return false;
  if (!row.last_heartbeat_at) return false;
  return now - Date.parse(row.last_heartbeat_at) < BRIDGE_STALE_MS;
}

async function loadBridgeState(): Promise<DiscordBridgeStateRow | null> {
  const { data, error } = await db()
    .from('discord_bridge_state')
    .select('guild_id, status, connected_at, last_ready_at, last_heartbeat_at, last_event_at, bridge_version, last_error, updated_at')
    .eq('guild_id', guildId())
    .maybeSingle();
  if (error) throw error;
  return (data as DiscordBridgeStateRow | null) ?? null;
}

/** GET /status — responde también con el flag apagado (el front decide qué chat montar). */
export async function discordStatus(devId: string): Promise<DiscordStatusView> {
  const base = { maxUploadBytes: config.discord.maxUploadBytes, limits: [...DISCORD_LIMITS] };
  if (!discordChatEnabled()) return { enabled: false, unavailable: 'disabled', link: null, guild: null, bridge: null, ...base };

  const [link, guild, bridge] = await Promise.all([loadLink(devId), loadGuildRow(), loadBridgeState()]);
  let unavailable: DiscordStatusView['unavailable'] = null;
  if (!discordBotConfigured()) unavailable = 'not_configured';
  else if (!link) unavailable = 'not_linked';
  else {
    const member = await loadMember(link.discord_user_id);
    if (!member || member.left_at) unavailable = 'not_member';
  }
  return {
    enabled: true,
    unavailable,
    link: link ? linkView(link) : null,
    guild: guild && !guild.deleted_at ? { id: guild.id, name: guild.name, iconUrl: guildIconUrl(guild.id, guild.icon) } : null,
    bridge: bridge
      ? { status: bridge.status, healthy: bridgeHealthy(bridge), lastHeartbeatAt: bridge.last_heartbeat_at, lastReadyAt: bridge.last_ready_at }
      : null,
    ...base,
  };
}

/**
 * Cookie que ata el `state` al navegador que pidió ligar la cuenta. El state de roz.oauth_state dice
 * QUÉ dev es, pero no que quien vuelve de Discord sea ese mismo navegador: sin esta cookie, un dev
 * podría mandar su URL de autorización a otra persona y, si esta aceptaba, su cuenta de Discord
 * quedaba ligada al dev del atacante (que vería en roz los canales de la víctima).
 * SameSite=Lax: viaja en la navegación de vuelta desde Discord (GET de nivel superior).
 */
export const DISCORD_OAUTH_COOKIE = 'roz_discord_oauth';
const OAUTH_COOKIE_PATH = '/api/discord';
const OAUTH_COOKIE_MAX_AGE_S = 15 * 60;

export function bindOAuthStateCookie(c: Context, state: string): void {
  if (!state) return;
  setCookie(c, DISCORD_OAUTH_COOKIE, state, {
    path: OAUTH_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    maxAge: OAUTH_COOKIE_MAX_AGE_S,
  });
}

/** Lee y borra la cookie (un solo uso, como el state). */
export function takeOAuthStateCookie(c: Context): string | null {
  const value = getCookie(c, DISCORD_OAUTH_COOKIE) ?? null;
  if (value !== null) deleteCookie(c, DISCORD_OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH });
  return value;
}

/** POST /link/start → URL de autorización de Discord con un state de un solo uso. */
export async function startDiscordLink(devId: string, authUserId: string | null): Promise<{ url: string }> {
  if (!discordOAuthConfigured()) throw new AppError('DISCORD_OAUTH_NOT_CONFIGURED', 'Falta configurar la app de Discord (OAuth2).', 503);
  const state = await createOAuthState(devId, authUserId, 'discord');
  return { url: oauthAuthorizeUrl(state) };
}

export type LinkOutcome = 'ok' | 'denied' | 'state' | 'taken' | 'not_member' | 'error';

/** Vuelta a Configuración con el desenlace (relativa, como el callback del calendario). */
export function linkRedirect(outcome: LinkOutcome): string {
  return `/app/settings?discord=${outcome}`;
}

type Log = (msg: string, extra?: Record<string, unknown>) => void;

/**
 * GET /api/discord/callback (contrato §B.9). Devuelve el desenlace; la ruta solo redirige. Nada del
 * error real viaja en la URL.
 */
export async function completeDiscordLink(
  query: { code?: string; state?: string; error?: string; cookieState?: string | null },
  log?: Log,
): Promise<LinkOutcome> {
  if (!discordChatEnabled() || !discordOAuthConfigured()) return 'error';
  if (query.error) return 'denied';
  if (!query.code || !query.state) return 'state';
  // El state tiene que volver al MISMO navegador que lo pidió (cookie de /link/start).
  if (!query.cookieState || !secureEqual(query.cookieState, query.state)) {
    log?.('discord: state de OAuth sin la cookie de este navegador', {});
    return 'state';
  }

  const claimed = await consumeOAuthState(query.state, 'discord');
  if (!claimed.ok || !claimed.row) {
    log?.('discord: state de OAuth rechazado', { reason: claimed.reason });
    return 'state';
  }
  const devId = claimed.row.dev_id;

  try {
    const token = await exchangeOAuthCode(query.code);
    const user = await fetchOAuthUser(token.accessToken);
    await revokeOAuthToken(token.accessToken).catch(() => {});

    // Una cuenta de Discord liga a UN dev: no se roba el vínculo de otro.
    const { data: other } = await db().from('discord_link').select('dev_id').eq('discord_user_id', user.id).maybeSingle();
    const owner = (other as { dev_id: string } | null)?.dev_id;
    if (owner && owner.toLowerCase() !== devId.toLowerCase()) return 'taken';

    const now = new Date().toISOString();
    const { error } = await db()
      .from('discord_link')
      .upsert(
        {
          dev_id: devId,
          discord_user_id: user.id,
          username: user.username,
          global_name: user.global_name ?? null,
          avatar: user.avatar ?? null,
          linked_at: now,
          updated_at: now,
        },
        { onConflict: 'dev_id' },
      );
    if (error) throw error;

    // Solo para el mensaje: el vínculo queda aunque no sea miembro (verá "tu cuenta no está en el servidor").
    let member = true;
    try {
      member = !!(await getGuildMember(user.id));
    } catch {
      member = true; // sin poder confirmarlo, no se asusta al dev
    }
    await sendDiscordEvent([devId], 'discord.link.changed', { linked: true }).catch(() => {});
    return member ? 'ok' : 'not_member';
  } catch (err) {
    log?.('discord: no se pudo completar el OAuth', { devId, error: err instanceof Error ? err.message : String(err) });
    return 'error';
  }
}

/** DELETE /link */
export async function unlinkDiscord(devId: string): Promise<void> {
  const { error } = await db().from('discord_link').delete().eq('dev_id', devId);
  if (error) throw error;
  await sendDiscordEvent([devId], 'discord.link.changed', { linked: false }).catch(() => {});
}
