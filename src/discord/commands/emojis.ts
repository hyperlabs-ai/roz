// Emojis de aplicación de roz (Application Emojis de Discord): íconos de proveedores y de Roz-bot
// dentro del texto de los mensajes (`<:roz_vercel:123…>`). Los sube `npm run discord:emojis`
// (scripts/discord-emojis.ts) desde src/bridge/assets/emojis/. Aquí solo se LEEN:
// GET /applications/{app}/emojis con el token del bot, cacheado en memoria con TTL. Si no existen, no
// hay token o Discord tarda, cada ícono cae a texto plano (cadena vacía): el mensaje sale igual.
import { config } from '../../config.js';
import { discordConfigured, discordRequest } from '../../adapters/discord.js';

/** Nombres que sube el script (y los únicos que se usan en los mensajes). */
export const APP_EMOJI_NAMES = ['roz_vercel', 'roz_railway', 'roz_supabase', 'roz_github', 'roz_linear', 'roz_bot'] as const;
export type AppEmojiName = (typeof APP_EMOJI_NAMES)[number];

/** nombre → markup listo para el texto (`<:roz_vercel:id>`). Vacío = sin íconos. */
export type AppEmojis = ReadonlyMap<string, string>;

const TTL_MS = 10 * 60_000;
/** Si falló, no se reintenta en cada comando. */
const FAIL_TTL_MS = 60_000;
/** Lo máximo que un comando espera por los íconos (el presupuesto de Discord es de 3 s). */
const WAIT_MS = 700;

let cache: { at: number; ttl: number; emojis: AppEmojis } | null = null;
let inflight: Promise<AppEmojis> | null = null;

interface ApiEmoji {
  id: string;
  name: string;
  animated?: boolean;
}

export function emojiMarkup(e: ApiEmoji): string {
  return `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;
}

async function fetchEmojis(): Promise<AppEmojis> {
  const res = await discordRequest<{ items?: ApiEmoji[] } | ApiEmoji[]>({ method: 'GET', path: `/applications/${config.discord.clientId}/emojis` });
  const items = Array.isArray(res) ? res : (res?.items ?? []);
  const out = new Map<string, string>();
  for (const e of items) if (e?.id && e.name) out.set(e.name, emojiMarkup(e));
  return out;
}

/** Emojis de la app (cacheados). Nunca lanza; sin token, sin app o si tarda → mapa vacío. */
export async function appEmojis(now: number = Date.now()): Promise<AppEmojis> {
  if (cache && now - cache.at < cache.ttl) return cache.emojis;
  if (!discordConfigured() || !config.discord.clientId) return new Map();
  inflight ??= fetchEmojis()
    .then((emojis) => {
      cache = { at: Date.now(), ttl: TTL_MS, emojis };
      return emojis;
    })
    .catch(() => {
      const empty: AppEmojis = new Map();
      cache = { at: Date.now(), ttl: FAIL_TTL_MS, emojis: empty };
      return empty;
    })
    .finally(() => {
      inflight = null;
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<AppEmojis>((resolve) => {
    timer = setTimeout(() => resolve(new Map()), WAIT_MS);
  });
  try {
    return await Promise.race([inflight, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Pruebas: vacía la caché. */
export function resetAppEmojis(): void {
  cache = null;
  inflight = null;
}

/** Ícono de un proveedor (`vercel` → `<:roz_vercel:…>`), o '' si no está. */
export function providerIcon(provider: string, emojis: AppEmojis | null | undefined): string {
  return emojis?.get(`roz_${provider.toLowerCase()}`) ?? '';
}

/** Ícono por nombre ('roz_bot', 'roz_github'…), o ''. */
export function icon(name: AppEmojiName, emojis: AppEmojis | null | undefined): string {
  return emojis?.get(name) ?? '';
}

/** "ícono texto" o solo "texto" si no hay ícono. */
export function withIcon(iconMarkup: string, label: string): string {
  return iconMarkup ? `${iconMarkup} ${label}` : label;
}
