// Estado de las piezas de larga vida del proceso (planificador, puente de Discord), para /health.
// Vive aparte de index.ts para que app.ts lo lea sin importar el arranque (y sin ciclos).
export interface RuntimeProbes {
  scheduler: () => boolean;
  bridge: () => unknown | null;
}

let probes: RuntimeProbes | null = null;

export function setRuntime(p: RuntimeProbes): void {
  probes = p;
}

/** Foto del proceso. Sin arranque (pruebas, MCP por stdio) reporta todo apagado. */
export function runtimeStatus(): { scheduler: boolean; bridge: unknown | null } {
  return { scheduler: probes?.scheduler() ?? false, bridge: probes?.bridge() ?? null };
}
