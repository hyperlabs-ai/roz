// Adapter de Google Calendar (REST v3 + OAuth 2.0), con `fetch` crudo y sin instalar `googleapis`:
// se usan cuatro endpoints y el SDK oficial pesa más que el código que lo reemplaza. Mismo criterio
// que los adapters de Vercel y Railway.
//
// Solo LECTURA (scope calendar.events.readonly) y solo lo mínimo para responder "¿está ocupado
// ahora y hasta cuándo?". No se pide ni se guarda nada más de la agenda.
import { config } from '../config.js';

const OAUTH_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
const OAUTH_REVOKE = 'https://oauth2.googleapis.com/revoke';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';

/**
 * Scope de solo lectura sobre calendarios y eventos.
 *
 * `calendar.events.readonly` sería más acotado y basta para leer eventos, pero NO permite
 * `calendarList.list` (Google responde ACCESS_TOKEN_SCOPE_INSUFFICIENT). Y listar los calendarios
 * del usuario no es opcional aquí: las clases y los proyectos suelen vivir en calendarios
 * secundarios, así que mirar solo el principal dejaría a la gente marcada como libre en media clase.
 *
 * `freebusy` tampoco sirve: da los bloques ocupados pero sin título, y el título es justo lo que
 * distingue una junta de una clase sin pedirle a nadie que configure reglas.
 */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

/** True si hay credenciales de Google. Sin esto la feature entera se apaga en silencio. */
export function googleConfigured(): boolean {
  return !!(config.google.clientId && config.google.clientSecret && config.google.redirectUri);
}

/**
 * Error de credencial irrecuperable: el usuario revocó el acceso, cambió su contraseña o el refresh
 * token caducó. Se distingue del resto de fallos porque no tiene sentido reintentarlo — hay que
 * pedirle a la persona que reconecte.
 */
export class GoogleAuthRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthRevokedError';
  }
}

/** URL a la que se manda al dev para que autorice. `state` viaja de ida y vuelta. */
export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: 'code',
    scope: CALENDAR_SCOPE,
    // offline + consent son lo que hace que Google entregue un refresh_token. Sin `prompt=consent`
    // una segunda autorización de la misma cuenta devuelve SOLO un access token de 1h, y la
    // conexión se rompería sola al día siguiente sin ningún error visible.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${OAUTH_AUTH}?${params.toString()}`;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string; // ISO
  scope: string | null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    const detail = json.error_description || json.error || res.statusText;
    // `invalid_grant` es la respuesta de Google a un refresh token revocado o caducado.
    if (json.error === 'invalid_grant') throw new GoogleAuthRevokedError(detail);
    throw new Error(`Google OAuth ${res.status}: ${detail}`);
  }
  return json;
}

function expiryFrom(expiresIn: number | undefined): string {
  return new Date(Date.now() + (expiresIn ?? 3600) * 1000).toISOString();
}

/** Intercambia el `code` del callback por tokens. Aquí es donde llega el refresh_token. */
export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const t = await postToken({
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: config.google.redirectUri,
    grant_type: 'authorization_code',
  });
  if (!t.access_token) throw new Error('Google no devolvió access_token');
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: expiryFrom(t.expires_in),
    scope: t.scope ?? null,
  };
}

/** Renueva el access token. Google NO devuelve refresh_token aquí: el original sigue siendo válido. */
export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  const t = await postToken({
    refresh_token: refreshToken,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    grant_type: 'refresh_token',
  });
  if (!t.access_token) throw new Error('Google no devolvió access_token al refrescar');
  return {
    accessToken: t.access_token,
    refreshToken: null,
    expiresAt: expiryFrom(t.expires_in),
    scope: t.scope ?? null,
  };
}

/** Revoca el acceso en Google. Best-effort: si falla, igual se borra la cuenta de nuestro lado. */
export async function revokeToken(token: string): Promise<void> {
  await fetch(OAUTH_REVOKE, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  }).catch(() => undefined);
}

