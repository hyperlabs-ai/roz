import { describe, expect, it } from 'vitest';
import { diffNames, parseDotenv, quoteValue, serializeDotenv } from '../src/dotenv.js';

const vars = (text: string): Record<string, string> => Object.fromEntries(parseDotenv(text).vars);

describe('parseDotenv', () => {
  it('asignaciones simples, comentarios, líneas vacías y export', () => {
    const text = ['# comentario', '', 'A=1', 'export B=dos', '  C = tres  ', 'D=', 'E=a=b=c'].join('\n');
    expect(vars(text)).toEqual({ A: '1', B: 'dos', C: 'tres', D: '', E: 'a=b=c' });
    expect(parseDotenv(text).problems).toEqual([]);
  });

  it('sin comillas: ` #` inicia comentario, `#` pegado no', () => {
    expect(vars('A=valor # comentario\nB=color#fff\nC=#todo comentario\nD=con espacios internos')).toEqual({
      A: 'valor',
      B: 'color#fff',
      C: '',
      D: 'con espacios internos',
    });
  });

  it('comilla simple: literal, sin escapes ni comentarios', () => {
    expect(vars(`A='con # gato y $HOME y \\n y "dobles"' # fuera`)).toEqual({ A: 'con # gato y $HOME y \\n y "dobles"' });
  });

  it('comilla doble: interpreta \\n \\r \\t \\\\ \\" \\$ y deja lo demás', () => {
    expect(vars('A="l1\\nl2\\tx\\\\y \\"q\\" \\$HOME $OTRA \\d # no comentario" # sí comentario')).toEqual({
      A: 'l1\nl2\tx\\y "q" $HOME $OTRA \\d # no comentario',
    });
  });

  it('valores de varias líneas entre comillas', () => {
    expect(vars('A="uno\ndos\ntres"\nB=\'x\ny\'\nC=fin')).toEqual({ A: 'uno\ndos\ntres', B: 'x\ny', C: 'fin' });
  });

  it('CRLF y BOM no ensucian los valores', () => {
    expect(vars('\uFEFFA=1\r\nB="dos"\r\nC=\'x\r\ny\'\r\n')).toEqual({ A: '1', B: 'dos', C: 'x\ny' });
  });

  it('si un nombre se repite gana el último', () => {
    expect(vars('A=1\nB=2\nA=3')).toEqual({ B: '2', A: '3' });
  });

  it('reporta lo que no pudo leer, con número de línea y sin valores', () => {
    const p = parseDotenv('A=1\nesto no es nada secreto123\nB="sin cerrar secreto456\nC=3');
    expect(p.problems.map((x) => x.line)).toEqual([2, 3]);
    expect(JSON.stringify(p.problems)).not.toMatch(/secreto123|secreto456/);
    expect(Object.fromEntries(p.vars)).toEqual({ A: '1', C: '3' });
    expect(parseDotenv('A="ok" basura').problems).toHaveLength(1);
  });

  it('separa el bloque local: se conserva crudo y sus variables no cuentan', () => {
    const block = '# >>> local\n# mis cosas\nPORT=4000\nA="pisada"\n# <<< local';
    const p = parseDotenv(`A=1\nB=2\n\n${block}\nC=3\n`);
    expect(Object.fromEntries(p.vars)).toEqual({ A: '1', B: '2', C: '3' });
    expect(p.localNames).toEqual(['PORT', 'A']);
    expect(p.localBlock).toBe(block);
    expect(p.problems).toEqual([]);
  });

  it('varios bloques locales y uno sin cerrar', () => {
    const p = parseDotenv('# >>> local\nX=1\n# <<< local\nA=1\n#>>> LOCAL (mío)\nY=2\n');
    expect(Object.fromEntries(p.vars)).toEqual({ A: '1' });
    expect(p.localNames).toEqual(['X', 'Y']);
    expect(p.localBlock).toBe('# >>> local\nX=1\n# <<< local\n\n#>>> LOCAL (mío)\nY=2\n# <<< local');
    expect(p.problems).toHaveLength(1);
  });

  it('un marcador dentro de un valor entre comillas no abre un bloque', () => {
    const p = parseDotenv('A="x\n# >>> local\ny"\nB=2');
    expect(Object.fromEntries(p.vars)).toEqual({ A: 'x\n# >>> local\ny', B: '2' });
    expect(p.localBlock).toBeNull();
  });
});

