import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Decisión del usuario: el ícono de chispa (lucide `Sparkle`, `Sparkles`, `WandSparkles`…) está
 * PROHIBIDO en toda la app web. Se ve genérico de "IA". Usa un ícono con sentido (`Bot`, `Cpu`,
 * `Zap`, `GraduationCap`…). Ver web/src/DESIGN.md → "Íconos prohibidos".
 */
const WEB_SRC = fileURLToPath(new URL('../web/src', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(tsx?|jsx?)$/.test(e.name) ? [p] : [];
  });
}

/** Nombres importados de cualquier `import { … } from '…'` (incluye multilínea y alias). */
function importedNames(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe('web: íconos prohibidos', () => {
  it('ningún archivo de web/src importa un ícono de chispa (Sparkle*)', () => {
    const offenders = sourceFiles(WEB_SRC).flatMap((file) => {
      const banned = importedNames(readFileSync(file, 'utf8')).filter((n) => /sparkle/i.test(n));
      return banned.map((n) => `${relative(WEB_SRC, file)}: ${n}`);
    });
    expect(offenders).toEqual([]);
  });

  it('el detector encuentra un import de chispa (control)', () => {
    expect(importedNames("import { Bot, Sparkles as S } from 'lucide-react';")).toContain('Sparkles');
    expect(importedNames("import {\n  WandSparkles,\n} from 'lucide-react';")).toContain('WandSparkles');
  });
});
