// Registro de los comandos de roz (/roz y acciones de mensaje) en el servidor de Discord.
// Contrato: docs/discord-commands-contract.md §2.3.
//
// La definición vive en roz (src/discord/commands/definitions.ts) y roz es quien compara el hash
// contra lo que Discord ya tiene y hace el PUT masivo solo si cambió (idempotente, sin estado). El
// puente solo se lo pide: POST /v1/internal/discord/commands/sync con su secreto, una vez al llegar a
// READY (así un deploy de roz con comandos nuevos queda registrado en el siguiente arranque del
// puente). Si falla reintenta 3 veces con backoff; nunca es fatal: el espejo sigue funcionando.
import { log } from './log.js';

export interface CommandsSyncResult {
  ok: true;
  changed: boolean;
  dryRun: boolean;
  hash: string;
  remoteHash: string;
  count: number;
}

export type SyncAttempt =
  | { kind: 'ok'; result: CommandsSyncResult }
  /** 404: ROZ_DISCORD_CHAT apagado en roz. No se reintenta. */
  | { kind: 'disabled' }
  /** 4xx / 503 de configuración (DISCORD_NOT_CONFIGURED, secreto malo): reintentar no lo arregla. */
  | { kind: 'rejected'; status: number; code: string | null }
  /** Red, timeout, 5xx: vale la pena reintentar. */
  | { kind: 'retry'; status: number | null; code: string | null };

export interface CommandSyncOptions {
  rozApiUrl: string;
  bridgeSecret: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  /** Reintentos después del primer intento (contrato: 3). */
  retries?: number;
  /** Pausa base del backoff (se duplica en cada reintento). */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class CommandSync {
  private readonly o: Required<Omit<CommandSyncOptions, 'fetch'>> & { fetch: typeof fetch };
  private done = false;
  private running: Promise<SyncAttempt> | null = null;
  private last: SyncAttempt | null = null;

  constructor(opts: CommandSyncOptions) {
    this.o = {
      requestTimeoutMs: 20_000,
      retries: 3,
      backoffMs: 2000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      fetch: globalThis.fetch.bind(globalThis),
      ...opts,
    } as Required<Omit<CommandSyncOptions, 'fetch'>> & { fetch: typeof fetch };
    this.o.rozApiUrl = this.o.rozApiUrl.replace(/\/+$/, '');
  }

  url(query: { force?: boolean; dryRun?: boolean } = {}): string {
    const q = new URLSearchParams();
    if (query.force) q.set('force', '1');
    if (query.dryRun) q.set('dryRun', '1');
    const qs = q.toString();
    return `${this.o.rozApiUrl}/v1/internal/discord/commands/sync${qs ? `?${qs}` : ''}`;
  }

  /** Último resultado (para /health). */
  lastAttempt(): SyncAttempt | null {
    return this.last;
  }

  /** Un intento, sin reintentos. Lo usa también el script `npm run register-commands`. */
  async attempt(query: { force?: boolean; dryRun?: boolean } = {}): Promise<SyncAttempt> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.o.requestTimeoutMs);
    try {
      const res = await this.o.fetch(this.url(query), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.o.bridgeSecret}` },
        signal: ctrl.signal,
      });
      const json = (await res.json().catch(() => null)) as (Partial<CommandsSyncResult> & { error?: unknown }) | null;
      const code =
        json && typeof json.error === 'object' && json.error && typeof (json.error as { code?: unknown }).code === 'string'
          ? ((json.error as { code: string }).code)
          : null;
      if (res.ok && json && json.ok === true) return { kind: 'ok', result: json as CommandsSyncResult };
      if (res.status === 404) return { kind: 'disabled' };
      if (res.status === 503 || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        return { kind: 'rejected', status: res.status, code };
      }
      return { kind: 'retry', status: res.status, code };
    } catch {
      return { kind: 'retry', status: null, code: null };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Sincroniza una vez por proceso (las siguientes llamadas devuelven el resultado anterior), con
   * reintentos y backoff. Nunca lanza.
   */
  syncOnce(): Promise<SyncAttempt> {
    if (this.running) return this.running;
    this.running = this.run().then((r) => {
      this.last = r;
      // Si se agotaron los reintentos, permitir otro intento en el próximo READY.
      if (r.kind === 'retry') this.running = null;
      else this.done = true;
      return r;
    });
    return this.running;
  }

  isDone(): boolean {
    return this.done;
  }

  private async run(): Promise<SyncAttempt> {
    let res: SyncAttempt = { kind: 'retry', status: null, code: null };
    for (let i = 0; i <= this.o.retries; i++) {
      if (i > 0) await this.o.sleep(this.o.backoffMs * 2 ** (i - 1));
      res = await this.attempt();
      if (res.kind !== 'retry') break;
      log.warn('no se pudieron registrar los comandos de roz; se reintentará', {
        attempt: i + 1,
        status: res.status,
        code: res.code,
      });
    }
    switch (res.kind) {
      case 'ok':
        log.info(res.result.changed ? 'comandos de roz registrados en el servidor' : 'comandos de roz al día (sin cambios)', {
          changed: res.result.changed,
          count: res.result.count,
          hash: res.result.hash.slice(0, 12),
          remoteHash: res.result.remoteHash.slice(0, 12),
        });
        break;
      case 'disabled':
        log.info('roz tiene ROZ_DISCORD_CHAT apagado (404): no se registran comandos');
        break;
      case 'rejected':
        log.error(
          res.status === 403
            ? 'roz rechazó el registro de comandos (403): revisa ROZ_BRIDGE_SECRET en ambos lados'
            : 'roz no pudo registrar los comandos (revisa DISCORD_CLIENT_ID, DISCORD_GUILD_ID y DISCORD_BOT_TOKEN en roz)',
          { status: res.status, code: res.code },
        );
        break;
      case 'retry':
        log.error('no se pudieron registrar los comandos de roz tras varios intentos; se reintenta en el próximo READY', {
          status: res.status,
          code: res.code,
        });
        break;
    }
    return res;
  }
}
