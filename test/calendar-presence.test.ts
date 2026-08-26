import { describe, it, expect } from 'vitest';
import { derivePresence, type PresenceBlock } from '../src/calendar/presence.js';
import { stateRejection } from '../src/calendar/accounts.js';

// La derivación del estado es la pieza con más casos límite de la integración de calendario, y la
// que decide si el indicador dice la verdad. Es pura justo para poder fijarla aquí sin base de datos.

const NOW = new Date('2026-08-25T17:30:00.000Z'); // 11:30 en CDMX
const SYNCED = '2026-08-25T17:28:00.000Z'; // sondeo de hace 2 minutos

function block(startsAt: string, endsAt: string, title: string | null, allDay = false): PresenceBlock {
  return { startsAt, endsAt, allDay, title };
}

function presence(blocks: PresenceBlock[], lastSyncedAt: string | null = SYNCED) {
  return derivePresence('dev-1', blocks, { now: NOW, connected: true, lastSyncedAt });
}

describe('derivePresence', () => {
  it('marca ocupado durante un evento en curso y expone su título', () => {
    const p = presence([block('2026-08-25T17:00:00Z', '2026-08-25T18:00:00Z', 'Review con ACME')]);
    expect(p.status).toBe('busy');
    expect(p.title).toBe('Review con ACME');
    expect(p.busyUntil).toBe('2026-08-25T18:00:00.000Z');
    expect(p.stale).toBe(false);
  });

  it('la hora es la del evento en curso, no la de la racha', () => {
    const p = presence([
      block('2026-08-25T17:00:00Z', '2026-08-25T18:00:00Z', 'Junta A'),
      block('2026-08-25T18:00:00Z', '2026-08-25T19:00:00Z', 'Junta B'),
      block('2026-08-25T19:02:00Z', '2026-08-25T20:00:00Z', 'Junta C'),
    ]);
    // Encadenarlas daría "Junta A hasta 20:00", que es falso: la Junta A termina a las 18:00. Con el
    // titular nombrando la actividad, la hora tiene que ser la de ESA actividad.
    expect(p.title).toBe('Junta A');
    expect(p.busyUntil).toBe('2026-08-25T18:00:00.000Z');
    expect(p.nextTitle).toBe('Junta B');
  });

  it('NO encadena cuando hay un hueco real entre bloques', () => {
    const p = presence([
      block('2026-08-25T17:00:00Z', '2026-08-25T18:00:00Z', 'Junta A'),
      block('2026-08-25T19:00:00Z', '2026-08-25T20:00:00Z', 'Junta B'),
    ]);
    expect(p.busyUntil).toBe('2026-08-25T18:00:00.000Z');
    expect(p.nextStartsAt).toBe('2026-08-25T19:00:00.000Z');
    expect(p.nextTitle).toBe('Junta B');
  });

  it('con eventos solapados manda el que empezó más tarde', () => {
    // Es lo último en lo que la persona entró, y por tanto lo que está haciendo. Con "Toy Dormido"
    // (empezó de madrugada) encimado con una sesión que acaba de arrancar, está en la sesión.
    const p = presence([
      block('2026-08-25T12:00:00Z', '2026-08-25T18:00:00Z', 'Turno de fondo'),
      block('2026-08-25T17:15:00Z', '2026-08-25T19:00:00Z', 'Lo que arrancó al último'),
    ]);
    expect(p.title).toBe('Lo que arrancó al último');
    expect(p.busyUntil).toBe('2026-08-25T19:00:00.000Z');
  });

  it('un evento de todo el día no marca ocupado', () => {
    const p = presence([block('2026-08-25T00:00:00Z', '2026-08-26T00:00:00Z', 'Cumpleaños de X', true)]);
    expect(p.status).toBe('free');
    expect(p.busyUntil).toBeNull();
  });

  it('queda libre justo al terminar el evento (el fin no incluye)', () => {
    const p = presence([block('2026-08-25T17:00:00Z', '2026-08-25T17:30:00Z', 'Ya terminó')]);
    expect(p.status).toBe('free');
  });

  it('ya está ocupado en el instante exacto en que empieza', () => {
    const p = presence([block('2026-08-25T17:30:00Z', '2026-08-25T18:00:00Z', 'Justo ahora')]);
    expect(p.status).toBe('busy');
  });

  it('sin bloques queda libre y sin próximo evento', () => {
    const p = presence([]);
    expect(p.status).toBe('free');
    expect(p.nextStartsAt).toBeNull();
  });

  it('libre anuncia la siguiente junta del día', () => {
    const p = presence([block('2026-08-25T20:00:00Z', '2026-08-25T21:00:00Z', 'Planeación')]);
    expect(p.status).toBe('free');
    expect(p.nextStartsAt).toBe('2026-08-25T20:00:00.000Z');
    expect(p.nextTitle).toBe('Planeación');
  });

  it('ignora bloques con horas inválidas o invertidas en vez de reventar', () => {
    const p = presence([
      block('no-es-fecha', '2026-08-25T18:00:00Z', 'Basura'),
      block('2026-08-25T18:00:00Z', '2026-08-25T17:00:00Z', 'Al revés'),
    ]);
    expect(p.status).toBe('free');
  });

  it('sin cuenta conectada el estado es desconocido, no libre', () => {
    const p = derivePresence('dev-1', [], { now: NOW, connected: false, lastSyncedAt: null });
    expect(p.status).toBe('unknown');
  });

  it('marca stale cuando el sondeo lleva demasiado sin correr', () => {
    const viejo = presence([], '2026-08-25T16:00:00Z'); // hora y media atrás
    expect(viejo.stale).toBe(true);
    expect(presence([], null).stale).toBe(true);
  });
});

