import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyGithub } from '../src/utils/webhooks.js';

const secret = 'shhh';
const body = '{"hello":"world"}';

describe('verifyGithub', () => {
  it('acepta una firma válida', () => {
    const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyGithub(body, sig, secret)).toBe(true);
  });
  it('rechaza una firma inválida', () => {
    expect(verifyGithub(body, 'sha256=deadbeef', secret)).toBe(false);
  });
  it('rechaza sin firma o sin secret', () => {
    expect(verifyGithub(body, null, secret)).toBe(false);
    expect(verifyGithub(body, 'sha256=x', '')).toBe(false);
  });
  it('rechaza si el cuerpo cambió (tamper)', () => {
    const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyGithub(body + ' ', sig, secret)).toBe(false);
  });
});
