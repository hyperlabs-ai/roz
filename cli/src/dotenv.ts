// Lectura y escritura de archivos .env. Funciones PURAS. Reglas (las que comparten dotenv,
// python-dotenv, docker compose y `source` de bash):
//   NOMBRE=valor            sin comillas: se recorta, y ` #…` al final es comentario
//   NOMBRE='valor'          literal: nada se interpreta; puede abarcar varias líneas
//   NOMBRE="valor"          interpreta \n \r \t \\ \" \$; puede abarcar varias líneas
//   export NOMBRE=valor     el `export` se ignora
// No se expanden variables ($OTRA queda tal cual).
//
// Lo que esté entre `# >>> local` y `# <<< local` es de la máquina: `env pull` lo conserva tal cual
// y `env push` nunca lo sube.

export interface DotenvProblem {
  line: number;
  message: string;
}

export interface DotenvParsed {
  /** Variables fuera del bloque local. Si un nombre se repite gana el último, como en dotenv. */
  vars: Map<string, string>;
  /** Nombres definidos dentro del bloque local. */
  localNames: string[];
  /** El bloque local crudo, con sus dos marcadores, o null si no hay. */
  localBlock: string | null;
  /** Líneas que no se pudieron leer. Nunca incluyen el valor, solo el número de línea. */
  problems: DotenvProblem[];
}

export const LOCAL_START = '# >>> local';
export const LOCAL_END = '# <<< local';
const LOCAL_START_RE = /^#\s*>>>\s*local\b/i;
const LOCAL_END_RE = /^#\s*<<<\s*local\b/i;
const ASSIGN_RE = /^[ \t]*(?:export[ \t]+)?([^\s=#'"]+)[ \t]*=[ \t]*/;
/** Valores que van sin comillas: ningún parser los interpreta distinto. */
const BARE_RE = /^[A-Za-z0-9_./:@%+,=-]+$/;

export function parseDotenv(input: string): DotenvParsed {
  // CRLF → LF: un .env con finales de Windows no debe meter \r en los valores.
  const text = input.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const vars = new Map<string, string>();
  const localNames = new Set<string>();
  const problems: DotenvProblem[] = [];
  const blocks: string[] = [];
  let localStart = -1;

  const lineOf = (index: number): number => {
    let n = 1;
    for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) n++;
    return n;
  };
  const endOfLine = (from: number): number => {
    const nl = text.indexOf('\n', from);
    return nl === -1 ? text.length : nl;
  };

  let i = 0;
  while (i < text.length) {
    const eol = endOfLine(i);
    const raw = text.slice(i, eol);
    const trimmed = raw.trim();

    if (LOCAL_START_RE.test(trimmed)) {
      if (localStart === -1) localStart = i;
      i = eol + 1;
      continue;
    }
    if (LOCAL_END_RE.test(trimmed)) {
      if (localStart !== -1) {
        blocks.push(text.slice(localStart, eol));
        localStart = -1;
      }
      i = eol + 1;
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('#')) {
      i = eol + 1;
      continue;
    }

    const m = ASSIGN_RE.exec(raw);
    if (!m || !m[1]) {
      problems.push({ line: lineOf(i), message: 'no es una asignación NOMBRE=valor' });
      i = eol + 1;
      continue;
    }
    const name = m[1];
    const start = i + m[0].length;
    const quote = text[start];
    let value: string;
    let next: number;

    if (quote === '"' || quote === "'") {
      const closed = readQuoted(text, start + 1, quote);
      if (!closed) {
        problems.push({ line: lineOf(i), message: `comilla sin cerrar en ${name}` });
        i = eol + 1;
        continue;
      }
      value = closed.value;
      const restEnd = endOfLine(closed.end);
      const rest = text.slice(closed.end, restEnd).trim();
      if (rest !== '' && !rest.startsWith('#')) {
        problems.push({ line: lineOf(closed.end), message: `texto después de la comilla de cierre en ${name}` });
      }
      next = restEnd + 1;
    } else {
      let rest = text.slice(start, eol);
      if (rest.startsWith('#')) rest = '';
      else rest = rest.replace(/[ \t]+#.*$/, '');
      value = rest.trim();
      next = eol + 1;
    }

    if (localStart !== -1) localNames.add(name);
    else {
      // delete + set para que el orden refleje la última definición.
      vars.delete(name);
      vars.set(name, value);
    }
    i = next;
  }

  if (localStart !== -1) {
    // Marcador de inicio sin cierre: todo hasta el final es local, y se cierra para no perderlo.
    problems.push({ line: lineOf(localStart), message: `falta el marcador "${LOCAL_END}"` });
    blocks.push(`${text.slice(localStart).replace(/\n+$/, '')}\n${LOCAL_END}`);
  }

  return { vars, localNames: [...localNames], localBlock: blocks.length ? blocks.join('\n\n') : null, problems };
}

function readQuoted(text: string, from: number, quote: string): { value: string; end: number } | null {
  if (quote === "'") {
    const close = text.indexOf("'", from);
    return close === -1 ? null : { value: text.slice(from, close), end: close + 1 };
  }
  let out = '';
  for (let k = from; k < text.length; k++) {
    const ch = text[k];
    if (ch === '"') return { value: out, end: k + 1 };
    if (ch === '\\' && k + 1 < text.length) {
      const esc = text[k + 1];
      const mapped = esc === 'n' ? '\n' : esc === 'r' ? '\r' : esc === 't' ? '\t' : esc === '\\' || esc === '"' || esc === '$' ? esc : null;
      if (mapped != null) {
        out += mapped;
        k++;
        continue;
      }
    }
    out += ch;
  }
  return null;
}

/** El valor como va a la derecha del `=`, con las comillas mínimas para que se lea idéntico. */
export function quoteValue(value: string): string {
  if (value === '') return '';
  if (BARE_RE.test(value)) return value;
  // Comilla simple = literal en todos los parsers (espacios, #, $, ", \ no se tocan). Los saltos de
  // línea van con comilla doble y \n en una sola línea, que es la forma que todos leen igual.
  if (!/['\n\r]/.test(value)) return `'${value}'`;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

export interface SerializeOptions {
  /** Líneas de comentario al inicio (sin el `#`). */
  header?: string[];
  /** Bloque local crudo (con marcadores) que se copia al final. */
  localBlock?: string | null;
}

export function serializeDotenv(vars: Iterable<[string, string]>, opts: SerializeOptions = {}): string {
  const lines: string[] = [];
  for (const h of opts.header ?? []) lines.push(`# ${h}`);
  for (const [name, value] of vars) lines.push(`${name}=${quoteValue(value)}`);
  let out = lines.join('\n') + (lines.length ? '\n' : '');
  if (opts.localBlock) out += `${out ? '\n' : ''}${opts.localBlock.replace(/\n+$/, '')}\n`;
  return out;
}

export interface NameDiff {
  added: string[];
  changed: string[];
  removed: string[];
  same: string[];
}

/** Diferencia por NOMBRE entre lo que hay (`current`) y lo que habría (`next`). */
export function diffNames(current: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): NameDiff {
  const diff: NameDiff = { added: [], changed: [], removed: [], same: [] };
  for (const [name, value] of next) {
    if (!current.has(name)) diff.added.push(name);
    else if (current.get(name) !== value) diff.changed.push(name);
    else diff.same.push(name);
  }
  for (const name of current.keys()) if (!next.has(name)) diff.removed.push(name);
  for (const list of [diff.added, diff.changed, diff.removed, diff.same]) list.sort();
  return diff;
}
