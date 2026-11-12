import type { CSSProperties } from 'react';
import type { SkillMatrix } from '@/lib/api';

/**
 * Escala de niveles de skill (0–5) y los agregados que comparten el mapa y su panel. Los nombres
 * son los mismos que usa `SkillMeter` (bits.tsx) para que la escala se lea igual en toda la app.
 */
export const LEVEL_LABEL = ['Sin nivel', 'Básico', 'Junior', 'Intermedio', 'Avanzado', 'Experto'] as const;

/** Desde este nivel una persona cuenta como experta (y el asignador la prefiere como especialista). */
export const EXPERT_LEVEL = 4;

/** Color de una celda del heatmap: intensidad creciente del naranja de marca; 0 = panel. */
export function cellStyle(level: number): CSSProperties {
  const ramp = [0, 0.2, 0.38, 0.58, 0.78, 1];
  // Vacío = apenas un velo: una matriz casi vacía no debe leerse como una pared de bloques.
  if (level <= 0) return { backgroundColor: 'hsl(var(--panel) / 0.45)', color: 'transparent' };
  return {
    backgroundColor: `hsl(var(--primary) / ${ramp[Math.min(5, level)]})`,
    color: level >= 3 ? 'hsl(var(--primary-foreground))' : 'hsl(var(--primary))',
  };
}

export const cellKey = (c: { devId: string; skillId: string }) => `${c.devId}:${c.skillId}`;

export type Dev = SkillMatrix['devs'][number];
export type SkillRow = { id: string; tag: string };

/** Salud de una skill según cuántas personas expertas la sostienen. */
export type SkillHealth = 'backed' | 'single' | 'none';

export interface SkillStat {
  id: string;
  tag: string;
  /** Personas con nivel ≥ 1, de mayor a menor nivel. */
  holders: { dev: Dev; level: number }[];
  experts: Dev[];
  avg: number;
  health: SkillHealth;
}

export interface DevStat {
  dev: Dev;
  skills: { skill: SkillRow; level: number; soleExpert: boolean }[];
  avg: number;
  expertIn: number;
}

export const HEALTH: Record<SkillHealth, { label: string; dot: string; chip: string }> = {
  backed: { label: 'Respaldada', dot: 'bg-green', chip: 'bg-green-soft text-green' },
  single: { label: 'Punto único', dot: 'bg-orange', chip: 'bg-orange-soft text-orange-ink' },
  none: { label: 'Sin experto', dot: 'bg-red', chip: 'bg-red-soft text-red' },
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Agregados por skill y por persona a partir de la matriz (una sola pasada). */
export function computeStats(devs: Dev[], rows: SkillRow[], levels: Map<string, number>) {
  const skillStats = new Map<string, SkillStat>();
  for (const s of rows) {
    const holders = devs
      .map((dev) => ({ dev, level: levels.get(cellKey({ devId: dev.id, skillId: s.id })) ?? 0 }))
      .filter((h) => h.level > 0)
      .sort((a, b) => b.level - a.level || a.dev.name.localeCompare(b.dev.name));
    const experts = holders.filter((h) => h.level >= EXPERT_LEVEL).map((h) => h.dev);
    skillStats.set(s.id, {
      id: s.id,
      tag: s.tag,
      holders,
      experts,
      avg: holders.length ? round1(holders.reduce((a, h) => a + h.level, 0) / holders.length) : 0,
      health: experts.length >= 2 ? 'backed' : experts.length === 1 ? 'single' : 'none',
    });
  }

  const devStats = new Map<string, DevStat>();
  for (const dev of devs) {
    const skills = rows
      .map((skill) => {
        const level = levels.get(cellKey({ devId: dev.id, skillId: skill.id })) ?? 0;
        const st = skillStats.get(skill.id)!;
        return { skill, level, soleExpert: st.health === 'single' && st.experts[0]?.id === dev.id };
      })
      .filter((x) => x.level > 0)
      .sort((a, b) => b.level - a.level || a.skill.tag.localeCompare(b.skill.tag));
    devStats.set(dev.id, {
      dev,
      skills,
      avg: skills.length ? round1(skills.reduce((a, x) => a + x.level, 0) / skills.length) : 0,
      expertIn: skills.filter((x) => x.level >= EXPERT_LEVEL).length,
    });
  }

  return { skillStats, devStats };
}

export type Selection = { kind: 'skill'; id: string } | { kind: 'dev'; id: string } | null;
