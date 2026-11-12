// Registro de los comandos de roz en el servidor de Discord (comandos de GUILD: se actualizan al
// instante, sin la hora de propagación de los globales). Idempotente y sin estado guardado: compara el
// hash de la definición (definitions.ts) contra el de lo que Discord tiene registrado —normalizado
// igual— y solo si difieren hace el PUT masivo.
//
// Lo usan:
//   · `npm run discord:commands` (scripts/discord-commands.ts) — a mano, con --check / --force;
//   · POST /v1/internal/discord/commands/sync — el puente lo llama al arrancar (con su secreto), así
//     un deploy de roz con comandos nuevos queda registrado en el siguiente arranque del puente.
import { config } from '../../config.js';
import { bulkOverwriteGuildCommands, listGuildCommands } from '../../adapters/discord.js';
import { AppError } from '../../utils/errors.js';
import { commandDefinitions, commandsHash, validateDefinitions } from './definitions.js';

export interface SyncCommandsResult {
  /** true = se registró (o, con dryRun, se registraría). */
  changed: boolean;
  dryRun: boolean;
  /** Hash de la definición de roz. */
  hash: string;
  /** Hash de lo que Discord tenía antes. */
  remoteHash: string;
  /** Comandos en la definición. */
  count: number;
}

export async function syncGuildCommands(opts: { force?: boolean; dryRun?: boolean } = {}): Promise<SyncCommandsResult> {
  const problems = validateDefinitions();
  if (problems.length) throw new AppError('DISCORD_COMMANDS_INVALID', `La definición de comandos no es válida: ${problems.join('; ')}`, 500);
  const appId = config.discord.clientId;
  const guildId = config.discord.guildId;
  if (!appId || !guildId || !config.discord.botToken) {
    throw new AppError('DISCORD_NOT_CONFIGURED', 'Faltan DISCORD_CLIENT_ID, DISCORD_GUILD_ID o DISCORD_BOT_TOKEN para registrar los comandos.', 503);
  }
  const local = commandDefinitions();
  const hash = commandsHash(local);
  const remote = await listGuildCommands(appId, guildId);
  const remoteHash = commandsHash(remote);
  const dryRun = !!opts.dryRun;
  if (hash === remoteHash && !opts.force) return { changed: false, dryRun, hash, remoteHash, count: local.length };
  if (!dryRun) await bulkOverwriteGuildCommands(appId, local, guildId);
  return { changed: true, dryRun, hash, remoteHash, count: local.length };
}
