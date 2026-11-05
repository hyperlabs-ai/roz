import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Transporte a TypeSafe. Lo importante no es "que funcione" sino cómo FALLA: un error de la API nunca
// puede leerse como una respuesta (un fallo no es un "no"), y quien llama necesita saber si vale la
// pena reintentar (429/5xx/red) o no (400/422, respuesta con otra forma). Además, lo que se guarda
// como registro debe ser exactamente lo que viajó, sin la llave.

const KEY = 'ts-test-key-123';

async function load() {
  process.env.TYPESAFE_API_KEY = KEY;
  vi.resetModules();
  return import('../src/adapters/typesafe.js');
}

const REQ = {
  model: 'jev-1.14.0',
  state: { task: { title: 'Arreglar login' } },
  questions: { urgent: { type: 'noul' as const, instructions: '`task` is urgent.' } },
};

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TYPESAFE_API_KEY;
});

describe('systemOne', () => {
  it('200: devuelve las respuestas tipadas y el modelo que respondió', async () => {
    const { systemOne } = await load();
    respond(200, { model: 'jev-1.14.0', answers: { urgent: { type: 'noul', noul: 0.91 } }, usage: { input_tokens: 80, output_tokens: 3 } });
    const res = await systemOne(REQ);
    expect(res.model).toBe('jev-1.14.0');
    expect(res.answers.urgent).toEqual({ type: 'noul', noul: 0.91 });
  });

  it('el cuerpo enviado es exactamente la request (registro fiel), y la llave va solo en el header', async () => {
    const { systemOne } = await load();
    const fetchMock = respond(200, { model: 'm', answers: { urgent: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } });
    await systemOne(REQ);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(JSON.parse(init.body as string)).toEqual(REQ);
    expect(init.body as string).not.toContain(KEY);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it('400 y 422: no reintentables, conservan el detalle de la API', async () => {
    const { systemOne, TypeSafeError } = await load();
    respond(422, { detail: [{ loc: ['body', 'questions'], msg: 'field required' }] });
    const err = await systemOne(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(TypeSafeError);
    expect(err).toMatchObject({ status: 422, retryable: false });
    expect(err.detail).toEqual([{ loc: ['body', 'questions'], msg: 'field required' }]);

    respond(400, { detail: 'bad request' });
    expect(await systemOne(REQ).catch((e) => e)).toMatchObject({ status: 400, retryable: false, detail: 'bad request' });
  });

  it('429: reintentable y respeta retry-after', async () => {
    const { systemOne } = await load();
    respond(429, { detail: 'slow down' }, { 'retry-after': '12' });
    expect(await systemOne(REQ).catch((e) => e)).toMatchObject({ status: 429, retryable: true, retryAfterSec: 12 });
  });

  it('5xx y red caída: reintentables', async () => {
    const { systemOne } = await load();
    respond(503, 'unavailable');
    expect(await systemOne(REQ).catch((e) => e)).toMatchObject({ status: 503, retryable: true });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await systemOne(REQ).catch((e) => e)).toMatchObject({ status: null, retryable: true });
  });

  it('200 con otra forma: error NO reintentable (es un cambio de contrato, no un tropiezo)', async () => {
    const { systemOne } = await load();
    respond(200, { model: 'm', answers: { urgent: { type: 'noul' } } });
    expect(await systemOne(REQ).catch((e) => e)).toMatchObject({ retryable: false, message: expect.stringMatching(/respuesta_invalida/) });
  });

  it('sin llave no llama a la red', async () => {
    process.env.TYPESAFE_API_KEY = '';
    vi.resetModules();
    const { systemOne, typesafeEnabled } = await import('../src/adapters/typesafe.js');
    const fetchMock = respond(200, {});
    expect(typesafeEnabled()).toBe(false);
    await expect(systemOne(REQ)).rejects.toMatchObject({ retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
