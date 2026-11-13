import { createCipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_SECRET_VALUE_BYTES,
  VaultCryptoError,
  decryptSecret,
  encryptSecret,
  fingerprint,
  generateDek,
  generateDeviceKey,
  isValidSecretName,
  secretAad,
  unwrapDek,
  wrapAad,
  wrapDek,
  zeroize,
} from '../src/crypto.js';

const WRAPPED_RE = /^zv1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{64}$/;
const SECRET_RE = /^zs1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;
const PUB_RE = /^[A-Za-z0-9_-]{43}$/;

/** Cambia un carácter base64url por otro distinto sin romper la forma del sobre. */
function flip(text: string, index: number): string {
  const ch = text[index];
  return text.slice(0, index) + (ch === 'A' ? 'B' : 'A') + text.slice(index + 1);
}

describe('llave de equipo', () => {
  it('pública y privada son 32 bytes en base64url (43 caracteres)', () => {
    const k = generateDeviceKey();
    expect(k.publicKey).toMatch(PUB_RE);
    expect(k.privateKey).toMatch(PUB_RE);
    expect(Buffer.from(k.publicKey, 'base64url')).toHaveLength(32);
    expect(generateDeviceKey().publicKey).not.toBe(k.publicKey);
  });

  it('huella = primeros 16 hex de sha256(pública cruda) en grupos de 4', () => {
    const k = generateDeviceKey();
    const hex = createHash('sha256').update(Buffer.from(k.publicKey, 'base64url')).digest('hex').slice(0, 16);
    expect(fingerprint(k.publicKey)).toBe(`${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`);
    expect(fingerprint(k.publicKey)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  });

  it('huella de un valor fijo (respuesta conocida)', () => {
    // 32 bytes en cero → sha256 = 66687aadf862bd77…
    expect(fingerprint(Buffer.alloc(32).toString('base64url'))).toBe('6668-7aad-f862-bd77');
  });

  it('rechaza públicas mal formadas', () => {
    expect(() => fingerprint('corta')).toThrow(VaultCryptoError);
    expect(() => fingerprint(`${'A'.repeat(42)}=`)).toThrow(VaultCryptoError);
    expect(() => fingerprint('A'.repeat(44))).toThrow(VaultCryptoError);
    // 43 caracteres válidos pero con bits sobrantes en el último: no canónico.
    expect(() => fingerprint(`${'A'.repeat(42)}B`)).toThrow(/canónico/);
  });
});

describe('AAD', () => {
  it('tienen exactamente la forma del contrato', () => {
    expect(wrapAad('ROZ', 'development', 3)).toBe('ROZ:development:3');
    expect(secretAad('ROZ', 'development', 'DATABASE_URL', 3)).toBe('ROZ:development:DATABASE_URL:3');
  });

  it('rechazan partes vacías, con dos puntos, nombres inválidos y versiones raras', () => {
    expect(() => wrapAad('', 'dev', 1)).toThrow(VaultCryptoError);
    expect(() => wrapAad('A:B', 'dev', 1)).toThrow(VaultCryptoError);
    expect(() => wrapAad('A', 'de:v', 1)).toThrow(VaultCryptoError);
    expect(() => wrapAad('A', 'dev', 0)).toThrow(VaultCryptoError);
    expect(() => wrapAad('A', 'dev', 1.5)).toThrow(VaultCryptoError);
    expect(() => secretAad('A', 'dev', '1MAL', 1)).toThrow(VaultCryptoError);
    expect(() => secretAad('A', 'dev', 'CON-GUION', 1)).toThrow(VaultCryptoError);
  });

  it('valida nombres de secreto', () => {
    expect(isValidSecretName('_x9')).toBe(true);
    expect(isValidSecretName('A'.repeat(128))).toBe(true);
    expect(isValidSecretName('A'.repeat(129))).toBe(false);
    expect(isValidSecretName('9A')).toBe(false);
    expect(isValidSecretName('A B')).toBe(false);
    expect(isValidSecretName('')).toBe(false);
  });
});

describe('DEK envuelta (zv1)', () => {
  const a = generateDeviceKey();
  const b = generateDeviceKey();
  const aad = wrapAad('ROZ', 'development', 1);

  it('va y vuelve, con la forma zv1 de 43/16/64', () => {
    const dek = generateDek();
    expect(dek).toHaveLength(32);
    const wrapped = wrapDek(dek, a.publicKey, aad);
    expect(wrapped).toMatch(WRAPPED_RE);
    const [, eph, nonce, ct] = wrapped.split('.');
    expect([eph?.length, nonce?.length, ct?.length]).toEqual([43, 16, 64]);
    expect(unwrapDek(wrapped, a.privateKey, a.publicKey, aad).equals(dek)).toBe(true);
  });

  it('cada envoltura es distinta (efímera y nonce nuevos)', () => {
    const dek = generateDek();
    expect(wrapDek(dek, a.publicKey, aad)).not.toBe(wrapDek(dek, a.publicKey, aad));
  });

  it('otro equipo no la abre', () => {
    const wrapped = wrapDek(generateDek(), a.publicKey, aad);
    expect(() => unwrapDek(wrapped, b.privateKey, b.publicKey, aad)).toThrow(VaultCryptoError);
  });

  it('no abre con otro proyecto, entorno o versión', () => {
    const wrapped = wrapDek(generateDek(), a.publicKey, aad);
    for (const other of [wrapAad('OTRO', 'development', 1), wrapAad('ROZ', 'production', 1), wrapAad('ROZ', 'development', 2)]) {
      expect(() => unwrapDek(wrapped, a.privateKey, a.publicKey, other)).toThrow(VaultCryptoError);
    }
  });

  it('cualquier parte alterada lanza', () => {
    const wrapped = wrapDek(generateDek(), a.publicKey, aad);
    const [p, eph = '', nonce = '', ct = ''] = wrapped.split('.');
    const variants = [
      [p, flip(eph, 5), nonce, ct],
      [p, eph, flip(nonce, 3), ct],
      [p, eph, nonce, flip(ct, 10)],
      [p, eph, nonce, flip(ct, 60)], // dentro del tag
    ];
    for (const v of variants) expect(() => unwrapDek(v.join('.'), a.privateKey, a.publicKey, aad)).toThrow(VaultCryptoError);
  });

  it('sobres truncados o con otra forma lanzan', () => {
    const wrapped = wrapDek(generateDek(), a.publicKey, aad);
    const [, eph = '', nonce = '', ct = ''] = wrapped.split('.');
    const bad = [
      '',
      'zv1',
      wrapped.slice(0, -1),
      wrapped.slice(0, -4),
      `zv2.${eph}.${nonce}.${ct}`,
      `zs1.${nonce}.${ct}`,
      `zv1.${eph}.${nonce}`,
      `zv1.${eph}.${nonce}.${ct}.extra`,
      `zv1.${eph.slice(1)}.${nonce}.${ct}`,
      `zv1.${eph}.${nonce.slice(2)}.${ct}`,
      `zv1.${eph}.${nonce}.${ct}==`,
      `zv1.${eph}.${nonce}.${ct.replace(/.$/, '+')}`,
    ];
    for (const w of bad) expect(() => unwrapDek(w, a.privateKey, a.publicKey, aad), w).toThrow(VaultCryptoError);
  });

  it('una privada que no corresponde a la pública lanza', () => {
    const wrapped = wrapDek(generateDek(), a.publicKey, aad);
    expect(() => unwrapDek(wrapped, b.privateKey, a.publicKey, aad)).toThrow(/no corresponde/);
  });

  it('rechaza DEK de tamaño incorrecto y públicas inválidas', () => {
    expect(() => wrapDek(Buffer.alloc(16), a.publicKey, aad)).toThrow(VaultCryptoError);
    expect(() => wrapDek(generateDek(), 'no-es-llave', aad)).toThrow(VaultCryptoError);
    // Punto de orden bajo (todo ceros): el secreto compartido saldría en ceros.
    expect(() => wrapDek(generateDek(), Buffer.alloc(32).toString('base64url'), aad)).toThrow(VaultCryptoError);
  });

  it('respuesta conocida: HKDF (salt, info), AAD y AES-GCM son exactamente los del contrato', () => {
    const dek = generateDek();
    const wrapped = wrapDek(dek, a.publicKey, aad);
    const [, ephText = '', nonceText = '', ctText = ''] = wrapped.split('.');
    const ephPub = Buffer.from(ephText, 'base64url');
    const recipientPub = Buffer.from(a.publicKey, 'base64url');

    // Derivación independiente, solo con node:crypto.
    const priv = createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: a.privateKey, x: a.publicKey }, format: 'jwk' });
    const eph = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: ephText }, format: 'jwk' });
    const ikm = diffieHellman({ privateKey: priv, publicKey: eph });
    const key = Buffer.from(hkdfSync('sha256', ikm, Buffer.concat([ephPub, recipientPub]), Buffer.from('zeus-vault-wrap-v1', 'utf8'), 32));

    // Cifrar de nuevo con el mismo nonce debe dar byte por byte el mismo ct||tag.
    const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(nonceText, 'base64url'));
    cipher.setAAD(Buffer.from('ROZ:development:1', 'utf8'));
    const expected = Buffer.concat([cipher.update(dek), cipher.final(), cipher.getAuthTag()]);
    expect(expected).toHaveLength(48);
    expect(expected.toString('base64url')).toBe(ctText);

    // Y con otro salt (orden invertido) ya no coincide: el orden ephPub || destinatario importa.
    const wrongKey = Buffer.from(hkdfSync('sha256', ikm, Buffer.concat([recipientPub, ephPub]), Buffer.from('zeus-vault-wrap-v1', 'utf8'), 32));
    expect(wrongKey.equals(key)).toBe(false);
  });

  it('abre un sobre armado a mano según el contrato (interoperabilidad)', () => {
    const dek = generateDek();
    const ephPair = generateDeviceKey();
    const ephPriv = createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: ephPair.privateKey, x: ephPair.publicKey }, format: 'jwk' });
    const recipient = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b.publicKey }, format: 'jwk' });
    const ikm = diffieHellman({ privateKey: ephPriv, publicKey: recipient });
    const salt = Buffer.concat([Buffer.from(ephPair.publicKey, 'base64url'), Buffer.from(b.publicKey, 'base64url')]);
    const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('zeus-vault-wrap-v1', 'utf8'), 32));
    const nonce = Buffer.alloc(12, 7);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from('HYPERHUB:production:4', 'utf8'));
    const ct = Buffer.concat([cipher.update(dek), cipher.final(), cipher.getAuthTag()]);
    const envelope = `zv1.${ephPair.publicKey}.${nonce.toString('base64url')}.${ct.toString('base64url')}`;
    expect(unwrapDek(envelope, b.privateKey, b.publicKey, wrapAad('HYPERHUB', 'production', 4)).equals(dek)).toBe(true);
  });
});

