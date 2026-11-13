// Orquestador del puente: ciclo de vida del gateway, estado (connecting → backfilling → ready;
// disconnected al perder la conexión), latido en discord_bridge_state, carril serial de escrituras,
// backfill/reconciliación en cada READY (no en RESUMED) y el estado para /health.
// Las interacciones (INTERACTION_CREATE) NO pasan por el carril serial: van directo al reenviador
// (src/interactions.ts), que tiene 3 s para contestar. En el primer READY se le pide a roz que
// registre los comandos del servidor si cambió su definición (src/commands.ts).
import { fullSync, type BackfillDeps } from './backfill.js';
import type { CommandSync } from './commands.js';
import { handleDispatch } from './handlers.js';
import type { InteractionForwarder, InteractionStats } from './interactions.js';
import { errorText, log } from './log.js';
import type { Notifier } from './notifier.js';
import { SerialQueue } from './queue.js';
import type { DiscordBridgeStatus } from './shared/types.js';
import type { DiscordSource, Gateway } from './source/types.js';
import type { BridgeStateFields, MirrorStore } from './store/types.js';

export interface BridgeOptions {
  guildId: string;
  version: string;
  backfillMessages: number;
  catchupMaxPages: number;
  store: MirrorStore;
  source: DiscordSource;
  gateway: Gateway;
  notifier: Pick<Notifier, 'enqueue' | 'close'>;
  /** Reenvío de interacciones a roz. Sin él, INTERACTION_CREATE se ignora. */
  interactions?: Pick<InteractionForwarder, 'handle' | 'close' | 'getStats'>;
  /** Registro de comandos al llegar a READY. */
  commandSync?: Pick<CommandSync, 'syncOnce' | 'isDone'>;
  now?: () => number;
  heartbeatMs?: number;
  /** Pausa entre reintentos de una escritura fallida (tests: 0). */
  retryDelayMs?: number;
}

export interface HealthReport {
  code: 200 | 503;
  body:
    | {
        ok: true;
        status: DiscordBridgeStatus;
        guildId: string;
        wsPing: number | null;
        lastEventAt: string | null;
        backfill: { pending: number; done: number };
        interactions?: InteractionStats;
      }
    | { ok: false; status: DiscordBridgeStatus; lastError: string | null };
}

/** Desconectado más de esto → /health responde 503 (Railway reinicia). */
export const HEALTH_DOWN_GRACE_MS = 60_000;

const WRITE_ATTEMPTS = 3;

