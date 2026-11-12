// Las copias de src/shared/ deben ser idénticas a lo que genera scripts/sync-shared.mjs desde el
// original de roz. Si falla: `npm run sync-shared` (y revisar que el puente siga compilando).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error módulo .mjs sin tipos
import { BRIDGE_ROOT, REPO_ROOT, SHARED_FILES, transform } from '../scripts/sync-shared.mjs';

describe('copias compartidas con roz', () => {
  for (const [original, copy] of SHARED_FILES as [string, string][]) {
    const src = resolve(REPO_ROOT, original);
    it.skipIf(!existsSync(src))(`${copy} está al día con ${original}`, () => {
      const expected = transform(readFileSync(src, 'utf8'), original);
      const actual = readFileSync(resolve(BRIDGE_ROOT, copy), 'utf8');
      expect(actual).toBe(expected);
    });
  }
});
