// Lo nuevo del flujo de variables: un archivo por entorno con versiones, status, diff entre
// entornos, historial y restore, set desde el portapapeles, operaciones en bloque, cambio de llave
// del equipo, el guardia de Claude Code, `setup claude`, `doctor` y el visor local.
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { envGrant, envInit, envRevoke, envRotate } from '../src/commands/admin.js';
import { doctorReport } from '../src/commands/doctor.js';
import { envDiff, envHistory, envPull, envPush, envRestore, envRm, envSet, envStatus } from '../src/commands/env.js';
import { checkBash, checkPrompt, checkTool, guard, isSecretEnvPath } from '../src/commands/guard.js';
import { keyInit, keyRotate } from '../src/commands/key.js';
import { setup, withGuardHooks } from '../src/commands/setup.js';
import { uiHandler } from '../src/commands/ui.js';
import type { RegisteredKey } from '../src/commands/vault.js';
import { parseDotenv } from '../src/dotenv.js';
import { defaultEnvFile, readHeader } from '../src/envfile.js';
import { loadDeviceKey } from '../src/store.js';
import { FakeZeus, machine, plaintextForms, type Machine } from './helpers.js';

let zeus: FakeZeus;
let ana: Machine; // admin
let beto: Machine;

const DEV = { DATABASE_URL: 'postgres://app:dev-clave-1234@localhost:5432/app', STRIPE_KEY: 'sk_test_51Dev0000000000000000AAAA', DEBUG: 'true' };
const PROD = { DATABASE_URL: 'postgres://app:PROD-clave-9876@db.prod:5432/app', STRIPE_KEY: 'stripe-prod-valor-de-prueba-ZZZZ', SENTRY_DSN: 'https://abc@sentry.io/1' };

const dotenv = (vars: Record<string, string>): string => Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
const file = (m: Machine, name: string): string => m.fs.files.get(m.file(name)) ?? '';
const vars = (m: Machine, name: string): Record<string, string> => Object.fromEntries(parseDotenv(file(m, name)).vars);

/** Nada de lo que el servidor recibió o guarda contiene alguno de estos valores. */
function expectNoPlaintext(values: string[]): void {
  const seen = zeus.bodies.join('\n') + zeus.dump();
  for (const v of values) for (const form of plaintextForms(v)) expect(seen.includes(form), `fuga de "${form.slice(0, 10)}…"`).toBe(false);
}

async function registered(m: Machine): Promise<RegisteredKey> {
  const k = await loadDeviceKey(m.fs, m.ctx.home);
  if (!k?.keyId) throw new Error('sin llave');
  return { ...k, keyId: k.keyId };
}

/** Ana crea orwel/development y orwel/production, sube ambos y le da acceso a Beto a los dos. */
beforeEach(async () => {
  zeus = new FakeZeus();
  zeus.addProject('ORWEL', 'Orwel');
  const anaDev = zeus.addDev('Ana Admin', { admin: true });
  const betoDev = zeus.addDev('Beto Dev');
  ana = machine(zeus, anaDev.token, 'ana');
  beto = machine(zeus, betoDev.token, 'beto');
  await keyInit(ana.ctx, []);
  await keyInit(beto.ctx, []);
  await envInit(ana.ctx, ['orwel']);
  await envInit(ana.ctx, ['orwel', 'prod']);
  ana.fs.files.set(ana.file('.env'), dotenv(DEV));
  ana.fs.files.set(ana.file('.env.production'), dotenv(PROD));
  await envPush(ana.ctx, ['orwel', '--yes']);
  await envPush(ana.ctx, ['orwel', 'production', '--yes']);
  await envGrant(ana.ctx, ['orwel', '--all-envs', '--to', 'Beto', '--yes']);
});

