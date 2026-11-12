// ¿El chat de roz es Discord? (ROZ_DISCORD_CHAT). Depende SOLO de configuración, nunca de fallos en
// caliente: si el puente se cae, el chat de Discord se muestra "sin conexión" — no cae en silencio
// al chat interno, donde lo escrito no llegaría a nadie. Va en su propio módulo (como
// src/linear/enabled.ts) para que rutas, tickets y MCP lo consulten sin importar el cliente REST.
import { config } from '../config.js';
import { AppError } from '../utils/errors.js';

/** Flag encendido. config.ts ya garantiza que, si lo está, todas las llaves necesarias existen. */
export function discordChatEnabled(): boolean {
  return config.discord.chatEnabled;
}

/** Hay bot y servidor (lo mínimo para hablar con Discord), con o sin flag. */
export function discordBotConfigured(): boolean {
  return config.discord.botToken !== '' && config.discord.guildId !== '';
}

/** Hay app de OAuth2 para ligar cuentas. */
export function discordOAuthConfigured(): boolean {
  return config.discord.clientId !== '' && config.discord.clientSecret !== '' && config.discord.oauthRedirectUri !== '';
}

/** Código del error de las rutas de Discord con el flag apagado. */
export const DISCORD_CHAT_DISABLED_CODE = 'DISCORD_CHAT_DISABLED';
/** Código del error de las rutas del chat INTERNO con el flag encendido. */
export const INTERNAL_CHAT_REPLACED_CODE = 'CHAT_REPLACED_BY_DISCORD';

/** Guardia de /api/dashboard/discord/*: con el flag apagado esas rutas no existen (404). */
export function assertDiscordChat(): void {
  if (discordChatEnabled()) return;
  throw new AppError(DISCORD_CHAT_DISABLED_CODE, 'El chat de Discord no está activado en este servidor.', 404);
}

/**
 * Guardia de las ESCRITURAS del chat interno (/api/dashboard/chat/*) con el flag encendido: lo que
 * se escribiera ahí no lo vería nadie en Discord. Las lecturas siguen permitidas (historial).
 */
export function assertInternalChatWritable(): void {
  if (!discordChatEnabled()) return;
  throw new AppError(
    INTERNAL_CHAT_REPLACED_CODE,
    'El chat de roz ahora es el servidor de Discord: escribe desde la sección Chat.',
    409,
  );
}
