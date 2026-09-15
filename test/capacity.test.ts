import { describe, it, expect } from 'vitest';
import { maxPrincipal, weeklyHoursOf, loadState } from '../src/dashboard/capacity.js';

// Las tres reglas que hacen que la tabla de capacidad se calcule sola en vez de escribirse a mano.
// Son funciones puras a propósito: la decisión de "cuánto cabe" y "cómo se llama esta carga" no
// debe depender de la base ni de la pantalla.

describe('cuántos proyectos principales caben', () => {
  it('tiempo completo admite dos frentes; medio tiempo, uno', () => {
    expect(maxPrincipal('full_time')).toBe(2);
    expect(maxPrincipal('part_time')).toBe(1);
  });
});

describe('horas semanales', () => {
  it('sin valor propio hereda el default de su dedicación', () => {
    expect(weeklyHoursOf('full_time', null)).toBe(40);
    expect(weeklyHoursOf('part_time', null)).toBe(20);
  });

  it('el valor propio pisa al default', () => {
    expect(weeklyHoursOf('part_time', 15)).toBe(15);
    expect(weeklyHoursOf('full_time', 32)).toBe(32);
  });

  it('un 0 o un negativo no son horas: se vuelve a heredar', () => {
    // El formulario manda null para heredar, pero un 0 que llegue por otra vía no puede dejar a
    // alguien con una capacidad de cero horas y una división por cero detrás.
    expect(weeklyHoursOf('part_time', 0)).toBe(20);
    expect(weeklyHoursOf('full_time', -5)).toBe(40);
  });
});

describe('estado de carga', () => {
  it('nombra cada tramo', () => {
    expect(loadState(0)).toBe('libre');
    expect(loadState(30)).toBe('libre');
    expect(loadState(50)).toBe('disponible');
    expect(loadState(84)).toBe('disponible');
    expect(loadState(85)).toBe('optima');
    expect(loadState(99)).toBe('optima');
    expect(loadState(100)).toBe('completa');
  });

  it('por encima del 100% marca saturada en vez de topar', () => {
    // Topar la suma en 100 escondería justo el problema que la pantalla existe para enseñar.
    expect(loadState(101)).toBe('saturada');
    expect(loadState(160)).toBe('saturada');
  });
});
