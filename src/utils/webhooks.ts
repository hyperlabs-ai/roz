// Verificación de firmas de webhooks entrantes. Cada proveedor firma distinto;
// todos usan HMAC-SHA256 sobre el cuerpo crudo (raw body), así que hay que verificar
// ANTES de parsear JSON.
import { createHmac } from 'node:crypto';
import { secureEqual } from './secure-compare.js';

/** GitHub: header `X-Hub-Signature-256: sha256=<hex>`. */
export function verifyGithub(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const digest = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  return secureEqual(digest, signature);
}
