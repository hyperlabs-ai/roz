// Interacciones de Discord (/roz, acciones de mensaje, botones, menús, modales, autocompletado).
// Contrato: docs/discord-commands-contract.md §1-§2.1.
//
// El puente NO interpreta nada: toma el payload CRUDO de INTERACTION_CREATE, lo reenvía a roz
// (POST /v1/internal/discord/interactions con Bearer ROZ_BRIDGE_SECRET) y manda a Discord, tal cual,
// el `callback` que roz devuelve (POST /interactions/{id}/{token}/callback). Toda la lógica vive en roz.
//
// Ventana de 3 s de Discord: roz ya se limita (espera a su handler ≤ 1800 ms y, si no alcanza, difiere
// con type 5/6 y completa después con el token). El puente le da como máximo 2500 ms (menos si la
// interacción llegó tarde según su snowflake) y, si roz no contesta a tiempo o falla, responde un
// FALLBACK (efímero con el aviso; autocompletado vacío) para que el usuario nunca vea "la aplicación
// no respondió". Si roz difirió y luego completa, su PATCH @original edita ese efímero: degrada bien.
//
// Reglas: una interacción se reconoce UNA sola vez (nunca se reintenta un callback; 40060 = ya
// reconocida, se ignora) y nunca se loguea el token ni el contenido: solo id, tipo, ms y códigos.
import { log } from './log.js';
import { snowflakeTime } from './snowflake.js';

/** Tipos de interacción de Discord. */
export const INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

/** Lo mínimo que el puente lee de la interacción cruda (el resto viaja intacto a roz). */
export interface RawInteraction {
  id: string;
  application_id?: string;
  type: number;
  token: string;
  guild_id?: string;
  [k: string]: unknown;
}

/** Cuerpo del callback de Discord (`{ type, data? }`). Nunca lleva el token. */
export interface InteractionCallbackBody {
  type: number;
  data?: Record<string, unknown>;
}

/** Lo que el puente manda a roz. */
export interface InteractionEnvelope {
  guildId: string;
  receivedAt?: number;
  interaction: RawInteraction;
}

/** Tope del contrato: más de esto esperando a roz → fallback. */
export const ROZ_TIMEOUT_MS = 2500;
/** Ventana de Discord para la respuesta inicial. */
export const DISCORD_WINDOW_MS = 3000;
/** Lo que se reserva para que el callback del puente llegue a Discord. */
export const CALLBACK_MARGIN_MS = 300;
/** Nunca esperar a roz menos que esto (si la interacción ya venía muy tarde, igual se intenta). */
export const MIN_ROZ_TIMEOUT_MS = 250;

export const TEXT_TIMEOUT = 'roz no respondió a tiempo. Intenta de nuevo en un momento.';
export const TEXT_UNAVAILABLE = 'roz no está disponible. Intenta de nuevo en un momento.';
export const TEXT_DISABLED = 'roz no tiene activado Discord.';

const EPHEMERAL = 64;
/** Discord: "Interaction has already been acknowledged". */
const ALREADY_ACKNOWLEDGED = 40060;
/** Discord: "Unknown interaction" (venció la ventana de 3 s o el token). */
const UNKNOWN_INTERACTION = 10062;

export type FallbackReason = 'timeout' | 'unavailable' | 'disabled';

/** Respuesta de emergencia cuando roz no decidió (contrato §2.1, "Fallback del puente"). */
export function fallbackCallback(interactionType: number, reason: FallbackReason = 'timeout'): InteractionCallbackBody {
  if (interactionType === INTERACTION_TYPE.AUTOCOMPLETE) return { type: 8, data: { choices: [] } };
  if (interactionType === INTERACTION_TYPE.PING) return { type: 1 };
  const content = reason === 'disabled' ? TEXT_DISABLED : reason === 'unavailable' ? TEXT_UNAVAILABLE : TEXT_TIMEOUT;
  return { type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } };
}

/**
 * Cuánto esperar a roz: 2500 ms, o menos si la interacción ya gastó parte de los 3 s (fecha del
 * snowflake, con el margen del callback). Con un reloj no creíble (negativo o > 10 s) se usan 2500.
 */