describe('un archivo por entorno, con cabecera', () => {
  it('development va a .env y production a .env.production; nunca se mezclan', async () => {
    await envPull(beto.ctx, ['orwel', 'local', '--yes']);
    await envPull(beto.ctx, ['orwel', 'prod', '--yes']);
    expect(vars(beto, '.env')).toEqual(DEV);
    expect(vars(beto, '.env.production')).toEqual(PROD);
    const h = readHeader(file(beto, '.env.production'));
    expect(h).toMatchObject({ projectKey: 'ORWEL', env: 'production' });
    expect(h?.versions.get('STRIPE_KEY')).toBe(1);
    expect(defaultEnvFile('staging')).toBe('.env.staging');
  });

  it('reconoce la cabecera de los archivos que bajó el CLI 0.1', () => {
    expect(readHeader('# zeus: orwel/production. Esta parte se reescribe…\nA=1\n')).toMatchObject({ projectKey: 'orwel', env: 'production' });
    expect(readHeader('A=1\n')).toBeNull();
  });

  it('si el archivo dice venir de otro entorno, pull pide confirmación antes de pisarlo', async () => {
    await envPull(beto.ctx, ['orwel', 'prod', '--yes']);
    beto.fs.files.set(beto.file('.env'), file(beto, '.env.production'));
    beto.prompt.answers = [false];
    await expect(envPull(beto.ctx, ['orwel', 'development', '--out', '.env'])).rejects.toThrow(/cancelado/);
    expect(beto.log.join('\n')).toMatch(/viene de ORWEL\/production/);
  });

  it('un .env.local con cabecera de development se usa en vez de crear .env', async () => {
    await envPull(beto.ctx, ['orwel', '--out', '.env.local', '--yes']);
    beto.fs.files.set(beto.file('.env.local'), file(beto, '.env.local').replace('DEBUG=true', 'DEBUG=false'));
    await envPush(beto.ctx, ['orwel', '--yes']);
    expect(beto.fs.files.has(beto.file('.env'))).toBe(false);
    await envPull(ana.ctx, ['orwel', '--stdout', '--format', 'json']);
    expect(JSON.parse(ana.out.at(-1)!).DEBUG).toBe('false');
  });
});

