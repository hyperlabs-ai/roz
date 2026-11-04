import { describe, it, expect } from 'vitest';
import { CHANNEL_TOKEN, MAX_CITED_TASKS, extractMentions, extractTaskIdentifiers, firstLine, hasChannelMention, previewText, statusTaskIds } from '../src/chat/text.js';

// El texto del chat viaja con tokens (<@id>, <!canal>) y markdown. Lo que se prueba aquí es lo que
// ve la gente fuera del chat: el cuerpo del push y el nombre de una tarea creada desde un mensaje.
// Un `<@3f2a…>` o un `**hola**` crudo en una notificación se lee como un error de roz.

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const names: Record<string, string> = { [A]: 'Carmen Vega', [B]: 'Mauricio Rodríguez' };
const nameOf = (id: string) => names[id];

describe('extractMentions', () => {
  it('saca los ids sin repetir y en orden', () => {
    expect(extractMentions(`hola <@${B}> y <@${A}>, <@${B}> otra vez`)).toEqual([B, A]);
  });

  it('normaliza a minúsculas e ignora tokens mal formados', () => {
    expect(extractMentions(`<@${A.toUpperCase()}> <@123> <@>`)).toEqual([A]);
  });
});

describe('hasChannelMention', () => {
  it('detecta @canal', () => {
    expect(hasChannelMention(`${CHANNEL_TOKEN} reunión`)).toBe(true);
    expect(hasChannelMention('canal sin token')).toBe(false);
  });
});

describe('previewText', () => {
  it('pone nombres en las menciones y @canal', () => {
    expect(previewText(`Hola, ${CHANNEL_TOKEN}. Gracias <@${A}>`, nameOf)).toBe('Hola, @canal. Gracias @Carmen Vega');
  });

  it('una mención a alguien desconocido no muestra el id', () => {
    expect(previewText('<@cccccccc-cccc-cccc-cccc-cccccccccccc> ok', nameOf)).toBe('@alguien ok');
  });

  it('quita el markdown y deja una sola línea', () => {
    expect(previewText('**Listo** el `deploy`\n\n> ver [el PR](https://x.y/1)\n- uno', nameOf)).toBe(
      'Listo el deploy ver el PR uno',
    );
  });

  it('resume los bloques de código', () => {
    expect(previewText('mira:\n```\nconst a = 1;\n```', nameOf)).toBe('mira: [código]');
  });

  it('recorta con elipsis', () => {
    const out = previewText('a'.repeat(300), nameOf, 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('firstLine', () => {
  it('toma la primera línea con contenido, en texto plano', () => {
    expect(firstLine(`\n\n**Revisar** el cronograma con <@${B}>\nsegunda línea`, nameOf)).toBe(
      'Revisar el cronograma con @Mauricio Rodríguez',
    );
  });
});

describe('extractTaskIdentifiers', () => {
  it('saca las tareas citadas con #KEY-N, en mayúsculas y sin repetir', () => {
    expect(extractTaskIdentifiers('mira #ROZ-12 y #hyperflow-454, otra vez #roz-12.')).toEqual(['ROZ-12', 'HYPERFLOW-454']);
  });

  it('no confunde títulos de markdown, anclas de URL ni texto pegado', () => {
    expect(extractTaskIdentifiers('# ROZ-12 título')).toEqual([]);
    expect(extractTaskIdentifiers('https://x.com/doc#ROZ-12')).toEqual([]);
    expect(extractTaskIdentifiers('abc#ROZ-12 y ##ROZ-3')).toEqual([]);
    expect(extractTaskIdentifiers('#ROZ-12x #ROZ-')).toEqual([]);
  });

  it('acepta la cita al inicio, entre paréntesis y al final de línea', () => {
    expect(extractTaskIdentifiers('#A-1 (#B-2)\nfin #C-3')).toEqual(['A-1', 'B-2', 'C-3']);
  });

  it(`tope de ${MAX_CITED_TASKS} tarjetas por mensaje`, () => {
    const body = Array.from({ length: 10 }, (_, i) => `#ROZ-${i + 1}`).join(' ');
    expect(extractTaskIdentifiers(body)).toHaveLength(MAX_CITED_TASKS);
  });
});

describe('statusTaskIds (bloque Status)', () => {
  it('lee los ids de un status y respeta el orden elegido', () => {
    expect(statusTaskIds({ type: 'status', taskIds: [B, A] })).toEqual([B, A]);
  });

  it('un mensaje que no es status no devuelve nada, aunque traiga taskIds', () => {
    expect(statusTaskIds({ type: 'task_created', taskIds: [A] })).toEqual([]);
    expect(statusTaskIds(null)).toEqual([]);
  });

  it('descarta valores que no son ids (meta malformado no rompe el mensaje)', () => {
    expect(statusTaskIds({ type: 'status', taskIds: [A, 3, null, { x: 1 }] })).toEqual([A]);
    expect(statusTaskIds({ type: 'status', taskIds: 'nope' })).toEqual([]);
  });
});
