import { describe, it, expect, vi } from 'vitest';

// El bug que motivó esto: un deploy fallido se guardaba como servicio caído. Aquí se fija la
// separación: la salud sale de lo que SIRVE producción; el último intento va aparte.

vi.mock('../src/config.js', () => ({
  config: { vercel: {}, railway: {}, supabaseAdmin: {}, resend: {}, dashboard: { url: 'https://roz.test' } },
}));
vi.mock('../src/db/supabase.js', () => ({ db: () => ({}) }));
vi.mock('../src/adapters/email.js', () => ({ sendEmail: async () => ({ id: 'x' }) }));
vi.mock('../src/notify/switches.js', () => ({ emailAllowed: async () => true, emailEnabled: async () => true }));

import { vercelDeployRef, vercelServiceStatus } from '../src/adapters/vercel.js';
import { railwayServiceStatus } from '../src/adapters/railway.js';
import { supabaseFailure } from '../src/adapters/supabase-admin.js';
import { detectTransition } from '../src/infra/transitions.js';
import { pickLogTail, type DeployRef } from '../src/infra/types.js';
import { renderServicePush, serviceCopy, type ServiceTransition } from '../src/infra/alerts.js';

const ref = (state: DeployRef['state'], id = 'd1'): DeployRef => ({
  id, state, nativeState: state.toUpperCase(), sha: 'abcdef1234567', branch: 'main', message: 'feat: algo', author: 'alanvdev',
  createdAt: '2026-11-11T10:00:00.000Z', durationMs: 42_000, url: null, inspectorUrl: null,
});

describe('Vercel: salud del servicio', () => {
  it('un build fallido con un deploy sirviendo deja el servicio en línea', () => {
    expect(vercelServiceStatus({ latest: ref('failed', 'new'), serving: ref('ready', 'old') })).toBe('healthy');
  });
  it('un build en curso con un deploy sirviendo no degrada', () => {
    expect(vercelServiceStatus({ latest: ref('building', 'new'), serving: ref('ready', 'old') })).toBe('healthy');
  });
  it('sin nada sirviendo, un fallo sí es caída y un build es degradado', () => {
    expect(vercelServiceStatus({ latest: ref('failed'), serving: null })).toBe('down');
    expect(vercelServiceStatus({ latest: ref('building'), serving: null })).toBe('degraded');
  });
  it('proyecto pausado manda', () => {
    expect(vercelServiceStatus({ latest: ref('ready'), serving: ref('ready'), paused: true })).toBe('paused');
  });
  it('un deploy bloqueado (ready === buildingAt) no reporta duración', () => {
    expect(vercelDeployRef({ uid: 'a', state: 'ERROR', buildingAt: 5, ready: 5 }).durationMs).toBeNull();
    expect(vercelDeployRef({ uid: 'a', state: 'READY', buildingAt: 5, ready: 1005 }).durationMs).toBe(1000);
  });
});

describe('Railway: salud del servicio', () => {
  it('FAILED nuevo con SUCCESS anterior: en línea, sirve el anterior', () => {
    const r = railwayServiceStatus([{ id: 'n', status: 'FAILED' }, { id: 'o', status: 'SUCCESS' }]);
    expect(r.status).toBe('healthy');
    expect(r.active?.id).toBe('o');
  });
  it('el deploy activo CRASHED es caída aunque haya REMOVED viejos', () => {
    expect(railwayServiceStatus([{ status: 'CRASHED' }, { status: 'REMOVED' }]).status).toBe('down');
  });
  it('un build fallido posterior no tapa un proceso caído', () => {
    expect(railwayServiceStatus([{ status: 'FAILED' }, { status: 'CRASHED' }]).status).toBe('down');
  });
  it('SLEEPING es pausa; solo intentos fallidos es caída; building solo es degradado', () => {
    expect(railwayServiceStatus([{ status: 'SLEEPING' }]).status).toBe('paused');
    expect(railwayServiceStatus([{ status: 'FAILED' }, { status: 'REMOVED' }]).status).toBe('down');
    expect(railwayServiceStatus([{ status: 'BUILDING' }]).status).toBe('degraded');
    expect(railwayServiceStatus([]).status).toBe('unknown');
  });
});

describe('Supabase: causa', () => {
  it('sano y con todo arriba no tiene causa', () => {
    expect(supabaseFailure('ACTIVE_HEALTHY', [{ name: 'db', healthy: true }])).toBeNull();
  });
  it('nombra los subsistemas sin salud', () => {
    const f = supabaseFailure('ACTIVE_HEALTHY', [{ name: 'db', healthy: true }, { name: 'auth', healthy: false }]);
    expect(f?.message).toBe('Sin salud: auth');
    expect(f?.scope).toBe('platform');
  });
});

