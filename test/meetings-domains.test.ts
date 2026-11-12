import { describe, expect, it } from 'vitest';
import { domainMatches, emailDomain, normalizeDomain, resolveProjectByDomains } from '../src/meetings/domains.js';

// Una junta con gente del cliente cae sola en su proyecto. Lo importante: el equipo propio no
// cuenta, un subdominio calza con su dominio (no al revés) y un empate NO se adivina.

const P = [
  { id: 'p-acme', name: 'Acme Web', domains: ['acme.com'] },
  { id: 'p-acme2', name: 'Acme App', domains: ['@ACME.com'] },
  { id: 'p-globex', name: 'Globex', domains: ['globex.mx', 'globex.io'] },
];

describe('emailDomain', () => {
  it('saca el dominio en minúsculas, también de "Nombre <correo>"', () => {
    expect(emailDomain('Ana@Acme.COM')).toBe('acme.com');
    expect(emailDomain('Ana <ana@mail.acme.com>')).toBe('mail.acme.com');
    expect(emailDomain('no-es-correo')).toBeNull();
    expect(emailDomain(null)).toBeNull();
  });

  it('normalizeDomain quita @ y mayúsculas', () => {
    expect(normalizeDomain(' @Acme.com ')).toBe('acme.com');
  });
});

describe('domainMatches', () => {
  it('igual o subdominio; nunca al revés ni por sufijo suelto', () => {
    expect(domainMatches('acme.com', 'acme.com')).toBe(true);
    expect(domainMatches('mail.acme.com', 'acme.com')).toBe(true);
    expect(domainMatches('acme.com', 'mail.acme.com')).toBe(false);
    expect(domainMatches('notacme.com', 'acme.com')).toBe(false);
  });
});

describe('resolveProjectByDomains', () => {
  it('un proyecto con match → ese proyecto', () => {
    const r = resolveProjectByDomains(['ana@hyper.dev', 'luis@globex.mx'], P, ['hyper.dev']);
    expect(r.projectId).toBe('p-globex');
    expect(r.matches).toEqual([{ projectId: 'p-globex', projectName: 'Globex', domain: 'globex.mx' }]);
  });

  it('dos proyectos del mismo dominio empatados → null (la UI pide elegir) con los dos matches', () => {
    const r = resolveProjectByDomains(['ana@acme.com'], P);
    expect(r.projectId).toBeNull();
    expect(r.matches.map((m) => m.projectId).sort()).toEqual(['p-acme', 'p-acme2']);
  });

  it('gana el proyecto con más asistentes que calzan', () => {
    const projects = [
      { id: 'a', name: 'A', domains: ['a.com'] },
      { id: 'b', name: 'B', domains: ['b.com'] },
    ];
    const r = resolveProjectByDomains(['x@a.com', 'y@a.com', 'z@b.com'], projects);
    expect(r.projectId).toBe('a');
  });

  it('los dominios del equipo se ignoran aunque un proyecto los tenga', () => {
    const projects = [{ id: 'int', name: 'Interno', domains: ['hyper.dev'] }];
    expect(resolveProjectByDomains(['ana@hyper.dev'], projects, ['hyper.dev'])).toEqual({ projectId: null, matches: [] });
  });

  it('sin correos o sin match → null sin matches', () => {
    expect(resolveProjectByDomains([], P)).toEqual({ projectId: null, matches: [] });
    expect(resolveProjectByDomains([null, 'x@gmail.com'], P)).toEqual({ projectId: null, matches: [] });
  });

  it('el mismo asistente repetido cuenta una vez', () => {
    const projects = [
      { id: 'a', name: 'A', domains: ['a.com'] },
      { id: 'b', name: 'B', domains: ['b.com'] },
    ];
    expect(resolveProjectByDomains(['x@a.com', 'X@a.com', 'z@b.com'], projects).projectId).toBeNull();
  });
});
