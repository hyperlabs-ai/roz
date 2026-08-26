import { describe, it, expect, vi, afterEach } from 'vitest';
import { listRepoCommits } from '../src/adapters/github.js';

// Un repo recién creado al que nadie ha hecho push responde 409 en el endpoint de commits. Eso no es
// un fallo: no hay historial que traer. Antes se propagaba, el backfill agotaba sus 5 reintentos y
// quedaba un evento muerto en la cola por un repo que estaba perfectamente bien.

function respondWith(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status < 400,
      status,
      headers: new Headers(),
      json: async () => body,
      text: async () => JSON.stringify(body),
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('listRepoCommits · repos sin historial', () => {
  const desde = '2026-08-01T00:00:00.000Z';

  it('un repo vacío (409) devuelve página vacía en vez de reventar', async () => {
    respondWith(409, { message: 'Git Repository is empty.' });
    await expect(listRepoCommits('acme/vision-180', desde)).resolves.toEqual({ items: [], lastPage: 1 });
  });

  it('un repo sin acceso (404) sigue devolviendo página vacía', async () => {
    respondWith(404, { message: 'Not Found' });
    await expect(listRepoCommits('acme/privado', desde)).resolves.toEqual({ items: [], lastPage: 1 });
  });

  it('conserva la página pedida al salir en vacío', async () => {
    respondWith(409, { message: 'Git Repository is empty.' });
    await expect(listRepoCommits('acme/vision-180', desde, 3)).resolves.toEqual({ items: [], lastPage: 3 });
  });

  it('los demás errores SÍ se propagan (un 500 sí merece reintento)', async () => {
    respondWith(500, { message: 'Internal Server Error' });
    await expect(listRepoCommits('acme/roto', desde)).rejects.toThrow(/500/);
  });

  it('un 403 de rate limit también se propaga', async () => {
    respondWith(403, { message: 'API rate limit exceeded' });
    await expect(listRepoCommits('acme/roto', desde)).rejects.toThrow(/403/);
  });
});
