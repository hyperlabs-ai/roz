// Solo lectura: inspecciona el workspace de Linear (con LINEAR_API_KEY del .env) y lo cruza
// con los proyectos y devs de roz, para revisar ANTES de sincronizar. No escribe nada.
//
// Uso:  npx tsx scripts/linear-inspect.ts
import 'dotenv/config';
import { listTeams, listLinearProjects, listUsers } from '../src/adapters/linear.js';
import { db } from '../src/db/supabase.js';

const norm = (s: string) => s.trim().toLowerCase();

async function main() {
  const [teams, projects, users] = await Promise.all([listTeams(), listLinearProjects(), listUsers()]);

  console.log(`\n=== Linear workspace ===`);
  console.log(`Teams: ${teams.length} | Projects: ${projects.length} | Users activos: ${users.length}\n`);

  console.log('TEAMS:');
  for (const t of teams) console.log(`  ${t.key.padEnd(8)} ${t.name}  (${t.id})`);

  // Cruce de proyectos por nombre.
  const { data: rozProjects } = await db().from('project').select('name, key');
  const rozByName = new Map((rozProjects ?? []).map((p: any) => [norm(p.name), p.key]));

  console.log('\nPROJECTS (Linear → match con roz):');
  for (const p of projects) {
    const match = rozByName.get(norm(p.name));
    console.log(`  ${match ? '✓' : '✗'} "${p.name}"  ${match ? `→ roz:${match}` : '(sin match exacto de nombre)'}`);
  }

  // Proyectos de roz que NO aparecen en Linear (por nombre).
  const linearNames = new Set(projects.map((p) => norm(p.name)));
  const rozSinLinear = (rozProjects ?? []).filter((p: any) => !linearNames.has(norm(p.name)));
  if (rozSinLinear.length) {
    console.log('\nroz projects SIN match en Linear (revisar nombre o crear en Linear):');
    for (const p of rozSinLinear as any[]) console.log(`  - ${p.key}: ${p.name}`);
  }

  // Cruce de devs por email.
  const { data: devs } = await db().from('dev').select('name, email, linear_user_id, active').eq('active', true);
  const linearByEmail = new Map(users.filter((u) => u.email).map((u) => [norm(u.email!), u]));

  console.log('\nDEVS (roz → match con Linear por email):');
  for (const d of (devs ?? []) as any[]) {
    const u = d.email ? linearByEmail.get(norm(d.email)) : null;
    const estado = d.linear_user_id ? 'ya vinculado' : u ? `→ vinculará (${u.displayName ?? u.name})` : 'sin match por email';
    console.log(`  ${u || d.linear_user_id ? '✓' : '✗'} ${d.name.padEnd(10)} ${d.email ?? '(sin email)'}  ${estado}`);
  }

  console.log('\nOK (read-only, nada se modificó)');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
