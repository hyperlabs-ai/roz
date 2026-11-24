// Autollenado de una junta pegada: del texto que se copia de Granola (o de cualquier notas/transcript
// parecido) saca título, fecha, hora, duración y asistentes. PURO (sin base ni red), para probarlo
// solo. Lo que devuelve es una PROPUESTA: la persona la corrige en el diálogo antes de guardar.
//
// Formas que entiende (en español y en inglés):
//   # Weekly con Acme                         ← título (primer renglón que no es fecha ni turno)
//   Fri, 14 Nov 25 · Ana López, Luis Ruiz     ← fecha + asistentes separados por "·" o "|"
//   jueves, 20 de noviembre de 2026 10:00 – 10:45   ← fecha, hora y duración
//   Asistentes: Ana <ana@acme.com>, Luis      ← renglón de asistentes (Attendees/Participantes/…)
//   Ana: vamos con Stripe                     ← turnos: quien habla 2+ veces cuenta como asistente
//
// No adivina la zona horaria: la fecha y la hora salen tal cual se leen (hora local de quien pegó).
import type { MeetingAttendee } from '../types/roz-v2.js';
import { splitSpeaker } from './transcript.js';

export interface PastedMeeting {
  title: string | null;
  /** Fecha leída, 'YYYY-MM-DD' (hora local de la junta). */
  date: string | null;
  /** Hora de inicio leída, 'HH:mm' (24 h). */
  time: string | null;
  durationMin: number | null;
  attendees: MeetingAttendee[];
}

