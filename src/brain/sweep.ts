// Barrida de consistencia del brain [fase 4]. Disparada por el cron diario
// (/v1/internal/brain-sweep). Hoy hace lo más valioso y seguro: rellenar embeddings que
// falten (skills nuevos creados sin que la API de OpenAI respondiera, átomos insertados sin
// vector por un fallo transitorio). Idempotente y acotada: procesa hasta `limit` filas por
// corrida, así nunca excede el maxDuration de la función serverless.
import { db } from '../db/supabase.js';
import { embed, embeddingModel } from '../adapters/embeddings.js';

export interface SweepResult {
  skillsReindexed: number;
  atomsReindexed: number;
}

export async function brainSweep(limit = 50): Promise<SweepResult> {
  const supabase = db();
  let skillsReindexed = 0;
  let atomsReindexed = 0;

  const { data: skills } = await supabase
    .from('skill')
    .select('id, tag, description')
    .is('embedding', null)
    .limit(limit);
  for (const s of skills ?? []) {
    try {
      const v = await embed(`${s.tag}. ${s.description ?? ''}`.trim());
      await supabase.from('skill').update({ embedding: `[${v.join(',')}]` }).eq('id', s.id);
      skillsReindexed++;
    } catch {
      // transitorio: lo reintenta la próxima barrida
    }
  }

  const { data: atoms } = await supabase
    .from('knowledge_atom')
    .select('id, title, body')
    .eq('status', 'active')
    .is('embedding', null)
    .limit(limit);
  for (const a of atoms ?? []) {
    try {
      const v = await embed(`${a.title}\n${a.body}`);
      await supabase
        .from('knowledge_atom')
        .update({ embedding: `[${v.join(',')}]`, embedding_model: embeddingModel })
        .eq('id', a.id);
      atomsReindexed++;
    } catch {
      // transitorio: lo reintenta la próxima barrida
    }
  }

  return { skillsReindexed, atomsReindexed };
}
