import { describe, it, expect, vi } from 'vitest';

// La etiqueta con la que cada quien reconoce su teléfono y su computadora en "Probar en mis
// dispositivos". El orden de los navegadores importa: Edge, Opera y Samsung también dicen "Chrome".
vi.mock('../src/db/supabase.js', () => ({ db: () => ({}), dbPublic: () => ({}) }));

const { deviceLabel } = await import('../src/notify/push.js');

describe('deviceLabel', () => {
  it('reconoce sistema y navegador', () => {
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')).toBe('Windows · Chrome');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0')).toBe('Windows · Edge');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36')).toBe('Android · Chrome');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36')).toBe('Android · Samsung Internet');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe('Mac · Firefox');
  });

  it('sin user agent no truena', () => {
    expect(deviceLabel(null)).toBe('Dispositivo desconocido');
  });
});
