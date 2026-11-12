// Ayudas de prueba para mensajes en Components V2 (src/discord/commands/v2.ts): leer el texto, las
// filas y los botones de un mensaje sin depender de dónde quedaron anidados.
import { flattenV2 } from '../src/discord/commands/v2.js';

type AnyMsg = { content?: string | null; components?: unknown[] } | null | undefined;

/** Todo el texto visible: `content` (si hay) + los TextDisplay en orden. */
export function textOf(msg: AnyMsg): string {
  return [msg?.content ?? '', flattenV2(msg?.components).text].filter(Boolean).join('\n');
}

function walk(list: unknown[] | undefined, visit: (c: any) => void): void {
  for (const c of list ?? []) {
    if (!c || typeof c !== 'object') continue;
    visit(c);
    walk((c as any).components, visit);
    if ((c as any).accessory) walk([(c as any).accessory], visit);
  }
}

/** Filas (ActionRow, type 1) en orden, estén donde estén. */
export function rowsOf(msg: AnyMsg): any[] {
  const out: any[] = [];
  walk(msg?.components, (c) => {
    if (c.type === 1) out.push(c);
  });
  return out;
}

/** Botones (type 2) en orden, incluidos los accesorios de Section. */
export function buttonsOf(msg: AnyMsg): any[] {
  const out: any[] = [];
  walk(msg?.components, (c) => {
    if (c.type === 2) out.push(c);
  });
  return out;
}

/** Componentes de un tipo (p. ej. 11 = miniatura, 9 = Section, 17 = Container). */
export function ofType(msg: AnyMsg, type: number): any[] {
  const out: any[] = [];
  walk(msg?.components, (c) => {
    if (c.type === type) out.push(c);
  });
  return out;
}
