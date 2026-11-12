import { describe, expect, it, vi } from 'vitest';
import { ExtractionError, extractFromTranscript, parseExtraction } from '../src/meetings/extract.js';
import {
  DUPLICATE_RRF_THRESHOLD,
  acceptMode,
  duplicateComment,
  meetingTrail,
  pickDuplicate,
  priorityFromUrgency,
  rozPriorityOf,
  titleOverlap,
} from '../src/meetings/rules.js';

// Claude propone, el código valida: JSON con forma fija (zod), un solo reintento, y si vuelve a
// fallar la junta queda para revisar. Nunca se llama a la API real: `complete` va inyectado.

const INPUT = { title: 'Weekly Acme', heldAt: '2026-11-10T16:00:00Z', attendees: [{ name: 'Ana', email: 'ana@acme.com' }], projectName: 'Acme', transcript: 'Ana: hola' };

const GOOD = JSON.stringify({
  tareas: [{ title: 'Exportar a CSV', description: 'En reportes', quote: 'necesitamos exportar a CSV', owner: 'Ana', due: 'el viernes', dueDate: '2026-11-13' }],
  compromisos: [],
  decisiones: [{ title: 'Usar Stripe', description: null, quote: 'vamos con Stripe' }],
});

describe('parseExtraction', () => {
  it('acepta JSON envuelto en ```json y normaliza opcionales', () => {
    const r = parseExtraction('Aquí va:\n```json\n' + GOOD + '\n```');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tareas[0]).toEqual({
        title: 'Exportar a CSV',
        description: 'En reportes',
        quote: 'necesitamos exportar a CSV',
        owner: 'Ana',
        due: 'el viernes',
        dueDate: '2026-11-13',
      });
      expect(r.value.decisiones[0]!.description).toBeNull();
    }
  });

  it('una fecha que no es YYYY-MM-DD se descarta (no tumba la candidata)', () => {
    const r = parseExtraction(JSON.stringify({ tareas: [{ title: 'x', quote: 'y', dueDate: 'viernes' }] }));
    expect(r.ok && r.value.tareas[0]!.dueDate).toBeNull();
  });

  it('listas ausentes = vacías', () => {
    const r = parseExtraction('{}');
    expect(r.ok && r.value).toEqual({ tareas: [], compromisos: [], decisiones: [] });
  });

  it('sin JSON o con forma equivocada → error con motivo', () => {
    expect(parseExtraction('no sé')).toMatchObject({ ok: false });
    const r = parseExtraction(JSON.stringify({ tareas: [{ title: 'sin cita' }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/quote/);
  });
});

describe('extractFromTranscript', () => {
  it('primera respuesta válida: un solo intento', async () => {
    const complete = vi.fn(async () => GOOD);
    const r = await extractFromTranscript(INPUT, complete);
    expect(r.attempts).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
    const prompt = (complete.mock.calls[0] as unknown as [{ user: string }])[0].user;
    expect(prompt).toContain('Fecha: 2026-11-10');
    expect(prompt).toContain('<transcripcion>');
  });

  it('respuesta inválida → reintenta UNA vez diciendo qué falló', async () => {
    const complete = vi.fn().mockResolvedValueOnce('lo siento').mockResolvedValueOnce(GOOD);
    const r = await extractFromTranscript(INPUT, complete);
    expect(r.attempts).toBe(2);
    expect((complete.mock.calls[1]![0] as { user: string }).user).toMatch(/no se pudo usar/);
  });

  it('dos inválidas → ExtractionError "revisar" (no reintentable)', async () => {
    const complete = vi.fn(async () => '{"tareas": 3}');
    const err = await extractFromTranscript(INPUT, complete).catch((e) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect(err.message).toMatch(/^revisar:/);
    expect(err.retryable).toBe(false);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('un error de la API se relanza tal cual (lo reintenta el outbox)', async () => {
    const boom = new Error('529 overloaded');
    const complete = vi.fn(async () => {
      throw boom;
    });
    await expect(extractFromTranscript(INPUT, complete)).rejects.toBe(boom);
  });
});

describe('duplicados', () => {
  const hit = (over: Partial<{ name: string; score: number }>) => ({
    id: 'w1',
    identifier: 'ACME-12',
    name: 'Exportar reportes a CSV',
    status: 'pendiente',
    linear_id: 'lin-1',
    score: 0.01,
    ...over,
  });

  it('RRF por encima del umbral (coinciden palabras y vector) = duplicado', () => {
    expect(pickDuplicate([hit({ name: 'otra cosa', score: DUPLICATE_RRF_THRESHOLD })], 'Algo distinto')).not.toBeNull();
  });

  it('solo palabras: duplicado si los nombres comparten casi todo', () => {
    expect(pickDuplicate([hit({})], 'Exportar a CSV los reportes')).not.toBeNull();
    expect(pickDuplicate([hit({})], 'Arreglar login')).toBeNull();
  });

  it('una sola palabra en común no basta', () => {
    expect(titleOverlap('Exportar facturas', 'Exportar usuarios')).toEqual({ ratio: 0.5, shared: 1 });
    expect(pickDuplicate([hit({ name: 'Exportar usuarios' })], 'Exportar facturas')).toBeNull();
  });

  it('sin resultados → null', () => {
    expect(pickDuplicate([], 'x')).toBeNull();
  });
});

describe('reglas de la bandeja', () => {
  it('prioridad desde la urgencia de Jev', () => {
    expect(priorityFromUrgency('urgente')).toBe(1);
    expect(priorityFromUrgency('no_urgente')).toBe(3);
    expect(priorityFromUrgency('incierta')).toBeNull();
    expect(rozPriorityOf(1)).toBe('urgent');
    expect(rozPriorityOf(null)).toBeNull();
  });

  it('modo por defecto: comentar si hay duplicado; lo que pida la persona gana', () => {
    expect(acceptMode(undefined, true)).toBe('comentar');
    expect(acceptMode(undefined, false)).toBe('crear');
    expect(acceptMode('crear', true)).toBe('crear');
  });

  it('rastros con la cita en markdown', () => {
    const m = { title: 'Weekly', heldAt: '2026-11-10T16:00:00Z' };
    expect(meetingTrail(m, 'línea 1\nlínea 2')).toBe('---\nDesde la junta «Weekly» (10 nov 2026):\n\n> línea 1\n> línea 2');
    expect(duplicateComment(m, { title: 'X', description: null, quote: 'cita' })).toBe(
      'Se volvió a hablar de esto en la junta «Weekly» (10 nov 2026).\n\n> cita',
    );
  });
});
