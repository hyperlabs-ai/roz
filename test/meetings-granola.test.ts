import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Transporte a Granola (solo lectura). Como con Linear y TypeSafe, importa cómo FALLA: sin llave no
// toca la red, un error de la API nunca se lee como "no hubo juntas", y el parseo tolera campos
// faltantes. Nunca se llama a la API real: `fetch` va simulado.

const KEY = 'grn_test_123';

async function load(withKey = true) {
  if (withKey) process.env.GRANOLA_API_KEY = KEY;
  else delete process.env.GRANOLA_API_KEY;
  vi.resetModules();
  return import('../src/adapters/granola.js');
}

type Reply = { status: number; body: unknown };

function respond(...replies: Reply[]) {
  let i = 0;
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
    const r = replies[Math.min(i++, replies.length - 1)]!;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => text };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GRANOLA_API_KEY;
});

describe('granola adapter', () => {
  it('sin llave: apagado y sin red', async () => {
    const g = await load(false);
    const fetchMock = respond({ status: 200, body: { notes: [] } });
    expect(g.granolaEnabled()).toBe(false);
    await expect(g.listNotes()).rejects.toMatchObject({ retryable: false, code: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('listNotes: Bearer, filtros en la URL y paginación', async () => {
    const g = await load();
    const fetchMock = respond({
      status: 200,
      body: { notes: [{ id: 'n1', title: 'Weekly', created_at: '2026-11-10T16:00:00Z' }], hasMore: true, cursor: 'c2' },
    });
    const page = await g.listNotes({ createdAfter: '2026-11-01T00:00:00.000Z' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/v1/notes?');
    expect(url).toContain('created_after=2026-11-01T00%3A00%3A00.000Z');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(page).toEqual({
      notes: [{ id: 'n1', title: 'Weekly', createdAt: '2026-11-10T16:00:00Z', updatedAt: null }],
      cursor: 'c2',
      hasMore: true,
    });
  });

  it('getNote: asistentes sin repetir (nota + calendario), hablantes y texto vacío fuera', async () => {
    const g = await load();
    respond({
      status: 200,
      body: {
        id: 'n1',
        title: null,
        created_at: '2026-11-10T16:00:00Z',
        attendees: [{ name: 'Ana', email: 'Ana@Acme.com' }],
        calendar_event: {
          event_title: 'Weekly Acme',
          scheduled_start_time: '2026-11-10T16:00:00Z',
          scheduled_end_time: '2026-11-10T16:45:00Z',
          invitees: [{ email: 'ana@acme.com' }, { email: 'luis@acme.com' }],
        },
        summary_markdown: '## Acuerdos',
        transcript: [
          { speaker: { source: 'microphone' }, text: 'Hola', start_time: '2026-11-10T16:00:01Z' },
          { speaker: { source: 'speaker', diarization_label: 'Luis' }, text: '  ' },
          { speaker: 'Ana', text: 'Va' },
        ],
      },
    });
    const note = await g.getNote('n1');
    expect(note).toMatchObject({
      id: 'n1',
      title: 'Weekly Acme',
      startAt: '2026-11-10T16:00:00Z',
      endAt: '2026-11-10T16:45:00Z',
      attendees: [
        { name: 'Ana', email: 'ana@acme.com' },
        { name: 'luis', email: 'luis@acme.com' },
      ],
      summaryMarkdown: '## Acuerdos',
    });
    expect(note!.transcript).toEqual([
      { speaker: 'Yo', text: 'Hola', startTime: '2026-11-10T16:00:01Z' },
      { speaker: 'Ana', text: 'Va', startTime: null },
    ]);
  });

  it('404 → null (la nota ya no existe)', async () => {
    const g = await load();
    respond({ status: 404, body: { error: 'not found' } });
    expect(await g.getNote('nope')).toBeNull();
  });

  it('429 y 5xx: reintentables; 401: no', async () => {
    const g = await load();
    respond({ status: 429, body: 'slow' });
    await expect(g.listNotes()).rejects.toMatchObject({ retryable: true, status: 429 });
    respond({ status: 502, body: 'bad gateway' });
    await expect(g.listNotes()).rejects.toMatchObject({ retryable: true, status: 502 });
    respond({ status: 401, body: { error: 'bad key' } });
    await expect(g.listNotes()).rejects.toMatchObject({ retryable: false, code: 'unauthorized' });
  });

  it('red caída: reintentable; 200 con forma rara: no', async () => {
    const g = await load();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(g.listNotes()).rejects.toMatchObject({ retryable: true, code: 'network' });
    respond({ status: 200, body: { notes: [{ title: 'sin id' }] } });
    await expect(g.listNotes()).rejects.toMatchObject({ retryable: false, code: 'respuesta_invalida' });
  });
});

describe('pollSince', () => {
  it('primera vez: últimos 7 días; luego, la última junta menos 2 días de traslape', async () => {
    const { pollSince } = await import('../src/meetings/granola.js');
    const now = Date.parse('2026-11-11T12:00:00Z');
    expect(pollSince(null, now)).toBe('2026-11-04T12:00:00.000Z');
    expect(pollSince('2026-11-10T16:00:00Z', now)).toBe('2026-11-08T16:00:00.000Z');
  });
});
