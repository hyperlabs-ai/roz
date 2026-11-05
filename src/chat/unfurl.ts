// Previews de links del chat ("unfurl", como Slack). Después de enviar o editar un mensaje, el
// backend busca sus links y arma una tarjeta por cada uno (máx. MAX_PREVIEWS): título, descripción,
// imagen y, para YouTube/Vimeo, el id del video para reproducirlo en línea.
//
// Se hace en el SERVIDOR y se guarda en el mensaje (chat_message.link_previews): todos ven la misma
// tarjeta, se calcula una vez y el navegador de nadie le pega a URLs arbitrarias.
//
// Fuentes, en orden:
//   1. oEmbed público (sin token) de YouTube, Vimeo, TikTok, X/Twitter y Spotify.
//   2. Open Graph / Twitter Cards del HTML de la página (cualquier otro sitio).
// Instagram y Facebook exigen un token de app de Meta para oEmbed: sin él solo se obtiene lo que
// expongan por Open Graph (a veces nada más que el título).
//
// Seguridad (SSRF): una URL la escribe cualquier miembro, y el servidor la visita. `safeFetchHtml`
// solo sale a http(s) en 80/443, resuelve el DNS y rechaza IPs privadas / loopback / link-local
// (p. ej. 169.254.169.254, metadata de la nube), revalida cada redirección, corta a los 5 s y lee
// como máximo 512 KB de HTML. Riesgo residual conocido: DNS rebinding (fetch vuelve a resolver el
// nombre después de la revisión). Aceptable aquí: solo miembros del equipo escriben links, y la
// respuesta nunca se devuelve cruda — solo título/descripción/imagen.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface LinkPreview {
  url: string;
  kind: 'video' | 'post' | 'link';
  /** Plataforma reconocida ('YouTube', 'X', 'TikTok'…) o null para un sitio cualquiera. */
  provider: string | null;
  siteName: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  icon: string | null;
  author: string | null;
  /** Reproducible en línea. */
  embed: { type: 'youtube' | 'vimeo' | 'tiktok'; id: string } | null;
}

export const MAX_PREVIEWS = 3;
const TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const UA = 'Mozilla/5.0 (compatible; rozbot/1.0; +link preview)';

// ---- Links del mensaje ----

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/** Quita la puntuación final y los cierres sin pareja: "(ver https://x.com/a)." → "https://x.com/a",
 *  pero "https://es.wikipedia.org/wiki/Foo_(bar)" se conserva entero. */
function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?*_~]+$/, '');
  for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
    while (url.endsWith(close) && url.split(open).length < url.split(close).length) url = url.slice(0, -1);
  }
  return url.replace(/[.,;:!?*_~]+$/, '');
}

