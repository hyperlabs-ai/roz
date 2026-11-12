// Clasificación determinística de un cambio (commit o PR) SIN modelo. Antes una pasada de Claude
// decidía si el cambio era trivial, lo intentaba emparejar con una tarea abierta y redactaba un
// resumen; eso se quitó: cada push costaba una llamada y, cuando la API fallaba, el evento
// reintentaba hasta morir. Ahora la tarea auto-documentada lleva el mensaje tal cual lo escribió
// el autor, y "trivial" se decide con estas reglas.

const TRIVIAL_PREFIX = /^(style|ci|build|chore\((deps|deps-dev|release)\))(\([^)]*\))?!?:/i;
const TRIVIAL_START = /^(merge\b|bump\b|wip\b|typo\b|lint\b|format\b|fmt\b|prettier\b|revert\b|release\b|v?\d+\.\d+\.\d+)/i;
const TRIVIAL_ANYWHERE =
  /\b(fix(ed|es)? typos?|typos?|lint(ing|er)?|prettier|format(ting|eo)?|bump (version|deps|dependenc\w+)|update (deps|dependenc\w+|lockfile)|version bump|lockfile)\b/i;

/** true = merge, formato, lint, bump de versión, typo…: no se documenta como tarea. */
export function isTrivialChange(title: string | null | undefined): boolean {
  const first = (title ?? '').split('\n')[0]!.trim();
  if (first.length < 4) return true;
  // Un "feat:" o "fix:" explícito manda aunque el texto mencione formato o lint.
  if (/^(feat|fix|perf|refactor)(\([^)]*\))?!?:/i.test(first)) return false;
  return TRIVIAL_PREFIX.test(first) || TRIVIAL_START.test(first) || TRIVIAL_ANYWHERE.test(first);
}
