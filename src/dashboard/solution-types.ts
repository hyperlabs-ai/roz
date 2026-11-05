// Tipos de solución (roz.solution_type, migración 0032): qué clase de trabajo es una tarea y qué
// pide — skill primaria con nivel mínimo, skill secundaria y tamaño típico. Se editan desde
// /app/skills. El nombre y la descripción son lo que lee Jev para clasificar: cambiarlos cambia cómo
// clasifica (cada decisión guarda el payload exacto que se envió).
import { db } from '../db/supabase.js';
import { AppError, ValidationError } from '../utils/errors.js';

/** Escala de puntos de roz (1 pt = 2 h). */
export const POINT_SCALE = [1, 2, 3, 5, 8, 13] as const;

export interface SolutionTypeView {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** null = "la skill del módulo afectado". */
  primarySkillId: string | null;
  primarySkillTag: string | null;
  minLevel: number;
  secondarySkillId: string | null;
  secondarySkillTag: string | null;
  sizeMin: number;
  sizeMax: number;
  active: boolean;
  sortOrder: number;
  /** Tareas que lo tienen fijado (para saber qué tanto pesa un cambio). */
  taskCount: number;
}

export interface SolutionTypeInput {
  name?: string;
  description?: string;
  primarySkillId?: string | null;
  minLevel?: number;
  secondarySkillId?: string | null;
  sizeMin?: number;
  sizeMax?: number;
  active?: boolean;
  sortOrder?: number;
}

const COLUMNS = 'id, slug, name, description, primary_skill_id, min_level, secondary_skill_id, size_min, size_max, active, sort_order';

type Row = {
  id: string;
  slug: string;
  name: string;
  description: string;
  primary_skill_id: string | null;
  min_level: number;
  secondary_skill_id: string | null;
  size_min: number;
  size_max: number;
  active: boolean;
  sort_order: number;
};

/** "Endpoint / CRUD" → "endpoint-crud". */
export function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'tipo'
  );
}

/**
 * Reglas de un tipo ya fusionado con lo que cambia. Puras, para probarlas solas.
 * Devuelve el primer problema en español, o null.
 */
export function solutionTypeProblem(t: {
  name: string;
  description: string;
  primarySkillId: string | null;
  secondarySkillId: string | null;
  minLevel: number;
  sizeMin: number;
  sizeMax: number;
}): string | null {
  if (!t.name.trim()) return 'el tipo necesita un nombre';
  if (t.name.trim().length > 80) return 'el nombre es muy largo (máx. 80)';
  if (!t.description.trim()) return 'la descripción es lo que lee roz para clasificar: no puede ir vacía';
  if (!Number.isInteger(t.minLevel) || t.minLevel < 1 || t.minLevel > 5) return 'el nivel mínimo va de 1 a 5';
  if (!(POINT_SCALE as readonly number[]).includes(t.sizeMin) || !(POINT_SCALE as readonly number[]).includes(t.sizeMax)) {
    return `el tamaño va en la escala ${POINT_SCALE.join('/')}`;
  }
  if (t.sizeMin > t.sizeMax) return 'el tamaño mínimo no puede ser mayor que el máximo';
  if (t.secondarySkillId && t.secondarySkillId === t.primarySkillId) return 'la skill secundaria no puede ser la misma que la primaria';
  return null;
}

async function skillTags(): Promise<Map<string, string>> {
  const { data, error } = await db().from('skill').select('id, tag');
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; tag: string }[]).map((s) => [s.id, s.tag]));
}

function toView(r: Row, tags: Map<string, string>, counts: Map<string, number>): SolutionTypeView {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    primarySkillId: r.primary_skill_id,
    primarySkillTag: r.primary_skill_id ? tags.get(r.primary_skill_id) ?? null : null,
    minLevel: r.min_level,
    secondarySkillId: r.secondary_skill_id,
    secondarySkillTag: r.secondary_skill_id ? tags.get(r.secondary_skill_id) ?? null : null,
    sizeMin: r.size_min,
    sizeMax: r.size_max,
    active: r.active,
    sortOrder: r.sort_order,
    taskCount: counts.get(r.id) ?? 0,
  };
}

async function taskCounts(): Promise<Map<string, number>> {
  const { data, error } = await db().from('work_item').select('solution_type_id').not('solution_type_id', 'is', null);
  if (error) return new Map();
  const out = new Map<string, number>();
  for (const r of (data ?? []) as { solution_type_id: string }[]) out.set(r.solution_type_id, (out.get(r.solution_type_id) ?? 0) + 1);
  return out;
}

