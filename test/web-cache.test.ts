import { describe, it, expect, beforeEach } from 'vitest';
import {
  keyFor, getEntry, fetchEntry, isFresh, invalidate, invalidateOnly, resetScope, cacheSize, subscribe,
} from '../web/src/lib/store.js';

// La caché del dashboard (web/src/lib/store.ts) es lo que hace que volver a una sección pinte al
// instante en vez de mostrar skeletons. Se prueba desde aquí porque es un módulo PURO (sin React),
// y porque su invariante más delicada no es de rendimiento sino de seguridad: no puede servir los
// datos de una cuenta a otra. Los tres cerrojos que se verifican abajo son el id del usuario dentro
// de la clave, el vaciado al cambiar de cuenta y el descarte de respuestas en vuelo.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => resetScope('user-A'));

describe('caché del dashboard · peticiones', () => {
  it('dos consumidores de la misma clave comparten UNA petición', async () => {
    let calls = 0;
    const key = keyFor('/projects', [1]);
    const fn = async () => { calls++; await sleep(10); return { n: calls }; };

    const [a, b] = await Promise.all([fetchEntry(key, fn), fetchEntry(key, fn)]);

    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(isFresh(getEntry(key), 30_000)).toBe(true);
  });

  it('un error conserva los datos viejos y expone el error (la pantalla no se vacía)', async () => {
    const key = keyFor('/infra', []);
    await fetchEntry(key, async () => 'bueno');
    await fetchEntry(key, async () => { throw new Error('boom'); }, true).catch(() => null);

    const entry = getEntry<string>(key);
    expect(entry.data).toBe('bueno');
    expect(entry.error).toBe('boom');
  });
});

describe('caché del dashboard · invalidación', () => {
  it('sin suscriptores la entrada se borra; con suscriptores se marca vieja y avisa', async () => {
    const key = keyFor('/projects', []);
    await fetchEntry(key, async () => 'x');

    invalidate('/projects');
    expect(getEntry(key).at).toBe(0);

    await fetchEntry(key, async () => 'y');
    let notified = 0;
    const unsub = subscribe(key, () => notified++);
    invalidate('/projects');
    expect(notified).toBe(1); // el componente montado revalida en silencio
    expect(getEntry(key).at).toBe(0);
    unsub();
  });

  it('invalidateOnly no arrastra las rutas hijas; invalidate sí', async () => {
    const parent = keyFor('/skills', []);
    const child = keyFor('/skills/matrix', []);
    await fetchEntry(parent, async () => 'p');
    await fetchEntry(child, async () => 'c');

    // Es la diferencia entre repintar solo el catálogo y repintar el heatmap entero.
    invalidateOnly('/skills');
    expect(getEntry(parent).at).toBe(0);
    expect(isFresh(getEntry(child), 30_000)).toBe(true);

    invalidate('/skills');
    expect(getEntry(child).at).toBe(0);
  });
});

describe('caché del dashboard · aislamiento entre cuentas', () => {
  it('cambiar de cuenta tira la caché y cambia las claves', async () => {
    await fetchEntry(keyFor('/me', []), async () => 'datos-de-A');
    expect(cacheSize()).toBeGreaterThan(0);
    const keyA = keyFor('/me', []);

    resetScope('user-B');

    expect(cacheSize()).toBe(0);
    expect(keyFor('/me', [])).not.toBe(keyA);
  });

  it('una respuesta en vuelo de la cuenta anterior se DESCARTA al aterrizar', async () => {
    const key = keyFor('/tickets', []);
    const inflight = fetchEntry(key, async () => { await sleep(20); return 'de-A'; }).catch(() => null);

    resetScope('user-B'); // el usuario cambió de cuenta mientras la petición viajaba
    await inflight;

    expect(getEntry(key).data).toBeNull();
  });
});
