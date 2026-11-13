// Cifrado de la bóveda de zeus (docs/zeus-contracts.md §5). Funciones PURAS: sin red, sin disco.
// Todo lo que sale de aquí hacia zeus es texto cifrado; la llave privada y la DEK en claro solo
// existen en la memoria de este proceso.
//
//   pública     32 bytes crudos X25519 en base64url (43 caracteres)
//   wrappedDek  zv1.<ephPub 43>.<nonce 16>.<ct||tag 64>   caja sellada para una pública
//   secreto     zs1.<nonce 16>.<ct||tag ≥22>              AES-256-GCM con la DEK
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

export const WRAP_PREFIX = 'zv1';
export const SECRET_PREFIX = 'zs1';
/** `info` de HKDF para la llave que envuelve la DEK. */
export const WRAP_INFO = 'zeus-vault-wrap-v1';
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_SECRET_NAME_LENGTH = 128;
/** 64 KiB, medido en bytes UTF-8. */
export const MAX_SECRET_VALUE_BYTES = 64 * 1024;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Error de formato o de autenticación. El mensaje nunca incluye material secreto. */
export class VaultCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultCryptoError';
  }
}

/** Par de llaves de un equipo; ambas como 32 bytes crudos en base64url. */
export interface DeviceKey {
  publicKey: string;
  privateKey: string;
}

// ---------------------------------------------------------------- base64url estricto

function b64u(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Decodifica base64url sin relleno y rechaza lo que Buffer aceptaría en silencio (caracteres
 * ajenos, relleno, bits sobrantes): dos textos distintos no deben decodificar a los mismos bytes.
 */
function fromB64u(text: string, what: string, bytes?: number): Buffer {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new VaultCryptoError(`${what}: no es base64url`);
  }
  const buf = Buffer.from(text, 'base64url');
  if (buf.toString('base64url') !== text) throw new VaultCryptoError(`${what}: base64url no canónico`);
  if (bytes != null && buf.length !== bytes) {
    throw new VaultCryptoError(`${what}: se esperaban ${bytes} bytes y llegaron ${buf.length}`);
  }
  return buf;
}

// ---------------------------------------------------------------- llaves de equipo

function publicKeyObject(publicKey: string): KeyObject {
  fromB64u(publicKey, 'llave pública', KEY_BYTES);
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: publicKey }, format: 'jwk' });
  } catch {
    throw new VaultCryptoError('llave pública inválida');
  }
}

function privateKeyObject(privateKey: string, publicKey: string): KeyObject {
  fromB64u(privateKey, 'llave privada', KEY_BYTES);
  fromB64u(publicKey, 'llave pública', KEY_BYTES);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: privateKey, x: publicKey }, format: 'jwk' });
  } catch {
    throw new VaultCryptoError('llave privada inválida');
  }
  // Node deriva la pública de la privada e ignora la `x` recibida: se compara a mano para detectar
  // un key.json con las mitades cruzadas (la pública también entra en el salt de HKDF).
  const derived = createPublicKey(key).export({ format: 'jwk' }).x;
  if (derived !== publicKey) throw new VaultCryptoError('la llave privada no corresponde a la pública');
  return key;
}

export function generateDeviceKey(): DeviceKey {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' }).x;
  if (!jwk.d || !pub) throw new VaultCryptoError('no se pudo generar la llave del equipo');
  return { publicKey: pub, privateKey: jwk.d };
}

/** Primeros 16 hex de sha256(pública cruda) en grupos de 4: `a1b2-c3d4-e5f6-0718`. */
export function fingerprint(publicKey: string): string {
  const raw = fromB64u(publicKey, 'llave pública', KEY_BYTES);
  const hex = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return (hex.match(/.{4}/g) ?? []).join('-');
}

// ---------------------------------------------------------------- AAD

function aadPart(value: string, what: string): string {
  // ':' es el separador del AAD: permitirlo dentro de una parte haría ambiguas dos tuplas distintas.
  if (typeof value !== 'string' || value.length === 0 || value.includes(':')) {
    throw new VaultCryptoError(`${what} inválido para el cifrado: "${String(value)}"`);
  }
  return value;
}

function aadVersion(dekVersion: number): string {
  if (!Number.isSafeInteger(dekVersion) || dekVersion < 1) {
    throw new VaultCryptoError(`versión de la llave del entorno inválida: ${String(dekVersion)}`);
  }
  return String(dekVersion);
}

export function isValidSecretName(name: string): boolean {
  return typeof name === 'string' && name.length <= MAX_SECRET_NAME_LENGTH && SECRET_NAME_RE.test(name);
}

/** AAD de la DEK envuelta: `<projectKey>:<env>:<dekVersion>`. */
export function wrapAad(projectKey: string, env: string, dekVersion: number): string {
  return `${aadPart(projectKey, 'proyecto')}:${aadPart(env, 'entorno')}:${aadVersion(dekVersion)}`;
}

/** AAD de un secreto: `<projectKey>:<env>:<name>:<dekVersion>`. */
export function secretAad(projectKey: string, env: string, name: string, dekVersion: number): string {
  if (!isValidSecretName(name)) throw new VaultCryptoError(`nombre de secreto inválido: "${String(name)}"`);
  return `${aadPart(projectKey, 'proyecto')}:${aadPart(env, 'entorno')}:${name}:${aadVersion(dekVersion)}`;
}

// ---------------------------------------------------------------- AES-256-GCM

function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: string): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function open(key: Uint8Array, nonce: Uint8Array, sealed: Buffer, aad: string, failure: string): Buffer {
  const ct = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new VaultCryptoError(failure);
  }
}