describe('stateRejection (state de OAuth)', () => {
  const vivo = {
    state: 's',
    dev_id: 'd',
    auth_user_id: null,
    expires_at: '2026-08-25T17:35:00Z',
    used_at: null,
  };

  it('acepta un state vigente y sin usar', () => {
    expect(stateRejection(vivo, NOW)).toBeNull();
  });
  it('rechaza uno desconocido', () => {
    expect(stateRejection(null, NOW)).toBe('desconocido');
  });
  it('rechaza uno ya usado', () => {
    expect(stateRejection({ ...vivo, used_at: '2026-08-25T17:29:00Z' }, NOW)).toBe('ya usado');
  });
  it('rechaza uno expirado', () => {
    expect(stateRejection({ ...vivo, expires_at: '2026-08-25T17:29:00Z' }, NOW)).toBe('expirado');
  });
});

// El desglose horario del hover. Existe porque el resumen colapsa las juntas pegadas a propósito:
// "Ocupado hasta 15:00" no puede responder "¿a qué horas exactamente?", y esta lista sí.
describe('derivePresence · agenda del hover', () => {
  const dia = [
    block('2026-08-25T16:00:00Z', '2026-08-25T17:00:00Z', 'Ya pasó'),
    block('2026-08-25T17:00:00Z', '2026-08-25T18:00:00Z', 'En curso'),
    block('2026-08-25T19:00:00Z', '2026-08-25T20:00:00Z', 'Después'),
    block('2026-08-25T21:00:00Z', '2026-08-25T22:00:00Z', 'Más tarde'),
  ];

  it('lista lo que sigue vivo y omite lo ya terminado', () => {
    const p = presence(dia);
    expect(p.upcoming.map((b) => b.title)).toEqual(['En curso', 'Después', 'Más tarde']);
  });

  it('marca cuál está en curso', () => {
    const p = presence(dia);
    expect(p.upcoming.filter((b) => b.current).map((b) => b.title)).toEqual(['En curso']);
  });

  it('deja fuera los eventos de todo el día', () => {
    const p = presence([...dia, block('2026-08-25T00:00:00Z', '2026-08-26T00:00:00Z', 'Cumpleaños', true)]);
    expect(p.upcoming.some((b) => b.title === 'Cumpleaños')).toBe(false);
  });

  it('también la trae cuando está libre', () => {
    const p = presence([block('2026-08-25T20:00:00Z', '2026-08-25T21:00:00Z', 'Planeación')]);
    expect(p.status).toBe('free');
    expect(p.upcoming.map((b) => b.title)).toEqual(['Planeación']);
  });

  it('sin cuenta conectada la agenda va vacía', () => {
    const p = derivePresence('dev-1', dia, { now: NOW, connected: false, lastSyncedAt: null });
    expect(p.upcoming).toEqual([]);
  });

  it('tope de renglones: un tooltip no puede crecer sin límite', () => {
    const muchos = Array.from({ length: 20 }, (_, i) =>
      block(`2026-08-25T${String(18 + Math.floor(i / 4)).padStart(2, '0')}:${(i % 4) * 10}0000Z`.replace('0000Z', ':00Z'),
            `2026-08-25T${String(18 + Math.floor(i / 4)).padStart(2, '0')}:${(i % 4) * 10 + 5}:00Z`, `Evento ${i}`),
    );
    expect(presence(muchos).upcoming.length).toBeLessThanOrEqual(10);
  });
});

