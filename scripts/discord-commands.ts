/**
 * Registra /roz y las acciones de mensaje en el servidor de Discord (comandos de servidor: se ven al
 * instante). Idempotente: si lo registrado ya coincide con src/discord/commands/definitions.ts (por
 * hash), no toca nada.
 *
 *   npm run discord:commands              # registra si cambió
 *   npm run discord:commands -- --check   # solo dice si cambiaría (no escribe)
 *   npm run discord:commands -- --force   # registra aunque el hash coincida
 *
 * Necesita DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID (Application ID) y DISCORD_GUILD_ID. Solo habla con
 * Discord: no toca la base. El puente hace lo mismo al arrancar (POST /v1/internal/discord/commands/sync).
 */
import 'dotenv/config';
import { syncGuildCommands } from '../src/discord/commands/register.js';
import { commandDefinitions, validateDefinitions } from '../src/discord/commands/definitions.js';

const dryRun = process.argv.includes('--check');
const force = process.argv.includes('--force');

async function main(): Promise<void> {
  const problems = validateDefinitions();
  if (problems.length) {
    console.error('La definición no es válida:\n' + problems.map((p) => `  · ${p}`).join('\n'));
    process.exit(1);
  }
  const result = await syncGuildCommands({ dryRun, force });
  const names = commandDefinitions().map((c) => (c.type === 1 ? `/${c.name}` : `"${c.name}"`));
  console.log(`comandos: ${names.join(', ')}`);
  console.log(`hash local ${result.hash.slice(0, 12)} · en Discord ${result.remoteHash.slice(0, 12)}`);
  if (!result.changed) console.log('Sin cambios: Discord ya tiene esta definición.');
  else if (result.dryRun) console.log('Cambiaría: corre sin --check para registrar.');
  else console.log(`Registrados ${result.count} comandos en el servidor.`);
}

main().catch((err) => {
  // Sin el error crudo de red: DiscordError ya trae la ruta sin tokens.
  console.error('No se pudieron registrar los comandos:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