export function rozTimeoutMs(interactionId: string, now: number): number {
  let created: number;
  try {
    created = snowflakeTime(interactionId);
  } catch {
    return ROZ_TIMEOUT_MS;
  }
  const elapsed = now - created;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 10_000) return ROZ_TIMEOUT_MS;
  return Math.max(MIN_ROZ_TIMEOUT_MS, Math.min(ROZ_TIMEOUT_MS, DISCORD_WINDOW_MS - CALLBACK_MARGIN_MS - elapsed));
}

function isRawInteraction(v: unknown): v is RawInteraction {
  const o = v as Partial<RawInteraction> | null;
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.id === 'string' &&
    /^\d{1,25}$/.test(o.id) &&
    typeof o.type === 'number' &&
    typeof o.token === 'string' &&
    o.token.length > 0
  );
}

function isCallbackBody(v: unknown): v is InteractionCallbackBody {
  const o = v as Partial<InteractionCallbackBody> | null;
  return (
    !!o &&
    typeof o === 'object' &&
    Number.isInteger(o.type) &&
    (o.data === undefined || (typeof o.data === 'object' && o.data !== null && !Array.isArray(o.data)))
  );
}

export interface InteractionForwarderOptions {
  rozApiUrl: string;
  bridgeSecret: string;
  guildId: string;
  /** Base de la API de Discord (tests). */
  discordApiBase?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Tope de la llamada del callback a Discord. */
  callbackTimeoutMs?: number;
}

export type ForwardOutcome =
  | { kind: 'roz'; callbackType: number }
  | { kind: 'fallback'; reason: FallbackReason; status: number | null };

export interface InteractionStats {
  forwarded: number;
  fallbacks: number;
  callbackErrors: number;
  inFlight: number;
}

export class InteractionForwarder {
  private readonly o: Required<Omit<InteractionForwarderOptions, 'fetch'>> & { fetch: typeof fetch };
  private readonly inFlight = new Set<Promise<void>>();
  private stats = { forwarded: 0, fallbacks: 0, callbackErrors: 0 };
  private stopped = false;

  constructor(opts: InteractionForwarderOptions) {
    this.o = {
      discordApiBase: 'https://discord.com/api/v10',
      now: () => Date.now(),
      callbackTimeoutMs: 5000,
      fetch: globalThis.fetch.bind(globalThis),
      ...opts,
    } as Required<Omit<InteractionForwarderOptions, 'fetch'>> & { fetch: typeof fetch };
    this.o.rozApiUrl = this.o.rozApiUrl.replace(/\/+$/, '');
    this.o.discordApiBase = this.o.discordApiBase.replace(/\/+$/, '');
  }

  get rozUrl(): string {
    return `${this.o.rozApiUrl}/v1/internal/discord/interactions`;
  }

  getStats(): InteractionStats {
    return { ...this.stats, inFlight: this.inFlight.size };
  }

