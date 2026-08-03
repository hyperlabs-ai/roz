import { describe, it, expect, vi, beforeEach } from 'vitest';

// La puerta de las ideas es lo único que impide leer o editar las de otra persona (RLS está en
// deny-all y el backend entra con service_role, que la bypassa). Se prueba contra un doble del
// cliente de Supabase: lo que importa es la decisión, no la query.
let row: { id: string; created_by: string; shared: boolean } | null = null;
let failQuery = false;

vi.mock('../src/db/supabase.js', () => ({
  db: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            failQuery ? { data: null, error: { message: 'boom' } } : { data: row, error: null },
        }),
      }),
    }),
  }),
  dbPublic: () => ({}),
}));

const { assertIdeaAccess } = await import('../src/dashboard/ideas.js');

const OWNER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const IDEA = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  failQuery = false;
  row = { id: IDEA, created_by: OWNER, shared: false };
});

describe('assertIdeaAccess', () => {
  it('el dueño lee y escribe su idea privada', async () => {
    await expect(assertIdeaAccess(IDEA, OWNER, 'read')).resolves.toMatchObject({ id: IDEA });
    await expect(assertIdeaAccess(IDEA, OWNER, 'write')).resolves.toMatchObject({ id: IDEA });
  });

  it('un tercero no ve una idea privada — y ni siquiera sabe que existe', async () => {
    await expect(assertIdeaAccess(IDEA, OTHER, 'read')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('un tercero lee una idea compartida', async () => {
    row = { id: IDEA, created_by: OWNER, shared: true };
    await expect(assertIdeaAccess(IDEA, OTHER, 'read')).resolves.toMatchObject({ shared: true });
  });

  it('compartir es SOLO lectura: un tercero nunca escribe', async () => {
    row = { id: IDEA, created_by: OWNER, shared: true };
    await expect(assertIdeaAccess(IDEA, OTHER, 'write')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('idea inexistente: 404', async () => {
    row = null;
    await expect(assertIdeaAccess(IDEA, OWNER, 'read')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('si la consulta falla, se cierra la puerta (no se asume acceso)', async () => {
    failQuery = true;
    await expect(assertIdeaAccess(IDEA, OWNER, 'read')).rejects.toBeTruthy();
  });
});