function requireDek(dek: Uint8Array): void {
  if (!(dek instanceof Uint8Array) || dek.length !== KEY_BYTES) {
    throw new VaultCryptoError('la llave del entorno (DEK) debe medir 32 bytes');
  }
}

// ---------------------------------------------------------------- DEK

export function generateDek(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Borra una llave de la memoria. No es garantía (el GC pudo copiarla), pero acorta su vida. */
export function zeroize(buf: Uint8Array | null | undefined): void {
  if (buf) buf.fill(0);
}

function wrapKey(shared: Buffer, ephPub: Buffer, recipientPub: Buffer): Buffer {
  const key = hkdfSync('sha256', shared, Buffer.concat([ephPub, recipientPub]), Buffer.from(WRAP_INFO, 'utf8'), KEY_BYTES);
  return Buffer.from(key);
}

/** Caja sellada: solo la privada de `recipientPublicKey` la abre, y solo con el mismo AAD. */
export function wrapDek(dek: Uint8Array, recipientPublicKey: string, aad: string): string {
  requireDek(dek);
  const recipientRaw = fromB64u(recipientPublicKey, 'llave pública', KEY_BYTES);
  const recipient = publicKeyObject(recipientPublicKey);
  const eph = generateKeyPairSync('x25519');
  const ephPubText = eph.publicKey.export({ format: 'jwk' }).x;
  if (!ephPubText) throw new VaultCryptoError('no se pudo generar la llave efímera');
  const ephPub = fromB64u(ephPubText, 'llave efímera', KEY_BYTES);

  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  } catch {
    // OpenSSL rechaza los puntos de orden bajo (el secreto compartido saldría en ceros).
    throw new VaultCryptoError('llave pública inválida');
  }
  const key = wrapKey(shared, ephPub, recipientRaw);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const sealed = seal(key, nonce, dek, aad);
    return `${WRAP_PREFIX}.${b64u(ephPub)}.${b64u(nonce)}.${b64u(sealed)}`;
  } finally {
    zeroize(shared);
    zeroize(key);
  }
}

/**
 * Abre una DEK envuelta para este equipo. Lanza si el sobre está mal formado, si se envolvió para
 * otra llave, si fue alterado o si el AAD (proyecto, entorno, versión) no es el mismo.
 * Quien llama es dueño del Buffer devuelto: `zeroize` al terminar.
 */
export function unwrapDek(wrapped: string, privateKey: string, publicKey: string, aad: string): Buffer {
  if (typeof wrapped !== 'string') throw new VaultCryptoError('llave del entorno envuelta: formato inválido');
  const parts = wrapped.split('.');
  if (parts.length !== 4 || parts[0] !== WRAP_PREFIX) {
    throw new VaultCryptoError('llave del entorno envuelta: formato inválido (se esperaba zv1.<ephPub>.<nonce>.<ct>)');
  }
  const ephPub = fromB64u(parts[1] ?? '', 'llave efímera', KEY_BYTES);
  const nonce = fromB64u(parts[2] ?? '', 'nonce', NONCE_BYTES);
  const sealed = fromB64u(parts[3] ?? '', 'DEK cifrada', KEY_BYTES + TAG_BYTES);

  const own = privateKeyObject(privateKey, publicKey);
  const ownPub = fromB64u(publicKey, 'llave pública', KEY_BYTES);
  const failure = 'no se pudo abrir la llave del entorno: no es para este equipo, fue alterada o es de otro proyecto/entorno/versión';
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey: own, publicKey: publicKeyObject(parts[1] ?? '') });
  } catch {
    throw new VaultCryptoError(failure);
  }
  const key = wrapKey(shared, ephPub, ownPub);
  try {
    return open(key, nonce, sealed, aad, failure);
  } finally {
    zeroize(shared);
    zeroize(key);
  }
}

// ---------------------------------------------------------------- secretos

export function encryptSecret(dek: Uint8Array, plaintext: string, aad: string): string {
  requireDek(dek);
  if (typeof plaintext !== 'string') throw new VaultCryptoError('el valor del secreto debe ser texto');
  const data = Buffer.from(plaintext, 'utf8');
  if (data.length > MAX_SECRET_VALUE_BYTES) {
    throw new VaultCryptoError(`el valor mide ${data.length} bytes; el máximo es ${MAX_SECRET_VALUE_BYTES} (64 KiB)`);
  }
  const nonce = randomBytes(NONCE_BYTES);
  return `${SECRET_PREFIX}.${b64u(nonce)}.${b64u(seal(dek, nonce, data, aad))}`;
}

/** Lanza si el sobre está mal formado, fue alterado, o se movió a otro nombre, entorno o versión. */
export function decryptSecret(dek: Uint8Array, blob: string, aad: string): string {
  requireDek(dek);
  if (typeof blob !== 'string') throw new VaultCryptoError('secreto cifrado: formato inválido');
  const parts = blob.split('.');
  if (parts.length !== 3 || parts[0] !== SECRET_PREFIX) {
    throw new VaultCryptoError('secreto cifrado: formato inválido (se esperaba zs1.<nonce>.<ct>)');
  }
  const nonce = fromB64u(parts[1] ?? '', 'nonce', NONCE_BYTES);
  const sealed = fromB64u(parts[2] ?? '', 'secreto cifrado');
  if (sealed.length < TAG_BYTES) throw new VaultCryptoError('secreto cifrado: truncado');
  const plain = open(
    dek,
    nonce,
    sealed,
    aad,
    'no se pudo descifrar el secreto: fue alterado, o es de otro nombre, entorno o versión de llave',
  );
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    throw new VaultCryptoError('el secreto descifrado no es texto UTF-8');
  } finally {
    zeroize(plain);
  }
}