/** Links http(s) del cuerpo, sin repetir, en orden, fuera de bloques y spans de código. */
export function extractUrls(body: string, max = MAX_PREVIEWS): string[] {
  const text = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    if (!out.includes(url)) out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

// ---- Plataformas ----

const hostOf = (u: URL) => u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');

/** Id de 11 caracteres de un video de YouTube (watch, youtu.be, shorts, embed, live). */
export function youtubeId(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = hostOf(u);
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
      id = m?.[1] ?? null;
    }
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

export function vimeoId(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (hostOf(u) !== 'vimeo.com') return null;
    const m = /^\/(?:video\/)?(\d{6,12})(?:\/|$)/.exec(u.pathname);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

interface OEmbedProvider {
  name: string;
  kind: LinkPreview['kind'];
  test: (u: URL) => boolean;
  endpoint: (url: string) => string;
}

const OEMBED: OEmbedProvider[] = [
  {
    name: 'YouTube',
    kind: 'video',
    test: (u) => !!youtubeId(u.toString()),
    endpoint: (url) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
  },
  {
    name: 'Vimeo',
    kind: 'video',
    test: (u) => !!vimeoId(u.toString()),
    endpoint: (url) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`,
  },
  {
    name: 'TikTok',
    kind: 'video',
    // También los cortos (vm.tiktok.com/ZM…): el oEmbed los resuelve.
    test: (u) => hostOf(u).endsWith('tiktok.com'),
    endpoint: (url) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
  },
  {
    name: 'X',
    kind: 'post',
    test: (u) => ['x.com', 'twitter.com'].includes(hostOf(u)) && /\/status\/\d+/.test(u.pathname),
    // publish.twitter.com redirige aquí (301): se pide directo.
    endpoint: (url) =>
      `https://publish.x.com/oembed?omit_script=1&dnt=1&url=${encodeURIComponent(url.replace(/\/\/(www\.|mobile\.)?twitter\.com\//, '//x.com/'))}`,
  },
  {
    name: 'Spotify',
    kind: 'link',
    test: (u) => hostOf(u) === 'open.spotify.com',
    endpoint: (url) => `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
  },
];

interface OEmbed {
  title?: string;
  author_name?: string;
  provider_name?: string;
  thumbnail_url?: string;
  html?: string;
}

/** Id del video de TikTok: del reproductor que trae el oEmbed (`/player/v1/<id>`, sirve también
 *  para los links cortos vm.tiktok.com) o de la URL (`/video/<id>`). */
export function tiktokId(url: string, html?: string): string | null {
  const fromHtml = html ? /\/player\/v1\/(\d{8,25})/.exec(html)?.[1] : null;
  return fromHtml ?? /\/video\/(\d{8,25})/.exec(url)?.[1] ?? null;
}

/** Texto del post dentro del blockquote que devuelve el oEmbed de X. */
export function tweetText(html: string): string | null {
  const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1];
  if (!p) return null;
  const text = decodeEntities(p.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
  return text || null;
}

async function fromOEmbed(url: string, provider: OEmbedProvider): Promise<LinkPreview | null> {
  // Endpoints fijos y conocidos: no hace falta la guarda SSRF, sí el timeout.
  const res = await fetch(provider.endpoint(url), { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': UA } });
  if (!res.ok) return null;
  const o = (await res.json()) as OEmbed;
  const isPost = provider.kind === 'post';
  const yt = provider.name === 'YouTube' ? youtubeId(url) : null;
  const vm = provider.name === 'Vimeo' ? vimeoId(url) : null;
  const tt = provider.name === 'TikTok' ? tiktokId(url, o.html) : null;
  const embed: LinkPreview['embed'] = yt ? { type: 'youtube', id: yt } : vm ? { type: 'vimeo', id: vm } : tt ? { type: 'tiktok', id: tt } : null;
  const description = isPost && o.html ? tweetText(o.html) : null;
  // Un oEmbed sin nada útil (TikTok ya casi no manda título) no gana a Open Graph… salvo que traiga
  // el reproductor.
  if (!o.title && !o.thumbnail_url && !description && !embed) return null;
  return {
    url,
    kind: provider.kind,
    provider: provider.name,
    siteName: o.provider_name ?? provider.name,
    title: clip(isPost ? o.author_name : o.title, 200),
    description: clip(description, 400),
    image: safeHttpUrl(o.thumbnail_url ?? (yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : null)),
    icon: null,
    author: clip(o.author_name, 120),
    embed,
  };
}

// ---- HTML → Open Graph ----

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', reg: '®', trade: '™',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', iquest: '¿', iexcl: '¡',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return NAMED[code] ?? NAMED[code.toLowerCase()] ?? whole;
  });
}

function clip(s: string | null | undefined, max: number): string | null {
  const t = s?.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function safeHttpUrl(raw: string | null | undefined, base?: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** Tarjeta a partir del HTML de la página. null si no hay ni título ni descripción. */
export function parseOpenGraph(html: string, pageUrl: string): LinkPreview | null {
  const end = html.search(/<\/head>/i);
  const head = end > 0 ? html.slice(0, end) : html.slice(0, 200_000);

  const meta = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
    if (key && a.content && !meta.has(key)) meta.set(key, a.content);
  }
  const first = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v && v.trim()) ?? null;

  let icon: string | null = null;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
    if (a.href && (rel.includes('icon') || rel.includes('apple-touch-icon'))) {
      icon = safeHttpUrl(a.href, pageUrl);
      if (rel.includes('icon')) break;
    }
  }

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = clip(first('og:title', 'twitter:title') ?? (titleTag ? decodeEntities(titleTag) : null), 200);
  const description = clip(first('og:description', 'twitter:description', 'description'), 300);
  if (!title && !description) return null;

  let host = '';
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    /* noop */
  }
  return {
    url: pageUrl,
    kind: 'link',
    provider: null,
    siteName: clip(first('og:site_name', 'application-name') ?? host, 80),
    title,
    description,
    image: safeHttpUrl(first('og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src'), pageUrl),
    icon: icon ?? safeHttpUrl('/favicon.ico', pageUrl),
    author: clip(first('author', 'article:author'), 120),
    embed: null,
  };
}

// ---- Fetch seguro (SSRF) ----

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

/** ¿La IP es privada, loopback, link-local, reservada o multicast? (v4 y v6, incl. v4 mapeada). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const n = v4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (s === '::' || s === '::1') return true;
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8:');
  }
  return true; // no es una IP: por seguridad, no se visita
}

async function assertPublicUrl(u: URL): Promise<void> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocolo no permitido');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('puerto no permitido');
  if (u.username || u.password) throw new Error('URL con credenciales');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host)) throw new Error('host interno');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('host privado');
}

async function readLimited(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const buf = Buffer.concat(chunks).subarray(0, limit);
  const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** GET de una página HTML con las guardas de arriba. null si no se pudo o no es HTML. */
export async function safeFetchHtml(raw: string): Promise<{ url: string; html: string } | null> {
  let current = new URL(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'es-MX,es;q=0.9,en;q=0.8' },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) return null;
      current = new URL(location, current);
      continue;
    }
    if (!res.ok || !/text\/html|application\/xhtml\+xml/i.test(res.headers.get('content-type') ?? '')) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return { url: current.toString(), html: await readLimited(res, MAX_HTML_BYTES) };
  }
  return null;
}

// ---- Orquestación ----

/** Tarjeta de UN link. Nunca lanza: un link que no se puede leer simplemente no tiene tarjeta. */
export async function unfurlUrl(url: string): Promise<LinkPreview | null> {
  try {
    const u = new URL(url);
    const provider = OEMBED.find((p) => p.test(u));
    if (provider) {
      const viaOEmbed = await fromOEmbed(url, provider).catch(() => null);
      if (viaOEmbed) return viaOEmbed;
    }
    const page = await safeFetchHtml(url);
    if (!page) return null;
    const og = parseOpenGraph(page.html, page.url);
    if (!og) return null;
    // La URL que se muestra es la que escribió la persona, no la final tras redirecciones.
    const yt = youtubeId(url);
    return { ...og, url, provider: provider?.name ?? null, embed: yt ? { type: 'youtube', id: yt } : og.embed };
  } catch {
    return null;
  }
}

/** Tarjetas de los links de un mensaje (en paralelo). `skipHosts`: dominios propios de roz. */
export async function unfurlBody(body: string, opts: { skipHosts?: string[] } = {}): Promise<LinkPreview[]> {
  const skip = new Set((opts.skipHosts ?? []).map((h) => h.toLowerCase()));
  const urls = extractUrls(body).filter((url) => {
    try {
      return !skip.has(new URL(url).hostname.toLowerCase());
    } catch {
      return false;
    }
  });
  if (!urls.length) return [];
  const cards = await Promise.all(urls.map((u) => unfurlUrl(u)));
  return cards.filter((c): c is LinkPreview => !!c);
}
