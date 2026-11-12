// GET /health para Railway (contrato §A.5). Sin auth, sin secretos ni contenido de mensajes.
import { createServer, type Server } from 'node:http';
import type { HealthReport } from './bridge.js';

export function createHealthServer(report: () => HealthReport): Server {
  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    if (path !== '/health' && path !== '/') {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }
    const r = report();
    res
      .writeHead(r.code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(req.method === 'HEAD' ? undefined : JSON.stringify(r.body));
  });
}