describe('quoteValue', () => {
  it('usa las comillas mínimas', () => {
    expect(quoteValue('')).toBe('');
    expect(quoteValue('simple-1.2_3')).toBe('simple-1.2_3');
    expect(quoteValue('https://a.b/c?d=e')).toBe(`'https://a.b/c?d=e'`);
    expect(quoteValue('postgres://u:p@h:5432/db')).toBe('postgres://u:p@h:5432/db');
    expect(quoteValue('con espacios')).toBe(`'con espacios'`);
    expect(quoteValue('a#b')).toBe(`'a#b'`);
    expect(quoteValue('pa$$word')).toBe(`'pa$$word'`);
    expect(quoteValue('dice "hola"')).toBe(`'dice "hola"'`);
    expect(quoteValue('C:\\ruta\\nueva')).toBe(`'C:\\ruta\\nueva'`);
    expect(quoteValue("it's")).toBe(`"it's"`);
    expect(quoteValue(`it's "x" $y \\z`)).toBe(`"it's \\"x\\" \\$y \\\\z"`);
    expect(quoteValue('l1\nl2')).toBe('"l1\\nl2"');
    expect(quoteValue(' borde ')).toBe(`' borde '`);
  });
});

describe('ida y vuelta', () => {
  const hard: Record<string, string> = {
    VACIA: '',
    SIMPLE: 'abc123',
    ESPACIOS: '  con espacios a los lados  ',
    GATO: 'a # b',
    GATO_PEGADO: '#inicio',
    DOLAR: '$HOME/${X} $$',
    SIMPLES: "it's",
    DOBLES: 'dice "hola"',
    AMBAS: `'a' "b" \\ $c`,
    NUEVAS_LINEAS: 'l1\nl2\n\nl4\n',
    CRLF: 'l1\r\nl2',
    TAB: 'a\tb',
    BARRAS: 'C:\\Users\\yo\\n',
    BARRA_FINAL: 'termina en \\',
    BARRA_Y_SIMPLE: `it's \\n literal`,
    PEM: '-----BEGIN PRIVATE KEY-----\nMIIEvQ+/=\n-----END PRIVATE KEY-----\n',
    JSON: '{"a":"b c","d":[1,2],"e":"it\'s"}',
    UNICODE: 'ñandú → 🚀',
    IGUAL: '=a==b=',
    MARCADOR: '# >>> local',
    EXPORT: 'export X=1',
    COMILLA_SOLA: '"',
    SIMPLE_SOLA: "'",
  };

  it('parse(serialize(x)) devuelve exactamente x, en el mismo orden', () => {
    const text = serializeDotenv(Object.entries(hard));
    const p = parseDotenv(text);
    expect(p.problems).toEqual([]);
    expect([...p.vars]).toEqual(Object.entries(hard));
    expect(p.localBlock).toBeNull();
  });

  it('cada variable ocupa una sola línea (los saltos van escapados)', () => {
    const text = serializeDotenv(Object.entries(hard));
    expect(text.trimEnd().split('\n')).toHaveLength(Object.keys(hard).length);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('aguanta valores al azar', () => {
    const alphabet = ['a', 'Z', '0', ' ', '\n', '\r', '\t', '"', "'", '\\', '$', '#', '=', '`', 'ñ', '{', '-'];
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const entries: Array<[string, string]> = [];
    for (let i = 0; i < 400; i++) {
      let v = '';
      const len = rnd() % 12;
      for (let j = 0; j < len; j++) v += alphabet[rnd() % alphabet.length];
      entries.push([`V_${i}`, v]);
    }
    const p = parseDotenv(serializeDotenv(entries));
    expect(p.problems).toEqual([]);
    expect([...p.vars]).toEqual(entries);
  });

  it('encabezado y bloque local: el bloque se copia idéntico y sigue separado', () => {
    const block = '# >>> local\nPORT=4000 # mío\n# <<< local';
    const text = serializeDotenv([['A', '1']], { header: ['generado'], localBlock: block });
    expect(text).toBe(`# generado\nA=1\n\n${block}\n`);
    const p = parseDotenv(text);
    expect(Object.fromEntries(p.vars)).toEqual({ A: '1' });
    expect(p.localBlock).toBe(block);
    expect(serializeDotenv([], { localBlock: block })).toBe(`${block}\n`);
    expect(serializeDotenv([])).toBe('');
  });
});

describe('diffNames', () => {
  it('clasifica por nombre y ordena', () => {
    const current = new Map([['B', '1'], ['A', '1'], ['C', '1'], ['Z', 'z']]);
    const next = new Map([['C', '2'], ['A', '1'], ['N', 'n'], ['M', 'm']]);
    expect(diffNames(current, next)).toEqual({ added: ['M', 'N'], changed: ['C'], removed: ['B', 'Z'], same: ['A'] });
  });
});
