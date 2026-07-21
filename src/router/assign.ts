// Router de devs [fase 2]: sugiere asignado por match real de skill (embedding) ×
// disponibilidad, penalizando la carga (tareas nativas en curso). Humano-en-el-loop:
// SOLO sugiere; la asignación se confirma explícitamente vía confirm_proposal.
//
// También expone la gestión de devs/roles/ocupación (upsertDev, setAvailability,
// setDevSkills) para manejarlo desde el MCP sin tocar la base a mano.
import { db } from '../db/supabase.js';
import { embed } from '../adapters/embeddings.js';

// ---------- utilidades de vectores ----------
function parseVec(v: unknown): number[] | null {
  if (!v) return null;
  if (Array.isArray(v)) return v as number[];
  if (typeof v === 'string') {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a : null;
    } catch {
      return null;
    }
  }
  return null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------- lectura ----------
export interface DevSummary {
  id: string;
  name: string;
  availability: number;
  load: number; // tareas nativas en curso (state='started') asignadas al dev
  skills: { tag: string; level: number }[];
}

/** Carga = tareas nativas en curso (state='started') asignadas al dev. Reemplaza el conteo de
 *  issues in-progress de Linear tras el corte a tareas nativas. */
async function inProgressCount(devId: string): Promise<number> {
  const { count } = await db()
    .from('work_item')
    .select('id', { count: 'exact', head: true })
    .eq('assignee_dev_id', devId)
    .eq('state', 'started');
  return count ?? 0;
}

export async function listDevs(): Promise<DevSummary[]> {
  const { data: devs } = await db()
    .from('dev')
    .select('id, name, availability, dev_skill(level, skill:skill_id(tag))')
    .eq('active', true);
  if (!devs) return [];

  return Promise.all(
    devs.map(async (d: any) => ({
      id: d.id,
      name: d.name,
      availability: d.availability,
      load: await inProgressCount(d.id),
      skills: (d.dev_skill ?? []).map((ds: any) => ({ tag: ds.skill?.tag, level: ds.level })),
    })),
  );
}

// ---------- sugerencia ----------
export interface AssigneeSuggestion {
  devId: string;
  name: string;
  score: number;
  reason: string;
  matchedSkill: string | null;
}

/**
 * Rankea TODOS los devs para una spec y devuelve los mejores candidatos.
 *   score = skillMatch × disponibilidad / (1 + carga)
 * skillMatch = máx. similitud coseno entre el embedding de la spec y el embedding de cada
 * skill del dev, ponderada por nivel (1..5). Un dev sin skills entra con baseline bajo.
 * Devolver varios permite recomendar alternativas cuando más de uno puede hacerlo.
 */
