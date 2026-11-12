// Enlaces a roz desde Discord (botón "Abrir", url de los embeds, miniaturas de Roz-bot). Solo con una
// URL PÚBLICA (config.dashboard.url): un enlace a localhost en un canal de Discord no le sirve a
// nadie, y Discord no puede descargar una miniatura de localhost. En local se omiten.
import { config } from '../../config.js';

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$|\.local$|\.internal$/i;

/** Base pública de roz (sin barra final) o null si no hay/no es pública. */
export function publicBaseUrl(raw: string = config.dashboard.url): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (PRIVATE_HOST.test(url.hostname)) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Enlace a una ruta del SPA (`/app/tasks?task=…`) o null sin URL pública. */
export function appLink(path: string, base: string | null = publicBaseUrl()): string | null {
  if (!base) return null;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Expresión de Roz-bot según la situación. */
export type RozMood = 'happy' | 'thinking' | 'alert';

/** PNG de Roz-bot (web/public/brand). Sin expresión → el avatar normal. null sin URL pública. */
export function rozBotImage(mood: RozMood | null = null, base: string | null = publicBaseUrl()): string | null {
  return appLink(`/brand/roz-bot${mood ? `-${mood}` : ''}.png`, base);
}
