// Agrupación de la bóveda por REPO. El CLI nombra cada entorno `<repo>-<etapa>`
// (api-hyperhub-production, api-hyperhub-development): para la persona es UN repo con sus variantes
// Local y Prod, no dos cosas con nombre largo. Aquí se deriva repo y etapa del nombre sin cambiar el
// modelo de datos. Módulo PURO (sin React ni API): se prueba desde test/zeus-vault-groups.test.ts.

/** Etapas del estándar del CLI, en el orden en que se muestran (local primero, prod después). */
export const STAGES = ['development', 'production', 'staging', 'preview', 'test'] as const;
export type Stage = (typeof STAGES)[number];

/** `api-hyperhub-production` → { repo: 'api-hyperhub', stage: 'production' }; sin patrón → sin etapa. */
export function envParts(name: string): { repo: string | null; stage: Stage | null } {
  const stage = STAGES.find((s) => name === s || name.endsWith(`-${s}`)) ?? null;
  if (!stage) return { repo: null, stage: null };
  return { repo: name === stage ? null : name.slice(0, -(stage.length + 1)), stage };
}

/** Lo mínimo de un entorno para agruparlo (ZeusVaultEnvSummary lo cumple). */
export interface GroupableEnv {
  id: string;
  projectId: string;
  projectKey: string;
  projectName: string;
  name: string;
}

export interface VaultVariant<E extends GroupableEnv> {
  /** null = el nombre no sigue `<repo>-<etapa>`: el repo se muestra sin etapa. */
  stage: Stage | null;
  env: E;
}

export interface VaultRepoGroup<E extends GroupableEnv> {
  /** `<projectId>:<repo>`: estable entre recargas. */
  id: string;
  /** Lo que se muestra: el repo, o la clave del proyecto si el entorno se llama solo `production`. */
  repo: string;
  variants: Array<VaultVariant<E>>;
}

export interface VaultProjectGroup<E extends GroupableEnv> {
  id: string;
  key: string;
  name: string;
  repos: Array<VaultRepoGroup<E>>;
}

const stageRank = (s: Stage | null): number => (s ? STAGES.indexOf(s) : STAGES.length);

/**
 * Proyectos → repos → variantes. Un entorno sin etapa reconocible queda como su propio "repo" sin
 * etapa; uno llamado solo `production` cuelga del repo con la clave del proyecto en minúsculas.
 */
export function groupVaultEnvs<E extends GroupableEnv>(envs: readonly E[]): Array<VaultProjectGroup<E>> {
  const projects = new Map<string, VaultProjectGroup<E>>();
  for (const e of envs) {
    const p = projects.get(e.projectId) ?? { id: e.projectId, key: e.projectKey, name: e.projectName, repos: [] };
    projects.set(e.projectId, p);
    const { repo, stage } = envParts(e.name);
    const repoName = stage ? (repo ?? e.projectKey.toLowerCase()) : e.name;
    // Un nombre sin etapa nunca se junta con un repo que sí la tiene (serían cosas distintas).
    const id = `${e.projectId}:${stage ? repoName : `=${e.name}`}`;
    let g = p.repos.find((r) => r.id === id);
    if (!g) {
      g = { id, repo: repoName, variants: [] };
      p.repos.push(g);
    }
    g.variants.push({ stage, env: e });
  }
  const out = [...projects.values()];
  for (const p of out) {
    p.repos.sort((a, b) => a.repo.localeCompare(b.repo, 'es'));
    for (const r of p.repos) r.variants.sort((a, b) => stageRank(a.stage) - stageRank(b.stage) || a.env.name.localeCompare(b.env.name));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

/** `HUB · api-hyperhub-production` (etiqueta de la auditoría) → proyecto, repo y etapa. */
export function auditEnvParts(label: string): { project: string | null; repo: string; stage: Stage | null } {
  const i = label.indexOf(' · ');
  const project = i >= 0 ? label.slice(0, i) : null;
  const name = i >= 0 ? label.slice(i + 3) : label;
  const { repo, stage } = envParts(name);
  return { project, repo: stage ? (repo ?? (project ?? name).toLowerCase()) : name, stage };
}
