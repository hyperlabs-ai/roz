import { beforeEach, describe, expect, it } from 'vitest';
import { envGrant, envInit, envRevoke, envRotate, selectKeys } from '../src/commands/admin.js';
import { login, mcp, whoami } from '../src/commands/auth.js';
import { envLs, envPull, envPush, envRm, envSet } from '../src/commands/env.js';
import { keyInit, keyShow } from '../src/commands/key.js';
import { run } from '../src/commands/run.js';
import { CliError, UsageError } from '../src/context.js';
import { parseDotenv } from '../src/dotenv.js';
import { configPath, keyPath, knownKeysPath, loadDeviceKey, type DeviceKeyFile } from '../src/store.js';
import type { VaultKey } from '../src/types.js';
import { FakeZeus, ZEUS_URL, machine, plaintextForms, type Machine } from './helpers.js';
import { ZeusClient } from '../src/api.js';

// Valores reconocibles: si alguno llegara al servidor, la búsqueda lo encuentra.
const SECRETS: Record<string, string> = {
  DATABASE_URL: 'postgres://roz:p4ssw0rd-MUY-secreta@db.interna:5432/roz',
  STRIPE_KEY: 'sk_live_51Hx_valor_de_prueba_QWERTY',
  CON_ESPACIOS: 'hola mundo # no es comentario',
  MULTILINEA: '-----BEGIN KEY-----\nMIIEvQIBADANBgkq\n-----END KEY-----',
  CON_COMILLAS: `it's "citado" $HOME \\ fin`,
  VACIA: '',
};

const ENV_FILE = [
  `DATABASE_URL=${SECRETS.DATABASE_URL}`,
  `STRIPE_KEY="${SECRETS.STRIPE_KEY}"`,
  `CON_ESPACIOS='${SECRETS.CON_ESPACIOS}'`,
  'MULTILINEA="-----BEGIN KEY-----\\nMIIEvQIBADANBgkq\\n-----END KEY-----"',
  'CON_COMILLAS="it\'s \\"citado\\" \\$HOME \\\\ fin"',
  'VACIA=',
  '',
].join('\n');

let zeus: FakeZeus;
let ana: Machine; // admin
let beto: Machine; // dev nuevo
let anaToken: string;
let betoToken: string;

async function key(m: Machine): Promise<DeviceKeyFile> {
  const k = await loadDeviceKey(m.fs, m.ctx.home);
  if (!k) throw new Error('sin llave');
  return k;
}

/** Ana crea ROZ/development y sube ENV_FILE. */
async function bootstrap(): Promise<void> {
  await keyInit(ana.ctx, []);
  await envInit(ana.ctx, ['ROZ']);
  ana.fs.files.set(ana.file('.env'), ENV_FILE);
  await envPush(ana.ctx, ['ROZ', '--yes']);
}

async function pulled(m: Machine, ...args: string[]): Promise<Map<string, string>> {
  await envPull(m.ctx, ['ROZ', ...args, '--yes']);
  return parseDotenv(m.fs.files.get(m.file('.env')) ?? '').vars;
}

/** Nada de lo que el servidor recibió o guarda contiene un valor, una DEK o una privada en claro. */
async function expectNoPlaintext(extra: string[] = []): Promise<void> {
  const seen = zeus.bodies.join('\n') + zeus.dump() + zeus.calls.join('\n');
  const privates = [(await key(ana)).privateKey];
  const betoKey = await loadDeviceKey(beto.fs, beto.ctx.home);
  if (betoKey) privates.push(betoKey.privateKey);
  for (const value of [...Object.values(SECRETS), ...extra, ...privates]) {
    for (const form of plaintextForms(value)) expect(seen.includes(form), `fuga de "${form.slice(0, 12)}…"`).toBe(false);
  }
}

beforeEach(() => {
  zeus = new FakeZeus();
  zeus.addProject('ROZ', 'roz');
  zeus.addProject('HYPERHUB', 'HyperHub');
  anaToken = zeus.addDev('Ana Admin', { admin: true }).token;
  betoToken = zeus.addDev('Beto Dev').token;
  ana = machine(zeus, anaToken, 'ana-laptop');
  beto = machine(zeus, betoToken, 'beto-pc');
});

