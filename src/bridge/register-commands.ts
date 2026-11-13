// Registra /roz y las acciones de mensaje en el servidor de Discord, a mano. Idempotente: roz compara
// el hash de su definición contra lo que Discord ya tiene y solo hace el PUT si cambió.
//
//   npm run register-commands              # registra si cambió
//   npm run register-commands -- --check   # solo dice si cambiaría (no escribe)
//   npm run register-commands -- --force   # registra aunque el hash coincida
//   node dist/register-commands.js         # lo mismo, en Railway (shell del servicio)
//
// Solo necesita ROZ_API_URL y ROZ_BRIDGE_SECRET: la definición, el token del bot y el Application ID
// los tiene roz (POST /v1/internal/discord/commands/sync). El puente hace lo mismo al arrancar.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { CommandSync, type SyncAttempt } from './commands.js';
import { registerSecrets } from './log.js';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Devuelve el código de salida. */
export async function runRegisterCommands(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  fetchImpl?: typeof fetch,
): Promise<number> {
  const rozApiUrl = env.ROZ_API_URL?.trim() ?? '';
  const bridgeSecret = env.ROZ_BRIDGE_SECRET?.trim() ?? '';
  const missing = [!rozApiUrl && 'ROZ_API_URL', !bridgeSecret && 'ROZ_BRIDGE_SECRET'].filter(Boolean);
  if (missing.length) {
    io.err(`Faltan variables de entorno: ${missing.join(', ')}`);
    return 1;
  }
  if (!/^https?:\/\//.test(rozApiUrl)) {
    io.err('ROZ_API_URL debe empezar con http:// o https://');
    return 1;
  }
  registerSecrets([bridgeSecret]);
  const dryRun = argv.includes('--check');
  const force = argv.includes('--force');
  const sync = new CommandSync({ rozApiUrl, bridgeSecret, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const res: SyncAttempt = await sync.attempt({ dryRun, force });
  switch (res.kind) {
    case 'ok': {
      const r = res.result;
      io.out(`hash de roz ${r.hash.slice(0, 12)} · en Discord ${r.remoteHash.slice(0, 12)} · ${r.count} comandos`);
      if (!r.changed) io.out('Sin cambios: Discord ya tiene esta definición.');
      else if (r.dryRun) io.out('Cambiaría: corre sin --check para registrar.');
      else io.out(`Registrados ${r.count} comandos en el servidor.`);
      return 0;
    }
    case 'disabled':
      io.err('roz respondió 404: ROZ_DISCORD_CHAT está apagado.');
      return 1;
    case 'rejected':
      io.err(
        res.status === 403
          ? 'roz respondió 403: ROZ_BRIDGE_SECRET no coincide con el de roz.'
          : `roz no pudo registrar los comandos (${res.status}${res.code ? ` ${res.code}` : ''}). Revisa DISCORD_CLIENT_ID, DISCORD_GUILD_ID y DISCORD_BOT_TOKEN en roz.`,
      );
      return 1;
    case 'retry':
      io.err(`No se pudo hablar con roz${res.status ? ` (${res.status}${res.code ? ` ${res.code}` : ''})` : ''}. ¿Está arriba ROZ_API_URL?`);
      return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runRegisterCommands(process.argv.slice(2), process.env, {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  }).then((code) => process.exit(code));
}
