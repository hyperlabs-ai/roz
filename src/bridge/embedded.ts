// El puente de Discord DENTRO del proceso de zeus.
//
// Antes era un servicio aparte en Railway que hablaba con el API por HTTP con un secreto compartido
// y copiaba a mano los tipos que compartían. Ahora que el API también es un proceso de larga vida, el
// gateway vive aquí: una sola imagen, un solo juego de variables y el token del bot en un solo lugar.
//
// El contrato entre puente y API no cambió (docs/discord-chat-contracts.md §A): el puente sigue
// haciendo POST a /v1/internal/discord/*, solo que ese fetch se resuelve en memoria contra el mismo
// app de Hono en vez de salir a la red. Así las rutas, su auth y sus pruebas quedan idénticas, y el
// secreto del puente puede generarse solo en cada arranque (ver config.ts).
import { config } from '../config.js';
import { Bridge, type HealthReport } from './bridge.js';
import { CommandSync } from './commands.js';
import { InteractionForwarder } from './interactions.js';
import { log, registerSecrets, setLogLevel } from './log.js';
import { Notifier } from './notifier.js';
import { DiscordJsGateway, DiscordJsSource, createDiscordClient } from './source/discordjs.js';
import { SupabaseMirrorStore } from './store/supabase.js';

/** Origen ficticio: lo que empiece con esto no sale a la red, se atiende en el mismo proceso. */
const INTERNAL_ORIGIN = 'http://zeus.internal';

/** Sin gateway más de esto → se tira el cliente y se levanta uno nuevo (re-identifica y reconcilia). */
const RESTART_AFTER_DOWN_MS = 10 * 60_000;

type AppFetch = (req: Request) => Response | Promise<Response>;

export interface EmbeddedBridge {
  health(): HealthReport['body'];
  stop(): Promise<void>;
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** fetch que atiende en memoria lo dirigido al API y deja pasar a la red todo lo demás (Discord). */
export function inProcessFetch(appFetch: AppFetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (urlOf(input).startsWith(INTERNAL_ORIGIN)) {
      return Promise.resolve(appFetch(new Request(input as string | URL | Request, init)));
    }
    return globalThis.fetch(input, init);
  }) as typeof fetch;
}

/** True si este proceso debe sostener el gateway de Discord. */
export function embeddedBridgeEnabled(): boolean {
  return config.discord.embedBridge && config.discord.chatEnabled && !!config.discord.botToken && !!config.discord.guildId;
}

function buildBridge(appFetch: AppFetch): Bridge {
  const d = config.discord;
  const fetchImpl = inProcessFetch(appFetch);
  const client = createDiscordClient();
  const remote = { rozApiUrl: INTERNAL_ORIGIN, bridgeSecret: d.bridgeSecret, fetch: fetchImpl };
  return new Bridge({
    guildId: d.guildId,
    version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) || process.env.BRIDGE_VERSION || 'zeus',
    backfillMessages: d.backfillMessages,
    catchupMaxPages: d.catchupMaxPages,
    store: new SupabaseMirrorStore(config.supabase.url, config.supabase.serviceRoleKey),
    source: new DiscordJsSource(client, d.guildId),
    gateway: new DiscordJsGateway(client, d.botToken),
    notifier: new Notifier({ ...remote, guildId: d.guildId }),
    interactions: new InteractionForwarder({ ...remote, guildId: d.guildId }),
    ...(d.registerCommands ? { commandSync: new CommandSync(remote) } : {}),
  });
}

/**
 * Arranca el puente y lo mantiene vivo. Nunca tumba el proceso: si Discord rechaza la conexión
 * (token inválido, intents sin activar) el API sigue sirviendo y el puente reintenta solo.
 */
export function startEmbeddedBridge(appFetch: AppFetch): EmbeddedBridge {
  registerSecrets([config.discord.botToken, config.supabase.serviceRoleKey, config.discord.bridgeSecret].filter((s) => s.length >= 8));
  setLogLevel(config.env === 'production' ? 'info' : 'debug');

  let bridge = buildBridge(appFetch);
  let stopped = false;
  let restarting = false;
  let lastStartError: string | null = null;

  const boot = async (b: Bridge) => {
    try {
      await b.start();
      lastStartError = null;
    } catch (err) {
      lastStartError = err instanceof Error ? err.message : String(err);
      log.error('no se pudo conectar a Discord; se reintenta en el próximo ciclo', { err });
    }
  };
  void boot(bridge);

  const watchdog = setInterval(() => {
    if (stopped || restarting) return;
    if (bridge.downMs() <= RESTART_AFTER_DOWN_MS) return;
    restarting = true;
    log.error('más de 10 min sin gateway; reiniciando el puente');
    const old = bridge;
    void old
      .stop()
      .catch(() => undefined)
      .then(() => {
        if (stopped) return;
        bridge = buildBridge(appFetch);
        return boot(bridge);
      })
      .finally(() => {
        restarting = false;
      });
  }, 30_000);
  watchdog.unref();

  return {
    health: () => {
      const body = bridge.health().body;
      if (body.ok || !lastStartError) return body;
      const down = body as { ok: false; status: typeof body.status; lastError: string | null };
      return { ...down, lastError: down.lastError ?? lastStartError };
    },
    stop: async () => {
      stopped = true;
      clearInterval(watchdog);
      await bridge.stop();
    },
  };
}