describe('login / whoami / mcp', () => {
  const deps = (m: Machine, env: NodeJS.ProcessEnv = {}) => ({
    fs: m.fs,
    prompt: m.prompt,
    out: m.ctx.out,
    home: m.ctx.home,
    env,
    connect: (url: string, token: string) => new ZeusClient({ url, token, fetch: zeus.fetch }),
  });

  it('valida con whoami, guarda la config 0600 y no imprime el token', async () => {
    expect(await login(deps(ana), ['--url', `${ZEUS_URL}/`, '--token', anaToken])).toBe(0);
    const file = configPath(ana.ctx.home);
    expect(JSON.parse(ana.fs.files.get(file) ?? '')).toEqual({ url: ZEUS_URL, token: anaToken });
    expect(ana.fs.modes.get(file)).toBe(0o600);
    expect(ana.fs.dirs.has(ana.ctx.home)).toBe(true);
    expect(ana.printed()).toContain('Ana Admin');
    expect(ana.printed()).not.toContain(anaToken);
  });

  it('lee ZEUS_URL y ZEUS_TOKEN, y pregunta el token sin eco si falta', async () => {
    expect(await login(deps(ana, { ZEUS_URL, ZEUS_TOKEN: anaToken }), [])).toBe(0);
    beto.prompt.secretValue = betoToken;
    expect(await login(deps(beto), ['--url', ZEUS_URL])).toBe(0);
    expect(beto.prompt.questions.join()).toContain('Token de zeus');
  });

  it('un token mal formado o rechazado no guarda nada', async () => {
    await expect(login(deps(ana), ['--url', ZEUS_URL, '--token', 'rozr_abc'])).rejects.toThrow(/no parece un token de zeus/);
    const fake = `zeus_${'x'.repeat(43)}`;
    await expect(login(deps(ana), ['--url', ZEUS_URL, '--token', fake])).rejects.toThrow(/no se guardó nada/);
    expect(ana.fs.files.size).toBe(0);
    expect(ana.printed()).not.toContain(fake);
  });

  it('whoami muestra dev, admin y el estado de la llave', async () => {
    await whoami(ana.ctx);
    expect(ana.out.join('\n')).toMatch(/Ana Admin <ana\.admin@hyper\.test> · admin de zeus/);
    expect(ana.out.join('\n')).toContain('sin llave de la bóveda');
  });

  it('mcp imprime el comando de Claude Code con el token y avisa', async () => {
    await mcp(ana.ctx, anaToken);
    expect(ana.out).toEqual([`claude mcp add --transport http zeus ${ZEUS_URL}/mcp --header "Authorization: Bearer ${anaToken}"`]);
    expect(ana.log.join('\n')).toContain('token completo');
  });
});

describe('key init / show', () => {
  it('genera, guarda 0600, registra la pública y pide leer la huella', async () => {
    expect(await keyInit(ana.ctx, ['--name', 'laptop de Ana'])).toBe(0);
    const k = await key(ana);
    expect(ana.fs.modes.get(keyPath(ana.ctx.home))).toBe(0o600);
    expect(zeus.keys).toHaveLength(1);
    expect(zeus.keys[0]).toMatchObject({ name: 'laptop de Ana', publicKey: k.publicKey, fingerprint: k.fingerprint });
    expect(k.keyId).toBe(zeus.keys[0]?.id);
    expect(ana.printed()).toContain(k.fingerprint);
    expect(ana.printed()).toMatch(/EN VOZ ALTA/);
    expect(ana.printed()).not.toContain(k.privateKey);
    expect(zeus.bodies.join()).not.toContain(k.privateKey);
    expect(ana.printed()).not.toContain('Windows');
  });

  it('no pisa una llave existente sin --force; con --force respalda la anterior', async () => {
    await keyInit(ana.ctx, []);
    const first = await key(ana);
    await expect(keyInit(ana.ctx, [])).rejects.toThrow(/ya tiene llave/);
    expect((await key(ana)).publicKey).toBe(first.publicKey);

    await keyInit(ana.ctx, ['--force']);
    const second = await key(ana);
    expect(second.publicKey).not.toBe(first.publicKey);
    expect(JSON.parse(ana.fs.files.get(`${keyPath(ana.ctx.home)}.bak`) ?? '').publicKey).toBe(first.publicKey);
    expect(zeus.keys).toHaveLength(2);
  });

  it('si el registro falló, la llave queda en disco y el siguiente init registra la misma', async () => {
    const offline = machine(zeus, `zeus_${'x'.repeat(43)}`, 'ana-laptop');
    await expect(keyInit(offline.ctx, [])).rejects.toThrow(/token de zeus inválido/);
    const saved = await key(offline);
    expect(saved.keyId).toBeNull();

    ana.fs.files.set(keyPath(ana.ctx.home), offline.fs.files.get(keyPath(offline.ctx.home)) ?? '');
    await keyInit(ana.ctx, []);
    expect((await key(ana)).publicKey).toBe(saved.publicKey);
    expect(zeus.keys.map((k) => k.publicKey)).toEqual([saved.publicKey]);
  });

  it('en Windows avisa una vez que los permisos POSIX no aplican', async () => {
    const win = machine(zeus, anaToken, 'ana-win', 'win32');
    await keyInit(win.ctx, []);
    expect(win.out.filter((l) => l.includes('Windows'))).toHaveLength(1);
  });

  it('key show imprime pública, huella e id, nunca la privada', async () => {
    await keyInit(ana.ctx, []);
    ana.out.length = 0;
    await keyShow(ana.ctx);
    const k = await key(ana);
    expect(ana.out.join('\n')).toContain(k.publicKey);
    expect(ana.out.join('\n')).toContain(k.fingerprint);
    expect(ana.out.join('\n')).toContain(k.keyId);
    expect(ana.out.join('\n')).not.toContain(k.privateKey);
    await expect(keyShow(beto.ctx)).rejects.toThrow(/zeus key init/);
  });
});

