// Router de devs [fase 2]: sugiere asignado por match real de skill (embedding) ×
// disponibilidad, penalizando la carga (issues in-progress en Linear). Humano-en-el-loop:
// SOLO sugiere; la asignación se confirma explícitamente vía confirm_proposal.
//
// También expone la gestión de devs/roles/ocupación (upsertDev, setAvailability,
// setDevSkills) para manejarlo desde el MCP sin tocar la base a mano.
import { db } from '../db/supabase.js';
import { embed } from '../adapters/embeddings.js';
import { inProgressCountByAssignee, listUsers, listTeams } from '../adapters/linear.js';

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
  matchedSkill: string | null;
  linked: boolean; // ¿está vinculado a un usuario real de Linear?
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
    .select(
      'id, name, availability, linear_user_id, dev_skill(level, skill:skill_id(tag, embedding))',
    )
    .eq('active', true);
  if (!devs?.length) return [];

  const scored: AssigneeSuggestion[] = [];

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
    const effectiveMatch = skillMatch > 0 ? skillMatch : 0.2;
    const score = (effectiveMatch * d.availability) / (1 + load);

    scored.push({
      devId: d.id,
      name: d.name,
      score: Number(score.toFixed(4)),
      matchedSkill: bestTag || null,
      linked: !!d.linear_user_id,
      reason: bestTag
        ? `skill "${bestTag}" (match ${skillMatch.toFixed(2)}) · disp ${d.availability} · carga ${load}` +
          (d.linear_user_id ? '' : ' · ⚠ sin vincular a Linear')
        : `sin skill que matchee · disp ${d.availability} · carga ${load}` +
          (d.linear_user_id ? '' : ' · ⚠ sin vincular a Linear'),
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
  { key: string; name: string; linked: boolean }[]
> {
  const { data } = await db().from('project').select('key, name, linear_team_id').order('key');
  return (data ?? []).map((p: any) => ({
    key: p.key,
    name: p.name,
    linked: !!p.linear_team_id,
  }));
}

/** Importa los equipos de Linear como proyectos (upsert por key). */
export async function syncProjects(): Promise<{ created: string[]; updated: string[] }> {
  const supabase = db();
  const teams = await listTeams();
  const created: string[] = [];
  const updated: string[] = [];

  for (const t of teams) {
    const { data: existing } = await supabase
      .from('project')
      .select('id')
      .eq('key', t.key)
      .maybeSingle();
    if (existing) {
      await supabase
        .from('project')
        .update({ name: t.name, linear_team_id: t.id })
        .eq('id', existing.id);
      updated.push(t.key);
    } else {
      await supabase.from('project').insert({ key: t.key, name: t.name, linear_team_id: t.id });
      created.push(t.key);
    }
  }
  return { created, updated };
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

/**
 * Sincroniza los miembros del workspace de Linear como devs de roz. Vincula así:
 *   1) si ya hay un dev con ese linear_user_id → actualiza email (respeta el name de roz);
 *   2) si no, pero hay un dev con el mismo email → le pega el linear_user_id (lo vincula);
 *   3) si no existe → crea el dev con el nombre de Linear.
 * No borra devs (los ficticios o inactivos en Linear quedan; se pueden desactivar a mano).
 */
export async function syncLinearMembers(): Promise<{
  created: string[];
  linked: string[];
  updated: string[];
}> {
  const supabase = db();
  const members = await listUsers();
  const created: string[] = [];
  const linked: string[] = [];
  const updated: string[] = [];

  for (const m of members) {
    // Saltar bots/usuarios de app de Linear (no son personas asignables).
    if (!m.email || m.email.endsWith('@linear.linear.app')) continue;

    const displayName = m.displayName || m.name || m.email || m.id;

    const { data: byLinear } = await supabase
      .from('dev')
      .select('id, name')
      .eq('linear_user_id', m.id)
      .maybeSingle();
    if (byLinear) {
      if (m.email) await supabase.from('dev').update({ email: m.email }).eq('id', byLinear.id);
      updated.push(byLinear.name);
      continue;
    }

    if (m.email) {
      const { data: byEmail } = await supabase
        .from('dev')
        .select('id, name')
        .eq('email', m.email)
        .maybeSingle();
      if (byEmail) {
        await supabase.from('dev').update({ linear_user_id: m.id }).eq('id', byEmail.id);
        linked.push(byEmail.name);
        continue;
      }
    }

    const { data: ins, error } = await supabase
      .from('dev')
      .insert({ name: displayName, email: m.email, linear_user_id: m.id, active: true })
      .select('name')
      .single();
    if (error) throw error;
    created.push(ins.name);
  }

  return { created, linked, updated };
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
