// Router de devs [fase 2]: sugiere asignado por match real de skill (embedding) ×
// disponibilidad, penalizando la carga (issues in-progress en Linear). Humano-en-el-loop:
// SOLO sugiere; la asignación se confirma explícitamente vía confirm_proposal.
//
// También expone la gestión de devs/roles/ocupación (upsertDev, setAvailability,
// setDevSkills) para manejarlo desde el MCP sin tocar la base a mano.
import { db } from '../db/supabase.js';
import { embed } from '../adapters/embeddings.js';
import { inProgressCountByAssignee } from '../adapters/linear.js';

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
  load: number; // issues in-progress (derivado de Linear)
  skills: { tag: string; level: number }[];
}

export async function listDevs(): Promise<DevSummary[]> {
  const { data: devs } = await db()
    .from('dev')
    .select('id, name, availability, linear_user_id, dev_skill(level, skill:skill_id(tag))')
    .eq('active', true);
  if (!devs) return [];

  return Promise.all(
    devs.map(async (d: any) => ({
      id: d.id,
      name: d.name,
      availability: d.availability,
      load: d.linear_user_id ? await inProgressCountByAssignee(d.linear_user_id).catch(() => 0) : 0,
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
}

/**
 * Sugiere el mejor dev para una spec.
 *   score = skillMatch × disponibilidad / (1 + carga)
 * skillMatch = máx. similitud coseno entre el embedding de la spec y el embedding de
 * cada skill del dev, ponderada por el nivel (1..5). Un dev sin skills entra con un
 * baseline bajo para no quedar fuera, pero por debajo de quien sí matchea.
 */
export async function suggestAssignee(
  _projectId: string,
  specText: string,
): Promise<AssigneeSuggestion | null> {
  let specEmb: number[] | null = null;
  try {
    specEmb = await embed(specText);
  } catch {
    specEmb = null;
  }

  const { data: devs } = await db()
    .from('dev')
    .select(
      'id, name, availability, linear_user_id, dev_skill(level, skill:skill_id(tag, embedding))',
    )
    .eq('active', true);
  if (!devs?.length) return null;

  let best: AssigneeSuggestion | null = null;

  for (const d of devs as any[]) {
    const load = d.linear_user_id
      ? await inProgressCountByAssignee(d.linear_user_id).catch(() => 0)
      : 0;

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
    // Sin embedding de spec o sin skills: baseline neutro para no excluir al dev.
    const effectiveMatch = skillMatch > 0 ? skillMatch : 0.2;
    const score = (effectiveMatch * d.availability) / (1 + load);

    const reason = bestTag
      ? `skill "${bestTag}" (match ${(skillMatch).toFixed(2)}), disponibilidad ${d.availability}, carga ${load}`
      : `sin skill que matchee; disponibilidad ${d.availability}, carga ${load}`;

    if (!best || score > best.score) {
      best = { devId: d.id, name: d.name, score: Number(score.toFixed(4)), reason };
    }
  }

  return best;
}

// ---------- gestión (desde el MCP) ----------
export interface UpsertDevInput {
  id?: string;
  name: string;
  email?: string;
  whatsapp?: string;
  linearUserId?: string;
  githubLogin?: string;
  availability?: number;
  active?: boolean;
}

export async function upsertDev(input: UpsertDevInput): Promise<{ id: string; name: string }> {
  const row: Record<string, unknown> = { name: input.name };
  if (input.email !== undefined) row.email = input.email;
  if (input.whatsapp !== undefined) row.whatsapp = input.whatsapp;
  if (input.linearUserId !== undefined) row.linear_user_id = input.linearUserId;
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