/** Cuántos renglones del principio se miran para título, fecha y asistentes de la cabecera. */
const HEAD_LINES = 15;
const EMAIL_RE = /[^\s<>(),;:"']+@[^\s<>(),;:"']+\.[a-z]{2,}/gi;

const MONTHS: Record<string, number> = {
  ene: 1, enero: 1, jan: 1, january: 1,
  feb: 2, febrero: 2, february: 2,
  mar: 3, marzo: 3, march: 3,
  abr: 4, abril: 4, apr: 4, april: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6, june: 6,
  jul: 7, julio: 7, july: 7,
  ago: 8, agosto: 8, aug: 8, august: 8,
  sep: 9, sept: 9, septiembre: 9, setiembre: 9, september: 9,
  oct: 10, octubre: 10, october: 10,
  nov: 11, noviembre: 11, november: 11,
  dic: 12, diciembre: 12, dec: 12, december: 12,
};
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

/** Minúsculas y sin acentos, carácter por carácter (el largo no cambia: sirve para recortar el original). */
export function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const base = ch.length === 1 ? (ch.normalize('NFD')[0] ?? ch).toLowerCase() : ch;
    out += base.length === ch.length ? base : ch;
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- fecha y hora

interface DateHit {
  date: string;
  /** Dónde terminó la fecha en el renglón (la hora se busca después). */
  end: number;
}

function validDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Año de 2 dígitos → 20xx; sin año → el actual, o el anterior si así quedaría en el futuro. */
function yearOf(raw: string | undefined, m: number, d: number, now: Date): number {
  if (raw) {
    const y = Number(raw);
    return raw.length <= 2 ? 2000 + y : y;
  }
  const y = now.getUTCFullYear();
  const guess = Date.UTC(y, m - 1, d);
  return guess > now.getTime() + 2 * 24 * 60 * 60 * 1000 ? y - 1 : y;
}

/** La primera fecha de un renglón, en cualquiera de las formas soportadas. */
export function findDate(line: string, now: Date = new Date()): DateHit | null {
  const s = fold(line);
  const hits: (DateHit & { at: number })[] = [];

  const iso = /\b(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const date = validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (date) hits.push({ date, at: iso.index, end: iso.index + iso[0].length });
  }

  // "Nov 20, 2026", "November 20", "nov. 20 26"
  const monthFirst = new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}|\\d{2})\\b(?!:))?`).exec(s);
  if (monthFirst) {
    const m = MONTHS[monthFirst[1]!]!;
    const d = Number(monthFirst[2]);
    const date = validDate(yearOf(monthFirst[3], m, d, now), m, d);
    if (date) hits.push({ date, at: monthFirst.index, end: monthFirst.index + monthFirst[0].length });
  }

  // "20 Nov 25", "20 de noviembre de 2026", "20 noviembre"
  const dayFirst = new RegExp(`\\b(\\d{1,2})\\s+(?:de\\s+)?(${MONTH_ALT})\\b\\.?(?:,?\\s+(?:de\\s+|del\\s+)?(\\d{4}|\\d{2})\\b(?!:))?`).exec(s);
  if (dayFirst) {
    const m = MONTHS[dayFirst[2]!]!;
    const d = Number(dayFirst[1]);
    const date = validDate(yearOf(dayFirst[3], m, d, now), m, d);
    if (date) hits.push({ date, at: dayFirst.index, end: dayFirst.index + dayFirst[0].length });
  }

  // "20/11/2026" (día primero, como se escribe aquí; si el segundo número pasa de 12, mes primero)
  const numeric = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/.exec(s);
  if (numeric) {
    let a = Number(numeric[1]);
    let b = Number(numeric[2]);
    if (b > 12 && a <= 12) [a, b] = [b, a];
    const date = validDate(yearOf(numeric[3], b, a, now), b, a);
    if (date) hits.push({ date, at: numeric.index, end: numeric.index + numeric[0].length });
  }

  if (!hits.length) return null;
  hits.sort((x, y) => x.at - y.at);
  return { date: hits[0]!.date, end: hits[0]!.end };
}

const TIME = String.raw`(\d{1,2}):(\d{2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)?`;

function to24(h: number, suffix: string | undefined): number {
  const pm = suffix ? suffix.startsWith('p') : false;
  const am = suffix ? suffix.startsWith('a') : false;
  if (pm && h < 12) return h + 12;
  if (am && h === 12) return 0;
  return h;
}

/** Hora de inicio y, si hay un rango ("10:00 – 10:45"), la duración en minutos. */
export function findTime(text: string): { time: string; durationMin: number | null } | null {
  const s = fold(text);
  const range = new RegExp(`${TIME}\\s*(?:-|–|—|a|to|hasta)\\s*${TIME}`).exec(s);
  if (range) {
    const sufB = range[6]?.replace(/[.\s]/g, '');
    const ownA = range[3]?.replace(/[.\s]/g, '');
    const h2 = to24(Number(range[4]), sufB);
    const m1 = Number(range[2]);
    const m2 = Number(range[5]);
    const span = (h1: number) => {
      let mins = h2 * 60 + m2 - (h1 * 60 + m1);
      if (mins <= 0) mins += 24 * 60;
      return mins;
    };
    // "11:30 – 12:15 pm": el inicio sin am/pm toma el del final solo si así queda un rango corto.
    const candidates = ownA ? [to24(Number(range[1]), ownA)] : [to24(Number(range[1]), sufB), to24(Number(range[1]), undefined)];
    const h1 = candidates.reduce((best, h) => (span(h) < span(best) ? h : best));
    if (h1 < 24 && h2 < 24 && m1 < 60 && m2 < 60) {
      const mins = span(h1);
      return { time: `${pad(h1)}:${pad(m1)}`, durationMin: mins >= 1 && mins <= 720 ? mins : null };
    }
  }
  const one = new RegExp(`(?:^|[^\\d:])${TIME}(?![\\d:])`).exec(s);
  if (one) {
    const h = to24(Number(one[1]), one[3]?.replace(/[.\s]/g, ''));
    const m = Number(one[2]);
    if (h < 24 && m < 60) return { time: `${pad(h)}:${pad(m)}`, durationMin: null };
  }
  return null;
}

function findDuration(text: string): number | null {
  const s = fold(text);
  const hm = /\b(\d{1,2})\s*h(?:rs?|oras?)?\s*(\d{1,2})\s*min/.exec(s);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const m = /\b(\d{1,3})\s*(?:min|mins|minutos|minutes)\b/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= 1440 ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------- asistentes

const ATTENDEES_LINE = /^\s*(?:\*\*)?(?:attendees|asistentes|participantes|participants|invitados|invitees|people|personas)(?:\*\*)?\s*:\s*(.+)$/i;

/** Etiquetas genéricas de "quién habla" que no son una persona (Granola usa Me/Them). */
const GENERIC_SPEAKER =
  /^(me|them|yo|t[uú]|ellos|ellas|nosotros|unknown|desconocid[oa]|nota|notas|note|notes|resumen|summary|acuerdos?|decisi[oó]n(es)?|pendientes?|next steps|action items|siguientes pasos|tareas?|transcript|transcripci[oó]n|agenda|temas?|objetivos?|contexto|importante|ojo|p\.?\s?d\.?|ps)$/i;
const GENERIC_SPEAKER_PREFIX = /^(speaker|hablante|participante|participant|otro participante|other participant|chat with|guest|invitado)\b/i;

/** "Ana López <ana@acme.com>", "ana@acme.com" o "Ana López" → asistente. */
export function attendeeFrom(raw: string): MeetingAttendee | null {
  const text = raw.trim().replace(/^[-*•]\s*/, '').replace(/[,;.]+$/, '');
  if (!text) return null;
  const email = text.match(EMAIL_RE)?.[0]?.toLowerCase() ?? null;
  const name = text
    .replace(/<[^>]*>/g, '')
    .replace(EMAIL_RE, '')
    .replace(/[<>()"[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!email && (!name || /\d/.test(name) || name.split(' ').length > 5)) return null;
  return { name: (name || email!.split('@')[0]!).slice(0, 200), email };
}

function splitNames(list: string): MeetingAttendee[] {
  return list
    .split(/\s*(?:,|;|\s+y\s+|\s+and\s+|\s+&\s+)\s*/i)
    .map(attendeeFrom)
    .filter((a): a is MeetingAttendee => !!a);
}

/** Quita una marca de tiempo al inicio del renglón ("[00:01:23] Ana: …", "00:01 Ana: …"). */
function stripTimestamp(line: string): string {
  return line.replace(/^\s*\[?\(?\d{1,2}:\d{2}(?::\d{2})?\)?\]?\s*[-–]?\s*/, '');
}

function isPersonName(name: string): boolean {
  if (GENERIC_SPEAKER.test(name) || GENERIC_SPEAKER_PREFIX.test(name)) return false;
  if (name.split(/\s+/).length > 3 || /\d/.test(name)) return false;
  return /^\p{Lu}/u.test(name);
}

/** Quien habla dos veces o más (los turnos "Nombre: texto"). */
function speakersOf(lines: string[]): string[] {
  const count = new Map<string, { name: string; n: number }>();
  for (const raw of lines) {
    const line = stripTimestamp(raw);
    if (!line || /^[-*•#>]/.test(line.trim())) continue;
    const t = splitSpeaker(line);
    if (!t.speaker || !isPersonName(t.speaker)) continue;
    const key = fold(t.speaker);
    const c = count.get(key) ?? { name: t.speaker, n: 0 };
    c.n++;
    count.set(key, c);
  }
  return [...count.values()].filter((c) => c.n >= 2).sort((a, b) => b.n - a.n).map((c) => c.name);
}

function mergeAttendees(lists: MeetingAttendee[][]): MeetingAttendee[] {
  const out: MeetingAttendee[] = [];
  const seen = new Set<string>();
  const known = (a: MeetingAttendee) => {
    if (a.email && seen.has(a.email)) return true;
    const n = fold(a.name);
    if (seen.has(`n:${n}`)) return true;
    // "Ana" como hablante y "Ana López" en la cabecera son la misma persona.
    return !a.email && out.some((o) => fold(o.name).split(' ')[0] === n);
  };
  for (const list of lists) {
    for (const a of list) {
      if (known(a)) continue;
      // Un correo suelto cuyo nombre ya está (p. ej. "Ana" y "ana@acme.com") completa al existente.
      const local = a.email ? fold(a.email.split('@')[0]!) : null;
      const twin = a.email ? out.find((o) => !o.email && fold(o.name).split(' ')[0] === local) : undefined;
      if (twin) {
        twin.email = a.email;
        seen.add(a.email!);
        continue;
      }
      out.push({ ...a });
      if (a.email) seen.add(a.email);
      seen.add(`n:${fold(a.name)}`);
    }
  }
  return out.slice(0, 100);
}

// ---------------------------------------------------------------- título

const GENERIC_TITLE = /^(transcript|transcripci[oó]n|notes|notas|meeting notes|notas de la junta|resumen|summary|enhanced notes|my notes|mis notas)$/i;

function cleanTitle(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^__(.+)__$/, '$1')
    .trim();
}

// ---------------------------------------------------------------- todo junto

export function parseMeetingPaste(raw: string, now: Date = new Date()): PastedMeeting {
  const lines = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const head: string[] = [];
  for (const l of lines) {
    if (l.trim()) head.push(l.trim());
    if (head.length >= HEAD_LINES) break;
  }

  // Título: el primer renglón que no es fecha, turno, viñeta ni cabecera genérica. Si el texto
  // empieza directo con un turno ("Ana: hola"), no hay título que leer.
  let title: string | null = null;
  for (const l of head.slice(0, 3)) {
    if (/^WEBVTT\b/.test(l) || /^\d+$/.test(l) || /-->/.test(l)) break;
    const t = cleanTitle(l);
    if (!t || GENERIC_TITLE.test(t)) continue;
    const date = findDate(t, now);
    // Un renglón que es casi solo fecha/hora no es título.
    if (date && t.replace(/[\d\s,.:·|/-]/g, '').length < 12) continue;
    if (/^[-*•>]/.test(t) || splitSpeaker(stripTimestamp(t)).speaker || t.length > 150) break;
    title = t.slice(0, 200);
    break;
  }

  let date: string | null = null;
  let time: string | null = null;
  let durationMin: number | null = null;
  const fromHeader: MeetingAttendee[] = [];
  for (const l of head) {
    const att = ATTENDEES_LINE.exec(l);
    if (att) {
      fromHeader.push(...splitNames(att[1]!));
      continue;
    }
    if (!date) {
      const d = findDate(l, now);
      if (d) {
        date = d.date;
        const t = findTime(l.slice(d.end)) ?? findTime(l);
        if (t) {
          time = t.time;
          durationMin = t.durationMin;
        }
        durationMin ??= findDuration(l);
        // "Fri, 14 Nov 25 · Ana López, Luis Ruiz": los tramos sin números son la lista de asistentes.
        const parts = l.split(/\s+[·|•]\s+/);
        if (parts.length > 1) {
          for (const p of parts.slice(1)) if (!/\d/.test(p.replace(EMAIL_RE, ''))) fromHeader.push(...splitNames(p));
        }
      }
    }
  }

  const headerEmails = head.join('\n').match(EMAIL_RE) ?? [];
  const attendees = mergeAttendees([
    fromHeader,
    headerEmails.map((e) => attendeeFrom(e)).filter((a): a is MeetingAttendee => !!a),
    speakersOf(lines.slice(0, 5000)).map((name) => ({ name, email: null })),
  ]);

  return { title, date, time, durationMin, attendees };
}

/**
 * Fecha y hora leídas → instante. Sin hora se toma el mediodía (así la FECHA no cambia con la
 * zona); la zona es la del equipo (America/Mexico_City, UTC-6 fijo desde 2022).
 */
export function pastedHeldAt(p: Pick<PastedMeeting, 'date' | 'time'>): string | null {
  if (!p.date) return null;
  const d = new Date(`${p.date}T${p.time ?? '12:00'}:00-06:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