describe('env status', () => {
  it('sin argumentos revisa todos los .env de la carpeta y separa cada caso, sin valores', async () => {
    await envPull(beto.ctx, ['orwel', '--yes']);
    await envPull(beto.ctx, ['orwel', 'prod', '--yes']);
    // Ana cambia STRIPE_KEY y agrega REDIS_URL en development.
    ana.io.clipboard = 'sk_test_51Nueva00000000000000BBBB';
    await envSet(ana.ctx, ['orwel', 'dev', 'STRIPE_KEY', '--from-clipboard']);
    ana.io.clipboard = 'redis://cache:6379';
    await envSet(ana.ctx, ['orwel', 'dev', 'REDIS_URL', '--from-clipboard']);
    // Beto cambia DEBUG en su archivo (sin subir) y agrega una solo suya.
    const mine = file(beto, '.env').replace('DEBUG=true', 'DEBUG=false') + 'MI_COSA=1\n';
    beto.fs.files.set(beto.file('.env'), mine);
    beto.fs.files.set(beto.file('.env.example'), 'DATABASE_URL=\nSTRIPE_KEY=\nMAILGUN_KEY=\n');

    beto.out.length = 0;
    await envStatus(beto.ctx, ['--json']);
    const [dev, prod] = JSON.parse(beto.out.at(-1)!) as Array<Record<string, any>>;
    expect(dev!.env).toBe('development');
    expect(dev!.missing.map((r: any) => r.name)).toEqual(['REDIS_URL']);
    expect(dev!.outdated).toMatchObject([{ name: 'STRIPE_KEY', yours: 1, version: 2, by: 'Ana Admin' }]);
    expect(dev!.localEdits).toEqual(['DEBUG']);
    expect(dev!.localOnly).toEqual(['MI_COSA']);
    expect(dev!.requiredMissing).toEqual(['MAILGUN_KEY']);
    // .env.example no se le exige a prod.
    expect(prod).toMatchObject({ env: 'production', missing: [], outdated: [], localEdits: [], requiredMissing: [] });

    beto.out.length = 0;
    await envStatus(beto.ctx, []);
    const text = beto.printed();
    expect(text).toMatch(/\+ REDIS_URL/);
    expect(text).toMatch(/~ STRIPE_KEY {2}desactualizada: tienes v1/);
    expect(text).toMatch(/↑ DEBUG/);
    expect(text).toMatch(/✓ al día/);
    for (const v of [...Object.values(DEV), ...Object.values(PROD)].filter((x) => x.length > 6)) expect(text).not.toContain(v);
  });

  it('pull avisa que pisa un cambio local sin subir; push avisa que pisa el de otro', async () => {
    await envPull(beto.ctx, ['orwel', '--yes']);
    beto.fs.files.set(beto.file('.env'), file(beto, '.env').replace('DEBUG=true', 'DEBUG=false'));
    ana.io.clipboard = 'otra-clave-de-ana-123456';
    await envSet(ana.ctx, ['orwel', 'dev', 'DATABASE_URL', '--from-clipboard']);

    beto.log.length = 0;
    await envPush(beto.ctx, ['orwel', '--yes']);
    expect(beto.log.join('\n')).toMatch(/DATABASE_URL {2}\(OTRA PERSONA LA CAMBIÓ/);

    // Tras subir, la cabecera queda con las versiones nuevas: status ya no ve pendientes de DEBUG.
    beto.out.length = 0;
    await envStatus(beto.ctx, ['orwel', '--json']);
    expect(JSON.parse(beto.out.at(-1)!)[0].localEdits).toEqual([]);

    beto.fs.files.set(beto.file('.env'), file(beto, '.env').replace('DEBUG=false', 'DEBUG=1'));
    beto.log.length = 0;
    await envPull(beto.ctx, ['orwel', '--yes']);
    expect(beto.log.join('\n')).toMatch(/DEBUG {2}\(LA CAMBIASTE AQUÍ Y NO LA SUBISTE/);
  });
});

describe('diff entre entornos, historial y restore', () => {
  it('diff local vs prod: solo nombres y si el valor coincide', async () => {
    ana.io.clipboard = DEV.STRIPE_KEY; // el error clásico: la misma llave en los dos
    await envSet(ana.ctx, ['orwel', 'prod', 'STRIPE_KEY', '--from-clipboard']);
    ana.out.length = 0;
    await envDiff(ana.ctx, ['orwel', 'local', 'prod', '--json']);
    expect(JSON.parse(ana.out.at(-1)!)).toEqual({
      a: 'ORWEL/development',
      b: 'ORWEL/production',
      onlyA: ['DEBUG'],
      onlyB: ['SENTRY_DSN'],
      different: ['DATABASE_URL'],
      same: ['STRIPE_KEY'],
    });
    await envDiff(ana.ctx, ['orwel', 'local', 'prod']);
    expect(ana.log.join('\n')).toMatch(/MISMO valor en dos entornos/);
  });

  it('history muestra versiones, quién y cuáles repiten valor; restore regresa una (también borrada)', async () => {
    ana.io.clipboard = 'sk_test_v2_00000000000000000000';
    await envSet(ana.ctx, ['orwel', 'dev', 'STRIPE_KEY', '--from-clipboard']);
    beto.io.clipboard = DEV.STRIPE_KEY;
    await envSet(beto.ctx, ['orwel', 'dev', 'STRIPE_KEY', '--from-clipboard']);

    ana.out.length = 0;
    await envHistory(ana.ctx, ['orwel', 'dev', 'STRIPE_KEY', '--json']);
    const rows = JSON.parse(ana.out.at(-1)!) as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.version, r.current, r.sameValueAs])).toEqual([
      [3, true, 1],
      [2, false, null],
      [1, false, null],
    ]);
    expect(rows[0]!.setBy).toBe('Beto Dev');

    await envRestore(ana.ctx, ['orwel', 'dev', 'STRIPE_KEY', '--version', '2', '--yes']);
    await envPull(ana.ctx, ['orwel', '--stdout', '--format', 'json']);
    expect(JSON.parse(ana.out.at(-1)!).STRIPE_KEY).toBe('sk_test_v2_00000000000000000000');

    await envRm(ana.ctx, ['orwel', 'dev', 'DEBUG', '--yes']);
    ana.out.length = 0;
    await envHistory(ana.ctx, ['orwel', 'dev', 'DEBUG']);
    expect(ana.out.join('\n')).toMatch(/v2 +borrada/);
    await envRestore(ana.ctx, ['orwel', 'dev', 'DEBUG', '--version', '1', '--yes']);
    await envPull(ana.ctx, ['orwel', '--stdout', '--format', 'json']);
    expect(JSON.parse(ana.out.at(-1)!).DEBUG).toBe('true');
    expectNoPlaintext(['sk_test_v2_00000000000000000000', DEV.STRIPE_KEY]);
  });

  it('rotar re-cifra también el historial: después se sigue pudiendo restaurar', async () => {
    ana.io.clipboard = 'clave-nueva-de-prod-000111';
    await envSet(ana.ctx, ['orwel', 'prod', 'DATABASE_URL', '--from-clipboard']);
    await envRotate(ana.ctx, ['orwel', 'prod', '--yes']);
    expect(ana.out.at(-1)).toMatch(/1 versión\(es\) anteriores/);
    await envRestore(ana.ctx, ['orwel', 'prod', 'DATABASE_URL', '--version', '1', '--yes']);
    await envPull(beto.ctx, ['orwel', 'prod', '--stdout', '--format', 'json']);
    expect(JSON.parse(beto.out.at(-1)!).DATABASE_URL).toBe(PROD.DATABASE_URL);
  });
});