export async function listSolutionTypes(): Promise<SolutionTypeView[]> {
  const [{ data, error }, tags, counts] = await Promise.all([
    db().from('solution_type').select(COLUMNS).order('sort_order').order('name'),
    skillTags(),
    taskCounts(),
  ]);
  if (error) throw error;
  return ((data ?? []) as Row[]).map((r) => toView(r, tags, counts));
}

async function getRow(id: string): Promise<Row> {
  const { data, error } = await db().from('solution_type').select(COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new AppError('NOT_FOUND', 'el tipo de solución no existe', 404);
  return data as Row;
}

function assertSkills(tags: Map<string, string>, ids: (string | null | undefined)[]): void {
  for (const id of ids) if (id && !tags.has(id)) throw new ValidationError('esa skill no existe en el catálogo');
}

function uniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

export async function createSolutionType(input: Required<Pick<SolutionTypeInput, 'name' | 'description' | 'minLevel' | 'sizeMin' | 'sizeMax'>> & SolutionTypeInput): Promise<SolutionTypeView> {
  const merged = {
    name: input.name.trim(),
    description: input.description.trim(),
    primarySkillId: input.primarySkillId ?? null,
    secondarySkillId: input.secondarySkillId ?? null,
    minLevel: input.minLevel,
    sizeMin: input.sizeMin,
    sizeMax: input.sizeMax,
  };
  const problem = solutionTypeProblem(merged);
  if (problem) throw new ValidationError(problem);
  const tags = await skillTags();
  assertSkills(tags, [merged.primarySkillId, merged.secondarySkillId]);

  // Al final de la tabla, salvo que digan otra posición.
  let sortOrder = input.sortOrder;
  if (sortOrder === undefined) {
    const { data } = await db().from('solution_type').select('sort_order').order('sort_order', { ascending: false }).limit(1);
    sortOrder = (((data ?? [])[0] as { sort_order: number } | undefined)?.sort_order ?? 0) + 10;
  }

  const base = slugify(merged.name);
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const { data, error } = await db()
      .from('solution_type')
      .insert({
        slug,
        name: merged.name,
        description: merged.description,
        primary_skill_id: merged.primarySkillId,
        min_level: merged.minLevel,
        secondary_skill_id: merged.secondarySkillId,
        size_min: merged.sizeMin,
        size_max: merged.sizeMax,
        active: input.active ?? true,
        sort_order: sortOrder,
      })
      .select(COLUMNS)
      .single();
    if (!error) return toView(data as Row, tags, new Map());
    if (!uniqueViolation(error)) throw error;
    // ¿Chocó el nombre (no el slug)? Entonces no es cuestión de sufijo.
    const { data: same } = await db().from('solution_type').select('id').eq('name', merged.name).maybeSingle();
    if (same) throw new ValidationError(`ya existe un tipo llamado "${merged.name}"`);
  }
  throw new ValidationError('no se pudo generar un identificador único para el tipo');
}

export async function updateSolutionType(id: string, patch: SolutionTypeInput): Promise<SolutionTypeView> {
  const current = await getRow(id);
  const merged = {
    name: (patch.name ?? current.name).trim(),
    description: (patch.description ?? current.description).trim(),
    primarySkillId: patch.primarySkillId !== undefined ? patch.primarySkillId : current.primary_skill_id,
    secondarySkillId: patch.secondarySkillId !== undefined ? patch.secondarySkillId : current.secondary_skill_id,
    minLevel: patch.minLevel ?? current.min_level,
    sizeMin: patch.sizeMin ?? current.size_min,
    sizeMax: patch.sizeMax ?? current.size_max,
  };
  const problem = solutionTypeProblem(merged);
  if (problem) throw new ValidationError(problem);
  const tags = await skillTags();
  assertSkills(tags, [merged.primarySkillId, merged.secondarySkillId]);

  const { data, error } = await db()
    .from('solution_type')
    .update({
      name: merged.name,
      description: merged.description,
      primary_skill_id: merged.primarySkillId,
      secondary_skill_id: merged.secondarySkillId,
      min_level: merged.minLevel,
      size_min: merged.sizeMin,
      size_max: merged.sizeMax,
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.sortOrder !== undefined ? { sort_order: patch.sortOrder } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(COLUMNS)
    .single();
  if (error) {
    if (uniqueViolation(error)) throw new ValidationError(`ya existe un tipo llamado "${merged.name}"`);
    throw error;
  }
  return toView(data as Row, tags, await taskCounts());
}
