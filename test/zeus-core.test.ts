// Piezas puras de zeus: tokens, referencias del grafo, jerarquía, resúmenes, validadores de la
// bóveda y el planificador en proceso que sustituye a los crons de Vercel.
import { describe, expect, it, vi } from 'vitest';
import { generateDeviceKey, generateDek, encryptSecret, wrapDek, wrapAad, secretAad, fingerprint as cliFingerprint } from '../cli/src/crypto.js';

// El planificador manda CRON_SECRET en cada corrida; config se lee al importar.
vi.hoisted(() => {
  process.env.CRON_SECRET = 'cron-de-prueba';
});

vi.mock('../src/db/supabase.js', () => ({ db: () => { throw new Error('sin base en esta prueba'); }, dbPublic: () => { throw new Error('sin base'); } }));

import { generateZeusToken, hashZeusToken, isZeusAdmin, looksLikeZeusToken, parseRef, zeusTokenPrefix } from '../src/zeus/core.js';
import { createsCycle } from '../src/zeus/graph.js';
import { slugify, summarize } from '../src/zeus/nodes.js';
import { fingerprint, isSecretEnvelope, isSecretName, isWrappedDek } from '../src/zeus/vault.js';
import { cronMatches, JOBS, startScheduler } from '../src/jobs/scheduler.js';

describe('tokens de zeus', () => {
  it('se generan con la forma que el servidor acepta', () => {
    const t = generateZeusToken();
    expect(looksLikeZeusToken(t)).toBe(true);
    expect(zeusTokenPrefix(t)).toHaveLength(12);
    expect(generateZeusToken()).not.toBe(t);
  });

  it('rechaza otras formas sin ir a la base', () => {
    for (const bad of ['', 'zeus_', 'zeus_corto', 'rozr_' + 'a'.repeat(43), 'zeus_' + 'a'.repeat(44), 'zeus_' + '!'.repeat(43), ' zeus_' + 'a'.repeat(43)]) {
      expect(looksLikeZeusToken(bad), bad).toBe(false);
    }
  });

  it('el hash es estable y no contiene el token', () => {
    const t = generateZeusToken();
    expect(hashZeusToken(t)).toBe(hashZeusToken(t));
    expect(hashZeusToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashZeusToken(t)).not.toContain(t.slice(5, 15));
  });
});

describe('referencias del grafo', () => {
  const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  it('acepta los cinco tipos', () => {
    expect(parseRef(`node:${id}`)).toEqual({ type: 'node', id });
    expect(parseRef(`dev:${id.toUpperCase()}`)).toEqual({ type: 'dev', id });
    expect(parseRef(`project:${id}`)?.type).toBe('project');
    expect(parseRef(`runner:${id}`)?.type).toBe('runner');
    expect(parseRef('repo:hyperlabs-ai/roz.web')).toEqual({ type: 'repo', id: 'hyperlabs-ai/roz.web' });
  });

  it('rechaza lo que no es una referencia', () => {
    for (const bad of ['', id, 'node:', 'node:123', 'otro:' + id, 'repo:solo-nombre', 'repo:a/b/c', "node:' or 1=1", 'repo:a/b,project_id.is.null']) {
      expect(parseRef(bad), bad).toBeNull();
    }
  });
});

describe('jerarquía', () => {
  it('administra quien tiene la marca o es CEO', () => {
    expect(isZeusAdmin({ role: 'dev', zeus_admin: true })).toBe(true);
    expect(isZeusAdmin({ role: 'ceo', zeus_admin: false })).toBe(true);
    expect(isZeusAdmin({ role: 'pm', zeus_admin: false })).toBe(false);
    expect(isZeusAdmin({ role: 'dev', zeus_admin: null })).toBe(false);
  });

  it('detecta ciclos al cambiar de jefe', () => {
    // c → b → a
    const m = new Map<string, string | null>([['a', null], ['b', 'a'], ['c', 'b']]);
    expect(createsCycle('a', 'c', m)).toBe(true); // a bajo c cerraría a → c → b → a
    expect(createsCycle('a', 'b', m)).toBe(true);
    expect(createsCycle('c', 'a', m)).toBe(false);
    expect(createsCycle('x', 'c', m)).toBe(false);
  });

  it('no se cuelga con una jerarquía que ya trae un ciclo', () => {
    const m = new Map<string, string | null>([['a', 'b'], ['b', 'a']]);
    expect(createsCycle('z', 'a', m)).toBe(false);
  });
});

