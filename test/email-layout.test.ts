// Layout único de correo: cifras sin huecos, modo oscuro y móvil.
import { describe, expect, it } from 'vitest';
import { kpiRows, renderEmailDoc } from '../src/notify/email-layout.js';

const sizes = (n: number) => kpiRows(Array.from({ length: n }, (_, i) => i)).map((r) => r.length);

describe('cifras del correo', () => {
  it('se reparten en filas sin dejar huecos ni una cifra sola', () => {
    expect(sizes(1)).toEqual([1]);
    expect(sizes(3)).toEqual([3]);
    expect(sizes(4)).toEqual([2, 2]);
    expect(sizes(5)).toEqual([3, 2]);
    expect(sizes(6)).toEqual([3, 3]);
    expect(sizes(7)).toEqual([3, 2, 2]);
    expect(sizes(0)).toEqual([]);
  });
});

describe('modo oscuro y móvil', () => {
  const { html } = renderEmailDoc({
    subject: 'Prueba',
    botFile: 'roz-bot.png',
    section: 'Tareas',
    kicker: 'Tarea nueva',
    tone: 'brand',
    headline: 'Hola',
    lead: 'Texto',
    blocks: [
      { kind: 'facts', rows: [{ label: 'Proyecto', value: 'HyperHub' }] },
      { kind: 'kpis', items: [1, 2, 3, 4].map((n) => ({ label: `k${n}`, value: String(n) })) },
      { kind: 'list', items: [{ text: 'Uno', chip: { label: 'Hoy', tone: 'warn' } }] },
    ],
    cta: { label: 'Abrir', url: 'https://roz.example/x' },
    base: 'https://roz.example',
  });

  it('declara modo oscuro y trae la cabecera e íconos en sus dos versiones', () => {
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(html).toContain('/brand/email/hero-tareas.png');
    expect(html).toContain('/brand/email/hero-tareas-dark.png');
    expect(html).toContain('/brand/email/icon-tareas-dark.png');
  });

  it('en móvil apila los datos y los botones en vez de comprimirlos', () => {
    expect(html).toMatch(/@media only screen and \(max-width:540px\)/);
    expect(html).toContain('e-stack e-fl');
    expect(html).toContain('e-pad');
  });

  it('las 4 cifras van en dos filas de 2, sin celdas vacías', () => {
    expect((html.match(/class="e-hair e-kpi"/g) ?? []).length).toBe(4);
    expect(html.match(/<td width="50%" valign="top" class="e-hair e-kpi"/g)?.length).toBe(4);
  });
});