  /**
   * Punto de entrada desde el gateway (payload `d` de INTERACTION_CREATE). No bloquea: cada
   * interacción corre por su lado (no pasa por el carril serial del espejo).
   */
  handle(data: unknown): void {
    if (this.stopped) return;
    const p = this.process(data).then(
      () => undefined,
      (err) => log.error('interacción: fallo inesperado del puente', { err }),
    );
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  /** Procesa una interacción de principio a fin. Público para tests. */
  async process(data: unknown): Promise<ForwardOutcome | null> {
    const receivedAt = this.o.now();
    if (!isRawInteraction(data)) {
      log.warn('interacción ignorada: payload sin id/tipo/token');
      return null;
    }
    const interaction = data;
    const meta = { interactionId: interaction.id, type: interaction.type };

    const asked = await this.askRoz(interaction, receivedAt);
    const rozMs = this.o.now() - receivedAt;
    let outcome: ForwardOutcome;
    let callback: InteractionCallbackBody;
    if (asked.kind === 'ok') {
      callback = asked.callback;
      outcome = { kind: 'roz', callbackType: callback.type };
      this.stats.forwarded += 1;
    } else {
      callback = fallbackCallback(interaction.type, asked.reason);
      outcome = { kind: 'fallback', reason: asked.reason, status: asked.status };
      this.stats.fallbacks += 1;
      const fields = { ...meta, reason: asked.reason, status: asked.status, ms: rozMs };
      if (asked.reason === 'disabled') log.warn('interacción: roz tiene ROZ_DISCORD_CHAT apagado (404); fallback', fields);
      else if (asked.status === 403) log.error('interacción: roz respondió 403; revisa ROZ_BRIDGE_SECRET y DISCORD_GUILD_ID en ambos lados', fields);
      else log.warn('interacción: roz no decidió a tiempo; fallback', fields);
    }

    const sent = await this.sendCallback(interaction, callback);
    const totalMs = this.o.now() - receivedAt;
    if (sent.ok) {
      log.info('interacción respondida', { ...meta, source: outcome.kind, callbackType: callback.type, rozMs, ms: totalMs });
    } else {
      this.stats.callbackErrors += 1;
      if (sent.code === ALREADY_ACKNOWLEDGED) {
        log.info('interacción ya reconocida (40060); se ignora', { ...meta, ms: totalMs });
      } else if (sent.code === UNKNOWN_INTERACTION) {
        log.warn('interacción vencida antes del callback (10062)', { ...meta, rozMs, ms: totalMs });
      } else {
        log.warn('Discord rechazó el callback de la interacción', { ...meta, status: sent.status, code: sent.code, ms: totalMs });
      }
    }
    return outcome;
  }

  private async askRoz(
    interaction: RawInteraction,
    receivedAt: number,
  ): Promise<{ kind: 'ok'; callback: InteractionCallbackBody } | { kind: 'fail'; reason: FallbackReason; status: number | null }> {
    const body: InteractionEnvelope = { guildId: this.o.guildId, receivedAt, interaction };
    const timeoutMs = rozTimeoutMs(interaction.id, receivedAt);
    const ctrl = new AbortController();
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      const res = await this.o.fetch(this.rozUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.bridgeSecret}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.status === 404) return { kind: 'fail', reason: 'disabled', status: 404 };
      if (!res.ok) return { kind: 'fail', reason: 'unavailable', status: res.status };
      const json = (await res.json().catch(() => null)) as { callback?: unknown } | null;
      if (!json || !isCallbackBody(json.callback)) {
        log.error('interacción: roz devolvió 200 sin un callback válido', { interactionId: interaction.id });
        return { kind: 'fail', reason: 'unavailable', status: res.status };
      }
      return { kind: 'ok', callback: json.callback };
    } catch (err) {
      if (timedOut) return { kind: 'fail', reason: 'timeout', status: null };
      log.warn('interacción: no se pudo hablar con roz', { interactionId: interaction.id, err });
      return { kind: 'fail', reason: 'unavailable', status: null };
    } finally {
      clearTimeout(t);
    }
  }

  /** POST /interactions/{id}/{token}/callback. Sin token del bot: el de la interacción es la credencial. */
  private async sendCallback(
    interaction: RawInteraction,
    callback: InteractionCallbackBody,
  ): Promise<{ ok: true } | { ok: false; status: number | null; code: number | null }> {
    const url = `${this.o.discordApiBase}/interactions/${interaction.id}/${encodeURIComponent(interaction.token)}/callback`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.o.callbackTimeoutMs);
    try {
      const res = await this.o.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(callback),
        signal: ctrl.signal,
      });
      if (res.ok) return { ok: true };
      const json = (await res.json().catch(() => null)) as { code?: unknown } | null;
      return { ok: false, status: res.status, code: typeof json?.code === 'number' ? json.code : null };
    } catch (err) {
      // El mensaje de un error de red no trae la URL, pero por si acaso el logger tacha /interactions/:id/:token.
      log.warn('no se pudo mandar el callback a Discord', { interactionId: interaction.id, err });
      return { ok: false, status: null, code: null };
    } finally {
      clearTimeout(t);
    }
  }

  /** Apagado: deja de aceptar y espera (hasta `timeoutMs`) lo que esté en vuelo. */
  async close(timeoutMs = 4000): Promise<void> {
    this.stopped = true;
    if (!this.inFlight.size) return;
    await Promise.race([Promise.allSettled([...this.inFlight]), new Promise((r) => setTimeout(r, timeoutMs))]);
  }
}
