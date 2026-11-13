// Versión del CLI (--version y user-agent). Se lee de package.json, que npm siempre incluye en el
// paquete, para que publicar no dependa de acordarse de cambiarla en dos lugares. Desde src/ (tests)
// y desde dist/ (lo publicado) package.json queda un nivel arriba.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export const VERSION: string = pkg.version;
