// Texto de una junta → el texto NORMALIZADO que se guarda en meeting.transcript y contra el que se
// verifican las citas. PURO (sin base ni red), para probarlo solo.
//
//   texto / granola_resumen → limpieza (BOM, fines de línea, espacios sobrantes)
//   vtt / srt               → sin cabeceras, números de bloque ni marcas de tiempo; un renglón por
//                             turno ("Ana: …"), juntando bloques seguidos de la misma persona
//   granola_api             → lo arma granolaNoteText (resumen + transcripción por hablante)
//
// Lo que NO se soporta todavía (.docx, .pdf) falla con un mensaje claro en vez de guardar basura
// binaria que ninguna cita va a poder verificar.
import { MEETING_TRANSCRIPT_MAX_CHARS, type TranscriptFormat } from '../types/roz-v2.js';
import { ValidationError } from '../utils/errors.js';
import type { GranolaNote } from '../adapters/granola.js';

export interface TranscriptTurn {
  speaker: string | null;
  text: string;
}

const UNSUPPORTED_EXT = /\.(docx?|pdf|rtf|odt|pages)$/i;

/** Limpieza común: BOM, \r\n, espacios al final de cada renglón y saltos de más. */
export function cleanText(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Quita etiquetas de formato de subtítulos (<i>, <b>, <c.color>, <00:00:01.000>, <font …>). */
function stripCueTags(s: string): string {
  return s
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, '')
    .replace(/<\/?(?:i|b|u|c|ruby|rt|lang|font)(?:[.\s][^>]*)?>/gi, '')
    .replace(/\{\\[^}]*\}/g, '') // marcas tipo ASS que se cuelan en algunos .srt
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

const TIMING_RE = /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;

/**
 * Hablante de un renglón de subtítulo: `<v Ana>texto`, `<v.loud Ana>texto` (WebVTT) o el estilo
 * Zoom/Teams/Meet "Ana: texto". Un "Nota: …" de 1 palabra corta también calza, y está bien: para
 * verificar citas da igual, solo cambia cómo se agrupa.
 */
export function splitSpeaker(line: string): TranscriptTurn {
  const voice = /^<v(?:\.[^\s>]+)*\s+([^>]+)>(.*)$/i.exec(line);
  if (voice) {
    return { speaker: voice[1]!.trim() || null, text: stripCueTags(voice[2]!.replace(/<\/v>/gi, '')).trim() };
  }
  const clean = stripCueTags(line.replace(/<\/v>/gi, '')).trim();
  const named = /^([\p{L}][\p{L}\p{M}.'’\- ]{0,40}?):\s+(.+)$/u.exec(clean);
  if (named && named[1]!.split(/\s+/).length <= 4) return { speaker: named[1]!.trim(), text: named[2]!.trim() };
  const bracket = /^\[([^\]]{1,40})\]\s*(.+)$/.exec(clean);
  if (bracket) return { speaker: bracket[1]!.trim(), text: bracket[2]!.trim() };
  return { speaker: null, text: clean };
}

/** Junta turnos seguidos de la misma persona (los subtítulos parten frases cada 3-4 segundos). */
export function mergeTurns(turns: TranscriptTurn[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const t of turns) {
    if (!t.text) continue;
    const last = out[out.length - 1];
    if (last && t.speaker !== null && last.speaker === t.speaker) {
      last.text = `${last.text} ${t.text}`;
    } else if (last && t.speaker === null && last.speaker === null) {
      last.text = `${last.text} ${t.text}`;
    } else {
      out.push({ speaker: t.speaker, text: t.text });
    }
  }
  return out;
}

export function turnsToText(turns: TranscriptTurn[]): string {
  return mergeTurns(turns)
    .map((t) => (t.speaker ? `${t.speaker}: ${t.text}` : t.text))
    .join('\n');
}

/** Bloques de cue separados por renglón vacío. */
function cueBlocks(raw: string): string[][] {
  return cleanText(raw)
    .split(/\n\s*\n/)
    .map((b) => b.split('\n').filter((l) => l.trim() !== ''))
    .filter((b) => b.length > 0);
}

/** Texto de los renglones de un cue: todo lo que sigue a la línea de tiempo. */
function cueTurns(lines: string[]): TranscriptTurn[] {
  const at = lines.findIndex((l) => TIMING_RE.test(l));
  if (at < 0) return [];
  const textLines = lines.slice(at + 1);
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;
  for (const l of textLines) {
    const t = splitSpeaker(l);
    if (!t.text) continue;
    // Un renglón sin hablante dentro de un cue es la continuación del anterior.
    if (current && t.speaker === null) {
      current.text = `${current.text} ${t.text}`;
      continue;
    }
    current = { ...t };
    turns.push(current);
  }
  return turns;
}

/** WebVTT → "Hablante: texto" por turno. Ignora WEBVTT, NOTE, STYLE, REGION y los ids de cue. */
export function parseVtt(raw: string): string {
  const turns: TranscriptTurn[] = [];
  for (const block of cueBlocks(raw)) {
    const first = block[0]!.trim();
    if (/^WEBVTT\b/.test(first) && !block.some((l) => TIMING_RE.test(l))) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(first)) continue;
    turns.push(...cueTurns(block));
  }
  return turnsToText(turns);
}