describe('detectTransition', () => {
  const healthy = (last: DeployRef | null) => ({ status: 'healthy', details: { lastDeploy: last } });
  it('primer sondeo no avisa', () => {
    expect(detectTransition(null, healthy(ref('failed')), 'vercel')).toBeNull();
  });
  it('deploy fallido con producción arriba es su propio evento, una vez por intento', () => {
    expect(detectTransition(healthy(ref('ready', 'a')), healthy(ref('failed', 'b')), 'vercel')).toBe('deploy_failed');
    expect(detectTransition(healthy(ref('failed', 'b')), healthy(ref('failed', 'b')), 'vercel')).toBeNull();
    expect(detectTransition(healthy(ref('failed', 'b')), healthy(ref('failed', 'c')), 'vercel')).toBe('deploy_failed');
  });
  it('caída y recuperación siguen siendo por estado del servicio', () => {
    expect(detectTransition(healthy(ref('ready')), { status: 'down', details: { lastDeploy: ref('failed') } }, 'railway')).toBe('down');
    expect(detectTransition({ status: 'down', details: { lastDeploy: ref('failed') } }, healthy(ref('ready')), 'railway')).toBe('up');
  });
  it('estreno del modelo: un "down" viejo por build fallido no dispara recuperación ni fallo viejo', () => {
    expect(detectTransition({ status: 'down', details: { recent: [] } }, healthy(ref('failed')), 'vercel')).toBeNull();
    expect(detectTransition({ status: 'healthy', details: { recent: [] } }, healthy(ref('failed')), 'vercel')).toBeNull();
    // Supabase no tenía ese falso positivo: su recuperación sí cuenta.
    expect(detectTransition({ status: 'down', details: {} }, { status: 'healthy', details: {} }, 'supabase')).toBe('up');
  });
});

describe('pickLogTail', () => {
  it('prefiere las líneas de error y limpia ANSI', () => {
    const out = pickLogTail(['Installing…', '\u001b[31mError: Cannot find module "x"\u001b[0m', 'done step', 'Command "npm run build" exited with 1']);
    expect(out).toEqual(['Error: Cannot find module "x"', 'Command "npm run build" exited with 1']);
  });
  it('sin errores devuelve la cola', () => {
    expect(pickLogTail(['a', 'b', '', 'c'])).toEqual(['a', 'b', 'c']);
  });
});

describe('redacción de avisos', () => {
  const base: ServiceTransition = {
    kind: 'deploy_failed', projectName: 'Hyperflow', provider: 'vercel', serviceLabel: 'hyperflow-core', externalRef: 'prj_1',
    status: 'healthy', providerStatus: 'READY', error: null, deploy: null, lastSeenOkAt: null, downtimeMs: null,
    lastDeploy: ref('failed', 'b'), serving: ref('ready', 'a'), authorName: 'Alan', authorDevId: 'dev1',
    failure: { scope: 'deploy', deployId: 'b', step: 'buildStep', code: 'BUILD_FAILED', message: 'Command "npm run build" exited with 1', logTail: [], helpUrl: null },
  };
  it('deploy fallido: nombra al autor, el paso, la causa y que producción sigue arriba', () => {
    const c = serviceCopy(base);
    expect(c.title).toBe('Falló un deploy en hyperflow-core · Hyperflow');
    expect(c.body).toContain('El deploy de Alan en hyperflow-core (main) falló en el paso buildStep.');
    expect(c.body).toContain('BUILD_FAILED: Command "npm run build" exited with 1');
    expect(c.body).toContain('Producción sigue en línea con el deploy anterior (abcdef1');
    expect(serviceCopy(base, true).body.startsWith('Tu deploy en')).toBe(true);
  });
  it('caída no se confunde con deploy fallido y ningún aviso usa guion largo', () => {
    const down = serviceCopy({ ...base, kind: 'down', status: 'down', serving: null, lastSeenOkAt: '2026-11-11T09:00:00.000Z' });
    expect(down.title).toBe('hyperflow-core está caído · Hyperflow');
    const up = renderServicePush({ ...base, kind: 'up', downtimeMs: 45 * 60_000 });
    expect(up.body).toContain('volvió a estar en línea tras 45 min fuera');
    for (const s of [down.title, down.body, up.title, up.body, serviceCopy(base).body]) expect(s).not.toContain('—');
  });
});
