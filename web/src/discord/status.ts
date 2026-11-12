import { ApiError, discordApi, type DiscordStatusView } from '@/lib/api';

/** Caché compartida de `/discord/status` (página del chat y Configuración). */
export const DISCORD_STATUS_KEY = '/discord/status';

const OFF: DiscordStatusView = {
  enabled: false, unavailable: 'disabled', link: null, guild: null, bridge: null, maxUploadBytes: 0, limits: [],
};

/**
 * `GET /discord/status`. Responde también con el flag apagado (`enabled: false`); un 404 solo puede
 * venir de un backend sin la ruta (deploy anterior al chat de Discord) y se trata igual: flag apagado.
 */
export async function discordStatusOrOff(): Promise<DiscordStatusView> {
  try {
    return await discordApi.status();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return OFF;
    throw e;
  }
}
