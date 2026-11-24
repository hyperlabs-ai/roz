import { describe, expect, it } from 'vitest';
import { findDate, findTime, parseMeetingPaste, pastedHeldAt } from '../src/meetings/paste.js';
import { accentRegex, searchTerms, snippetOf } from '../src/meetings/store.js';

// Autollenado de una junta pegada (Granola y parecidos) y las piezas puras de la búsqueda. Sin base.

const NOW = new Date('2026-11-23T18:00:00Z');

describe('parseMeetingPaste', () => {
  it('nota copiada de Granola: título, fecha con año corto y asistentes tras "·"', () => {
    const p = parseMeetingPaste(
      ['Weekly con Acme', 'Fri, 14 Nov 25 · Ana López, Luis Ruiz', '', '### Acuerdos', '- Vamos con Stripe', '', 'Chat with meeting transcript: https://notes.granola.ai/d/abc'].join('\n'),
      NOW,
    );
    expect(p.title).toBe('Weekly con Acme');
    expect(p.date).toBe('2025-11-14');
    expect(p.attendees).toEqual([
      { name: 'Ana López', email: null },
      { name: 'Luis Ruiz', email: null },
    ]);
  });

  it('español con hora y rango: duración; renglón de asistentes con correos', () => {
    const p = parseMeetingPaste(
      [
        '# Kickoff portal',
        'jueves, 20 de noviembre de 2026 · 10:00 – 10:45',
        'Asistentes: Ana López <ana@acme.com>, luis@acme.com',
        '',
        'Ana: arrancamos',
      ].join('\n'),
      NOW,
    );
    expect(p).toMatchObject({ title: 'Kickoff portal', date: '2026-11-20', time: '10:00', durationMin: 45 });
    expect(p.attendees).toEqual([
      { name: 'Ana López', email: 'ana@acme.com' },
      { name: 'luis', email: 'luis@acme.com' },
    ]);
  });

  it('transcript pelón: sin título; quien habla 2+ veces es asistente, Me/Them no', () => {
    const p = parseMeetingPaste(
      ['Me: hola', 'Ana: qué tal', 'Them: bien', 'Ana: va', '[00:01:20] Luis Ruiz: listo', 'Luis Ruiz: cierro', 'Nota: una vez'].join('\n'),
      NOW,
    );
    expect(p.title).toBeNull();
    expect(p.date).toBeNull();
    expect(p.attendees.map((a) => a.name)).toEqual(['Ana', 'Luis Ruiz']);
  });

  it('el hablante "Ana" no duplica a "Ana López" de la cabecera', () => {
    const p = parseMeetingPaste(['Demo', 'Nov 20, 2026 3:30 PM', 'Attendees: Ana López', 'Ana: uno', 'Ana: dos'].join('\n'), NOW);
    expect(p).toMatchObject({ date: '2026-11-20', time: '15:30' });
    expect(p.attendees).toEqual([{ name: 'Ana López', email: null }]);
  });

  it('sin año: el actual, o el anterior si quedaría en el futuro', () => {
    expect(findDate('Nov 20', NOW)?.date).toBe('2026-11-20');
    expect(findDate('15 de diciembre', NOW)?.date).toBe('2025-12-15');
    expect(findDate('20/11/2026', NOW)?.date).toBe('2026-11-20');
    expect(findDate('2026-11-02', NOW)?.date).toBe('2026-11-02');
    expect(findDate('sin fecha aquí', NOW)).toBeNull();
  });

  it('horas: 12 h con am/pm y rango', () => {
    expect(findTime('9:15 am')).toEqual({ time: '09:15', durationMin: null });
    expect(findTime('11:30 – 12:15 pm')).toEqual({ time: '11:30', durationMin: 45 });
    expect(findTime('nada')).toBeNull();
  });

  it('pastedHeldAt: hora del equipo (UTC-6); sin hora, mediodía', () => {
    expect(pastedHeldAt({ date: '2026-11-20', time: '10:00' })).toBe('2026-11-20T16:00:00.000Z');
    expect(pastedHeldAt({ date: '2026-11-20', time: null })).toBe('2026-11-20T18:00:00.000Z');
    expect(pastedHeldAt({ date: null, time: '10:00' })).toBeNull();
  });
});

describe('búsqueda', () => {
  it('searchTerms: solo letras y números, sin repetir, hasta 6', () => {
    expect(searchTerms('  "Stripe", pagos; (stripe) a ')).toEqual(['Stripe', 'pagos', 'stripe']);
    expect(searchTerms('title.ilike.*,x')).toEqual(['title', 'ilike']);
    expect(searchTerms(null)).toEqual([]);
  });

  it('accentRegex: ignora acentos y mayúsculas', () => {
    expect(accentRegex('Reunión')).toBe('r[eéè][uúü][nñ][iíì][oóò][nñ]');
    expect(new RegExp(accentRegex('reunion'), 'i').test('La REUNIÓN de ayer')).toBe(true);
  });

  it('snippetOf: recorte alrededor de la primera coincidencia, sin importar acentos', () => {
    const text = `${'x '.repeat(300)}Ana: decidimos usar la integración de pagos ${'y '.repeat(300)}`;
    const s = snippetOf(text, ['integracion'], 60)!;
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('integración');
    expect(snippetOf('nada que ver', ['stripe'])).toBeNull();
  });
});
