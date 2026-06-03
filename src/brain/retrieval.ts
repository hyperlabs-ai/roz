// Second brain — retrieval híbrido [fase 4]: full-text (keyword/BM25) + pgvector
// (semántico) combinados con reciprocal rank fusion. Keyword atrapa identificadores
// exactos (ROZ-123, nombres de función); embeddings atrapa el duplicado disfrazado.
import { db } from '../db/supabase.js';
import { embed } from '../adapters/embeddings.js';

export interface AtomHit {
  id: string;
  title: string;
  body: string;
  score: number;
}

/**
 * Recupera átomos relevantes para un proyecto. Llama al RPC `search_atoms_hybrid` en
 * Postgres (definido en la migración) que hace keyword + vector + RRF. Degrada a un
 * listado simple si el embedding o el RPC no están disponibles (dev/fase temprana).
 */
export async function getProjectContext(projectKey: string, query: string): Promise<AtomHit[]> {
  const supabase = db();

  const { data: project } = await supabase
    .from('project')
    .select('id')
    .eq('key', projectKey)
    .single();
  if (!project) return [];

  let embedding: number[] | null = null;
  try {
    embedding = await embed(query);
  } catch {
    embedding = null;
  }

  const { data, error } = await supabase.rpc('search_atoms_hybrid', {
    p_project_id: project.id,
    p_query: query,
    p_embedding: embedding,
    p_limit: 8,
  });

  if (error || !data) {
    // Fallback: átomos activos del proyecto, sin ranking.
    const { data: fallback } = await supabase
      .from('knowledge_atom')
      .select('id, title, body')
      .eq('project_id', project.id)
      .eq('status', 'active')
      .limit(8);
    return (fallback ?? []).map((a: any) => ({ ...a, score: 0 }));
  }

  return data as AtomHit[];
}
