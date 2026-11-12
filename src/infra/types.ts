// Forma normalizada de un sondeo de servicio. Cada adapter (Vercel/Railway/Supabase) traduce
// la respuesta nativa de su API a esto, para que el poller y el dashboard no sepan de proveedores.
//
// Dos conceptos que NO son lo mismo y se guardan por separado:
//   - `status`: salud del SERVICIO, o sea de lo que está sirviendo producción ahora mismo.
//   - `details.lastDeploy`: resultado del ÚLTIMO INTENTO de deploy.
// Un build que falla no tumba producción (el deploy anterior sigue sirviendo): el servicio queda
// 'healthy' con `lastDeploy.state = 'failed'`. Solo es 'down' cuando lo que sirve está roto o no
// hay nada sirviendo. Fase "solo datos": sin umbrales, solo lo que el proveedor reporta.

export type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'paused' | 'unknown';

/** Resultado normalizado de un intento de deploy. */
export type DeployState = 'building' | 'ready' | 'failed' | 'canceled' | 'unknown';

export interface ServiceDeploy {
  state: string;                // estado nativo del último deploy (READY, SUCCESS, ERROR…)
  url: string | null;           // URL del deploy/servicio
  sha: string | null;           // commit
  createdAt: string | null;     // ISO
  commitMessage?: string | null;
  branch?: string | null;
  author?: string | null;
  repo?: string | null;
  durationMs?: number | null;   // tiempo de build (si el proveedor lo expone)
}

/** Un deploy concreto (el último intento, o el que sirve producción). Vive en `details`. */
export interface DeployRef {
  id: string | null;
  state: DeployState;
  nativeState: string;
  sha: string | null;
  branch: string | null;
  message: string | null;
  author: string | null;
  createdAt: string | null;
  durationMs: number | null;
  url: string | null;
  inspectorUrl: string | null;
}

/**
 * Por qué falló algo, SOLO con lo que el proveedor dice (sin interpretación). Cada campo es
 * opcional: lo que no se pudo leer de forma confiable queda en null y no se muestra.
 */
export interface FailureInfo {
  /** A qué se refiere: un intento de deploy, el proceso en ejecución, o un subsistema. */
  scope: 'deploy' | 'runtime' | 'platform';
  /** Id del deploy al que pertenece (para no volver a pedir los logs del mismo fallo). */
  deployId: string | null;
  /** Paso que falló, tal cual lo nombra el proveedor (p. ej. "buildStep"). */
  step: string | null;
  code: string | null;
  message: string | null;
  /** Últimas líneas relevantes del log (de error si las hay). */
  logTail: string[];
  /** Enlace de ayuda del proveedor para ese error. */
  helpUrl: string | null;
}

/** Las claves de `details` que comparten los proveedores con deploys (Vercel y Railway). */
export interface DeployDetails {
  lastDeploy: DeployRef | null;
  /** El deploy que atiende producción. null = no hay ninguno sirviendo (o no se pudo saber). */
  serving: DeployRef | null;
  failure: FailureInfo | null;
}

export interface ServiceProbe {
  /** La llamada a la API del proveedor tuvo éxito. false = token faltante o error de red/API. */
  ok: boolean;
  status: ServiceStatus;
  /** Estado nativo del proveedor (sin normalizar), para mostrar el detalle real. */
  providerStatus: string | null;
  /** ¿El recurso está activo/corriendo? null si el proveedor no lo expone claramente. */
  active: boolean | null;
  deploy: ServiceDeploy | null;
  /** Métricas best-effort: { requests, ... }. null si no se pudieron leer (o no aplican). */
  metrics: Record<string, number | null> | null;
  /** Datos ricos específicos del proveedor (framework, región, réplicas, subsistemas, recientes…)
   *  más `lastDeploy` / `serving` / `failure` (ver DeployDetails). */
  details: Record<string, unknown> | null;
  error: string | null;
  raw?: unknown;
}

/** Lo que el sondeo anterior ya averiguó; evita volver a bajar los logs de un fallo ya visto. */
export interface ProbeHint {
  failure?: FailureInfo | null;
}

/** Helper para construir un sondeo degradado (sin token / no soportado) sin romper el ciclo. */
export function degraded(error: string): ServiceProbe {
  return { ok: false, status: 'unknown', providerStatus: null, active: null, deploy: null, metrics: null, details: null, error };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const ERROR_LINE = /\b(error|err!|failed|failure|fatal|exception|cannot|not found|exit code|exited with|denied|unhandled|traceback)\b/i;

/**
 * De un log completo, las líneas que explican el fallo: las últimas que huelen a error y, si no hay
 * ninguna, las últimas tal cual. Limpia códigos ANSI y recorta líneas kilométricas.
 */
export function pickLogTail(lines: string[], max = 8): string[] {
  const clean = lines
    .flatMap((l) => String(l ?? '').split('\n'))
    .map((l) => l.replace(ANSI, '').trimEnd())
    .filter((l) => l.trim().length > 0);
  if (!clean.length) return [];
  const errs = clean.filter((l) => ERROR_LINE.test(l));
  const picked = errs.length ? errs.slice(-max) : clean.slice(-Math.min(max, 5));
  return picked.map((l) => (l.length > 240 ? `${l.slice(0, 239)}…` : l));
}