describe('env set sin que el valor pase por la terminal ni el chat', () => {
  it('--from-clipboard y --from-file; nunca viaja en claro', async () => {
    ana.io.clipboard = 'valor-desde-portapapeles-XYZ987';
    await envSet(ana.ctx, ['orwel', 'dev', 'DESDE_CLIP', '--from-clipboard']);
    ana.fs.files.set(ana.file('cuenta.json'), '{"type":"service_account","k":"secreto-de-archivo-777"}\n');
    await envSet(ana.ctx, ['orwel', 'dev', 'GOOGLE_SA', '--from-file', 'cuenta.json']);
    await envPull(beto.ctx, ['orwel', '--stdout', '--format', 'json']);
    const got = JSON.parse(beto.out.at(-1)!);
    expect(got.DESDE_CLIP).toBe('valor-desde-portapapeles-XYZ987');
    expect(got.GOOGLE_SA).toBe('{"type":"service_account","k":"secreto-de-archivo-777"}');
    expect(ana.printed()).not.toContain('XYZ987');
    expectNoPlaintext(['valor-desde-portapapeles-XYZ987', 'secreto-de-archivo-777']);
    ana.io.clipboard = '';
    await expect(envSet(ana.ctx, ['orwel', 'dev', 'VACIA', '--from-clipboard'])).rejects.toThrow(/vacío/);
  });
});

describe('operaciones en bloque', () => {
  it('grant --all da acceso a todo lo que tiene quien comparte; rotate --all rota lo marcado', async () => {
    const carla = machine(zeus, zeus.addDev('Carla').token, 'carla');
    await keyInit(carla.ctx, []);
    await envGrant(ana.ctx, ['--all', '--env', 'prod', '--to', 'Carla', '--yes']);
    expect(zeus.env('ORWEL', 'production')?.grants.size).toBe(3);
    expect(zeus.env('ORWEL', 'development')?.grants.size).toBe(2);

    const betoKey = await registered(beto);
    await envRevoke(ana.ctx, ['orwel', '--key', betoKey.keyId, '--yes']);
    await envRotate(ana.ctx, ['--all', '--yes']);
    expect(zeus.env('ORWEL', 'development')?.dekVersion).toBe(2);
    expect(zeus.env('ORWEL', 'production')?.dekVersion).toBe(1); // no estaba marcado
    await expect(envPull(beto.ctx, ['orwel', '--yes'])).rejects.toThrow(/acceso/);
  });
});

