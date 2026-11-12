// Exporta a Roz-bot (web/public/brand/roz-bot*.svg) como PNG 512×512 para Discord, que solo acepta
// PNG/JPG como ícono del bot. Deja cada PNG en discord-bridge/assets/ y una copia en
// web/public/brand/ (URL pública para los thumbnails de los embeds).
//
// @resvg/resvg-js NO es dependencia del puente: se instala aparte, fuera del repo, y se apunta aquí:
//   npm i --prefix <dir-temporal> @resvg/resvg-js
//   RESVG_FROM=<dir-temporal> node discord-bridge/scripts/export-bot-avatars.mjs
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..');
const SRC = join(REPO, 'web', 'public', 'brand');
const OUT = join(REPO, 'discord-bridge', 'assets');
const MOODS = ['roz-bot', 'roz-bot-happy', 'roz-bot-thinking', 'roz-bot-alert'];

const base = process.env.RESVG_FROM ? join(resolve(process.env.RESVG_FROM), 'package.json') : import.meta.url;
let Resvg;
try {
  ({ Resvg } = createRequire(base)('@resvg/resvg-js'));
} catch {
  console.error('Falta @resvg/resvg-js. Instálalo fuera del repo y pasa RESVG_FROM=<dir> (ver cabecera).');
  process.exit(1);
}

for (const name of MOODS) {
  const svg = readFileSync(join(SRC, `${name}.svg`), 'utf8');
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 512 }, background: 'rgba(0,0,0,0)' }).render().asPng();
  const out = join(OUT, `${name}.png`);
  writeFileSync(out, png);
  copyFileSync(out, join(SRC, `${name}.png`));
  console.log(`${name}.png (${png.length} bytes)`);
}
