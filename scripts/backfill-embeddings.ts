// Backfill de embeddings. Idempotente: solo rellena filas con embedding NULL, así que se
// puede correr cuantas veces haga falta (skills nuevos, átomos del brain, etc.).
// Uso: npx tsx scripts/backfill-embeddings.ts
//
// Requiere que el .env apunte a la DB (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) y que el
// schema `roz` esté expuesto en la API de Supabase.
import 'dotenv/config';
import { db } from '../src/db/supabase.js';
import { embed, embeddingModel } from '../src/adapters/embeddings.js';

async function backfillSkills(): Promise<number> {
  const supabase = db();
  const { data: skills, error } = await supabase
    .from('skill')
    .select('id, tag, description')
    .is('embedding', null);
  if (error) throw error;
  let n = 0;
  for (const s of skills ?? []) {
    const v = await embed(`${s.tag}. ${s.description ?? ''}`.trim());
    const { error: upErr } = await supabase
      .from('skill')
      .update({ embedding: `[${v.join(',')}]` })
      .eq('id', s.id);
    if (upErr) throw upErr;
    n++;
    // eslint-disable-next-line no-console
    console.log(`  skill ${s.tag} (${v.length}d)`);
  }
  return n;
}

async function backfillAtoms(): Promise<number> {
  const supabase = db();
  const { data: atoms, error } = await supabase
    .from('knowledge_atom')
    .select('id, title, body')
    .is('embedding', null);
  if (error) throw error;
  let n = 0;
  for (const a of atoms ?? []) {
    const v = await embed(`${a.title}\n${a.body}`);
    const { error: upErr } = await supabase
      .from('knowledge_atom')
      .update({ embedding: `[${v.join(',')}]`, embedding_model: embeddingModel })
      .eq('id', a.id);
    if (upErr) throw upErr;
    n++;
  }
  return n;
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(`Backfill con ${embeddingModel}…`);
  const skills = await backfillSkills();
  const atoms = await backfillAtoms();
  // eslint-disable-next-line no-console
  console.log(`Listo: ${skills} skills, ${atoms} átomos embebidos.`);
  process.exit(0);
}
main();
