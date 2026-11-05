import { describe, it, expect } from 'vitest';
import { cleanReadme, type RepoProfile } from '../src/adapters/github.js';
import { buildJevRequest, projectState, type TaskInput } from '../src/assign/classify.js';
import {
  MAX_DESCRIPTION,
  PROJECT_TYPES,
  PROJECT_TYPE_VALUES,
  buildProfilePrompt,
  buildTypeRequest,
  detectStack,
  factualDescription,
  fillPatch,
  firstParagraph,
  readType,
  parseProfile,
  projectTypeForJev,
} from '../src/projects/profile.js';
import { PROJECT_TYPES as WEB_PROJECT_TYPES } from '../web/src/lib/project-types.js';

// Perfil del proyecto (0033): lo que roz lee de GitHub para describirlo, cómo se interpreta la
// respuesta de la IA, que el llenado nunca pise lo humano, y cómo llega a Jev al clasificar.

const repo = (over: Partial<RepoProfile> = {}): RepoProfile => ({
  fullName: 'org/flujo-api',
  description: 'API de la bandeja',
  homepage: null,
  topics: ['whatsapp'],
  languages: [{ name: 'TypeScript', pct: 90 }],
  topLevel: ['src/', 'supabase/', 'package.json'],
  dependencies: ['hono', '@supabase/supabase-js'],
  readme: 'Backend de la bandeja de conversaciones.',
  pushedAt: '2026-10-01T00:00:00Z',
  ...over,
});

