// Errores de Discord (DiscordError del adaptador) → AppError con los códigos del contrato (§B.4).
// El mensaje nunca lleva el detalle crudo de Discord: puede traer nombres de canal o ids que no
// aportan nada al dev y sí ruido; el log del servidor conserva el error original.
import { DISCORD_ERROR, isDiscordError } from '../adapters/discord.js';
import { AppError } from '../utils/errors.js';

export const DISCORD_UNAVAILABLE = 'DISCORD_UNAVAILABLE';
export const DISCORD_UPLOAD_TOO_LARGE = 'DISCORD_UPLOAD_TOO_LARGE';
export const DISCORD_THREAD_LOCKED = 'DISCORD_THREAD_LOCKED';
export const DISCORD_BOT_PERMISSIONS = 'DISCORD_BOT_PERMISSIONS';
export const DISCORD_CANNOT_SEND = 'DISCORD_CANNOT_SEND';
export const DISCORD_CHANNEL_UNSUPPORTED = 'DISCORD_CHANNEL_UNSUPPORTED';
export const DISCORD_NOT_OWN_MESSAGE = 'DISCORD_NOT_OWN_MESSAGE';
export const DISCORD_ERROR_CODE = 'DISCORD_ERROR';

/** Traduce cualquier error de una llamada a Discord. Lo que no es DiscordError pasa intacto. */
export function mapDiscordError(err: unknown): unknown {
  if (err instanceof AppError || !isDiscordError(err)) return err;
  if (err.retryable) {
    return new AppError(DISCORD_UNAVAILABLE, 'Discord no responde ahora; intenta de nuevo en un momento.', 503, {
      retryAfterSec: err.retryAfterSec,
    });
  }
  if (err.code === DISCORD_ERROR.ENTITY_TOO_LARGE || err.status === 413) {
    return new AppError(DISCORD_UPLOAD_TOO_LARGE, 'Discord rechazó el archivo por tamaño.', 413);
  }
  if (err.code === DISCORD_ERROR.THREAD_ARCHIVED) {
    return new AppError(DISCORD_THREAD_LOCKED, 'El hilo está archivado o bloqueado.', 409);
  }
  if (err.code === DISCORD_ERROR.MISSING_PERMISSIONS || err.code === DISCORD_ERROR.MISSING_ACCESS) {
    return new AppError(DISCORD_BOT_PERMISSIONS, 'El bot de roz no tiene permiso para esto en este canal (Manage Webhooks / Send Messages).', 502);
  }
  return new AppError(DISCORD_ERROR_CODE, 'Discord rechazó la operación.', 502, { discordCode: err.code, status: err.status });
}
