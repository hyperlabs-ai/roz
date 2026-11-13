// SPA del dashboard servido por el propio back. OPCIONAL: en el despliegue normal el front vive en
// Vercel (estático) y zeus solo expone el API. Esto queda para el self-host de una sola caja: si
// existe un build en web/dist, zeus también lo sirve; si no, estas rutas ni se registran.
import type { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { RozContext } from './types/hono.js';

const SPA_DIST = (() => {
  const candidates = [
    join(process.cwd(), 'web/dist'),
    join(process.cwd(), '../web/dist'),
  ].filter(Boolean);
  return candidates.find((c) => existsSync(join(c, 'index.html'))) ?? candidates[candidates.length - 1]!;
})();

const MIME: Record<string, string> = {
  '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.map': 'application/json', '.webp': 'image/webp', '.gif': 'image/gif', '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg',
};

// El service worker y el manifest NO deben cachearse de forma agresiva: el navegador debe poder
// detectar una versión nueva del SW en cada visita para actualizar la PWA.
const NO_CACHE = new Set(['sw.js', 'manifest.webmanifest']);

/** Registra las rutas del SPA si hay build. Devuelve si quedó montado. */
export function mountSpa(app: Hono<RozContext>): boolean {
  if (!existsSync(join(SPA_DIST, 'index.html'))) return false;

  // Estáticos hasheados (inmutables) desde /assets.
  app.get('/assets/*', async (c) => {
    const rel = c.req.path.replace(/^\/+/, ''); // "assets/xxx"
    try {
      const buf = await readFile(join(SPA_DIST, rel));
      return c.body(buf, 200, {
        'content-type': MIME[extname(rel)] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=31536000, immutable',
      });
    } catch {
      return c.notFound();
    }
  });

  // Fallback del SPA. Si la ruta tiene extensión (favicon, /roz.png y demás de web/public que
  // el build copia a dist), se sirve ese archivo; si no existe o no tiene extensión, cae al
  // index.html para que resuelva el router del lado cliente.
  app.get('*', async (c) => {
    const rel = c.req.path.replace(/^\/+/, '');
    if (rel && extname(rel)) {
      try {
        const buf = await readFile(join(SPA_DIST, rel));
        return c.body(buf, 200, {
          'content-type': MIME[extname(rel)] ?? 'application/octet-stream',
          'cache-control': NO_CACHE.has(rel) ? 'no-cache' : 'public, max-age=3600',
          // El SW debe poder controlar todo el origen, no solo /assets.
          ...(rel === 'sw.js' ? { 'service-worker-allowed': '/' } : {}),
        });
      } catch {
        /* no es un archivo del build: cae al SPA */
      }
    }
    try {
      return c.html(await readFile(join(SPA_DIST, 'index.html'), 'utf8'));
    } catch {
      return c.text('SPA build no encontrado', 500);
    }
  });
  return true;
}
