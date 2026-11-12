// Avisos puente → roz (contrato §A.2/§A.3): POST /v1/internal/discord/events con Bearer
// ROZ_BRIDGE_SECRET y SOLO ids. roz relee la base y transmite el estado actual, así que repetir o
// desordenar avisos es inofensivo; perderlos solo cuesta el empujón de tiempo real.
//
//   · Agrupa en ventanas de ~250 ms o 100 avisos (lo que llegue primero) y quita repetidos.
//   · Si roz falla (red, 5xx, 429, 403 por un secreto rotado a medias…) reintenta con backoff; un
//     aviso con más de 5 min en cola se descarta.
//   · 404 = ROZ_DISCORD_CHAT apagado: se descarta todo y no se vuelve a avisar hasta el próximo
//     arranque del puente.
//   · 400 = el cuerpo está mal (bug): se descarta ese lote para no atascar la cola.
import { log } from './log.js';
import type { DiscordBridgeEventsBody, DiscordBridgeNotice } from './shared/types.js';

export interface NotifierOptions {
  rozApiUrl: string;
  bridgeSecret: string;
  guildId: string;
  fetch?: typeof fetch;
  windowMs?: number;
  maxBatch?: number;
  maxAgeMs?: number;
  /** Reloj y temporizadores inyectables para tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  requestTimeoutMs?: number;
}

interface Queued {
  notice: DiscordBridgeNotice;
  key: string;
  at: number;
}

export interface NotifierStats {
  sent: number;
  dropped: number;
  pending: number;
  disabled: boolean;
}

export function noticeKey(n: DiscordBridgeNotice): string {
  switch (n.kind) {
    case 'message.created':
    case 'message.updated':
      return `${n.kind}:${n.channelId}:${n.messageId}`;
    case 'message.deleted':
      return `${n.kind}:${n.channelId}:${[...n.messageIds].sort().join(',')}`;
    case 'structure.changed':
      return `${n.kind}:${n.scope}:${[...(n.channelIds ?? [])].sort().join(',')}:${[...(n.userIds ?? [])].sort().join(',')}`;
    case 'bridge.status':
      return `${n.kind}:${n.status}`;
  }
}

export class Notifier {
  private queue: Queued[] = [];
  private timer: unknown = null;
  private sending = false;
  private inFlight = 0;
  private failures = 0;
  private retryAt = 0;
  private disabled = false;
  private stopped = false;
  private stats = { sent: 0, dropped: 0 };
  private readonly o: Required<Omit<NotifierOptions, 'fetch'>> & { fetch: typeof fetch };

  constructor(opts: NotifierOptions) {
    this.o = {
      windowMs: 250,
      maxBatch: 100,
      maxAgeMs: 5 * 60_000,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
      requestTimeoutMs: 10_000,
      fetch: globalThis.fetch.bind(globalThis),
      ...opts,
    } as Required<Omit<NotifierOptions, 'fetch'>> & { fetch: typeof fetch };
  }

  get url(): string {
    return `${this.o.rozApiUrl}/v1/internal/discord/events`;
  }

  getStats(): NotifierStats {
    return { ...this.stats, pending: this.queue.length, disabled: this.disabled };
  }

  enqueue(...notices: DiscordBridgeNotice[]): void {
    if (this.disabled || this.stopped) return;
    const at = this.o.now();
    for (const notice of notices) {
      const key = noticeKey(notice);
      // Un aviso igual que ya ESPERA en cola basta (roz transmite el estado actual de todos modos).
      // Contra el lote en vuelo no se deduplica: roz pudo haber leído la base antes de esta escritura.
      if (this.queue.some((q, i) => i >= this.inFlight && q.key === key)) continue;
      this.queue.push({ notice, key, at });
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.sending || this.timer !== null || !this.queue.length) return;
    const wait =
      this.retryAt > this.o.now()
        ? this.retryAt - this.o.now()
        : this.queue.length >= this.o.maxBatch
          ? 0
          : this.o.windowMs;
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  /** Manda lo que haya en cola (lotes de hasta maxBatch). Resuelve cuando termina el intento. */
  async flush(): Promise<void> {
    if (this.sending || this.disabled) return;
    if (this.timer !== null) {
      this.o.clearTimer(this.timer);
      this.timer = null;
    }
    this.sending = true;
    try {
      this.dropExpired();
      while (this.queue.length && !this.disabled) {
        const batch = this.queue.slice(0, this.o.maxBatch);
        this.inFlight = batch.length;
        const outcome = await this.send(batch.map((q) => q.notice)).finally(() => {
          this.inFlight = 0;
        });
        if (outcome === 'ok' || outcome === 'drop') {
          this.queue.splice(0, batch.length);
          if (outcome === 'ok') this.stats.sent += batch.length;
          else this.stats.dropped += batch.length;
          this.failures = 0;
          this.retryAt = 0;
          continue;
        }
        if (outcome === 'disabled') {
          this.stats.dropped += this.queue.length;
          this.queue = [];
          this.disabled = true;
          log.warn('roz respondió 404: ROZ_DISCORD_CHAT está apagado; no se avisará hasta reiniciar el puente');
          break;
        }
        // retry
        this.failures += 1;
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.failures - 1, 6));
        this.retryAt = this.o.now() + delay;
        break;
      }
    } finally {
      this.sending = false;
    }
    if (!this.stopped) this.schedule();
  }

  private dropExpired(): void {
    const limit = this.o.now() - this.o.maxAgeMs;
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.at >= limit);
    const dropped = before - this.queue.length;
    if (dropped) {
      this.stats.dropped += dropped;
      log.warn('avisos a roz descartados por antigüedad (>5 min sin poder entregarlos)', { dropped });
    }
  }

  private async send(notices: DiscordBridgeNotice[]): Promise<'ok' | 'drop' | 'retry' | 'disabled'> {
    const body: DiscordBridgeEventsBody = { guildId: this.o.guildId, notices };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.o.requestTimeoutMs);
    try {
      const res = await this.o.fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.bridgeSecret}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.ok) return 'ok';
      if (res.status === 404) return 'disabled';
      if (res.status === 400) {
        log.error('roz rechazó un lote de avisos (400); se descarta', { count: notices.length });
        return 'drop';
      }
      if (res.status === 403) {
        log.error('roz respondió 403 a los avisos: revisa ROZ_BRIDGE_SECRET y DISCORD_GUILD_ID en ambos lados');
      } else {
        log.warn('roz no aceptó los avisos; se reintentará', { status: res.status, count: notices.length });
      }
      return 'retry';
    } catch (err) {
      log.warn('no se pudo avisar a roz; se reintentará', { err, count: notices.length });
      return 'retry';
    } finally {
      clearTimeout(t);
    }
  }

  /** Apagado limpio: intenta mandar lo pendiente (hasta `timeoutMs`) y deja de aceptar avisos. */
  async close(timeoutMs = 5000): Promise<void> {
    this.retryAt = 0;
    const done = this.flush();
    await Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs))]);
    this.stopped = true;
    if (this.timer !== null) {
      this.o.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
