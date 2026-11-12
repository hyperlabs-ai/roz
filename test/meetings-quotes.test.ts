import { describe, expect, it } from 'vitest';
import { MIN_QUOTE_CHARS, cleanQuote, keepVerified, normalizeForMatch, normalizeWithMap, verifyQuote } from '../src/meetings/quotes.js';

// La defensa contra candidatas inventadas: una cita que no está literal (normalizada) en el texto
// no pasa. La normalización tolera lo que Claude "limpia" sin querer (acentos, mayúsculas, comillas,
// espacios) y NADA más: una paráfrasis se descarta.

const T = `Ana: Hola a todos.
Beto: Yo   mando el “reporte” de ventas el viernes, sin falta.
Carla: Decidimos que el lanzamiento se mueve a marzo — no hay de otra.`;

describe('normalizeForMatch', () => {
  it('minúsculas, sin acentos, comillas rectas, espacios colapsados', () => {
    expect(normalizeForMatch('  Él  dijo:\n“Sí”  ')).toBe('el dijo: "si"');
    expect(normalizeForMatch('a — b … c')).toBe('a - b ... c');
  });

  it('el mapa apunta al carácter original', () => {
    const n = normalizeWithMap('Á  b');
    expect(n.text).toBe('a b');
    expect(n.map).toEqual([0, 1, 3]);
  });
});

describe('cleanQuote', () => {
  it('quita comillas y puntos suspensivos que envuelven la cita', () => {
    expect(cleanQuote('«...yo mando el reporte…»')).toBe('yo mando el reporte');
    expect(cleanQuote('"hola"')).toBe('hola');
  });
});

describe('verifyQuote', () => {
  it('pasa con diferencias de mayúsculas, acentos, comillas y espacios', () => {
    const r = verifyQuote(T, 'yo mando el "reporte" de ventas el viernes');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(T.slice(r.start, r.end)).toBe('Yo   mando el “reporte” de ventas el viernes');
    }
  });

  it('pasa a través de un salto de renglón (cita que cruza turnos)', () => {
    expect(verifyQuote(T, 'sin falta. Carla: Decidimos que').ok).toBe(true);
  });

  it('una paráfrasis NO pasa', () => {
    expect(verifyQuote(T, 'Beto enviará el reporte de ventas el viernes')).toEqual({ ok: false, reason: 'no_encontrada' });
  });

  it('vacía o demasiado corta no prueba nada', () => {
    expect(verifyQuote(T, '  ')).toEqual({ ok: false, reason: 'vacia' });
    expect(verifyQuote(T, 'Hola')).toEqual({ ok: false, reason: 'corta' });
    expect(MIN_QUOTE_CHARS).toBeGreaterThan(4);
  });

  it('guion largo y acentos del original', () => {
    const r = verifyQuote(T, 'el lanzamiento se mueve a marzo - no hay de otra');
    expect(r.ok).toBe(true);
    if (r.ok) expect(T.slice(r.start, r.end)).toBe('el lanzamiento se mueve a marzo — no hay de otra');
  });
});

describe('keepVerified', () => {
  it('se queda solo con las verificadas y guarda la cita tal cual está en el texto', () => {
    const { kept, dropped } = keepVerified(T, [
      { title: 'Reporte', quote: 'yo mando el “reporte” de ventas' },
      { title: 'Inventada', quote: 'migramos todo a Kubernetes mañana' },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.title).toBe('Reporte');
    expect(kept[0]!.quote).toBe('Yo   mando el “reporte” de ventas');
    expect(kept[0]!.quoteStart).toBe(T.indexOf('Yo   mando'));
    expect(dropped).toEqual([{ item: { title: 'Inventada', quote: 'migramos todo a Kubernetes mañana' }, reason: 'no_encontrada' }]);
  });
});
