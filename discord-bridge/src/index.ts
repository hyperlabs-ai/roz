// Arranque del puente roz ↔ Discord (Railway). Ver README.md.
import { Bridge } from './bridge.js';
import { CommandSync } from './commands.js';
import { ConfigError, loadConfig, secretsOf } from './config.js';
import { createHealthServer } from './health.js';
import { InteractionForwarder } from './interactions.js';
import { log, registerSecrets, setLogLevel } from './log.js';
import { Notifier } from './notifier.js';
import { DiscordJsGateway, DiscordJsSource, createDiscordClient } from './source/discordjs.js';
import { SupabaseMirrorStore } from './store/supabase.js';

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  registerSecrets(secretsOf(cfg));
  setLogLevel(cfg.logLevel);

  const client = createDiscordClient();
  const bridge = new Bridge({
    guildId: cfg.guildId,
    version: cfg.version,
    backfillMessages: cfg.backfillMessages,
    catchupMaxPages: cfg.catchupMaxPages,
    store: new SupabaseMirrorStore(cfg.supabaseUrl, cfg.supabaseServiceRoleKey),
    source: new DiscordJsSource(client, cfg.guildId),
    gateway: new DiscordJsGateway(client, cfg.botToken),
    notifier: new Notifier({ rozApiUrl: cfg.rozApiUrl, bridgeSecret: cfg.bridgeSecret, guildId: cfg.guildId }),
    // /roz y acciones de mensaje: reenvío a roz + callback a Discord (docs/discord-commands-contract.md).
    interactions: new InteractionForwarder({ rozApiUrl: cfg.rozApiUrl, bridgeSecret: cfg.bridgeSecret, guildId: cfg.guildId }),
    ...(cfg.registerCommands ? { commandSync: new CommandSync({ rozApiUrl: cfg.rozApiUrl, bridgeSecret: cfg.bridgeSecret }) } : {}),
  });

  const server = createHealthServer(() => bridge.health());
  server.listen(cfg.port, () => log.info('health escuchando', { port: cfg.port }));

  let closing = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (closing) return;
    closing = true;
    log.info('señal recibida', { signal });
    const force = setTimeout(() => {
      log.error('el apagado tardó demasiado; saliendo a la fuerza');
      process.exit(1);
    }, 20_000);
    force.unref();
    try {
      await bridge.stop();
    } finally {
      server.close();
      clearTimeout(force);
      process.exit(exitCode);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error('promesa rechazada sin manejar', { err }));

  // Railway solo usa /health al desplegar; si discord.js no logra reconectar en 10 min, salir con
  // error para que la política de reinicio levante un proceso nuevo (que re-identifica y reconcilia).
  const watchdog = setInterval(() => {
    if (!closing && bridge.downMs() > 10 * 60_000) {
      log.error('más de 10 min sin gateway; reiniciando el proceso');
      void shutdown('watchdog', 1);
    }
  }, 30_000);
  watchdog.unref();

  try {
    await bridge.start();
  } catch (err) {
    // Token inválido, intents privilegiados sin activar (4014), etc.: Railway reintenta el arranque.
    log.error('no se pudo conectar a Discord', { err });
    await bridge.stop().catch(() => undefined);
    server.close();
    process.exit(1);
  }
}

void main();
