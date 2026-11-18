// Aviso de CLI nuevo: compara versiones, consulta npm a lo más una vez al día, nunca tumba un comando
// si npm no responde, se puede apagar, y llega al contexto de Claude por el reporte de `doctor`.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorReport } from '../src/commands/doctor.js';
import { isNewer, latestCliVersion, updateNotice } from '../src/update.js';
import { FakeZeus, machine, type Machine } from './helpers.js';

function withNpm(m: Machine, answer: () => Promise<string | null>): { calls: number } {
  const seen = { calls: 0 };
  m.ctx.latestVersion = async () => {
    seen.calls++;
    return answer();
  };
  return seen;
}

function setup(): Machine {
  const zeus = new FakeZeus();
  return machine(zeus, zeus.addDev('Ana').token, 'ana');
}

describe('versiones', () => {
  it('compara x.y.z como números', () => {
    expect(isNewer('0.2.10', '0.2.9')).toBe(true);
    expect(isNewer('0.3.0', '0.2.9')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.2.2', '0.2.2')).toBe(false);
    expect(isNewer('0.2.1', '0.2.2')).toBe(false);
  });
});

describe('aviso de actualización', () => {
  it('avisa con el comando para actualizar cuando npm tiene una más nueva', async () => {
    const ana = setup();
    withNpm(ana, async () => '0.9.0');
    expect(await updateNotice(ana.ctx, '0.2.2')).toBe('hay una versión nueva del CLI de zeus: 0.9.0 (tienes 0.2.2). Actualiza con `npm i -g @hyperlabs-ai/zeus`');
    expect(await updateNotice(ana.ctx, '0.9.0')).toBeNull();
  });

  it('consulta npm a lo más una vez al día', async () => {
    const ana = setup();
    const npm = withNpm(ana, async () => '0.9.0');
    const t0 = new Date('2026-11-18T10:00:00Z');
    expect(await latestCliVersion(ana.ctx, t0)).toBe('0.9.0');
    expect(await latestCliVersion(ana.ctx, new Date('2026-11-18T20:00:00Z'))).toBe('0.9.0');
    expect(npm.calls).toBe(1);
    expect(JSON.parse(ana.fs.files.get(path.join(ana.ctx.home, 'update.json')) ?? '{}').latest).toBe('0.9.0');
    await latestCliVersion(ana.ctx, new Date('2026-11-19T11:00:00Z'));
    expect(npm.calls).toBe(2);
  });

  it('si npm falla no tumba nada ni reintenta en el día; ZEUS_NO_UPDATE_CHECK lo apaga', async () => {
    const ana = setup();
    const npm = withNpm(ana, async () => {
      throw new Error('sin red');
    });
    expect(await updateNotice(ana.ctx, '0.2.2')).toBeNull();
    expect(await updateNotice(ana.ctx, '0.2.2')).toBeNull();
    expect(npm.calls).toBe(1);

    const beto = setup();
    const npm2 = withNpm(beto, async () => '0.9.0');
    beto.ctx.env.ZEUS_NO_UPDATE_CHECK = '1';
    expect(await updateNotice(beto.ctx, '0.2.2')).toBeNull();
    expect(npm2.calls).toBe(0);
  });

  it('llega al contexto de Claude al abrir sesión (reporte breve de doctor)', async () => {
    const ana = setup();
    withNpm(ana, async () => '99.0.0');
    const lines = await doctorReport(ana.ctx, { brief: true });
    expect(lines[0]).toMatch(/versión nueva del CLI de zeus: 99\.0\.0/);
    expect(lines[0]).toMatch(/no lo actualices sin su permiso/);
  });
});