export class Bridge {
  readonly lane = new SerialQueue();
  private status: DiscordBridgeStatus = 'connecting';
  private gatewayUp = false;
  private downSince: number;
  private lastEventAt: number | null = null;
  private lastError: string | null = null;
  private backfill = { pending: 0, done: 0 };
  private syncRunning: Promise<void> | null = null;
  private syncAgain = false;
  private stopping = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly o: BridgeOptions) {
    this.now = o.now ?? Date.now;
    this.downSince = this.now();
  }

  // ---------------------------------------------------------------- ciclo de vida

  async start(): Promise<void> {
    this.o.gateway.onDispatch((t, d) => this.onDispatch(t, d));
    this.o.gateway.onDisconnect((info) => {
      this.gatewayUp = false;
      log.warn('gateway desconectado', { code: info.code ?? null });
      void this.setStatus('disconnected');
    });
    this.o.gateway.onReconnecting(() => {
      this.gatewayUp = false;
      void this.setStatus('disconnected');
    });
    this.o.gateway.onError((err) => {
      this.lastError = errorText(err);
      log.error('error del gateway', { err });
    });

    await this.writeState({ status: 'connecting', bridge_version: this.o.version, last_error: null });
    this.status = 'connecting';
    this.o.notifier.enqueue({ kind: 'bridge.status', status: 'connecting' });

    const every = this.o.heartbeatMs ?? 30_000;
    this.heartbeat = setInterval(() => void this.beat(), every);
    this.heartbeat.unref?.();

    log.info('conectando al gateway de Discord', { guildId: this.o.guildId, version: this.o.version });
    await this.o.gateway.login();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    log.info('apagando el puente');
    // Esperar el backfill en curso (corta en el siguiente canal) y lo que quede en el carril.
    await Promise.race([Promise.all([this.syncRunning ?? Promise.resolve(), this.lane.idle()]), sleep(8000)]);
    // Las interacciones en vuelo terminan su callback (son segundos) antes de cerrar el gateway.
    await this.o.interactions?.close(4000);
    await this.setStatus('disconnected', true);
    await this.o.notifier.close(5000);
    try {
      await this.o.gateway.destroy();
    } catch (err) {
      log.warn('no se pudo cerrar el gateway limpio', { err });
    }
  }

  // ---------------------------------------------------------------- eventos

  /** Punto de entrada de cada DISPATCH (público para tests). */
  onDispatch(type: string, data: unknown): void {
    if (this.stopping) return;
    this.lastEventAt = this.now();
    if (type === 'INTERACTION_CREATE') {
      this.o.interactions?.handle(data);
      return;
    }
    if (type === 'READY') {
      this.gatewayUp = true;
      if (this.o.commandSync && !this.o.commandSync.isDone()) void this.o.commandSync.syncOnce();
      void this.runFullSync();
      return;
    }
    if (type === 'RESUMED') {
      this.gatewayUp = true;
      void this.setStatus(this.syncRunning ? 'backfilling' : 'ready');
      return;
    }
    void this.lane
      .run(() => this.withRetry(type, () => handleDispatch(this.ctx(), type, data)))
      .catch(() => undefined);
  }

  private ctx() {
    return {
      guildId: this.o.guildId,
      store: this.o.store,
      source: this.o.source,
      notify: (...n: Parameters<Notifier['enqueue']>) => this.o.notifier.enqueue(...n),
    };
  }

  private async withRetry(what: string, fn: () => Promise<unknown>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await fn();
        return;
      } catch (err) {
        if (attempt >= WRITE_ATTEMPTS) {
          this.lastError = errorText(err);
          log.error('no se pudo reflejar un evento de Discord (se corrige en la próxima reconciliación)', {
            event: what,
            err,
          });
          return;
        }
        await sleep((this.o.retryDelayMs ?? 500) * attempt);
      }
    }
  }

  // ---------------------------------------------------------------- backfill

  /** Corre el backfill; si llega otro READY mientras corre, se repite al terminar. */
  runFullSync(): Promise<void> {
    if (this.syncRunning) {
      this.syncAgain = true;
      return this.syncRunning;
    }
    this.syncRunning = (async () => {
      do {
        this.syncAgain = false;
        await this.setStatus('backfilling');
        const started = this.now();
        try {
          const deps: BackfillDeps = {
            guildId: this.o.guildId,
            store: this.o.store,
            source: this.o.source,
            lane: this.lane,
            notify: (...n) => this.o.notifier.enqueue(...n),
            backfillMessages: this.o.backfillMessages,
            catchupMaxPages: this.o.catchupMaxPages,
            now: this.now,
            shouldStop: () => this.stopping,
            onProgress: (p) => {
              this.backfill = p;
            },
          };
          const res = await fullSync(deps);
          log.info('backfill terminado', { channels: res.channels, failed: res.failed, ms: this.now() - started });
          await this.writeState({ last_ready_at: new Date(this.now()).toISOString() });
        } catch (err) {
          this.lastError = errorText(err);
          log.error('backfill falló; se reintenta en el próximo READY', { err });
          await this.writeState({ last_error: this.lastError });
        }
      } while (this.syncAgain && !this.stopping);
    })().finally(() => {
      this.syncRunning = null;
      if (!this.stopping) void this.setStatus(this.gatewayUp ? 'ready' : 'disconnected');
    });
    return this.syncRunning;
  }

  // ---------------------------------------------------------------- estado

  private async setStatus(status: DiscordBridgeStatus, force = false): Promise<void> {
    if (status === this.status && !force) return;
    const prev = this.status;
    this.status = status;
    const up = status === 'ready' || status === 'backfilling';
    if (up) this.downSince = Number.NaN;
    else if (!Number.isFinite(this.downSince)) this.downSince = this.now();
    if (status !== prev) log.info('estado del puente', { from: prev, to: status });
    const iso = new Date(this.now()).toISOString();
    await this.writeState({
      status,
      ...(up && prev !== 'ready' && prev !== 'backfilling' ? { connected_at: iso } : {}),
      ...(status === 'ready' ? { last_ready_at: iso, last_error: null } : {}),
    });
    this.o.notifier.enqueue({ kind: 'bridge.status', status });
  }

  private async writeState(extra: Partial<BridgeStateFields>): Promise<void> {
    try {
      await this.o.store.upsertBridgeState({
        guild_id: this.o.guildId,
        status: this.status,
        last_heartbeat_at: new Date(this.now()).toISOString(),
        ...(this.lastEventAt ? { last_event_at: new Date(this.lastEventAt).toISOString() } : {}),
        ...extra,
      });
    } catch (err) {
      log.warn('no se pudo guardar el estado del puente', { err });
    }
  }

  private async beat(): Promise<void> {
    await this.writeState({});
  }

  health(): HealthReport {
    const down = Number.isFinite(this.downSince) ? this.now() - this.downSince : 0;
    if (down > HEALTH_DOWN_GRACE_MS) {
      return { code: 503, body: { ok: false, status: this.status, lastError: this.lastError } };
    }
    return {
      code: 200,
      body: {
        ok: true,
        status: this.status,
        guildId: this.o.guildId,
        wsPing: this.o.gateway.ping(),
        lastEventAt: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
        backfill: { ...this.backfill },
        ...(this.o.interactions ? { interactions: this.o.interactions.getStats() } : {}),
      },
    };
  }

  /** Milisegundos que lleva sin gateway (0 si está conectado). */
  downMs(): number {
    return Number.isFinite(this.downSince) ? this.now() - this.downSince : 0;
  }

  getStatus(): DiscordBridgeStatus {
    return this.status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