/** SubRip (.srt) → "Hablante: texto" por turno. Ignora los números de bloque y las marcas de tiempo. */
export function parseSrt(raw: string): string {
  const turns: TranscriptTurn[] = [];
  for (const block of cueBlocks(raw)) turns.push(...cueTurns(block));
  return turnsToText(turns);
}

/** ¿Parece un subtítulo aunque lo hayan pegado como texto? (al menos dos líneas de tiempo) */
export function looksTimed(raw: string): boolean {
  let n = 0;
  for (const l of raw.split(/\r?\n/)) if (TIMING_RE.test(l) && ++n >= 2) return true;
  return false;
}

/** Contenido binario (un .docx es un zip: empieza con "PK"; un PDF con "%PDF"). */
function looksBinary(raw: string): boolean {
  if (/^PK\u0003\u0004/.test(raw) || raw.startsWith('%PDF')) return true;
  // Muchos caracteres de control = no es texto.
  const sample = raw.slice(0, 2000);
  let ctrl = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return sample.length > 0 && ctrl / sample.length > 0.05;
}

/**
 * El texto que se guarda para una junta. Lanza ValidationError (400) si el archivo no se soporta,
 * si queda vacío o si pasa del límite.
 */
export function normalizeTranscript(format: TranscriptFormat, content: string, fileName?: string | null): string {
  if (fileName && UNSUPPORTED_EXT.test(fileName)) {
    throw new ValidationError(
      `Los archivos ${fileName.slice(fileName.lastIndexOf('.')).toLowerCase()} todavía no se soportan: sube un .txt, .vtt o .srt, o pega el texto.`,
    );
  }
  if (looksBinary(content)) {
    throw new ValidationError('El archivo no es texto (¿un .docx o .pdf?): sube un .txt, .vtt o .srt, o pega el texto.');
  }
  let text: string;
  if (format === 'vtt' || (format === 'texto' && /^\uFEFF?WEBVTT\b/.test(content.trimStart()))) text = parseVtt(content);
  else if (format === 'srt' || (format === 'texto' && looksTimed(content))) text = parseSrt(content);
  else text = cleanText(content);

  if (!text) throw new ValidationError('La junta no tiene texto (¿el archivo está vacío o solo trae marcas de tiempo?)');
  if (text.length > MEETING_TRANSCRIPT_MAX_CHARS) {
    throw new ValidationError(`El texto de la junta es demasiado largo (${text.length} caracteres; máximo ${MEETING_TRANSCRIPT_MAX_CHARS}).`);
  }
  return text;
}

/**
 * Texto de una nota de Granola: el resumen (si lo hay) y la transcripción por hablante. Las citas se
 * pueden verificar contra cualquiera de las dos partes.
 */
export function granolaNoteText(note: Pick<GranolaNote, 'summaryMarkdown' | 'transcript'>): string {
  const parts: string[] = [];
  if (note.summaryMarkdown) parts.push(`Resumen de Granola:\n${cleanText(note.summaryMarkdown)}`);
  if (note.transcript.length) parts.push(`Transcripción:\n${turnsToText(note.transcript.map((t) => ({ speaker: t.speaker, text: t.text })))}`);
  return cleanText(parts.join('\n\n')).slice(0, MEETING_TRANSCRIPT_MAX_CHARS);
}
