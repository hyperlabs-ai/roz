// `zeus setup`: un comando que deja la PC lista (CLI, cuenta por navegador, llave, hooks y MCP), con
// todo lo de afuera falso: zeus en memoria (con la "persona en el navegador" que aprueba o rechaza),
// npm y claude como procesos que se registran, y un reloj que avanza con cada espera.
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZeusClient } from '../src/api.js';
import { setup, type SetupDeps } from '../src/commands/setup.js';
import { CliError } from '../src/context.js';
import { configPath, loadDeviceKey, type ZeusConfig } from '../src/store.js';
import { VERSION } from '../src/version.js';
import { FakeZeus, ZEUS_URL, machine, type Machine } from './helpers.js';

let zeus: FakeZeus;
let pc: Machine;
let clock: number;
let installed: string[];

function deps(config: ZeusConfig | null = null): SetupDeps {
  return {
    config,
    connect: (url, token) => new ZeusClient({ url, token, fetch: zeus.fetch }),
    device: (url) => new ZeusClient({ url, token: '', fetch: zeus.fetch }),
    sleep: async (ms) => {
      clock += ms;
    },
    which: (cmd) => (installed.includes(cmd) ? `/usr/local/bin/${cmd}` : null),
    now: () => clock,
  };
}

const settingsFile = () => path.join('/home/pc-nueva', '.claude', 'settings.json');
const savedConfig = (): ZeusConfig | null => {
  const raw = pc.fs.files.get(configPath(pc.ctx.home));
  return raw ? (JSON.parse(raw) as ZeusConfig) : null;
};

beforeEach(() => {
  zeus = new FakeZeus();
  zeus.addDev('Ana');
  // Una PC recién llegada: sin config, sin llave, corriendo por npx y sin terminal (como Claude Code).
  pc = machine(zeus, '', 'pc-nueva');
  pc.ctx.env = { PATH: '/usr/bin', HOME: '/home/pc-nueva', ZEUS_URL };
  pc.prompt.interactive = false;
  const spawn = pc.ctx.spawn;
  pc.ctx.spawn = async (cmd, args, env, opts) => (await spawn(cmd, args, env, opts), 0);
  clock = 0;
  installed = ['claude'];
});

