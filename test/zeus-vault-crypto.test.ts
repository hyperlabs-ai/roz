import { describe, expect, it } from 'vitest';
import {
  VaultCryptoError,
  decryptSecret,
  encryptSecret,
  fingerprint,
  generateDek,
  generateDeviceKey,
  secretAad,
  unwrapDek,
  wrapAad,
  wrapDek,
} from '../cli/src/crypto.js';

// Fija el formato de los sobres de la bóveda (docs/zeus-contracts.md §5) desde la suite que corre
// CI. El CLI (cli/) cifra y el back (src/zeus/vault.ts) valida la forma: si alguno de los dos
// cambia el formato, esto truena. Las expresiones son las del contrato, escritas aquí a propósito
// (no importadas) para que un cambio en cualquiera de los dos lados se note.
const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const WRAPPED_DEK_RE = /^zv1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{64}$/;
const SECRET_RE = /^zs1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;
const FINGERPRINT_RE = /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/;

describe('bóveda de zeus: formato de cifrado del CLI', () => {
  const device = generateDeviceKey();
  const other = generateDeviceKey();

  it('llave pública y huella con la forma del contrato', () => {
    expect(device.publicKey).toMatch(PUBLIC_KEY_RE);
    expect(fingerprint(device.publicKey)).toMatch(FINGERPRINT_RE);
    // sha256 de 32 bytes en cero empieza con 66687aadf862bd77.
    expect(fingerprint(Buffer.alloc(32).toString('base64url'))).toBe('6668-7aad-f862-bd77');
  });

  it('AAD: <proyecto>:<entorno>:<versión> y <proyecto>:<entorno>:<nombre>:<versión>', () => {
    expect(wrapAad('ROZ', 'development', 2)).toBe('ROZ:development:2');
    expect(secretAad('ROZ', 'development', 'DATABASE_URL', 2)).toBe('ROZ:development:DATABASE_URL:2');
  });

  it('DEK envuelta: zv1 con partes de 43/16/64, va y vuelve solo para su equipo y su AAD', () => {
    const dek = generateDek();
    const aad = wrapAad('ROZ', 'development', 1);
    const wrapped = wrapDek(dek, device.publicKey, aad);
    expect(wrapped).toMatch(WRAPPED_DEK_RE);
    expect(unwrapDek(wrapped, device.privateKey, device.publicKey, aad).equals(dek)).toBe(true);
    expect(() => unwrapDek(wrapped, other.privateKey, other.publicKey, aad)).toThrow(VaultCryptoError);
    expect(() => unwrapDek(wrapped, device.privateKey, device.publicKey, wrapAad('ROZ', 'development', 2))).toThrow(VaultCryptoError);
    expect(() => unwrapDek(wrapped.slice(0, -2), device.privateKey, device.publicKey, aad)).toThrow(VaultCryptoError);
  });

  it('secreto: zs1, va y vuelve; alterado o movido de nombre, entorno o versión lanza', () => {
    const dek = generateDek();
    const aad = secretAad('ROZ', 'development', 'DATABASE_URL', 1);
    for (const value of ['', 'postgres://u:p@h/db', 'línea1\nlínea2 "x" $y']) {
      const blob = encryptSecret(dek, value, aad);
      expect(blob).toMatch(SECRET_RE);
      expect(decryptSecret(dek, blob, aad)).toBe(value);
    }
    const blob = encryptSecret(dek, 'valor', aad);
    const last = blob.at(-6) === 'A' ? 'B' : 'A';
    const tampered = blob.slice(0, -6) + last + blob.slice(-5);
    expect(() => decryptSecret(dek, tampered, aad)).toThrow(VaultCryptoError);
    expect(() => decryptSecret(dek, blob, secretAad('ROZ', 'development', 'OTRA', 1))).toThrow(VaultCryptoError);
    expect(() => decryptSecret(dek, blob, secretAad('ROZ', 'production', 'DATABASE_URL', 1))).toThrow(VaultCryptoError);
    expect(() => decryptSecret(dek, blob, secretAad('ROZ', 'development', 'DATABASE_URL', 2))).toThrow(VaultCryptoError);
    expect(() => decryptSecret(generateDek(), blob, aad)).toThrow(VaultCryptoError);
    expect(() => decryptSecret(dek, 'valor-en-claro', aad)).toThrow(VaultCryptoError);
  });
});
