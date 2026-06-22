// Forma normalizada de un sondeo de servicio. Cada adapter (Vercel/Railway/Supabase) traduce
// la respuesta nativa de su API a esto, para que el poller y el dashboard no sepan de proveedores.
// Fase "solo datos": no se evalúan umbrales — `status` refleja lo que el proveedor ya reporta.

export type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'paused' | 'unknown';

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
  /** Datos ricos específicos del proveedor (framework, región, réplicas, subsistemas, recientes…). */
  details: Record<string, unknown> | null;
  error: string | null;
  raw?: unknown;
}

/** Helper para construir un sondeo degradado (sin token / no soportado) sin romper el ciclo. */
export function degraded(error: string): ServiceProbe {
  return { ok: false, status: 'unknown', providerStatus: null, active: null, deploy: null, metrics: null, details: null, error };
}
