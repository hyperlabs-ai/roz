// Logger mínimo en JSON por línea (Railway lo indexa tal cual). Dos garantías:
//   1. Nunca imprime un secreto: cualquier valor registrado con `registerSecrets` se tacha aunque
//      venga dentro del mensaje de un error de una librería (p. ej. una URL de webhook con token).
//   2. Nunca imprime contenido de mensajes: quien llama solo pasa ids y conteos.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = 'info';
let secrets: string[] = [];
let sink: (line: string, level: LogLevel) => void = (line, level) => {
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function registerSecrets(values: string[]): void {
  secrets = [...new Set([...secrets, ...values.filter((v) => v && v.length >= 8)])];
}

/** Solo para tests. */
export function __setLogSink(fn: (line: string, level: LogLevel) => void): void {
  sink = fn;
}

// Tokens con forma reconocible aunque no estén registrados (token de bot, URL de webhook, Bearer).
const PATTERNS: RegExp[] = [
  /\/webhooks\/(\d+)\/[\w-]{20,}/g,
  /Bearer\s+[\w.-]{8,}/gi,
  /\b[\w-]{24,28}\.[\w-]{6,7}\.[\w-]{27,40}\b/g,
  // Token de una interacción dentro de la URL del callback.
  /\/interactions\/(\d+)\/[^/\s"']+/g,
];

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[redactado]');
  out = out.replace(PATTERNS[0]!, '/webhooks/$1/[redactado]');
  out = out.replace(PATTERNS[1]!, 'Bearer [redactado]');
  out = out.replace(PATTERNS[2]!, '[redactado]');
  out = out.replace(PATTERNS[3]!, '/interactions/$1/[redactado]');
  return out;
}

function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; status?: unknown };
    return { error: redact(e.message), errorName: e.name, code: e.code, status: e.status };
  }
  return { error: redact(String(err)) };
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const rec: Record<string, unknown> = { t: new Date().toISOString(), level, msg: redact(msg) };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'err') Object.assign(rec, errorFields(v));
      else rec[k] = v;
    }
  }
  let line: string;
  try {
    line = JSON.stringify(rec);
  } catch {
    line = JSON.stringify({ t: rec.t, level, msg: rec.msg });
  }
  sink(redact(line), level);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

/** Texto corto y sin secretos para guardar en last_error. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redact(raw).slice(0, 500);
}
