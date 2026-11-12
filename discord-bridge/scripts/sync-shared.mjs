// Copia al puente los módulos PUROS que comparte con roz (src/types/discord.ts, src/discord/reply.ts,
// src/discord/normalize.ts) y reescribe sus imports.
//
// Por qué copia y no import relativo: el puente se despliega SOLO (Railway con raíz en
// discord-bridge/), así que no puede depender de ../src en tiempo de ejecución. Para que la copia no
// se desfase, test/shared-sync.test.ts compara cada copia con lo que generaría este script desde el
// original y falla si difieren: después de tocar el original, correr `npm run sync-shared`.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const BRIDGE_ROOT = resolve(here, '..');
export const REPO_ROOT = resolve(BRIDGE_ROOT, '..');

/** [original relativo a la raíz del repo, copia relativa a discord-bridge/] */
export const SHARED_FILES = [
  ['src/types/discord.ts', 'src/shared/types.ts'],
  ['src/discord/reply.ts', 'src/shared/reply.ts'],
  ['src/discord/normalize.ts', 'src/shared/normalize.ts'],
];

const REWRITES = [
  ["'../adapters/discord.js'", "'./api-types.js'"],
  ["'../types/discord.js'", "'./types.js'"],
];

/** Contenido de la copia a partir del original (normaliza a LF). */
export function transform(source, original) {
  let out = source.replace(/\r\n/g, '\n');
  for (const [from, to] of REWRITES) out = out.split(from).join(to);
  return `// GENERADO por discord-bridge/scripts/sync-shared.mjs desde ${original}. No editar a mano.\n${out}`;
}

function main() {
  for (const [original, copy] of SHARED_FILES) {
    const src = readFileSync(resolve(REPO_ROOT, original), 'utf8');
    writeFileSync(resolve(BRIDGE_ROOT, copy), transform(src, original), 'utf8');
    console.log(`copiado ${original} → discord-bridge/${copy}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