describe('env init / ls', () => {
  it('crea el entorno con la DEK envuelta para este equipo', async () => {
    await keyInit(ana.ctx, []);
    expect(await envInit(ana.ctx, ['ROZ'])).toBe(0);
    const env = zeus.env('ROZ', 'development');
    expect(env?.dekVersion).toBe(1);
    expect([...(env?.grants.keys() ?? [])]).toEqual([(await key(ana)).keyId]);
    await expect(envInit(ana.ctx, ['ROZ'])).rejects.toThrow(/ya existe/);
  });

  it('usa la clave del proyecto como la conoce zeus aunque se escriba distinto', async () => {
    await keyInit(ana.ctx, []);
    await envInit(ana.ctx, ['roz', 'production']);
    ana.fs.files.set(ana.file('.env'), 'A=valor-de-produccion\n');
    await envPush(ana.ctx, ['Roz', 'production', '--yes']);
    await envPull(ana.ctx, ['ROZ', 'production', '--stdout']);
    expect(ana.out.at(-1)).toBe('A=valor-de-produccion');
  });

  it('rechaza nombres de entorno que el servidor no acepta', async () => {
    await keyInit(ana.ctx, []);
    await expect(envInit(ana.ctx, ['ROZ', 'Production'])).rejects.toThrow(UsageError);
    await expect(envInit(ana.ctx, ['ROZ', 'a:b'])).rejects.toThrow(UsageError);
  });

  it('un dev que no es admin no puede crear entornos', async () => {
    await keyInit(beto.ctx, []);
    await expect(envInit(beto.ctx, ['ROZ'])).rejects.toThrow(/administrador/);
  });

  it('ls muestra entornos y si este equipo tiene acceso', async () => {
    await bootstrap();
    await keyInit(beto.ctx, []);
    ana.out.length = 0;
    await envLs(ana.ctx);
    await envLs(beto.ctx);
    expect(ana.out.join('\n')).toMatch(/ROZ\/development\s+con acceso\s+llave v1/);
    expect(beto.out.join('\n')).toMatch(/ROZ\/development\s+sin acceso/);
    expect(beto.log.join('\n')).toContain((await key(beto)).fingerprint);
  });
});

