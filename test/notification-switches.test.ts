import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Los interruptores son lo único que separa "roz no notifica porque lo apagamos" de "roz no
// notifica porque algo se rompió". Se prueba contra un doble del cliente de Supabase: importa la
// decisión (¿se envía o no?), no la query. Y el caso que motivó la feature: con el killswitch
// apagado, sendEmail NO debe lanzar — si lanzara, el drain reintentaría y los avisos acabarían en
// el dead-letter, que es justo lo que se quiere evitar.

interface Row {
  scope: 'global' | 'dev';
  dev_id: string | null;
  email_enabled: boolean;
  push_enabled: boolean;
  updated_by: string | null;
  updated_at: string | null;
}

let rows: Row[] = [];
let failQuery = false;

vi.mock('../src/db/supabase.js', () => ({
  db: () => ({
    from: () => ({
      select: async () => (failQuery ? { data: null, error: { message: 'boom' } } : { data: rows, error: null }),
    }),
  }),
  dbPublic: () => ({}),
}));

const DEV_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DEV_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function global_(email: boolean, push: boolean): Row {
  return { scope: 'global', dev_id: null, email_enabled: email, push_enabled: push, updated_by: 'manuel@hyperdigital.mx', updated_at: '2026-09-08T00:00:00.000Z' };
}
function dev(devId: string, email: boolean, push: boolean): Row {
  return { scope: 'dev', dev_id: devId, email_enabled: email, push_enabled: push, updated_by: null, updated_at: null };
}

/** Módulo fresco en cada caso: el estado se cachea unos segundos y todas las pruebas caben dentro
 *  de esa ventana, así que sin resetModules la segunda leería la caché de la primera. */
async function switches() {
  vi.resetModules();
  return import('../src/notify/switches.js');
}

beforeEach(() => {
  rows = [];
  failQuery = false;
});

describe('interruptores de notificaciones', () => {
  it('sin filas, roz notifica (el default es encendido)', async () => {
    const s = await switches();
    expect(await s.emailEnabled()).toBe(true);
    expect(await s.pushEnabledGlobally()).toBe(true);
    expect(await s.emailAllowed(DEV_A)).toBe(true);
    expect(await s.pushAllowed(DEV_A)).toBe(true);
  });

  it('un error de lectura NO apaga las notificaciones', async () => {
    failQuery = true;
    const s = await switches();
    expect(await s.emailEnabled()).toBe(true);
    expect(await s.emailAllowed(DEV_A)).toBe(true);
  });

  it('el killswitch global apaga el correo de todos, con o sin fila propia', async () => {
    rows = [global_(false, true), dev(DEV_A, true, true)];
    const s = await switches();
    expect(await s.emailEnabled()).toBe(false);
    expect(await s.emailAllowed(DEV_A)).toBe(false);
    expect(await s.emailAllowed(DEV_B)).toBe(false);
    expect(await s.emailAllowed(null)).toBe(false); // destinatario suelto (quien reportó)
  });

  it('el interruptor de una persona solo la silencia a ella', async () => {
    rows = [global_(true, true), dev(DEV_A, false, true)];
    const s = await switches();
    expect(await s.emailAllowed(DEV_A)).toBe(false);
    expect(await s.emailAllowed(DEV_B)).toBe(true);
    expect(await s.pushAllowed(DEV_A)).toBe(true); // su push sigue encendido
  });

  it('correo y push son independientes', async () => {
    rows = [global_(false, true)];
    const s = await switches();
    expect(await s.emailEnabled()).toBe(false);
    expect(await s.pushEnabledGlobally()).toBe(true);
    expect(await s.pushAllowed(DEV_A)).toBe(true);
  });

  it('listSwitches reporta el estado global y quién lo movió', async () => {
    rows = [global_(false, false), dev(DEV_A, false, true)];
    const { global, devs } = await (await switches()).listSwitches();
    expect(global).toMatchObject({ emailEnabled: false, pushEnabled: false, updatedBy: 'manuel@hyperdigital.mx' });
    expect(devs).toEqual([{ devId: DEV_A, emailEnabled: false, pushEnabled: true, updatedBy: null, updatedAt: null }]);
  });
});

describe('sendEmail con el killswitch apagado', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('omite el envío en silencio, sin lanzar y sin pegarle a Resend', async () => {
    rows = [global_(false, true)];
    process.env.RESEND_API_KEY = 're_test';
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'no-deberia-enviarse' }) }));
    vi.stubGlobal('fetch', fetchSpy);

    vi.resetModules();
    const { sendEmail } = await import('../src/adapters/email.js');
    await expect(sendEmail({ to: 'sebas@hyperdigital.mx', subject: 'x', text: 'x' })).resolves.toEqual({
      id: null,
      suppressed: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('encendido, sí envía', async () => {
    rows = [global_(true, true)];
    process.env.RESEND_API_KEY = 're_test';
    const fetchSpy = vi.fn(async () => ({ ok: true, statusText: 'OK', json: async () => ({ id: 'msg_1' }) }));
    vi.stubGlobal('fetch', fetchSpy);

    vi.resetModules();
    const { sendEmail } = await import('../src/adapters/email.js');
    await expect(sendEmail({ to: 'sebas@hyperdigital.mx', subject: 'x', text: 'x' })).resolves.toEqual({ id: 'msg_1' });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
