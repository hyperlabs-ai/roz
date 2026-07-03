import { describe, it, expect } from 'vitest';
import { isGeneratedPath } from '../src/adapters/github.js';

describe('isGeneratedPath', () => {
  it('marca dependencias/artefactos generados (no cuentan como líneas)', () => {
    for (const p of [
      'node_modules/react/index.js',
      'apps/web/node_modules/foo.js', // en cualquier nivel del path
      'dist/bundle.js',
      'build/output.js.map',
      'package-lock.json',
      'pnpm-lock.yaml',
      'go.sum',
      'styles/app.min.css',
    ]) {
      expect(isGeneratedPath(p)).toBe(true);
    }
  });

  it('NO marca código ni assets reales', () => {
    for (const p of [
      'src/app.ts',
      'components/Button.tsx',
      'README.md',
      'public/logo.svg',
      'assets/data.geojson',
    ]) {
      expect(isGeneratedPath(p)).toBe(false);
    }
  });
});
