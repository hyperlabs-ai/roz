import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';

// El cifrado de credenciales por-dev (refresh tokens de Google). `config` se evalúa al importarse,
// así que la llave se pone ANTES y el módulo se carga con un import dinámico.
let encryptSecret: (s: string) => string;
let decryptSecret: (s: string) => string;

beforeAll(async () => {
  process.env.ROZ_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  const mod = await import('../src/utils/crypto.js');
  encryptSecret = mod.encryptSecret;
  decryptSecret = mod.decryptSecret;
});

describe('cifrado de credenciales', () => {
  it('va y vuelve sin perder nada', () => {
    const secreto = '1//0abcDEF_google-refresh-token-ñ-áé';
    expect(decryptSecret(encryptSecret(secreto))).toBe(secreto);
  });

  it('cifra el mismo texto distinto cada vez (IV aleatorio)', () => {
    // Si dos tokens iguales produjeran el mismo texto cifrado, la tabla revelaría quién comparte
    // credencial con quién solo con mirarla.
    expect(encryptSecret('mismo')).not.toBe(encryptSecret('mismo'));
  });

  it('no deja el secreto legible en el texto cifrado', () => {
    expect(encryptSecret('token-super-secreto')).not.toContain('token-super-secreto');
  });

  it('rechaza un texto cifrado manipulado en vez de devolver basura', () => {
    const blob = encryptSecret('intacto');
    const parts = blob.split(':');
    // Se altera el ciphertext dejando el tag: GCM tiene que detectarlo.
    const roto = [parts[0], parts[1], parts[2], Buffer.from('otra-cosa').toString('base64')].join(':');
    expect(() => decryptSecret(roto)).toThrow();
  });

  it('rechaza un formato desconocido', () => {
    expect(() => decryptSecret('texto-plano')).toThrow(/formato desconocido/);
    expect(() => decryptSecret('v9:a:b:c')).toThrow(/formato desconocido/);
  });
});