async function calendarGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${CALENDAR}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) throw new GoogleAuthRevokedError('Google 401: token inválido');
  if (!res.ok) {
    throw new Error(`Google Calendar ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }
  return (await res.json()) as T;
}

export interface GoogleCalendarEntry {
  id: string;
  summary: string | null;
  primary: boolean;
}

interface CalendarListResponse {
  items?: { id?: string; summary?: string; primary?: boolean; selected?: boolean; deleted?: boolean }[];
}

/**
 * Calendarios del usuario que vale la pena mirar.
 *
 * Se descartan los de cumpleaños/festivos: están llenos de eventos de todo el día que no son
 * ocupación real y solo gastarían llamadas. Y los que el usuario tiene ocultos en su propia UI
 * (`selected === false`) se respetan como lo que son: agendas que ni él mira.
 */
export async function listCalendars(accessToken: string, max = 10): Promise<GoogleCalendarEntry[]> {
  const json = await calendarGet<CalendarListResponse>(
    '/users/me/calendarList?minAccessRole=reader&maxResults=100',
    accessToken,
  );
  const items = (json.items ?? []).filter((c) => {
    if (!c.id || c.deleted) return false;
    if (c.selected === false && !c.primary) return false;
    return !/holiday|birthday|#contacts@|#weather@/i.test(c.id);
  });
  // El primario primero: si hay que truncar, que sobreviva el que importa.
  items.sort((a, b) => Number(b.primary ?? false) - Number(a.primary ?? false));
  return items.slice(0, max).map((c) => ({
    id: c.id!,
    summary: c.summary ?? null,
    primary: !!c.primary,
  }));
}

export interface GoogleEvent {
  id: string;
  title: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  status: string | null;
}

interface EventsResponse {
  items?: {
    id?: string;
    summary?: string;
    status?: string;
    transparency?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    attendees?: { self?: boolean; responseStatus?: string }[];
  }[];
}

/**
 * Eventos de un calendario en una ventana. `singleEvents=true` expande las recurrencias, así que
 * cada instancia llega con su propio id y sus horas ya resueltas — sin eso habría que interpretar
 * reglas RRULE a mano.
 *
 * El filtrado de aquí es la diferencia entre un indicador útil y uno que miente: cada regla
 * corresponde a un falso "ocupado" que se vería en el dashboard.
 */
export async function listEvents(
  accessToken: string,
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<GoogleEvent[]> {
  const qs = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    showDeleted: 'false',
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    maxResults: '250',
  });
  const json = await calendarGet<EventsResponse>(
    `/calendars/${encodeURIComponent(calendarId)}/events?${qs.toString()}`,
    accessToken,
  );

  const out: GoogleEvent[] = [];
  for (const e of json.items ?? []) {
    if (!e.id || e.status === 'cancelled') continue;
    // "Disponible" en la UI de Calendar: el evento existe pero su dueño declaró que no ocupa.
    if (e.transparency === 'transparent') continue;
    // Invitación que ESTA persona rechazó: sigue en su calendario, pero no va a ir.
    if (e.attendees?.some((a) => a.self && a.responseStatus === 'declined')) continue;

    const allDay = !e.start?.dateTime;
    const start = e.start?.dateTime ?? e.start?.date;
    const end = e.end?.dateTime ?? e.end?.date;
    if (!start || !end) continue;

    out.push({
      id: e.id,
      title: e.summary ?? null,
      // Las horas vienen en ISO con offset, así que Date las normaliza a UTC sin ambigüedad de zona
      // horaria. Las de todo el día vienen como fecha suelta y quedan a medianoche UTC — da igual:
      // los eventos de todo el día no cuentan como ocupado.
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      allDay,
      status: e.status ?? null,
    });
  }
  return out;
}

/**
 * Email de la cuenta conectada, sacado de la lista de calendarios: el id del calendario primario ES
 * la dirección de correo.
 *
 * Se resuelve así, y no con `GET /calendars/primary`, para no depender de una llamada (y un permiso)
 * extra por un dato que la lista ya trae. Best-effort: si falla, la conexión se guarda sin correo y
 * la tarjeta de Configuración simplemente dice "Cuenta conectada".
 */
export async function primaryEmail(accessToken: string): Promise<string | null> {
  const calendars = await listCalendars(accessToken).catch(() => []);
  return calendars.find((c) => c.primary)?.id ?? null;
}
