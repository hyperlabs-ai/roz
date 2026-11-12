// Verificación de citas: lo que Claude dice que se dijo en la junta TIENE que estar en el texto. Es
// la defensa contra candidatas inventadas: una tarea sin cita literal verificada no se guarda.
// PURO (sin base ni red).
//
// Se compara sobre una forma normalizada de los dos lados — minúsculas, sin acentos, espacios
// colapsados, comillas tipográficas → rectas, guiones largos → '-', '…' → '...' — porque Claude
// "limpia" sin querer esos detalles al citar, y ninguno cambia lo que se dijo. Nada más: ni
// sinónimos ni palabras sueltas; una paráfrasis NO pasa.
//
// La posición que se devuelve (quote_start) es la del texto GUARDADO (sin normalizar), para que la
// bandeja pueda resaltar la cita en la transcripción tal cual se ve.

/** Una cita más corta que esto (normalizada) no prueba nada ("sí", "ok, va"). */
export const MIN_QUOTE_CHARS = 12;

const SINGLE_QUOTES = /[‘’‚‛′´`]/;
const DOUBLE_QUOTES = /[“”„‟″«»]/;
const DASHES = /[‐‑‒–—―−]/;

/** Forma normalizada de un carácter (puede ser vacía: un acento combinante desaparece). */
function normChar(ch: string): string {
  if (/\s/.test(ch)) return ' ';
  if (SINGLE_QUOTES.test(ch)) return "'";
  if (DOUBLE_QUOTES.test(ch)) return '"';
  if (DASHES.test(ch)) return '-';
  if (ch === '…') return '...';
  return ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export interface NormalizedText {
  text: string;
  /** map[i] = índice en el texto original del carácter i del texto normalizado. */
  map: number[];
}

/** Normaliza conservando, para cada carácter de salida, su posición en el original. */
export function normalizeWithMap(s: string): NormalizedText {
  let text = '';
  const map: number[] = [];
  // Iterar por puntos de código (no por unidades UTF-16) para no partir emojis.
  let i = 0;
  for (const ch of s) {
    const n = normChar(ch);
    for (const c of n) {
      if (c === ' ' && (text === '' || text.endsWith(' '))) continue;
      text += c;
      map.push(i);
    }
    i += ch.length;
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

export function normalizeForMatch(s: string): string {
  return normalizeWithMap(s).text;
}

/**
 * La cita como la mandó Claude, sin lo que la envuelve: comillas, «», puntos suspensivos al inicio o
 * al final ("...y lo mandamos el viernes...") y espacios.
 */
export function cleanQuote(quote: string): string {
  return quote
    .trim()
    .replace(/^(?:["'«»“”‘’]|\.\.\.|…|\s)+/u, '')
    .replace(/(?:["'«»“”‘’]|\.\.\.|…|\s)+$/u, '')
    .trim();
}

export type QuoteCheck =
  | { ok: true; start: number; end: number; quote: string }
  | { ok: false; reason: 'vacia' | 'corta' | 'no_encontrada' };

/** ¿La cita está, literal (normalizada), en el texto? Devuelve dónde empieza y termina en el original. */
export function verifyQuote(transcript: string, rawQuote: string, haystack?: NormalizedText): QuoteCheck {
  const quote = cleanQuote(rawQuote ?? '');
  if (!quote) return { ok: false, reason: 'vacia' };
  const needle = normalizeForMatch(quote);
  if (needle.length < MIN_QUOTE_CHARS) return { ok: false, reason: 'corta' };
  const hay = haystack ?? normalizeWithMap(transcript);
  const at = hay.text.indexOf(needle);
  if (at < 0) return { ok: false, reason: 'no_encontrada' };
  const start = hay.map[at]!;
  const lastOrig = hay.map[at + needle.length - 1]!;
  // El último carácter normalizado puede venir de un carácter original de 2 unidades (emoji) o de '…'.
  const end = lastOrig + (transcript.codePointAt(lastOrig)! > 0xffff ? 2 : 1);
  return { ok: true, start, end, quote };
}

/**
 * Filtra una lista de candidatas: se quedan solo las que tienen cita verificada (con su posición).
 * Normaliza el texto UNA vez para todas.
 */
export function keepVerified<T extends { quote: string }>(
  transcript: string,
  items: T[],
): { kept: (T & { quote: string; quoteStart: number })[]; dropped: { item: T; reason: string }[] } {
  const hay = normalizeWithMap(transcript);
  const kept: (T & { quote: string; quoteStart: number })[] = [];
  const dropped: { item: T; reason: string }[] = [];
  for (const item of items) {
    const r = verifyQuote(transcript, item.quote, hay);
    if (r.ok) kept.push({ ...item, quote: transcript.slice(r.start, r.end), quoteStart: r.start });
    else dropped.push({ item, reason: 'reason' in r ? r.reason : 'no_encontrada' });
  }
  return { kept, dropped };
}
