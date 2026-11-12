import { describe, expect, it } from 'vitest';
import {
  cleanText,
  granolaNoteText,
  looksTimed,
  normalizeTranscript,
  parseSrt,
  parseVtt,
  splitSpeaker,
} from '../src/meetings/transcript.js';

// El texto que se guarda es contra el que se verifican las citas: sin marcas de tiempo ni números de
// bloque, con un renglón por turno y el hablante delante. Si el parseo mete basura, ninguna cita
// verifica y la junta sale vacía.

describe('parseVtt', () => {
  it('quita cabecera, ids y tiempos; usa <v> como hablante y junta turnos seguidos', () => {
    const vtt = [
      'WEBVTT',
      'Kind: captions',
      '',
      'NOTE esto es un comentario',
      '',
      '1',
      '00:00:01.000 --> 00:00:03.500 align:start',
      '<v Ana López>Hola a todos,</v>',
      '',
      '2',
      '00:00:03.500 --> 00:00:06.000',
      '<v Ana López>vamos con el checkout.</v>',
      '',
      '00:00:06.000 --> 00:00:09.000',
      '<v.loud Beto>Yo mando el reporte el viernes.</v>',
    ].join('\n');
    expect(parseVtt(vtt)).toBe('Ana López: Hola a todos, vamos con el checkout.\nBeto: Yo mando el reporte el viernes.');
  });

  it('entiende el estilo "Nombre: texto" de Zoom/Teams y limpia etiquetas de formato', () => {
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\nCarla: <i>Revisa</i> el <c.yellow>deploy</c>\n\n00:02.000 --> 00:03.000\nCarla: de staging.';
    expect(parseVtt(vtt)).toBe('Carla: Revisa el deploy de staging.');
  });

  it('un renglón sin hablante dentro del cue continúa el turno', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nDiego: primera parte\nsegunda parte';
    expect(parseVtt(vtt)).toBe('Diego: primera parte segunda parte');
  });

  it('acepta \\r\\n y BOM', () => {
    const vtt = '\uFEFFWEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHola mundo\r\n';
    expect(parseVtt(vtt)).toBe('Hola mundo');
  });
});

describe('parseSrt', () => {
  it('quita números de bloque y tiempos con coma', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:04,000',
      'Ana: Necesitamos exportar a CSV',
      '',
      '2',
      '00:00:04,000 --> 00:00:06,000',
      'Ana: antes del lanzamiento.',
      '',
      '3',
      '00:00:06,000 --> 00:00:08,000',
      '[Beto] De acuerdo.',
    ].join('\n');
    expect(parseSrt(srt)).toBe('Ana: Necesitamos exportar a CSV antes del lanzamiento.\nBeto: De acuerdo.');
  });

  it('subtítulos sin hablante se juntan en un párrafo', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n<i>hola</i>\n\n2\n00:00:02,000 --> 00:00:03,000\nqué tal';
    expect(parseSrt(srt)).toBe('hola qué tal');
  });
});

describe('splitSpeaker', () => {
  it('no confunde una frase con dos puntos con un hablante', () => {
    expect(splitSpeaker('Hay que revisar esto, mira: el botón falla').speaker).toBeNull();
    expect(splitSpeaker('Ana María: hola')).toEqual({ speaker: 'Ana María', text: 'hola' });
  });
});

describe('normalizeTranscript', () => {
  it('texto pegado: solo limpieza', () => {
    expect(normalizeTranscript('texto', '  hola  \r\n\r\n\r\n\r\nadiós \n')).toBe('hola\n\nadiós');
  });

  it('un .vtt pegado como texto se parsea igual', () => {
    expect(normalizeTranscript('texto', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAna: hola')).toBe('Ana: hola');
  });

  it('un .srt pegado como texto también', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nhola\n\n2\n00:00:02,000 --> 00:00:03,000\nadiós';
    expect(looksTimed(srt)).toBe(true);
    expect(normalizeTranscript('texto', srt)).toBe('hola adiós');
  });

  it('.docx: error claro de "no soportado aún"', () => {
    expect(() => normalizeTranscript('texto', 'algo', 'minuta.docx')).toThrow(/\.docx todavía no se soportan/);
  });

  it('contenido binario (zip de un docx): error claro', () => {
    expect(() => normalizeTranscript('texto', 'PK\u0003\u0004\u0000\u0000\u0001')).toThrow(/no es texto/);
  });

  it('vacío tras parsear: error', () => {
    expect(() => normalizeTranscript('vtt', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n')).toThrow(/no tiene texto/);
  });

  it('demasiado largo: error', () => {
    expect(() => normalizeTranscript('texto', 'a'.repeat(400_001))).toThrow(/demasiado largo/);
  });
});

describe('granolaNoteText', () => {
  it('resumen + transcripción por hablante', () => {
    const text = granolaNoteText({
      summaryMarkdown: '## Acuerdos\n- Vamos con Stripe',
      transcript: [
        { speaker: 'Ana', text: 'Vamos con Stripe.', startTime: null },
        { speaker: 'Ana', text: 'Lo integro esta semana.', startTime: null },
        { speaker: 'Beto', text: 'Va.', startTime: null },
      ],
    });
    expect(text).toBe('Resumen de Granola:\n## Acuerdos\n- Vamos con Stripe\n\nTranscripción:\nAna: Vamos con Stripe. Lo integro esta semana.\nBeto: Va.');
  });

  it('sin nada: cadena vacía', () => {
    expect(granolaNoteText({ summaryMarkdown: null, transcript: [] })).toBe('');
    expect(cleanText('   ')).toBe('');
  });
});