describe('key rotate', () => {
  it('cambia la llave del equipo, conserva los accesos y revoca la vieja', async () => {
    const before = await registered(beto);
    await keyRotate(beto.ctx, ['--yes']);
    const after = await registered(beto);
    expect(after.keyId).not.toBe(before.keyId);
    expect(zeus.keys.find((k) => k.id === before.keyId)?.revokedAt).toBeTruthy();
    await envPull(beto.ctx, ['orwel', 'prod', '--stdout', '--format', 'json']);
    expect(JSON.parse(beto.out.at(-1)!)).toEqual(PROD);
    expect(beto.fs.files.has(`${path.join(beto.ctx.home, 'key.json')}.old`)).toBe(true);
    expect(zeus.bodies.join('\n')).not.toContain(after.privateKey);
  });
});

describe('zeus guard', () => {
  it('bloquea leer .env desde Claude, pero no las plantillas ni los comandos inocuos', () => {
    for (const cmd of ['cat .env', 'type .env.production', 'Get-Content ./.env.local', 'grep KEY .env', 'zeus env pull orwel --stdout', 'echo x | zeus env set orwel dev A', 'zeus env ui']) {
      expect(checkBash(cmd).block, cmd).toBe(true);
    }
    for (const cmd of ['cat .env.example', 'ls -la .env', 'zeus env pull orwel --yes', 'git check-ignore .env', 'npm run dev', 'echo .env >> .gitignore', 'cat .envrc']) {
      expect(checkBash(cmd).block, cmd).toBe(false);
    }
    expect(checkTool('Read', { file_path: 'C:\\repo\\.env.production' }).block).toBe(true);
    expect(checkTool('Read', { file_path: '/repo/.env.example' }).block).toBe(false);
    expect(checkTool('Grep', { pattern: 'KEY', glob: '.env*' }).block).toBe(true);
    expect(isSecretEnvPath('.env.json')).toBe(true);
    expect(isSecretEnvPath('.env.production.bak')).toBe(true);
  });

  it('bloquea un mensaje con forma de secreto o con un valor de los .env de la carpeta', () => {
    // Armada en partes: escrita entera, el escáner de secretos de GitHub la toma por una llave real.
    const fakeStripe = ['sk', 'live', `51Hx${'0'.repeat(22)}`].join('_');
    expect(checkPrompt(`usa esta llave ${fakeStripe}`).block).toBe(true);
    expect(checkPrompt('la url es postgres://app:Sup3rClave@db:5432/x').block).toBe(true);
    expect(checkPrompt('-----BEGIN PRIVATE KEY-----\nabc').block).toBe(true);
    expect(checkPrompt('cambia el color del botón a naranja').block).toBe(false);
    expect(checkPrompt('es la anon key eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJlMTIz [zeus-ok]').block).toBe(false);
    const known = new Map([['INTERNAL_TOKEN', 'abc123def456ghi789'], ['DEBUG', 'true']]);
    const v = checkPrompt('oye, por qué falla con abc123def456ghi789?', known);
    expect(v).toMatchObject({ block: true });
    expect(v.reason).toContain('INTERNAL_TOKEN');
    expect(v.reason).not.toContain('abc123def456ghi789');
    expect(checkPrompt('pon DEBUG en true', known).block).toBe(false);
  });

  it('como hook: lee el evento de stdin, sale con 2 para bloquear y nunca truena', async () => {
    await envPull(beto.ctx, ['orwel', 'prod', '--yes']);
    beto.io.stdin = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: `revisa ${PROD.STRIPE_KEY}`, cwd: beto.ctx.cwd });
    beto.log.length = 0;
    expect(await guard(beto.ctx)).toBe(2);
    expect(beto.log.join('\n')).toMatch(/NO se envió/);
    beto.io.stdin = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(await guard(beto.ctx)).toBe(0);
    beto.io.stdin = 'esto no es json';
    expect(await guard(beto.ctx)).toBe(0);
  });

  it('al abrir sesión le da a Claude los pendientes de la bandeja y el estado de los .env', async () => {
    zeus.inboxOpen = [{ id: 'm1', kind: 'plan', from: 'Ana Admin', to: 'Beto Dev', subject: 'Migrar pagos a Stripe v2', status: 'pending', at: '2026-11-17T10:00:00Z' }];
    await envPull(beto.ctx, ['orwel', '--yes']);
    ana.io.clipboard = 'redis://cache:6379';
    await envSet(ana.ctx, ['orwel', 'dev', 'REDIS_URL', '--from-clipboard']);
    beto.io.stdin = JSON.stringify({ hook_event_name: 'SessionStart', cwd: beto.ctx.cwd });
    beto.out.length = 0;
    expect(await guard(beto.ctx)).toBe(0);
    const ctxText = beto.out.join('\n');
    expect(ctxText).toMatch(/\[plan\] Migrar pagos a Stripe v2 — de Ana Admin/);
    expect(ctxText).toMatch(/\.env \(ORWEL\/development\): 1 faltan/);
    const lines = await doctorReport(beto.ctx);
    expect(lines.join('\n')).toMatch(/conectado como Beto Dev/);
  });
});

