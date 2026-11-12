import { describe, expect, it } from 'vitest';
import { pickFeed } from '../src/dashboard/pulse.js';

// El historial del Pulso se filtra por tipo en el front: una semana con cientos de commits no debe
// dejar vacíos los filtros de juntas, planes o infra.
const ev = (kind: string, minute: number) => ({ kind, at: new Date(Date.UTC(2026, 10, 10, 12, minute)).toISOString() });

describe('pickFeed', () => {
  it('conserva los más recientes y un piso de cada tipo aunque sean viejos', () => {
    const commits = Array.from({ length: 50 }, (_, i) => ev('commit', 59 - i)); // los más nuevos
    const meetings = Array.from({ length: 5 }, (_, i) => ev('meeting', i)); // los más viejos
    const all = [...commits, ...meetings].sort((a, b) => b.at.localeCompare(a.at));
    const out = pickFeed(all, 20, 3);
    expect(out.filter((e) => e.kind === 'commit')).toHaveLength(20);
    expect(out.filter((e) => e.kind === 'meeting')).toHaveLength(3);
    // Sigue ordenado del más nuevo al más viejo.
    expect(out.map((e) => e.at)).toEqual([...out.map((e) => e.at)].sort().reverse());
  });

  it('con pocos eventos devuelve todos', () => {
    const all = [ev('deploy', 3), ev('infra', 2), ev('plan', 1)];
    expect(pickFeed(all)).toHaveLength(3);
  });
});
