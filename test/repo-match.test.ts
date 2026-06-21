import { describe, it, expect } from 'vitest';
import { matchByText } from '../src/reconcile/repos.js';

const projects = [
  { id: 'p1', key: 'ROZ', name: 'Roz' },
  { id: 'p2', key: 'HYPERFLOW', name: 'Hyperflow OS' },
  { id: 'p3', key: 'ADS', name: 'Google Ads Manager' },
];

describe('matchByText', () => {
  it('vincula por contención del nombre (repo "hyper-roz-web" → Roz)', () => {
    // "hyperrozweb" contiene "roz" → match con el proyecto Roz.
    expect(matchByText('hyper-roz-web', projects)?.id).toBe('p1');
  });

  it('vincula por slug casi idéntico a la key', () => {
    expect(matchByText('hyperflow', projects)?.id).toBe('p2');
  });

  it('vincula por nombre muy similar (typo)', () => {
    // "gogle-ads-manager" ~ "Google Ads Manager" (Levenshtein alto).
    expect(matchByText('google-ads-manager', projects)?.id).toBe('p3');
  });

  it('devuelve null cuando no hay relación clara', () => {
    expect(matchByText('totally-unrelated-thing', projects)).toBeNull();
  });

  it('no hace match con tokens cortos accidentales', () => {
    // Nombre muy corto no debe colarse por contención (<4 chars).
    expect(matchByText('ab', projects)).toBeNull();
  });

  it('NO vincula por un único token genérico compartido (service/manager)', () => {
    const ps = [
      { id: 'a', key: 'AUTH', name: 'Auth Service' },
      { id: 'b', key: 'INV', name: 'Inventory Manager' },
    ];
    // "billing-service" comparte solo "service" (genérico) con "Auth Service" → null.
    expect(matchByText('billing-service', ps)).toBeNull();
    // "tasks-manager" comparte solo "manager" (genérico) con "Inventory Manager" → null.
    expect(matchByText('tasks-manager', ps)).toBeNull();
  });

  it('sí vincula si comparte un token distintivo además del genérico', () => {
    const ps = [{ id: 'a', key: 'AUTH', name: 'Auth Service' }];
    // Comparte "auth" (distintivo, = key) y "service" → match claro.
    expect(matchByText('auth-service', ps)?.id).toBe('a');
  });
});
