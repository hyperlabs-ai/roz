import { describe, it, expect } from 'vitest';
import { channelSlug, chatPushRecipients, defaultNotifyLevel, dmKey, splitTaskQuery, type PushCandidate } from '../src/chat/rules.js';

// Las reglas del chat que deciden a quién se molesta. Un push de más entrena a la gente a silenciar
// roz; uno de menos hace que el chat "no sirva". Se prueban sin base: solo la decisión.

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const D = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const member = (devId: string, notifyLevel: PushCandidate['notifyLevel'] = 'mentions'): PushCandidate => ({ devId, notifyLevel });

describe('channelSlug', () => {
  it('normaliza como Slack: minúsculas, guiones y sin símbolos', () => {
    expect(channelSlug('  Asistencia Equipos ')).toBe('asistencia-equipos');
    expect(channelSlug('#facturación_proy!!')).toBe('facturación-proy');
    expect(channelSlug('a -- b')).toBe('a-b');
  });

  it('rechaza un nombre que queda vacío', () => {
    expect(() => channelSlug('###')).toThrow();
    expect(() => channelSlug('   ')).toThrow();
  });
});

describe('dmKey', () => {
  it('es la misma para el mismo grupo sin importar el orden ni repetidos', () => {
    expect(dmKey([B, A])).toBe(dmKey([A, B, A]));
    expect(dmKey([A.toUpperCase(), B])).toBe(dmKey([A, B]));
  });

  it('distingue grupos distintos', () => {
    expect(dmKey([A, B])).not.toBe(dmKey([A, B, C]));
  });
});

describe('defaultNotifyLevel', () => {
  it('MD avisa todo; canal solo menciones', () => {
    expect(defaultNotifyLevel('dm')).toBe('all');
    expect(defaultNotifyLevel('channel')).toBe('mentions');
  });
});

describe('chatPushRecipients', () => {
  it('MD: avisa a los demás, nunca al autor', () => {
    const out = chatPushRecipients({
      kind: 'dm',
      authorDevId: A,
      members: [member(A, 'all'), member(B, 'all'), member(C, 'mentions')],
      mentions: [],
      mentionChannel: false,
      isReply: false,
    });
    expect(out).toEqual([B, C]);
  });

  it('nadie recibe nada de una conversación silenciada, aunque lo mencionen', () => {
    const out = chatPushRecipients({
      kind: 'channel',
      authorDevId: A,
      members: [member(A), member(B, 'none'), member(C, 'none')],
      mentions: [B],
      mentionChannel: true,
      isReply: false,
    });
    expect(out).toEqual([]);
  });

  it("canal: 'all' recibe todo; 'mentions' solo si lo mencionan", () => {
    const out = chatPushRecipients({
      kind: 'channel',
      authorDevId: A,
      members: [member(A), member(B, 'all'), member(C, 'mentions'), member(D, 'mentions')],
      mentions: [D],
      mentionChannel: false,
      isReply: false,
    });
    expect(out).toEqual([B, D]);
  });

  it('@canal avisa a todo miembro no silenciado', () => {
    const out = chatPushRecipients({
      kind: 'channel',
      authorDevId: A,
      members: [member(A), member(B), member(C, 'none'), member(D)],
      mentions: [],
      mentionChannel: true,
      isReply: false,
    });
    expect(out).toEqual([B, D]);
  });

  it("hilo en canal: participantes y mencionados; 'all' no incluye hilos ajenos ni @canal despierta al canal", () => {
    const out = chatPushRecipients({
      kind: 'channel',
      authorDevId: A,
      members: [member(A), member(B, 'all'), member(C), member(D)],
      mentions: [D],
      mentionChannel: true,
      isReply: true,
      threadParticipants: [A, C],
    });
    expect(out).toEqual([C, D]);
  });

  it('mencionar a alguien que no es miembro no le manda nada', () => {
    const out = chatPushRecipients({
      kind: 'channel',
      authorDevId: A,
      members: [member(A), member(B)],
      mentions: [C],
      mentionChannel: false,
      isReply: false,
    });
    expect(out).toEqual([]);
  });
});

describe('splitTaskQuery (@tarea <persona> <texto>)', () => {
  const devs = [
    { id: 'crix', name: 'Crix' },
    { id: 'araly', name: 'Araly' },
    { id: 'ana', name: 'Ana María López' },
    { id: 'fer', name: 'Fer' },
  ];

  it('la persona se reconoce con o sin @, y el resto es texto', () => {
    expect(splitTaskQuery('@Crix sitemap', devs)).toEqual({ devIds: ['crix'], textWords: ['sitemap'], empty: false });
    expect(splitTaskQuery('crix sitemap', devs)).toEqual({ devIds: ['crix'], textWords: ['sitemap'], empty: false });
  });

  it('busca tareas de OTRAS personas, no solo de quien busca', () => {
    expect(splitTaskQuery('@Fer login', devs).devIds).toEqual(['fer']);
  });

  it('nombres compuestos y acentos: cualquier parte del nombre, sin importar tildes', () => {
    expect(splitTaskQuery('@maria', devs).devIds).toEqual(['ana']);
    expect(splitTaskQuery('Ana María', devs).devIds).toEqual(['ana']);
  });

  it('sin palabras: vacío (se listan las tareas abiertas propias); una @ suelta no cuenta', () => {
    expect(splitTaskQuery('', devs)).toEqual({ devIds: [], textWords: [], empty: true });
    expect(splitTaskQuery('@', devs)).toEqual({ devIds: [], textWords: [], empty: true });
  });

  it('limpia lo que rompería el filtro de PostgREST', () => {
    expect(splitTaskQuery('login,(admin)', devs).textWords).toEqual(['loginadmin']);
  });
});
