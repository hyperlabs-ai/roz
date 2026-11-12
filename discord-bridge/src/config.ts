// Configuración del puente, leída UNA vez del entorno. Falla al arrancar si falta algo obligatorio:
// mejor que Railway marque el despliegue como caído a que el puente corra a medias.
//
// Variables (contrato §A.3): DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, ROZ_API_URL, ROZ_BRIDGE_SECRET, DISCORD_BACKFILL_MESSAGES, PORT.
// Opcional: DISCORD_REGISTER_COMMANDS=false para no registrar /roz al arrancar.

export interface BridgeConfig {
  botToken: string;
  guildId: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  /** Base de roz sin la barra final, p. ej. https://roz.example.com */
  rozApiUrl: string;
  bridgeSecret: string;
  /** Mensajes a traer por canal en el backfill inicial. */
  backfillMessages: number;
  /** Tope de páginas (de 100) al ponerse al día con `after` tras una caída larga. */
  catchupMaxPages: number;
  port: number;
  /** Pedir a roz que registre /roz en el servidor al llegar a READY (DISCORD_REGISTER_COMMANDS, default sí). */
  registerCommands: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  version: string;
}

export class ConfigError extends Error {}

function intEnv(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} debe ser un entero entre ${min} y ${max}`);
  }
  return n;
}

const SNOWFLAKE_RE = /^\d{15,25}$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const missing: string[] = [];
  const req = (name: string): string => {
    const v = env[name]?.trim() ?? '';
    if (!v) missing.push(name);
    return v;
  };
  const botToken = req('DISCORD_BOT_TOKEN');
  const guildId = req('DISCORD_GUILD_ID');
  const supabaseUrl = req('SUPABASE_URL');
  const supabaseServiceRoleKey = req('SUPABASE_SERVICE_ROLE_KEY');
  const rozApiUrl = req('ROZ_API_URL');
  const bridgeSecret = req('ROZ_BRIDGE_SECRET');
  // Solo los NOMBRES de lo que falta; nunca valores.
  if (missing.length) throw new ConfigError(`Faltan variables de entorno: ${missing.join(', ')}`);
  if (!SNOWFLAKE_RE.test(guildId)) throw new ConfigError('DISCORD_GUILD_ID debe ser un snowflake (solo dígitos)');
  if (!/^https?:\/\//.test(rozApiUrl)) throw new ConfigError('ROZ_API_URL debe empezar con http:// o https://');

  const level = (env.LOG_LEVEL ?? 'info').trim() as BridgeConfig['logLevel'];
  return {
    botToken,
    guildId,
    supabaseUrl,
    supabaseServiceRoleKey,
    rozApiUrl: rozApiUrl.replace(/\/+$/, ''),
    bridgeSecret,
    backfillMessages: intEnv(env, 'DISCORD_BACKFILL_MESSAGES', 200, 0, 100_000),
    catchupMaxPages: intEnv(env, 'DISCORD_CATCHUP_MAX_PAGES', 50, 1, 10_000),
    port: intEnv(env, 'PORT', 8080, 1, 65_535),
    registerCommands: !['0', 'false', 'no', 'off'].includes((env.DISCORD_REGISTER_COMMANDS ?? '').trim().toLowerCase()),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
    version: env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) || env.BRIDGE_VERSION || '0.1.0',
  };
}

/** Valores que NUNCA deben salir en un log (el logger los tacha si aparecen en un texto). */
export function secretsOf(cfg: BridgeConfig): string[] {
  return [cfg.botToken, cfg.supabaseServiceRoleKey, cfg.bridgeSecret].filter((s) => s.length >= 8);
}