describe('slug y resumen', () => {
  it('slug sin acentos ni símbolos', () => {
    expect(slugify('ADR-0003: Usar Postgres, ¡no Mongo!')).toBe('adr-0003-usar-postgres-no-mongo');
    expect(slugify('Diseño de autenticación')).toBe('diseno-de-autenticacion');
    expect(slugify('***')).toBe('nodo');
    expect(slugify('a'.repeat(200))).toHaveLength(80);
  });

  it('el resumen es la primera línea con contenido, sin sintaxis', () => {
    const md = ['# Título', '', 'Status: Accepted', '', '| a | b |', '', '> **Usamos** [Postgres](https://x) y `pgvector` para todo.', '', 'Otra línea.'].join('\n');
    expect(summarize(md)).toBe('Usamos Postgres y pgvector para todo.');
  });

  it('recorta y no rompe con documentos vacíos', () => {
    expect(summarize('')).toBe('');
    expect(summarize('# Solo título')).toBe('');
    const long = summarize('x'.repeat(40) + ' ' + 'palabra '.repeat(60), 100);
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('validadores de la bóveda (el servidor solo guarda sobres bien formados)', () => {
  const aadW = wrapAad('ORWEL', 'development', 1);
  const aadS = secretAad('ORWEL', 'development', 'DATABASE_URL', 1);

  it('acepta lo que produce el CLI', () => {
    const device = generateDeviceKey();
    const dek = generateDek();
    expect(isWrappedDek(wrapDek(dek, device.publicKey, aadW))).toBe(true);
    expect(isSecretEnvelope(encryptSecret(dek, 'postgres://u:p@h/db', aadS))).toBe(true);
    expect(isSecretEnvelope(encryptSecret(dek, '', aadS))).toBe(true);
    expect(isSecretEnvelope(encryptSecret(dek, 'ñ'.repeat(5000), aadS))).toBe(true);
  });

  it('rechaza un valor en claro pegado por error', () => {
    for (const plain of ['postgres://user:pass@host/db', 'sk_live_abc123', '', 'zs1.', 'zs1.corto.x', 'zv1.a.b.c', null, 42, {}]) {
      expect(isSecretEnvelope(plain), String(plain)).toBe(false);
      expect(isWrappedDek(plain), String(plain)).toBe(false);
    }
  });

  it('rechaza sobres enormes', () => {
    expect(isSecretEnvelope('zs1.' + 'A'.repeat(16) + '.' + 'A'.repeat(100_000))).toBe(false);
  });

  it('nombres de variable', () => {
    for (const ok of ['DATABASE_URL', '_X', 'a1', 'NEXT_PUBLIC_API']) expect(isSecretName(ok), ok).toBe(true);
    for (const bad of ['', '1X', 'A-B', 'A B', 'A=B', 'Ñ', 'A'.repeat(129), null]) expect(isSecretName(bad), String(bad)).toBe(false);
  });

  it('la huella coincide con la del CLI', () => {
    const device = generateDeviceKey();
    expect(fingerprint(device.publicKey)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    expect(fingerprint(device.publicKey)).toBe(cliFingerprint(device.publicKey));
  });
});

describe('planificador', () => {
  const at = (iso: string) => new Date(iso);

  it('evalúa las expresiones que usaban los crons de Vercel, en UTC', () => {
    expect(cronMatches('* * * * *', at('2026-11-12T10:07:00Z'))).toBe(true);
    expect(cronMatches('*/15 * * * *', at('2026-11-12T10:30:00Z'))).toBe(true);
    expect(cronMatches('*/15 * * * *', at('2026-11-12T10:31:00Z'))).toBe(false);
    expect(cronMatches('0 9 * * *', at('2026-11-12T09:00:00Z'))).toBe(true);
    expect(cronMatches('0 9 * * *', at('2026-11-12T09:01:00Z'))).toBe(false);
    expect(cronMatches('0 9 * * *', at('2026-11-12T10:00:00Z'))).toBe(false);
  });

  it('día de la semana: rangos, sábado y domingo como 0 o 7', () => {
    // 2026-11-12 es jueves; 14 sábado; 15 domingo.
    expect(cronMatches('0 15 * * 1-5', at('2026-11-12T15:00:00Z'))).toBe(true);
    expect(cronMatches('0 15 * * 1-5', at('2026-11-14T15:00:00Z'))).toBe(false);
    expect(cronMatches('0 3 * * 6', at('2026-11-14T03:00:00Z'))).toBe(true);
    expect(cronMatches('0 3 * * 6', at('2026-11-13T03:00:00Z'))).toBe(false);
    expect(cronMatches('0 0 * * 0', at('2026-11-15T00:00:00Z'))).toBe(true);
    expect(cronMatches('0 0 * * 7', at('2026-11-15T00:00:00Z'))).toBe(true);
  });

  it('listas, día del mes y expresiones inválidas', () => {
    expect(cronMatches('0,30 * * * *', at('2026-11-12T10:30:00Z'))).toBe(true);
    expect(cronMatches('0 0 1 * *', at('2026-12-01T00:00:00Z'))).toBe(true);
    expect(cronMatches('0 0 1 * *', at('2026-12-02T00:00:00Z'))).toBe(false);
    expect(cronMatches('5/20 * * * *', at('2026-11-12T10:25:00Z'))).toBe(true);
    for (const bad of ['', '* * * *', '*/0 * * * *', 'x * * * *', '* * * * * *']) expect(cronMatches(bad, at('2026-11-12T10:00:00Z')), bad).toBe(false);
  });

  it('conserva todos los jobs que tenía vercel.json', () => {
    const paths = JOBS.map((j) => j.path);
    for (const p of ['infra-poll', 'calendar-poll', 'brain-sweep', 'ops-bridge', 'weekly-digest', 'linear-reconcile', 'granola-poll', 'plan-watchdog', 'task-reminders']) {
      expect(paths, p).toContain(p);
    }
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('drena en su ciclo, manda el secreto y no apila corridas del mismo job', async () => {
    vi.useFakeTimers();
    try {
      const seen: Array<{ path: string; auth: string | null }> = [];
      let release: (() => void) | null = null;
      const appFetch = (req: Request) => {
        seen.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization') });
        return new Promise<Response>((resolve) => {
          release = () => resolve(new Response('{}', { status: 200 }));
        });
      };
      const s = startScheduler(appFetch, { jobs: [], drainEveryMs: 1000 });
      await vi.advanceTimersByTimeAsync(3500);
      // Tres ticks, pero el primero nunca terminó: solo una corrida.
      expect(seen).toHaveLength(1);
      expect(seen[0]!.path).toBe('/v1/internal/drain');
      expect(seen[0]!.auth).toBe('Bearer cron-de-prueba');
      release!();
      await vi.advanceTimersByTimeAsync(1000);
      expect(seen).toHaveLength(2);
      release!();
      await s.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(seen).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