describe('zeus setup claude', () => {
  it('agrega los hooks sin duplicar ni tocar lo demás, y registra el MCP', async () => {
    const settings = path.join(ana.ctx.cwd, '.claude', 'settings.json');
    ana.fs.files.set(settings, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mi-hook' }] }] } }));
    expect(await setup(ana.ctx, ['claude', '--project', '--yes'], 'zeus_' + 'x'.repeat(43))).toBe(0);
    const s = JSON.parse(ana.fs.files.get(settings)!);
    expect(s.model).toBe('opus');
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toBe('zeus guard');
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(ana.spawned.at(-1)).toMatchObject({ command: 'claude' });
    expect(ana.spawned.at(-1)!.args).toContain('--transport');
    // Correrlo otra vez no duplica.
    expect(withGuardHooks(s).added).toEqual([]);
  });
});

describe('zeus env ui', () => {
  it('solo responde con el token y el host correctos; muestra y cambia valores', async () => {
    const key = await registered(beto);
    const port = 4321;
    const handle = uiHandler(beto.ctx, key, 'tok-secreto', () => port);
    const req = (method: string, url: string, headers: Record<string, string> = {}, body = '') =>
      handle({ method, url, headers: { host: `127.0.0.1:${port}`, ...headers }, body });

    expect((await handle({ method: 'GET', url: '/', headers: { host: 'evil.com' }, body: '' })).status).toBe(421);
    expect((await req('GET', '/')).body).toContain('zeus · bóveda');
    expect((await req('GET', '/api/envs')).status).toBe(401);
    const envs = JSON.parse((await req('GET', '/api/envs', { 'x-zeus-ui': 'tok-secreto' })).body);
    expect(envs.envs.map((e: { env: string }) => e.env).sort()).toEqual(['development', 'production']);
    const env = JSON.parse((await req('GET', '/api/env?project=orwel&env=production', { 'x-zeus-ui': 'tok-secreto' })).body);
    expect(env.secrets.find((s: { name: string }) => s.name === 'STRIPE_KEY').value).toBe(PROD.STRIPE_KEY);

    const set = await req(
      'POST',
      '/api/set',
      { 'x-zeus-ui': 'tok-secreto', 'content-type': 'application/json' },
      JSON.stringify({ project: 'orwel', env: 'production', name: 'NUEVA', value: 'desde-el-visor-555' }),
    );
    expect(set.status).toBe(200);
    await envPull(ana.ctx, ['orwel', 'prod', '--stdout', '--format', 'json']);
    expect(JSON.parse(ana.out.at(-1)!).NUEVA).toBe('desde-el-visor-555');
    expectNoPlaintext(['desde-el-visor-555']);
  });
});
