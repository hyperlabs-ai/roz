// Cómo se NOMBRA un entorno de la bóveda frente a una persona. El CLI lo guarda como `<repo>-<etapa>`
// (api-hyperhub-production) y así sigue en datos y comandos; en textos (avisos, correos, Discord) se
// muestra como "api-hyperhub (Prod)", igual que la sección Variables del front
// (web/src/components/zeus/vault-groups.ts, misma regla).

const STAGES = ['development', 'production', 'staging', 'preview', 'test'] as const;
type Stage = (typeof STAGES)[number];

const STAGE_LABEL: Record<Stage, string> = { development: 'Local', production: 'Prod', staging: 'Staging', preview: 'Preview', test: 'Test' };

export function envParts(name: string): { repo: string | null; stage: Stage | null } {
  const stage = STAGES.find((s) => name === s || name.endsWith(`-${s}`)) ?? null;
  if (!stage) return { repo: null, stage: null };
  return { repo: name === stage ? null : name.slice(0, -(stage.length + 1)), stage };
}

/**
 * `api-hyperhub-production` → "api-hyperhub (Prod)". Un entorno que se llama solo como la etapa
 * (`development`) toma el nombre del proyecto: "HYPERHUB (Local)". Fuera del estándar, queda igual.
 */
export function envDisplay(name: string, projectKey?: string | null): string {
  const { repo, stage } = envParts(name);
  if (!stage) return name;
  const base = repo ?? projectKey;
  return base ? `${base} (${STAGE_LABEL[stage]})` : STAGE_LABEL[stage];
}

// Lo que va después de "zeus env <comando> <PROYECTO> " es un comando: se deja con el nombre real.
const WITH_REPO = /(?<!zeus env [a-z]+ [A-Za-z0-9_-]+ )(?<![\w./-])(?:[A-Z][A-Z0-9_-]*\/)?([a-z0-9][a-z0-9._-]*?)-(development|production|staging|preview|test)\b/g;
const ONLY_STAGE = /(?<!zeus env [a-z]+ )(?<![\w./-])([A-Z][A-Z0-9_-]*)\/(development|production|staging|preview|test)\b/g;

/** Reescribe nombres de entorno dentro de un texto (avisos viejos con el nombre largo). Puro. */
export function prettyEnvText(text: string): string {
  return text
    .replace(ONLY_STAGE, (_m, project: string, stage: Stage) => `${project} (${STAGE_LABEL[stage]})`)
    .replace(WITH_REPO, (_m, repo: string, stage: Stage) => `${repo} (${STAGE_LABEL[stage]})`);
}