describe('secreto (zs1)', () => {
  const dek = generateDek();
  const aad = secretAad('ROZ', 'development', 'DATABASE_URL', 1);

  it('va y vuelve con valores difíciles', () => {
    for (const value of ['', 'simple', 'con espacios y "comillas"', 'línea1\nlínea2\r\n', 'ñ → 🚀 $HOME #x', 'x'.repeat(MAX_SECRET_VALUE_BYTES)]) {
      const blob = encryptSecret(dek, value, aad);
      expect(blob).toMatch(SECRET_RE);
      expect(decryptSecret(dek, blob, aad)).toBe(value);
    }
  });

  it('el mismo valor cifra distinto cada vez y no aparece en el sobre', () => {
    const blob = encryptSecret(dek, 'postgres://usuario:clave@host/db', aad);
    expect(encryptSecret(dek, 'postgres://usuario:clave@host/db', aad)).not.toBe(blob);
    expect(blob).not.toContain('postgres');
    expect(Buffer.from(blob.split('.')[2] ?? '', 'base64url').toString('latin1')).not.toContain('postgres');
  });

  it('respuesta conocida: AES-256-GCM con la DEK, nonce de 12 bytes y el AAD del contrato', () => {
    const blob = encryptSecret(dek, 'valor', aad);
    const [, nonceText = '', ctText = ''] = blob.split('.');
    const nonce = Buffer.from(nonceText, 'base64url');
    expect(nonce).toHaveLength(12);
    const cipher = createCipheriv('aes-256-gcm', dek, nonce);
    cipher.setAAD(Buffer.from('ROZ:development:DATABASE_URL:1', 'utf8'));
    const expected = Buffer.concat([cipher.update('valor', 'utf8'), cipher.final(), cipher.getAuthTag()]);
    expect(expected.toString('base64url')).toBe(ctText);
  });

  it('movido a otro nombre, entorno, proyecto o versión no descifra', () => {
    const blob = encryptSecret(dek, 'valor', aad);
    const moved = [
      secretAad('ROZ', 'development', 'OTRA', 1),
      secretAad('ROZ', 'production', 'DATABASE_URL', 1),
      secretAad('OTRO', 'development', 'DATABASE_URL', 1),
      secretAad('ROZ', 'development', 'DATABASE_URL', 2),
    ];
    for (const other of moved) expect(() => decryptSecret(dek, blob, other)).toThrow(VaultCryptoError);
  });

  it('con otra DEK no descifra', () => {
    expect(() => decryptSecret(generateDek(), encryptSecret(dek, 'valor', aad), aad)).toThrow(VaultCryptoError);
  });

  it('alterado o truncado lanza, nunca devuelve basura', () => {
    const blob = encryptSecret(dek, 'un valor de prueba', aad);
    const [p, nonce = '', ct = ''] = blob.split('.');
    const bad = [
      [p, flip(nonce, 2), ct].join('.'),
      [p, nonce, flip(ct, 0)].join('.'),
      [p, nonce, flip(ct, ct.length - 3)].join('.'),
      blob.slice(0, -1),
      blob.slice(0, -8),
      `zs1.${nonce}.`,
      `zs1.${nonce}.AAAA`,
      `zs1.${nonce}`,
      `zv1.${nonce}.${ct}`,
      `zs1.${nonce.slice(1)}.${ct}`,
      `${blob}.x`,
      `zs1.${nonce}.${ct}=`,
      'texto-en-claro',
    ];
    for (const b of bad) expect(() => decryptSecret(dek, b, aad), b).toThrow(VaultCryptoError);
  });

  it('rechaza valores de más de 64 KiB y DEK inválida', () => {
    expect(() => encryptSecret(dek, 'x'.repeat(MAX_SECRET_VALUE_BYTES + 1), aad)).toThrow(/64 KiB/);
    expect(() => encryptSecret(dek, 'ñ'.repeat(MAX_SECRET_VALUE_BYTES / 2 + 1), aad)).toThrow(/64 KiB/);
    expect(() => encryptSecret(Buffer.alloc(31), 'x', aad)).toThrow(VaultCryptoError);
    expect(() => decryptSecret(Buffer.alloc(33), encryptSecret(dek, 'x', aad), aad)).toThrow(VaultCryptoError);
  });

  it('los errores no llevan el valor ni la llave', () => {
    const blob = encryptSecret(dek, 'super-secreto-123', aad);
    try {
      decryptSecret(dek, blob, secretAad('ROZ', 'development', 'OTRA', 1));
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secreto-123');
      expect((err as Error).message).not.toContain(dek.toString('base64url'));
    }
  });

  it('zeroize deja la llave en ceros', () => {
    const k = generateDek();
    zeroize(k);
    expect(k.equals(Buffer.alloc(32))).toBe(true);
    expect(() => zeroize(null)).not.toThrow();
  });
});
