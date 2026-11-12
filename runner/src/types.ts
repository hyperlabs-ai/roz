// Tipos de la API /v1/runner/* — ESPEJO A MANO de src/types/roz-v2.ts (sección Runners) del backend.
// El runner es un paquete independiente (se instala en la PC de cada dev sin el resto de roz), así
// que no importa del backend. Si un campo cambia allá, cambia aquí en el mismo cambio: un campo
// renombrado compila igual y rompe el runner en runtime. Contrato: docs/roz-v2-contracts.md (c).

export type PlanStatus =
  | 'en_cola'
  | 'planeando'
  | 'esperando_aprobacion'
  | 'implementando'
  | 'pr_abierto'
  | 'hecho'
  | 'jalado'
  | 'cancelado';
export type PlanPhase = 'planear' | 'implementar';
/** 0 = planea e implementa hasta PR; 1 = planea y espera aprobación; 2 = solo plan, implementa una persona. */
export type PlanRisk = 0 | 1 | 2;

export type RiskCode = 'ruta_sensible' | 'migracion' | 'auth_rls' | 'pagos' | 'cliente_sla' | 'ruta_proyecto' | 'origen_externo';
export interface RiskReason {
  code: RiskCode;
  detail: string;
}

export interface PlanProgress {
  step: string | null;
  message: string | null;
  pct: number | null;
  at: string;
}

/** Horario del runner. days: 1 = lunes … 7 = domingo (ISO). Horas en la zona `tz`. */
export interface RunnerSchedule {
  tz: string;
  days: number[];
  start: string; // 'HH:MM'
  end: string; // 'HH:MM'
}
export const DEFAULT_RUNNER_SCHEDULE: RunnerSchedule = {
  tz: 'America/Mexico_City',
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '19:00',
};

export interface RunnerSummary {
  id: string;
  devId: string;
  devName: string;
  name: string;
  tokenPrefix: string;
  schedule: RunnerSchedule;
  maxConcurrent: number;
  version: string | null;
  platform: string | null;
  lastSeenAt: string | null;
  online: boolean;
  revokedAt: string | null;
  running: number;
  createdAt: string;
}

/**
 * Listas blancas por defecto (las mismas que el backend). El servidor manda la lista en cada
 * RunnerJob; estas solo se usan cuando el runner sigue solo (plan_listo con riesgo 0 → implementar).
 */
export const RUNNER_ALLOWED_TOOLS_PLAN: readonly string[] = ['Read', 'Glob', 'Grep', 'Write(PLAN.md)', 'mcp__roz__*'];
export const RUNNER_ALLOWED_TOOLS_IMPLEMENT: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(npm test:*)',
  'Bash(npm run typecheck:*)',
  'Bash(npx tsc:*)',
  'Bash(npx vitest:*)',
  'mcp__roz__*',
];
export const MAX_TURNS_PLAN = 40;
export const MAX_TURNS_IMPLEMENT = 120;

export interface RunnerRegisterRequest {
  name: string;
  version: string;
  platform: string;
  schedule?: RunnerSchedule;
  maxConcurrent?: number;
}
export interface RunnerRegisterResponse {
  runner: RunnerSummary;
  dev: { id: string; name: string; githubLogin: string | null };
  mcpUrl: string;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
}

export interface RunnerHeartbeatRequest {
  running: { planId: string; leaseId: string; progress?: Omit<PlanProgress, 'at'> }[];
  version?: string;
}
export type RunnerStopReason = 'cancelado' | 'lease_perdido' | 'reasignado';
export interface RunnerHeartbeatResponse {
  now: string;
  inSchedule: boolean;
  stop: { planId: string; reason: RunnerStopReason }[];
}

export interface RunnerJob {
  planId: string;
  leaseId: string;
  phase: PlanPhase;
  risk: PlanRisk;
  riskReasons: RiskReason[];
  identifier: string;
  issue: { title: string; description: string | null; url: string | null; projectName: string | null };
  repo: string | null; // "owner/name"
  baseBranch: string | null;
  branch: string;
  planMd: string | null;
  feedback: string | null;
  prompt: string;
  allowedTools: string[];
  maxTurns: number;
}
export interface RunnerNextJobResponse {
  job: RunnerJob | null;
  retryAfterMs: number;
}

export type RunnerProgressKind = 'progress' | 'plan_ready' | 'pr_opened' | 'failed' | 'released';
export interface RunnerProgressRequest {
  planId: string;
  leaseId: string;
  kind: RunnerProgressKind;
  step?: string;
  message?: string;
  pct?: number;
  planMd?: string;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  error?: string;
}
export interface RunnerProgressResponse {
  status: PlanStatus;
  phase: PlanPhase;
  continue: boolean;
}

export interface RunnerPullRequest {
  planId?: string;
  identifier?: string;
}
export interface RunnerPullResponse {
  planId: string;
  identifier: string;
  repo: string | null;
  baseBranch: string | null;
  branch: string;
  planMd: string;
  issue: { title: string; url: string | null };
}