// El horizonte del desglose es OTRO que el del resumen. Mirando de noche, 12 h cortaban la tarde
// del día siguiente completa — y el tooltip decía "resto del día".
describe('derivePresence · horizonte del desglose vs del resumen', () => {
  const enOchoHoras = block('2026-08-26T01:30:00Z', '2026-08-26T02:30:00Z', 'Dentro de 8 h');
  const enVeinte = block('2026-08-26T13:30:00Z', '2026-08-26T14:30:00Z', 'Dentro de 20 h');
  const enTreinta = block('2026-08-26T23:30:00Z', '2026-08-27T00:30:00Z', 'Dentro de 30 h');

  it('el desglose llega a 24 h', () => {
    const p = presence([enOchoHoras, enVeinte]);
    expect(p.upcoming.map((b) => b.title)).toEqual(['Dentro de 8 h', 'Dentro de 20 h']);
  });

  it('el desglose corta más allá de 24 h', () => {
    expect(presence([enTreinta]).upcoming).toEqual([]);
  });

  it('el resumen sigue anunciando solo lo de las próximas 12 h', () => {
    // A 20 h de distancia entra en el desglose pero NO se anuncia como "próxima": sería ruido.
    const p = presence([enVeinte]);
    expect(p.upcoming.map((b) => b.title)).toEqual(['Dentro de 20 h']);
    expect(p.nextStartsAt).toBeNull();
  });
});

// Regresión del caso real que lo destapó: dormido de 00:45 a 09:30, sesión 09:00–13:00, weekly
// 12:00–14:00 y clase a las 16:30. El panel decía "Toy Dormido hasta 14:00 · Sigue 16:30" —
// atribuía a la siesta el fin de toda la racha y saltaba por encima de la sesión y el weekly.
describe('derivePresence · agenda encadenada del día', () => {
  const dia = [
    block('2026-08-25T07:45:00Z', '2026-08-25T16:30:00Z', 'Toy Dormido'),
    block('2026-08-25T16:00:00Z', '2026-08-25T20:00:00Z', 'Sesion Lunes a Jueves'),
    block('2026-08-25T19:00:00Z', '2026-08-25T21:00:00Z', 'Weekly Hyper'),
    block('2026-08-25T23:30:00Z', '2026-08-26T01:00:00Z', 'ITSON - Ingenieria de Requisitos'),
  ];

  it('de madrugada: la siesta termina cuando termina, y lo que sigue es la sesión', () => {
    const p = derivePresence('dev-1', dia, {
      now: new Date('2026-08-25T08:00:00Z'),
      connected: true,
      lastSyncedAt: '2026-08-25T07:59:00Z',
    });
    expect(p.title).toBe('Toy Dormido');
    expect(p.busyUntil).toBe('2026-08-25T16:30:00.000Z'); // 09:30, no 14:00
    expect(p.nextTitle).toBe('Sesion Lunes a Jueves');    // 09:00, no la clase de las 16:30
  });

  it('a media mañana ya reporta la sesión, no la siesta encimada', () => {
    const p = derivePresence('dev-1', dia, {
      now: new Date('2026-08-25T16:15:00Z'),
      connected: true,
      lastSyncedAt: '2026-08-25T16:14:00Z',
    });
    expect(p.title).toBe('Sesion Lunes a Jueves');
    expect(p.nextTitle).toBe('Weekly Hyper');
  });

  it('al mediodía manda el weekly, que es lo último que arrancó', () => {
    const p = derivePresence('dev-1', dia, {
      now: new Date('2026-08-25T19:30:00Z'),
      connected: true,
      lastSyncedAt: '2026-08-25T19:29:00Z',
    });
    expect(p.title).toBe('Weekly Hyper');
    expect(p.busyUntil).toBe('2026-08-25T21:00:00.000Z');
    expect(p.nextTitle).toBe('ITSON - Ingenieria de Requisitos');
  });
});
