import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, secretsOf } from '../../src/bridge/config.js';
import { __setLogSink, log, redact, registerSecrets, type LogLevel } from '../../src/bridge/log.js';

const ENV = {
  DISCORD_BOT_TOKEN: 'bot-token-super-secreto-123',
  DISCORD_GUILD_ID: '100000000000000001',
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-secreta-456',
  ROZ_API_URL: 'https://roz.example.com/',
  ROZ_BRIDGE_SECRET: 'bridge-secret-789xyz',
};

describe('config', () => {
  it('lee las variables con defaults', () => {
    const cfg = loadConfig({ ...ENV });
    expect(cfg).toMatchObject({ guildId: ENV.DISCORD_GUILD_ID, rozApiUrl: 'https://roz.example.com', backfillMessages: 200, port: 8080 });
  });

  it('falla nombrando lo que falta, sin valores', () => {
    try {
      loadConfig({ ...ENV, DISCORD_BOT_TOKEN: '', ROZ_BRIDGE_SECRET: undefined });
      throw new Error('no falló');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('DISCORD_BOT_TOKEN');
      expect((err as Error).message).toContain('ROZ_BRIDGE_SECRET');
      expect((err as Error).message).not.toContain(ENV.SUPABASE_SERVICE_ROLE_KEY);
    }
  });

  it('valida guild y números', () => {
    expect(() => loadConfig({ ...ENV, DISCORD_GUILD_ID: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...ENV, DISCORD_BACKFILL_MESSAGES: '-1' })).toThrow(ConfigError);
    expect(loadConfig({ ...ENV, DISCORD_BACKFILL_MESSAGES: '50' }).backfillMessages).toBe(50);
  });
});

describe('log sin secretos', () => {
  const lines: string[] = [];
  afterEach(() => {
    lines.length = 0;
  });

  it('tacha secretos registrados aunque vengan dentro de un error', () => {
    const cfg = loadConfig({ ...ENV });
    registerSecrets(secretsOf(cfg));
    __setLogSink((line: string, _l: LogLevel) => lines.push(line));
    log.error('falló', { err: new Error(`401 con token ${ENV.DISCORD_BOT_TOKEN} y Bearer ${ENV.ROZ_BRIDGE_SECRET}`) });
    expect(lines[0]).not.toContain(ENV.DISCORD_BOT_TOKEN);
    expect(lines[0]).not.toContain(ENV.ROZ_BRIDGE_SECRET);
    expect(lines[0]).toContain('[redactado]');
  });

  it('tacha tokens de webhook y de bot con forma reconocible', () => {
    expect(redact('https://discord.com/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz0123')).toBe(
      'https://discord.com/api/webhooks/123456/[redactado]',
    );
    // Token de bot FALSO, armado por partes: escrito de corrido lo bloquea el escáner de secretos de GitHub.
    const fakeBotToken = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456'].join('.');
    expect(redact(fakeBotToken)).toBe('[redactado]');
    expect(redact('POST https://discord.com/api/v10/interactions/123456/aW50ZXJhY3Rpb246MTIz/callback')).toBe(
      'POST https://discord.com/api/v10/interactions/123456/[redactado]/callback',
    );
  });
});