export async function rankAssignees(
  _projectId: string,
  specText: string,
  limit = 3,
): Promise<AssigneeSuggestion[]> {
  let specEmb: number[] | null = null;
  try {
    specEmb = await embed(specText);
  } catch {
    specEmb = null;
  }

  const { data: devs } = await db()
    .from('dev')
    .select('id, name, availability, dev_skill(level, skill:skill_id(tag, embedding))')
    .eq('active', true);
  if (!devs?.length) return [];

  const scored: AssigneeSuggestion[] = [];

  for (const d of devs as any[]) {
    const load = await inProgressCount(d.id);

    let skillMatch = 0;
    let bestTag = '';
    if (specEmb) {
      for (const ds of d.dev_skill ?? []) {
        const emb = parseVec(ds.skill?.embedding);
        if (!emb) continue;
        const level = ds.level ?? 3;
        const sim = cosine(specEmb, emb) * (0.6 + 0.08 * level); // nivel 5 → ×1.0, nivel 1 → ×0.68
        if (sim > skillMatch) {
          skillMatch = sim;
          bestTag = ds.skill?.tag ?? '';
        }
      }
    }
    const effectiveMatch = skillMatch > 0 ? skillMatch : 0.2;
    const score = (effectiveMatch * d.availability) / (1 + load);

    scored.push({
      devId: d.id,
      name: d.name,
      score: Number(score.toFixed(4)),
      matchedSkill: bestTag || null,
      reason: bestTag
        ? `skill "${bestTag}" (match ${skillMatch.toFixed(2)}) · disp ${d.availability} · carga ${load}`
        : `sin skill que matchee · disp ${d.availability} · carga ${load}`,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Sugerencia top-1 (compat). */
export async function suggestAssignee(
  projectId: string,
  specText: string,
): Promise<AssigneeSuggestion | null> {
  const [best] = await rankAssignees(projectId, specText, 1);
  return best ?? null;
}

// ---------- Proyectos (selector) ----------
export async function listProjects(): Promise<
  { key: string; name: string; linkedHyperops: boolean }[]
> {
  const { data } = await db()
    .from('project')
    .select('key, name, hyperops_project_id')
    .eq('active', true)
    .order('key');
  return (data ?? []).map((p: any) => ({
    key: p.key,
    name: p.name,
    linkedHyperops: !!p.hyperops_project_id, // necesario para reconciliar commits del proyecto
  }));
}

// ---------- gestión (desde el MCP) ----------
export interface UpsertDevInput {
  id?: string;
  name: string;
  email?: string;
  whatsapp?: string;
  githubLogin?: string;
  availability?: number;
  active?: boolean;
}

export async function upsertDev(input: UpsertDevInput): Promise<{ id: string; name: string }> {
  const row: Record<string, unknown> = { name: input.name };
  if (input.email !== undefined) row.email = input.email;
  if (input.whatsapp !== undefined) row.whatsapp = input.whatsapp;
  if (input.githubLogin !== undefined) row.github_login = input.githubLogin;
  if (input.availability !== undefined) row.availability = input.availability;
  if (input.active !== undefined) row.active = input.active;

  const q = db().from('dev');
  const { data, error } = input.id
    ? await q.update(row).eq('id', input.id).select('id, name').single()
    : await q.insert(row).select('id, name').single();
  if (error) throw error;
  return data;
}

/** Ocupación: availability 0 (saturado) .. 1 (totalmente disponible). */
export async function setAvailability(
  devId: string,
  availability: number,
): Promise<{ id: string; availability: number }> {
  const a = Math.max(0, Math.min(1, availability));
  const { data, error } = await db()
    .from('dev')
    .update({ availability: a })
    .eq('id', devId)
    .select('id, availability')
    .single();
  if (error) throw error;
  return data;
}

/**
 * Define los skills/roles de un dev. Crea los skills que no existan (con embedding del
 * tag+descripción) y reemplaza el set de skills del dev por el provisto.
 */
export async function setDevSkills(
  devId: string,
  skills: { tag: string; level?: number; description?: string }[],
): Promise<{ devId: string; skills: { tag: string; level: number }[] }> {
  const supabase = db();
  const out: { tag: string; level: number }[] = [];

  // Limpia el set previo (reemplazo total).
  await supabase.from('dev_skill').delete().eq('dev_id', devId);

  for (const s of skills) {
    const tag = s.tag.trim().toLowerCase();
    const level = Math.max(1, Math.min(5, s.level ?? 3));

    // ¿existe el skill?
    let { data: skill } = await supabase
      .from('skill')
      .select('id, embedding')
      .eq('tag', tag)
      .maybeSingle();

    if (!skill) {
      let embedding: string | null = null;
      try {
        const e = await embed(`${tag}. ${s.description ?? ''}`.trim());
        embedding = `[${e.join(',')}]`;
      } catch {
        embedding = null;
      }
      const ins = await supabase
        .from('skill')
        .insert({ tag, description: s.description ?? null, embedding })
        .select('id, embedding')
        .single();
      if (ins.error) throw ins.error;
      skill = ins.data;
    }

    const link = await supabase
      .from('dev_skill')
      .insert({ dev_id: devId, skill_id: (skill as { id: string }).id, level });
    if (link.error) throw link.error;
    out.push({ tag, level });
  }

  return { devId, skills: out };
}