describe('env push', () => {
  beforeEach(bootstrap);

  it('sube todo cifrado: el servidor nunca ve un valor', async () => {
    const env = zeus.env('ROZ', 'development');
    expect([...(env?.secrets.keys() ?? [])].sort()).toEqual(Object.keys(SECRETS).sort());
    for (const s of env?.secrets.values() ?? []) expect(s.ciphertext).toMatch(/^zs1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/);
    await expectNoPlaintext();
  });

  it('muestra solo nombres, y solo manda lo que cambió', async () => {
    ana.fs.files.set(ana.file('.env'), ENV_FILE.replace(SECRETS.STRIPE_KEY ?? '', 'sk_live_valor_NUEVO_zzz') + 'NUEVA=recien-agregada-123\n');
    zeus.bodies.length = 0;
    ana.log.length = 0;
    ana.prompt.answers = [true];
    await envPush(ana.ctx, ['ROZ']);

    const log = ana.log.join('\n');
    expect(log).toMatch(/\+ NUEVA\s+\(nueva\)/);
    expect(log).toMatch(/~ STRIPE_KEY\s+\(cambia de valor\)/);
    expect(log).not.toContain('DATABASE_URL');
    for (const v of ['sk_live_valor_NUEVO_zzz', 'recien-agregada-123', ...Object.values(SECRETS).filter(Boolean)]) expect(ana.printed()).not.toContain(v);
    expect(ana.prompt.questions).toHaveLength(1);

    const body = JSON.parse(zeus.bodies.at(-1) ?? '{}') as { dekVersion: number; set: Array<{ name: string }>; delete: string[] };
    expect(body.set.map((s) => s.name)).toEqual(['NUEVA', 'STRIPE_KEY']);
    expect(body.delete).toEqual([]);
    expect(body.dekVersion).toBe(1);
    await expectNoPlaintext(['sk_live_valor_NUEVO_zzz', 'recien-agregada-123']);
  });

  it('sin --prune nunca borra; con --prune borra lo que falta en el archivo', async () => {
    ana.fs.files.set(ana.file('.env'), `DATABASE_URL=${SECRETS.DATABASE_URL}\nOTRA=valor-de-otra-xyz\n`);
    ana.log.length = 0;
    await envPush(ana.ctx, ['ROZ', '--yes']);
    const env = zeus.env('ROZ', 'development');
    expect(env?.secrets.size).toBe(Object.keys(SECRETS).length + 1);
    expect(ana.log.join('\n')).toMatch(/= STRIPE_KEY\s+\(solo en la bóveda: no se toca/);

    ana.log.length = 0;
    await envPush(ana.ctx, ['ROZ', '--prune', '--yes']);
    expect([...(env?.secrets.keys() ?? [])].sort()).toEqual(['DATABASE_URL', 'OTRA']);
    expect(ana.log.join('\n')).toMatch(/- STRIPE_KEY\s+\(se BORRA de la bóveda\)/);
    expect(ana.out.at(-1)).toMatch(/0 escritas, 5 borradas/);
  });

  it('sin cambios no escribe ni pregunta', async () => {
    zeus.bodies.length = 0;
    ana.out.length = 0;
    await envPush(ana.ctx, ['ROZ']);
    expect(zeus.bodies).toHaveLength(0);
    expect(ana.prompt.questions).toHaveLength(0);
    expect(ana.out.join()).toContain('ya tiene lo mismo');
  });

  it('si la persona no confirma, no se sube nada', async () => {
    ana.fs.files.set(ana.file('.env'), `${ENV_FILE}X=1\n`);
    zeus.bodies.length = 0;
    ana.prompt.answers = [false];
    await expect(envPush(ana.ctx, ['ROZ'])).rejects.toThrow(/cancelado/);
    expect(zeus.bodies).toHaveLength(0);

    ana.prompt.interactive = false;
    await expect(envPush(ana.ctx, ['ROZ'])).rejects.toThrow(/--yes/);
  });

  it('el bloque local no se sube', async () => {
    ana.fs.files.set(ana.file('.env'), `${ENV_FILE}\n# >>> local\nPORT=4000\nDATABASE_URL=postgres://solo-mi-maquina-777\n# <<< local\n`);
    zeus.bodies.length = 0;
    ana.out.length = 0;
    await envPush(ana.ctx, ['ROZ', '--yes']);
    expect(zeus.bodies).toHaveLength(0);
    expect(zeus.env('ROZ', 'development')?.secrets.has('PORT')).toBe(false);
  });

  it('un archivo con nombres inválidos, líneas ilegibles o que no existe no sube nada', async () => {
    zeus.bodies.length = 0;
    ana.fs.files.set(ana.file('.env'), 'MAL-NOMBRE=valor-xyz-123\nBIEN=1\n');
    await expect(envPush(ana.ctx, ['ROZ', '--yes'])).rejects.toThrow(/MAL-NOMBRE: nombre inválido/);
    ana.fs.files.set(ana.file('.env'), 'BIEN=1\nesto no es una asignacion\nROTA="sin cerrar\n');
    await expect(envPush(ana.ctx, ['ROZ', '--yes'])).rejects.toThrow(/línea 2.*línea 3/);
    ana.fs.files.set(ana.file('.env'), `GRANDE=${'x'.repeat(64 * 1024 + 1)}\n`);
    await expect(envPush(ana.ctx, ['ROZ', '--yes'])).rejects.toThrow(/64 KiB/);
    await expect(envPush(ana.ctx, ['ROZ', '--from', 'no-existe.env'])).rejects.toThrow(/no existe/);
    expect(zeus.bodies).toHaveLength(0);
    try {
      ana.fs.files.set(ana.file('.env'), 'MAL-NOMBRE=valor-xyz-123\n');
      await envPush(ana.ctx, ['ROZ', '--yes']);
    } catch (err) {
      expect((err as Error).message).not.toContain('valor-xyz-123');
    }
  });

  it('409 ZEUS_VAULT_STALE pide volver a bajar', async () => {
    ana.fs.files.set(ana.file('.env'), `${ENV_FILE}X=1\n`);
    zeus.failNextWriteAsStale = true;
    await expect(envPush(ana.ctx, ['ROZ', '--yes'])).rejects.toThrow(/zeus env pull ROZ development/);
  });

  it('--from lee otro archivo', async () => {
    ana.fs.files.set(ana.file('prod.env'), 'SOLO_PROD=valor-prod-abc\n');
    await envPush(ana.ctx, ['ROZ', '--from', 'prod.env', '--yes']);
    expect(zeus.env('ROZ', 'development')?.secrets.has('SOLO_PROD')).toBe(true);
  });
});

describe('env pull', () => {
  beforeEach(bootstrap);

  it('descifra todo y lo escribe como .env que se lee idéntico', async () => {
    ana.fs.files.delete(ana.file('.env'));
    const vars = await pulled(ana);
    expect(Object.fromEntries(vars)).toEqual(SECRETS);
    expect(ana.fs.modes.get(ana.file('.env'))).toBe(0o600);
    expect(ana.fs.files.has(ana.file('.env.bak'))).toBe(false);
    for (const v of Object.values(SECRETS).filter(Boolean)) expect(ana.printed()).not.toContain(v);
    await expectNoPlaintext();
  });

  it('si el archivo ya está al día no lo toca', async () => {
    const before = ana.fs.files.get(ana.file('.env'));
    ana.out.length = 0;
    await envPull(ana.ctx, ['ROZ']);
    expect(ana.fs.files.get(ana.file('.env'))).toBe(before);
    expect(ana.out.join()).toContain('ya está al día');
    expect(ana.prompt.questions).toHaveLength(0);
  });

  it('si difiere: diff de nombres, confirmación, respaldo .bak y bloque local intacto', async () => {
    const local = '# >>> local\n# mi puerto\nPORT=4000\nDATABASE_URL="postgres://localhost/mio"\n# <<< local';
    const previous = `DATABASE_URL=postgres://viejo-valor-000\nSOBRA=valor-que-sobra-111\n\n${local}\n`;
    ana.fs.files.set(ana.file('.env'), previous);
    ana.log.length = 0;

    ana.prompt.answers = [false];
    await expect(envPull(ana.ctx, ['ROZ'])).rejects.toThrow(/cancelado/);
    expect(ana.fs.files.get(ana.file('.env'))).toBe(previous);

    ana.prompt.answers = [true];
    ana.log.length = 0;
    expect(await envPull(ana.ctx, ['ROZ'])).toBe(0);
    const log = ana.log.join('\n');
    expect(log).toMatch(/\+ STRIPE_KEY\s+\(nueva\)/);
    expect(log).toMatch(/~ DATABASE_URL\s+\(cambia de valor\)/);
    expect(log).toMatch(/- SOBRA\s+\(no está en la bóveda/);
    for (const v of ['viejo-valor-000', 'valor-que-sobra-111', 'localhost/mio', ...Object.values(SECRETS).filter(Boolean)]) {
      expect(ana.printed()).not.toContain(v);
    }

    const written = ana.fs.files.get(ana.file('.env')) ?? '';
    expect(written.endsWith(`\n${local}\n`)).toBe(true);
    expect(ana.fs.files.get(ana.file('.env.bak'))).toBe(previous);
    expect(ana.fs.modes.get(ana.file('.env.bak'))).toBe(0o600);
    const parsed = parseDotenv(written);
    expect(Object.fromEntries(parsed.vars)).toEqual(SECRETS);
    expect(parsed.localNames).toEqual(['PORT', 'DATABASE_URL']);

    // Y un segundo pull ya no encuentra diferencias.
    ana.out.length = 0;
    await envPull(ana.ctx, ['ROZ']);
    expect(ana.out.join()).toContain('ya está al día');
  });

  it('sin terminal y sin --yes no sobreescribe', async () => {
    ana.fs.files.set(ana.file('.env'), 'OTRA=1\n');
    ana.prompt.interactive = false;
    await expect(envPull(ana.ctx, ['ROZ'])).rejects.toThrow(/--yes/);
    expect(ana.fs.files.get(ana.file('.env'))).toBe('OTRA=1\n');
  });

  it('--stdout no escribe a disco; --format json y --out', async () => {
    ana.fs.files.delete(ana.file('.env'));
    ana.out.length = 0;
    await envPull(ana.ctx, ['ROZ', '--stdout']);
    expect(Object.fromEntries(parseDotenv(ana.out.join('\n')).vars)).toEqual(SECRETS);
    expect(ana.fs.files.has(ana.file('.env'))).toBe(false);

    ana.out.length = 0;
    await envPull(ana.ctx, ['ROZ', '--stdout', '--format', 'json']);
    expect(JSON.parse(ana.out.join('\n'))).toEqual(SECRETS);

    await envPull(ana.ctx, ['ROZ', 'development', '--out', 'config/secretos.json', '--format', 'json']);
    expect(JSON.parse(ana.fs.files.get(ana.file('config/secretos.json')) ?? '')).toEqual(SECRETS);
    await expect(envPull(ana.ctx, ['ROZ', '--format', 'yaml'])).rejects.toThrow(UsageError);
  });

  it('sin acceso o sin llave falla con instrucciones', async () => {
    await expect(envPull(beto.ctx, ['ROZ'])).rejects.toThrow(/zeus key init/);
    await keyInit(beto.ctx, []);
    await expect(envPull(beto.ctx, ['ROZ'])).rejects.toThrow(/no tiene acceso/);
    await expect(envPull(ana.ctx, ['ROZ', 'staging'])).rejects.toThrow(/no tiene el entorno/);
  });

  it('un texto cifrado movido de nombre por el servidor se detecta', async () => {
    const env = zeus.env('ROZ', 'development');
    const a = env?.secrets.get('DATABASE_URL');
    const b = env?.secrets.get('STRIPE_KEY');
    if (!env || !a || !b) throw new Error('faltan secretos');
    env.secrets.set('DATABASE_URL', { ...a, ciphertext: b.ciphertext });
    await expect(envPull(ana.ctx, ['ROZ', '--stdout'])).rejects.toThrow(/DATABASE_URL: no se pudo descifrar/);
  });

  it('una DEK envuelta de otro entorno no abre', async () => {
    await envInit(ana.ctx, ['ROZ', 'production']);
    const dev = zeus.env('ROZ', 'development');
    const prod = zeus.env('ROZ', 'production');
    const keyId = (await key(ana)).keyId ?? '';
    const prodGrant = prod?.grants.get(keyId);
    if (!dev || !prodGrant) throw new Error('faltan grants');
    dev.grants.set(keyId, prodGrant);
    await expect(envPull(ana.ctx, ['ROZ', '--stdout'])).rejects.toThrow(/no se pudo abrir la llave del entorno/);
  });
});

describe('env set / rm', () => {
  beforeEach(bootstrap);

  it('set toma el valor del prompt sin eco (o stdin), nunca de argv', async () => {
    ana.prompt.secretValue = 'whsec_valor_de_webhook_998877';
    ana.out.length = 0;
    expect(await envSet(ana.ctx, ['ROZ', 'development', 'WEBHOOK_SECRET'])).toBe(0);
    expect(ana.out.join()).toContain('WEBHOOK_SECRET creada');
    expect((await pulled(ana)).get('WEBHOOK_SECRET')).toBe('whsec_valor_de_webhook_998877');
    expect(ana.printed()).not.toContain('whsec_valor_de_webhook_998877');
    await expectNoPlaintext(['whsec_valor_de_webhook_998877']);

    await expect(envSet(ana.ctx, ['ROZ', 'development', 'X', 'valor-en-argv'])).rejects.toThrow(UsageError);
    await expect(envSet(ana.ctx, ['ROZ', 'development', '9X'])).rejects.toThrow(/nombre inválido/);
  });

  it('set no acepta un valor vacío por accidente', async () => {
    ana.prompt.secretValue = '';
    await expect(envSet(ana.ctx, ['ROZ', 'development', 'STRIPE_KEY'])).rejects.toThrow(/vacío/);
    await envSet(ana.ctx, ['ROZ', 'development', 'STRIPE_KEY', '--empty']);
    expect((await pulled(ana)).get('STRIPE_KEY')).toBe('');
  });

  it('rm confirma y borra solo ese nombre', async () => {
    ana.prompt.answers = [false];
    await expect(envRm(ana.ctx, ['ROZ', 'development', 'STRIPE_KEY'])).rejects.toThrow(/cancelado/);
    expect(zeus.env('ROZ', 'development')?.secrets.has('STRIPE_KEY')).toBe(true);
    await envRm(ana.ctx, ['ROZ', 'development', 'STRIPE_KEY', '--yes']);
    expect(zeus.env('ROZ', 'development')?.secrets.has('STRIPE_KEY')).toBe(false);
    expect(zeus.env('ROZ', 'development')?.secrets.size).toBe(Object.keys(SECRETS).length - 1);
    await expect(envRm(ana.ctx, ['ROZ', 'development', 'NO_EXISTE', '--yes'])).rejects.toThrow(/no tiene NO_EXISTE/);
  });
});

describe('env grant', () => {
  beforeEach(async () => {
    await bootstrap();
    await keyInit(beto.ctx, []);
  });

  it('muestra nombre y huella, pide confirmar la verificación y envuelve la DEK para ese equipo', async () => {
    const betoKey = await key(beto);
    ana.log.length = 0;
    ana.prompt.answers = [true];
    expect(await envGrant(ana.ctx, ['ROZ', '--to', 'beto dev'])).toBe(0);
    expect(ana.log.join('\n')).toContain(`Beto Dev · equipo "beto-pc" · huella ${betoKey.fingerprint}`);
    expect(ana.prompt.questions.at(-1)).toMatch(/canal distinto a zeus/);

    expect(Object.fromEntries(await pulled(beto))).toEqual(SECRETS);
    expect(JSON.parse(ana.fs.files.get(knownKeysPath(ana.ctx.home)) ?? '{}')).toMatchObject({ [betoKey.keyId ?? '']: betoKey.fingerprint });
    await expectNoPlaintext();
  });

  it('la DEK envuelta para Beto no la abre Ana ni viceversa (cada equipo su sobre)', async () => {
    await envGrant(ana.ctx, ['ROZ', '--to', (await key(beto)).keyId ?? '', '--yes']);
    const env = zeus.env('ROZ', 'development');
    const anaId = (await key(ana)).keyId ?? '';
    const betoId = (await key(beto)).keyId ?? '';
    const [a, b] = [env?.grants.get(anaId), env?.grants.get(betoId)];
    if (!env || !a || !b) throw new Error('faltan grants');
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    env.grants.set(anaId, b);
    await expect(envPull(ana.ctx, ['ROZ', '--stdout'])).rejects.toThrow(/no se pudo abrir la llave del entorno/);
  });

  it('si no se confirma la huella no se da acceso', async () => {
    ana.prompt.answers = [false];
    await expect(envGrant(ana.ctx, ['ROZ', '--to', 'Beto'])).rejects.toThrow(/cancelado/);
    expect(zeus.env('ROZ', 'development')?.grants.size).toBe(1);
    await expect(envPull(beto.ctx, ['ROZ'])).rejects.toThrow(/no tiene acceso/);
  });

  it('con varios equipos exige elegir uno o --all-devices', async () => {
    const beto2 = machine(zeus, betoToken, 'beto-laptop');
    await keyInit(beto2.ctx, []);
    await expect(envGrant(ana.ctx, ['ROZ', '--to', 'Beto', '--yes'])).rejects.toThrow(/tiene 2 equipos/);
    expect(ana.log.join('\n')).toContain((await key(beto2)).fingerprint);

    await envGrant(ana.ctx, ['ROZ', '--to', (await key(beto2)).keyId ?? '', '--yes']);
    expect(zeus.env('ROZ', 'development')?.grants.size).toBe(2);
    await expect(envPull(beto.ctx, ['ROZ'])).rejects.toThrow(/no tiene acceso/);

    ana.out.length = 0;
    await envGrant(ana.ctx, ['ROZ', '--to', 'Beto', '--all-devices', '--yes']);
    expect(zeus.env('ROZ', 'development')?.grants.size).toBe(3);
    expect(ana.out.at(-1)).toContain('1 equipo(s)');
    expect(Object.fromEntries(await pulled(beto))).toEqual(SECRETS);
    expect(Object.fromEntries(await pulled(beto2))).toEqual(SECRETS);

    ana.out.length = 0;
    await envGrant(ana.ctx, ['ROZ', '--to', 'Beto', '--all-devices', '--yes']);
    expect(ana.out.at(-1)).toContain('nada que hacer');
  });

  it('si zeus reporta una huella que no corresponde a la pública, no sigue', async () => {
    const k = zeus.keys.find((x) => x.devName === 'Beto Dev');
    if (k) k.fingerprint = '0000-0000-0000-0000';
    await expect(envGrant(ana.ctx, ['ROZ', '--to', 'Beto', '--yes'])).rejects.toThrow(/no corresponde a su llave pública/);
  });

  it('un dev sin permisos de admin no puede dar acceso', async () => {
    await envGrant(ana.ctx, ['ROZ', '--to', 'Beto', '--yes']);
    zeus.addDev('Caro Dev');
    await expect(envGrant(beto.ctx, ['ROZ', '--to', 'Caro', '--yes'])).rejects.toThrow(/administrador/);
  });

  it('selectKeys: por id de llave, id de dev, nombre, y correo solo si zeus lo manda', () => {
    const k = (id: string, devId: string, devName: string, devEmail?: string): VaultKey => ({
      id,
      devId,
      devName,
      name: 'pc',
      publicKey: '',
      fingerprint: '',
      lastUsedAt: null,
      revokedAt: null,
      createdAt: '',
      ...(devEmail ? { devEmail } : {}),
    });
    const keys = [k('k1', 'd1', 'Beto Dev'), k('k2', 'd1', 'Beto Dev'), k('k3', 'd2', 'Berta Ruiz')];
    expect(selectKeys(keys, 'k2')).toEqual({ keys: [keys[1]], byKeyId: true });
    expect(selectKeys(keys, 'd1').keys).toHaveLength(2);
    expect(selectKeys(keys, 'berta').keys).toEqual([keys[2]]);
    expect(() => selectKeys(keys, 'be')).toThrow(/varias personas/);
    expect(() => selectKeys(keys, 'nadie')).toThrow(/zeus key init/);
    expect(() => selectKeys(keys, 'beto@hyper.test')).toThrow(/no manda el correo/);
    expect(selectKeys([...keys, k('k4', 'd3', 'Caro', 'Caro@hyper.test')], 'caro@hyper.test').keys.map((x) => x.id)).toEqual(['k4']);
  });
});

describe('env revoke / rotate', () => {
  beforeEach(async () => {
    await bootstrap();
    await keyInit(beto.ctx, []);
    await envGrant(ana.ctx, ['ROZ', '--to', 'Beto', '--yes']);
  });

  it('revoke quita el acceso y avisa que hay que rotar', async () => {
    const betoId = (await key(beto)).keyId ?? '';
    ana.log.length = 0;
    expect(await envRevoke(ana.ctx, ['ROZ', '--key', betoId, '--yes'])).toBe(0);
    expect(ana.log.join('\n')).toMatch(/ya vio los valores/);
    expect(ana.log.join('\n')).toContain('zeus env rotate ROZ development');
    expect(ana.log.join('\n')).toMatch(/proveedor/);
    await expect(envPull(beto.ctx, ['ROZ'])).rejects.toThrow(/no tiene acceso/);
    await expect(envRevoke(ana.ctx, ['ROZ', '--yes'])).rejects.toThrow(UsageError);
  });

  it('rotate: DEK nueva para todos los accesos vigentes y todo re-cifrado con la versión nueva', async () => {
    const env = zeus.env('ROZ', 'development');
    const before = new Map([...(env?.secrets ?? [])].map(([n, s]) => [n, s.ciphertext]));
    const wrappedBefore = new Map([...(env?.grants ?? [])].map(([id, g]) => [id, g.wrappedDek]));
    ana.log.length = 0;
    ana.prompt.answers = [true];

    expect(await envRotate(ana.ctx, ['ROZ'])).toBe(0);
    expect(env?.dekVersion).toBe(2);
    expect(env?.secrets.size).toBe(before.size);
    for (const [name, s] of env?.secrets ?? []) {
      expect(s.dekVersion).toBe(2);
      expect(s.ciphertext).not.toBe(before.get(name));
    }
    expect(env?.grants.size).toBe(2);
    for (const [id, g] of env?.grants ?? []) expect(g.wrappedDek).not.toBe(wrappedBefore.get(id));
    expect(ana.log.join('\n')).toContain((await key(beto)).fingerprint);
    expect(ana.log.join('\n')).toMatch(/NO cambia los secretos en su proveedor/);

    expect(Object.fromEntries(await pulled(ana))).toEqual(SECRETS);
    expect(Object.fromEntries(await pulled(beto))).toEqual(SECRETS);
    await expectNoPlaintext();
  });

  it('un texto cifrado de la versión anterior ya no descifra tras rotar', async () => {
    const env = zeus.env('ROZ', 'development');
    const old = env?.secrets.get('STRIPE_KEY');
    await envRotate(ana.ctx, ['ROZ', '--yes']);
    const now = env?.secrets.get('STRIPE_KEY');
    if (!env || !old || !now) throw new Error('faltan secretos');
    env.secrets.set('STRIPE_KEY', { ...now, ciphertext: old.ciphertext });
    await expect(envPull(ana.ctx, ['ROZ', '--stdout'])).rejects.toThrow(/STRIPE_KEY: no se pudo descifrar/);
  });

  it('después de revocar y rotar, el equipo revocado se queda fuera y no puede leer lo nuevo', async () => {
    const betoId = (await key(beto)).keyId ?? '';
    await envRevoke(ana.ctx, ['ROZ', '--key', betoId, '--yes']);
    await envRotate(ana.ctx, ['ROZ', '--yes']);
    const env = zeus.env('ROZ', 'development');
    expect([...(env?.grants.keys() ?? [])]).toEqual([(await key(ana)).keyId]);
    await expect(envPull(beto.ctx, ['ROZ'])).rejects.toThrow(/no tiene acceso/);
    expect(ana.out.at(-1)).toMatch(/v2; 6 secreto\(s\) y 1 acceso\(s\)/);
  });

  it('push con la versión vieja después de rotar: el CLI usa la vigente', async () => {
    await envRotate(ana.ctx, ['ROZ', '--yes']);
    beto.fs.files.set(beto.file('.env'), `${ENV_FILE}DE_BETO=valor-de-beto-456\n`);
    await envPush(beto.ctx, ['ROZ', '--yes']);
    expect(zeus.env('ROZ', 'development')?.secrets.get('DE_BETO')?.dekVersion).toBe(2);
    expect((await pulled(ana)).get('DE_BETO')).toBe('valor-de-beto-456');
    await expectNoPlaintext(['valor-de-beto-456']);
  });

  it('si no se confirma, o el servidor responde 409, no cambia nada', async () => {
    ana.prompt.answers = [false];
    await expect(envRotate(ana.ctx, ['ROZ'])).rejects.toThrow(/cancelado/);
    zeus.failNextWriteAsStale = true;
    await expect(envRotate(ana.ctx, ['ROZ', '--yes'])).rejects.toThrow(/zeus env pull/);
    expect(zeus.env('ROZ', 'development')?.dekVersion).toBe(1);
  });

  it('si el servidor cambia la pública de una llave ya verificada, rotate se niega', async () => {
    const impostor = machine(zeus, betoToken, 'impostor');
    await keyInit(impostor.ctx, []);
    const fake = await key(impostor);
    const real = zeus.keys.find((k) => k.name === 'beto-pc');
    if (!real) throw new Error('sin llave de beto');
    real.publicKey = fake.publicKey;
    real.fingerprint = fake.fingerprint;
    zeus.bodies.length = 0;
    await expect(envRotate(ana.ctx, ['ROZ', '--yes'])).rejects.toThrow(/ya NO es la que verificaste/);
    expect(zeus.bodies).toHaveLength(0);
    expect(zeus.env('ROZ', 'development')?.dekVersion).toBe(1);
  });

  it('marca las llaves que este equipo no verificó', async () => {
    ana.fs.files.delete(knownKeysPath(ana.ctx.home));
    ana.log.length = 0;
    await envRotate(ana.ctx, ['ROZ', '--yes']);
    expect(ana.log.join('\n')).toMatch(/Beto Dev.*no verificada en este equipo/);
    expect(ana.log.join('\n')).toMatch(/este equipo$/m);
  });

  it('un dev que no es admin no puede rotar ni revocar', async () => {
    await expect(envRotate(beto.ctx, ['ROZ', '--yes'])).rejects.toThrow(/administrador/);
    await expect(envRevoke(beto.ctx, ['ROZ', '--key', (await key(ana)).keyId ?? '', '--yes'])).rejects.toThrow(/administrador/);
    expect(zeus.env('ROZ', 'development')?.dekVersion).toBe(1);
  });
});

describe('run', () => {
  beforeEach(bootstrap);

  it('inyecta los secretos por el entorno del hijo, no por argumentos ni a disco, y propaga el código', async () => {
    const files = new Map(ana.fs.files);
    expect(await run(ana.ctx, ['ROZ', '--', 'npm', 'run', 'dev', '--', '--port', '3000'])).toBe(7);
    expect(ana.spawned).toHaveLength(1);
    const call = ana.spawned[0];
    expect(call?.command).toBe('npm');
    expect(call?.args).toEqual(['run', 'dev', '--', '--port', '3000']);
    expect(call?.env).toMatchObject({ ...SECRETS, PATH: '/usr/bin' });
    expect(new Map(ana.fs.files)).toEqual(files);
    expect(ana.printed()).not.toContain(SECRETS.STRIPE_KEY);
  });

  it('sin comando o con opciones de más es error de uso', async () => {
    await expect(run(ana.ctx, ['ROZ'])).rejects.toThrow(UsageError);
    await expect(run(ana.ctx, ['ROZ', '--'])).rejects.toThrow(UsageError);
    await expect(run(ana.ctx, ['--', 'node'])).rejects.toThrow(UsageError);
    expect(ana.spawned).toHaveLength(0);
  });
});

describe('errores', () => {
  it('son CliError con código 1 y los de uso con código 2', async () => {
    const err = await envPull(ana.ctx, ['ROZ']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(1);
    const usage = await envPull(ana.ctx, ['ROZ', '--no-existe']).catch((e: unknown) => e);
    expect((usage as CliError).exitCode).toBe(2);
    expect((usage as Error).message).toMatch(/opciones inválidas/);
  });
});
