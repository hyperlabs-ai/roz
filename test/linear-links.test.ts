import { describe, expect, it, vi } from 'vitest';

// Mapeo roz ↔ Linear: devs por CORREO (nunca por nombre), tipos de solución por nombre de etiqueta,
// equipos solo si un proyecto los usa en exclusiva, y estados por tipo (con "revisión" por nombre).

vi.hoisted(() => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  process.env.LINEAR_TEAM_ID = '';
});
vi.mock('../src/db/supabase.js', () => ({ db: () => ({}), dbPublic: () => ({}) }));

import {
  devByEmail,
  labelLinks,
  pickStateForStatus,
  projectLinks,
  stateLinks,
  statusToLinearStateType,
  teamLinks,
  userLinks,
} from '../src/linear/links.js';

const devs = [
  { id: 'ana', email: 'Ana@Acme.com', github_email: 'ana@gh.dev' },
  { id: 'beto', email: 'beto@acme.com', github_email: 'ana@acme.com' }, // github_email chocando con el email de Ana
];

describe('usuarios', () => {
  it('correo en minúsculas; dev.email gana sobre github_email', () => {
    const m = devByEmail(devs);
    expect(m.get('ana@acme.com')).toBe('ana');
    expect(m.get('ana@gh.dev')).toBe('ana');
    expect(m.get('beto@acme.com')).toBe('beto');
  });

  it('un usuario de Linear sin correo conocido queda sin vínculo, pero se guarda', () => {
    const rows = userLinks(
      [
        { id: 'u1', name: 'Ana', displayName: 'ana', email: 'ANA@acme.com', active: true, avatarUrl: null },
        { id: 'u2', name: 'Externo', displayName: null, email: 'x@otro.com', active: false, avatarUrl: null },
      ],
      devs,
    );
    expect(rows[0]).toMatchObject({ kind: 'user', linear_id: 'u1', roz_id: 'ana', key: 'ana@acme.com', name: 'ana', active: true });
    expect(rows[1]).toMatchObject({ roz_id: null, key: 'x@otro.com', active: false });
  });
});

describe('equipos, etiquetas, estados, proyectos', () => {
  it('un equipo compartido por dos proyectos no se liga a ninguno', () => {
    const rows = teamLinks(
      [
        { id: 't1', key: 'HYP', name: 'Hyper' },
        { id: 't2', key: 'OPS', name: 'Ops' },
      ],
      [
        { id: 'p1', linear_team_id: 't1', linear_project_id: null },
        { id: 'p2', linear_team_id: 't1', linear_project_id: null },
        { id: 'p3', linear_team_id: 't2', linear_project_id: null },
      ],
    );
    expect(rows[0]).toMatchObject({ roz_id: null, key: 'HYP' });
    expect(rows[1]).toMatchObject({ roz_id: 'p3', key: 'OPS' });
  });

  it('etiqueta ↔ tipo de solución por nombre, sin distinguir mayúsculas', () => {
    const rows = labelLinks(
      [
        { id: 'l1', name: 'maquetación / ui básica', color: null, teamId: null },
        { id: 'l2', name: 'Bug', color: '#f00', teamId: 't1' },
      ],
      [{ id: 'st1', name: 'Maquetación / UI básica' }],
    );
    expect(rows[0]).toMatchObject({ roz_id: 'st1', team_id: null });
    expect(rows[1]).toMatchObject({ roz_id: null, team_id: 't1' });
  });

  it('estados guardan su tipo como key; proyectos se ligan por linear_project_id', () => {
    expect(stateLinks([{ id: 's1', name: 'Todo', type: 'unstarted', position: 1, teamId: 't1' }])[0]).toMatchObject({ key: 'unstarted', team_id: 't1' });
    expect(projectLinks([{ id: 'lp1', name: 'Portal', state: 'started', teamIds: ['t1'] }], [{ id: 'p1', linear_team_id: 't1', linear_project_id: 'lp1' }])[0]).toMatchObject({
      roz_id: 'p1',
      team_id: 't1',
    });
  });

  it('status de roz → estado del equipo (revisión por nombre, menor posición gana)', () => {
    const states = [
      { id: 'backlog', name: 'Backlog', key: 'backlog', position: 0 },
      { id: 'todo', name: 'Todo', key: 'unstarted', position: 1 },
      { id: 'review', name: 'In Review', key: 'started', position: 3 },
      { id: 'doing', name: 'In Progress', key: 'started', position: 2 },
      { id: 'done', name: 'Done', key: 'completed', position: 4 },
    ];
    expect(pickStateForStatus(states, 'planificada')).toBe('backlog');
    expect(pickStateForStatus(states, 'pendiente')).toBe('todo');
    expect(pickStateForStatus(states, 'en_progreso')).toBe('doing');
    expect(pickStateForStatus(states, 'revision')).toBe('review');
    expect(pickStateForStatus(states, 'cancelada')).toBeNull();
    expect(statusToLinearStateType('completada')).toBe('completed');
  });
});
