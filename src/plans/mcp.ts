// Lo que el agente (Claude Code en el runner) consulta y reporta por el MCP de roz mientras trabaja
// un plan: el plan y su issue, las decisiones del proyecto (átomos del brain que salieron de juntas)
// y su avance. Las herramientas se registran en src/mcp/server.ts.
import { db } from '../db/supabase.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { assertPlansEnabled, getPlan, getWorkItem, type PlanRow } from './store.js';
import { normalizeText } from './rules.js';
import { planByIdentifier } from './service.js';
import { runnerProgress } from './runners.js';
import type { PlanPhase, PlanRisk, PlanStatus, RiskReason, RunnerProgressResponse } from '../types/roz-v2.js';

export interface AgentPlanView {
  planId: string;
  identifier: string;
  status: PlanStatus;
  phase: PlanPhase;
  risk: PlanRisk;
  riskReasons: RiskReason[];
  issue: { title: string; description: string | null; url: string | null; labels: string[]; projectId: string | null };
  repo: string | null;
  branch: string | null;
  planMd: string | null;
  planVersion: number;
  feedback: string | null;
}

async function resolvePlan(input: { planId?: string; identifier?: string }): Promise<PlanRow> {
  if (input.planId) {
    const row = await getPlan(input.planId);
    if (!row) throw new NotFoundError('Ese plan no existe.');
    return row;
  }
  if (input.identifier) {
    const row = await planByIdentifier(input.identifier);
    if (!row) throw new NotFoundError(`No hay plan para ${input.identifier}.`);
    return row;
  }
  throw new ValidationError('manda planId o identifier');
}

export async function getPlanForAgent(input: { planId?: string; identifier?: string }): Promise<AgentPlanView> {
  assertPlansEnabled();
  const row = await resolvePlan(input);
  const item = await getWorkItem(row.work_item_id);
  return {
    planId: row.id,
    identifier: row.identifier,
    status: row.status,
    phase: row.phase,
    risk: row.risk,
    riskReasons: row.risk_reasons ?? [],
    issue: {
      title: item?.name ?? row.identifier,
      description: item?.description ?? null,
      url: item?.url ?? null,
      labels: item?.labels ?? [],
      projectId: item?.project_id ?? null,
    },
    repo: row.repo,
    branch: row.branch,
    planMd: row.plan_md,
    planVersion: row.plan_version,
    feedback: row.feedback,
  };
}

export interface DecisionView {
  id: string;
  title: string;
  body: string;
  meetingId: string | null;
  createdAt: string;
}

/**
 * Decisiones del proyecto: átomos activos del brain cuyo origen es una junta (provenance 'meeting:<id>').
 * El proyecto sale del plan (planId) o se pasa directo. `query` filtra por texto (sin acentos).
 */
export async function getDecisionsForAgent(input: {
  planId?: string;
  projectId?: string;
  query?: string;
  limit?: number;
}): Promise<{ projectId: string | null; decisions: DecisionView[] }> {
  assertPlansEnabled();
  let projectId = input.projectId ?? null;
  if (!projectId && input.planId) {
    const row = await getPlan(input.planId);
    if (!row) throw new NotFoundError('Ese plan no existe.');
    projectId = (await getWorkItem(row.work_item_id))?.project_id ?? null;
  }
  if (!projectId) return { projectId: null, decisions: [] };

  const { data, error } = await db()
    .from('knowledge_atom')
    .select('id, title, body, provenance, created_at')
    .eq('project_id', projectId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw error;
  const q = input.query ? normalizeText(input.query.trim()) : '';
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const decisions = ((data ?? []) as { id: string; title: string; body: string; provenance: string[] | null; created_at: string }[])
    .filter((a) => (a.provenance ?? []).some((p) => p.startsWith('meeting:')))
    .filter((a) => !q || normalizeText(`${a.title}\n${a.body}`).includes(q))
    .slice(0, limit)
    .map((a) => ({
      id: a.id,
      title: a.title,
      body: a.body,
      meetingId: (a.provenance ?? []).find((p) => p.startsWith('meeting:'))?.slice('meeting:'.length) ?? null,
      createdAt: a.created_at,
    }));
  return { projectId, decisions };
}

/** report_progress del MCP: lo mismo que /v1/runner/progress kind 'progress', validado por el lease. */
export async function reportProgressFromAgent(input: {
  planId: string;
  leaseId: string;
  step?: string;
  message?: string;
  pct?: number;
}): Promise<RunnerProgressResponse> {
  return runnerProgress(null, null, {
    planId: input.planId,
    leaseId: input.leaseId,
    kind: 'progress',
    step: input.step,
    message: input.message,
    pct: input.pct,
  });
}