describe('lo que se lee de GitHub', () => {
  it('el README pierde badges, imágenes, HTML y links (queda el texto)', () => {
    const raw = '# Flujo\n\n![build](https://x/badge.svg) <img src="a.png">\n\nBandeja de [WhatsApp](https://wa.me) en tiempo real.\n\n\n\nFin';
    expect(cleanReadme(raw)).toBe('# Flujo\n\nBandeja de WhatsApp en tiempo real.\n\nFin');
    expect(cleanReadme('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('el prompt lleva cada repo con su evidencia y la lista CERRADA de tipos', () => {
    const { system, user } = buildProfilePrompt({ name: 'Flujo', kind: 'client' }, [repo(), repo({ fullName: 'org/flujo-web', readme: null })]);
    for (const t of PROJECT_TYPES) expect(system).toContain(`- ${t.value}:`);
    expect(user).toContain('proyecto de cliente');
    expect(user).toContain('### org/flujo-api');
    expect(user).toContain('Dependencias: hono, @supabase/supabase-js');
    expect(user).toContain('README: (no tiene)');
  });
});

describe('respuesta de la IA', () => {
  it('lee el JSON aunque venga con texto alrededor', () => {
    expect(parseProfile('Aquí va:\n{"type":"app_web","description":"  Bandeja   de mensajes. "}\n')).toEqual({
      projectType: 'app_web',
      description: 'Bandeja de mensajes.',
    });
  });

  it('un tipo fuera de la lista queda vacío (no se inventa); sin JSON, nada', () => {
    expect(parseProfile('{"type":"saas","description":"x"}').projectType).toBeNull();
    expect(parseProfile('no sé')).toEqual({ projectType: null, description: null });
  });

  it('recorta descripciones largas', () => {
    const d = parseProfile(JSON.stringify({ type: 'otro', description: 'a'.repeat(MAX_DESCRIPTION + 50) })).description!;
    expect(d.length).toBe(MAX_DESCRIPTION);
  });
});

describe('llenado con IA', () => {
  it('solo escribe campos vacíos: nunca pisa lo que puso una persona', () => {
    const s = { projectType: 'app_web', description: 'de la IA' };
    expect(fillPatch({ project_type: null, description: null }, s)).toEqual({ project_type: 'app_web', description: 'de la IA' });
    expect(fillPatch({ project_type: 'landing', description: '  ' }, s)).toEqual({ description: 'de la IA' });
    expect(fillPatch({ project_type: 'landing', description: 'humana' }, s)).toEqual({});
    expect(fillPatch({ project_type: null, description: null }, { projectType: null, description: null })).toEqual({});
  });
});

describe('cómo llega a Jev', () => {
  const task = (over: Partial<TaskInput> = {}): TaskInput => ({
    id: 't',
    name: 'Arreglar el botón',
    description: null,
    projectId: 'p',
    projectName: 'Flujo',
    projectKind: 'client',
    priority: null,
    prioritySource: 'humano',
    dueDate: null,
    estimate: null,
    solutionTypeId: null,
    ...over,
  });

  it('sin perfil: el texto de siempre', () => {
    expect(projectState(task())).toBe('Flujo (client project)');
  });

  it('con perfil: nombre, cliente/interno, tipo con su significado y descripción', () => {
    const t = task({ projectType: projectTypeForJev('app_web'), projectDescription: 'Bandeja con backend en Supabase.' });
    expect(projectState(t)).toEqual({
      name: 'Flujo',
      kind: 'client project',
      type: 'App web con backend — plataforma o SaaS con usuarios, base de datos y lógica de negocio propia',
      description: 'Bandeja con backend en Supabase.',
    });
    const req = buildJevRequest(t, [], [], null, 'm');
    expect((req.state.task as { project: unknown }).project).toEqual(projectState(t));
  });

  it('las opciones de proyecto (cuando la tarea no trae) también llevan su perfil', () => {
    const req = buildJevRequest(task({ projectId: null, projectName: null }), [], [], [
      { id: 'p', key: 'F', name: 'Flujo', kind: 'client', type: 'App web con backend', description: 'Bandeja.' },
    ], 'm');
    expect((req.state.active_projects as Record<string, string>).Flujo).toBe('client project · App web con backend · Bandeja.');
  });
});

describe('la misma lista en la web', () => {
  it('los tipos del cliente son los mismos que valida el backend (y la migración)', () => {
    expect(WEB_PROJECT_TYPES.map((t) => t.value)).toEqual([...PROJECT_TYPE_VALUES]);
  });
});

describe('sin Claude: tipo con Jev y descripción con datos de GitHub', () => {
  it('el tipo de Jev: compañero ≥ 0.7 toma el elegido; ≤ 0.3 es "otro"; en medio queda vacío', () => {
    const a = (choice: string, fit: number) => ({
      project_type: { type: 'choice', choice, confidence: 0.8, probabilities: {} },
      project_type_fit: { type: 'noul', noul: fit },
    });
    expect(readType(a('App web con backend', 0.9))).toBe('app_web');
    expect(readType(a('App web con backend', 0.2))).toBe('otro');
    expect(readType(a('App web con backend', 0.5))).toBeNull();
    expect(readType(a('Inventado', 0.9))).toBeNull();
  });

  it('la request a Jev lleva los repos (README recortado) y las opciones sin "Otro"', () => {
    const req = buildTypeRequest({ name: 'Flujo', kind: 'client' }, [repo({ readme: 'x'.repeat(4000) })], 'm');
    expect(Object.keys(req.state.project_types as object)).not.toContain('Otro');
    expect(((req.state.repos as { readme: string }[])[0]!.readme).length).toBe(1500);
    expect(JSON.stringify(req)).not.toMatch(/assignee|dev_id/i);
  });

  it('detecta el stack por dependencias y carpetas', () => {
    const s = detectStack([
      repo({ dependencies: ['next', 'react', 'stripe', 'openai'], topLevel: ['supabase/'] }),
      repo({ dependencies: ['expo'], topLevel: ['ios/'] }),
    ]);
    expect(s.frontend).toEqual(['Next.js', 'React']);
    expect(s['móvil']).toEqual(['React Native', 'iOS/Android nativo']);
    expect(s.backend).toEqual(['Supabase']);
    expect(s.integraciones).toEqual(['Stripe']);
    expect(s.IA).toEqual(['OpenAI']);
  });

  it('el primer párrafo del README salta títulos, listas, código y líneas cortas', () => {
    const md = ['# Flujo', '', '## Install', '', '```', 'npm i', '```', '- item', '', 'Corto.', '', 'Bandeja unificada de conversaciones para equipos de atención.', ''].join('\n');
    expect(firstParagraph(md)).toBe('Bandeja unificada de conversaciones para equipos de atención.');
    expect(firstParagraph(null)).toBeNull();
    // Un párrafo partido en varias líneas se lee completo.
    expect(firstParagraph(['# App', '', 'Aplicación de escritorio que representa tu ecosistema', 'como un mapa navegable.', '', 'Más.'].join('\n'))).toBe(
      'Aplicación de escritorio que representa tu ecosistema como un mapa navegable.',
    );
  });

  it('salta plantillas sin tocar, quita markdown y prefiere el repo principal al de la landing', () => {
    const d = factualDescription([
      repo({ fullName: 'org/hub-site', description: 'Sitio de marketing de **Hub**', dependencies: [], topLevel: [] }),
      repo({ fullName: 'org/hub-app', description: null, readme: 'This template provides a minimal setup to get React working in Vite.', dependencies: [], topLevel: [] }),
      repo({ fullName: 'org/hub-api', description: 'API de `Hub`: leads, conversaciones y campañas', dependencies: [], topLevel: [] }),
    ]);
    expect(d).toBe('API de Hub: leads, conversaciones y campañas. Repos: hub-site, hub-app, hub-api.');
  });

  it('el repo principal (se llama como el proyecto, o es la "app") da la frase', () => {
    const d = factualDescription(
      [
        repo({ fullName: 'org/flujo-storefront', description: 'Renderiza las tiendas', dependencies: [], topLevel: [] }),
        repo({ fullName: 'org/flujo-app', description: 'Bandeja de conversaciones con agentes', dependencies: [], topLevel: [] }),
      ],
      'Flujo',
    );
    expect(d!.startsWith('Bandeja de conversaciones con agentes.')).toBe(true);
  });

  it('una frase larga se corta en la última oración completa', () => {
    const long = `${'Plataforma de reclutamiento para oficios. '.repeat(3)}${'x'.repeat(300)}`;
    const d = factualDescription([repo({ description: long, dependencies: [], topLevel: [] })])!;
    expect(d.startsWith('Plataforma de reclutamiento para oficios.')).toBe(true);
    expect(d).not.toContain('x');
  });

  it('la descripción factual dice qué es, con qué está hecho y sus repos', () => {
    const d = factualDescription([
      repo({ fullName: 'org/flujo-app', description: 'Bandeja de conversaciones', dependencies: ['next', 'react'], topLevel: ['supabase/'] }),
      repo({ fullName: 'org/flujo-mobile', description: null, dependencies: ['expo'], topLevel: [] }),
    ]);
    expect(d).toBe('Bandeja de conversaciones. Frontend: Next.js, React. App móvil: React Native. Backend: Supabase. Repos: flujo-app, flujo-mobile.');
  });
});
