// Cifrado simétrico para credenciales guardadas en la base de datos.
//
// Hasta ahora roz no guardaba secretos por-persona: todos los tokens externos (GitHub, Vercel,
// Resend...) son globales y viven en variables de entorno. El refresh_token de Google Calendar es
// distinto — es una credencial de larga vida, de UNA persona, y da acceso a su agenda. Guardarlo en
// claro haría que cualquier volcado de la base expusiera la agenda de todo el equipo.
//
// AES-256-GCM con `node:crypto`: sin dependencias nuevas y autenticado, así que un texto cifrado
// manipulado falla al descifrar en vez de devolver basura silenciosamente.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits: el tamaño que recomienda GCM
const VERSION = 'v1'; // prefijo para poder rotar de algoritmo sin adivinar el formato viejo

/** True si hay llave configurada. Sin ella, la integración de calendario se queda apagada. */
export function encryptionAvailable(): boolean {
  return !!config.encryptionKey;
}

/**
 * La llave, validada. Se resuelve en cada llamada (y no una vez al importar) para que un deploy sin
 * llave pueda arrancar igual: falla solo quien intente cifrar, no el proceso entero.
 */
function key(): Buffer {
  const raw = config.encryptionKey;
  if (!raw) throw new Error('ROZ_ENCRYPTION_KEY no configurada');
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) {
    throw new Error(`ROZ_ENCRYPTION_KEY debe ser 32 bytes en base64 (llegaron ${k.length})`);
  }
  return k;
}

/** Cifra un secreto. Formato: `v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Descifra lo que produjo `encryptSecret`. Lanza si el formato no cuadra o el tag no valida. */
export function decryptSecret(blob: string): string {
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('secreto cifrado con formato desconocido');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64!, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64!, 'base64')), decipher.final()]).toString('utf8');
}