describe('zeus setup', () => {
  it('PC nueva por npx con --yes: instala, aprueba en el navegador, crea la llave y conecta Claude Code', async () => {
    zeus.browser = { devName: 'Ana', afterPolls: 3, decision: 'approve' };
    expect(await setup(pc.ctx, ['--yes'], deps())).toBe(0);

    // 1. CLI global, en la misma versión que corre.
    expect(pc.spawned[0]).toMatchObject({ command: 'npm', args: ['i', '-g', `@hyperlabs-ai/zeus@${VERSION}`] });
    // 2. Login por navegador: abrió la página con el código y guardó el token que entregó zeus.
    expect(pc.io.opened).toEqual([`https://roz.test/conectar?code=${zeus.devices[0]!.userCode}`]);
    expect(zeus.devices[0]).toMatchObject({ clientName: 'pc-nueva', status: 'delivered', polls: 3 });
    expect(pc.out.join('\n')).toContain(`Código: ${zeus.devices[0]!.userCode}`);
    const ana = zeus.devs[0]!;
    expect(savedConfig()).toEqual({ url: ZEUS_URL, token: ana.token });
    // 3. Llave registrada con el nombre del equipo.
    const key = await loadDeviceKey(pc.fs, pc.ctx.home);
    expect(key).toMatchObject({ name: 'pc-nueva', url: ZEUS_URL });
    expect(zeus.keys.map((k) => k.name)).toEqual(['pc-nueva']);
    // 4. Hooks en el settings.json del usuario.
    const s = JSON.parse(pc.fs.files.get(settingsFile())!);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe('zeus guard');
    // 5. MCP con el MISMO token, quitando antes el anterior, y sin imprimir la salida (lleva el token).
    const claude = pc.spawned.filter((x) => x.command === 'claude');
    expect(claude.map((x) => x.args.slice(0, 2))).toEqual([['mcp', 'remove'], ['mcp', 'add']]);
    expect(claude[1]!.args).toContain(`Authorization: Bearer ${ana.token}`);
    expect(claude[1]!.args).toContain(`${ZEUS_URL}/mcp`);
    expect(claude.every((x) => x.quiet)).toBe(true);
    // El token nunca se imprime completo.
    expect(pc.printed()).not.toContain(ana.token);

    const out = pc.out.join('\n');
    for (const label of ['CLI', 'cuenta', 'llave', 'hooks', 'MCP']) expect(out).toMatch(new RegExp(`✓ ${label}`));
    expect(out).toContain('/mcp__zeus__pendientes');
  });

  it('idempotente: con todo hecho no vuelve a pedir login, ni instala, ni crea otra llave', async () => {
    zeus.browser = { devName: 'Ana', afterPolls: 1, decision: 'approve' };
    await setup(pc.ctx, ['--yes'], deps());
    installed.push('zeus');
    const spawnedBefore = pc.spawned.length;

    expect(await setup(pc.ctx, ['--yes'], deps(savedConfig()))).toBe(0);
    expect(zeus.devices).toHaveLength(1);
    expect(zeus.keys).toHaveLength(1);
    expect(pc.spawned.slice(spawnedBefore).some((x) => x.command === 'npm')).toBe(false);
    expect(pc.log.join('\n')).toMatch(/ya conectado como Ana/);
    expect(pc.log.join('\n')).toMatch(/ya estaban en/);
  });

  it('una config con token revocado vuelve a pedir aprobación', async () => {
    installed.push('zeus');
    zeus.browser = { devName: 'Ana', afterPolls: 1, decision: 'approve' };
    expect(await setup(pc.ctx, ['--yes'], deps({ url: ZEUS_URL, token: 'zeus_' + 'r'.repeat(43) }))).toBe(0);
    expect(zeus.devices).toHaveLength(1);
    expect(savedConfig()?.token).toBe(zeus.devs[0]!.token);
  });

  it('rechazada en el navegador: falla sin guardar nada', async () => {
    zeus.browser = { devName: 'Ana', afterPolls: 2, decision: 'deny' };
    await expect(setup(pc.ctx, ['--yes'], deps())).rejects.toThrow(/rechazó/);
    expect(savedConfig()).toBeNull();
    expect(await loadDeviceKey(pc.fs, pc.ctx.home)).toBeNull();
  });

  it('si nadie aprueba en 10 minutos, vence', async () => {
    zeus.browser = { devName: 'Ana', afterPolls: 1, decision: 'never' };
    await expect(setup(pc.ctx, ['--yes', '--no-browser'], deps())).rejects.toThrow(/venció/);
    expect(pc.io.opened).toEqual([]);
    expect(clock).toBeGreaterThan(600_000);
    expect(savedConfig()).toBeNull();
  });

  it('sin terminal y sin --yes pide --yes en vez de quedarse esperando', async () => {
    await expect(setup(pc.ctx, [], deps())).rejects.toBeInstanceOf(CliError);
    expect(pc.spawned).toEqual([]);
  });

  it('sin Claude Code: deja el resto listo y dice qué falta', async () => {
    installed = ['zeus'];
    zeus.browser = { devName: 'Ana', afterPolls: 1, decision: 'approve' };
    expect(await setup(pc.ctx, ['--yes'], deps())).toBe(0);
    expect(pc.spawned.some((x) => x.command === 'claude')).toBe(false);
    expect(pc.out.join('\n')).toMatch(/! MCP +falta Claude Code/);
  });

  it('`setup claude` sigue funcionando y otras palabras no', async () => {
    zeus.browser = { devName: 'Ana', afterPolls: 1, decision: 'approve' };
    expect(await setup(pc.ctx, ['claude', '--yes'], deps())).toBe(0);
    await expect(setup(pc.ctx, ['otra-cosa'], deps())).rejects.toThrow(/uso: zeus setup/);
  });
});
