import { ShieldAlert, ShieldCheck, Shield } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import type { ButtonProps } from '@/components/ui/button';
import { ProgressBar } from '@/components/bits';
import {
  PLAN_STATUS_LABEL,
  type AgentPlanSummary, type PlanHumanAction, type PlanProgress, type PlanRisk, type PlanStatus, type RiskReason,
} from '@/lib/api';
import { relative } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Piezas visuales del plan del agente, compartidas por Planes (la "Flota" del mock) y el Pulso. El
 * vocabulario (estados, riesgo) es el de src/types/roz-v2.ts; aquí solo se decide cómo se ve:
 * morado = el agente trabajando, amarillo = espera a una persona, verde = PR/listo.
 */

/** Tono por estado. */
export const PLAN_STATUS_TONE: Record<PlanStatus, BadgeVariant> = {
  en_cola: 'neutral',
  planeando: 'llm',
  esperando_aprobacion: 'human',
  implementando: 'llm',
  pr_abierto: 'info',
  hecho: 'ok',
  jalado: 'human',
  cancelado: 'secondary',
};

export function PlanStatusBadge({ status, className }: { status: PlanStatus; className?: string }) {
  const running = status === 'planeando' || status === 'implementando';
  return (
    <Badge variant={PLAN_STATUS_TONE[status]} className={cn('whitespace-nowrap', className)}>
      {running && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {PLAN_STATUS_LABEL[status]}
    </Badge>
  );
}

export const RISK_LABEL: Record<PlanRisk, string> = {
  0: 'Riesgo 0 · planea e implementa',
  1: 'Riesgo 1 · espera aprobación',
  2: 'Riesgo 2 · solo plan',
};
const RISK_SHORT: Record<PlanRisk, string> = { 0: 'Riesgo 0', 1: 'Riesgo 1', 2: 'Riesgo 2' };
const RISK_TONE: Record<PlanRisk, BadgeVariant> = { 0: 'ok', 1: 'human', 2: 'bad' };
const RISK_ICON = { 0: ShieldCheck, 1: Shield, 2: ShieldAlert } as const;

/** Insignia de riesgo; el `title` enumera las reglas que lo dispararon. */
export function RiskBadge({ risk, reasons, long = false }: { risk: PlanRisk; reasons?: RiskReason[]; long?: boolean }) {
  const Icon = RISK_ICON[risk];
  const why = reasons?.length ? reasons.map((r) => `· ${r.detail}`).join('\n') : 'Sin reglas de riesgo';
  return (
    <Badge variant={RISK_TONE[risk]} title={`${RISK_LABEL[risk]}\n${why}`} className="whitespace-nowrap">
      <Icon className="size-3" />
      {long ? RISK_LABEL[risk] : RISK_SHORT[risk]}
    </Badge>
  );
}

export const PHASE_LABEL = { planear: 'Fase: planear', implementar: 'Fase: implementar' } as const;

/** Avance que reportó el runner: barra fina morada (o indeterminada) + paso/mensaje + cuándo. */
export function PlanProgressLine({ progress, running, className }: { progress: PlanProgress | null; running: boolean; className?: string }) {
  if (!progress && !running) return null;
  const text = [progress?.step, progress?.message].filter(Boolean).join(' · ');
  return (
    <div className={cn('grid gap-1', className)}>
      <ProgressBar pct={running ? progress?.pct ?? null : progress?.pct ?? 0} color="purple-deep" />
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{text || (running ? 'Trabajando…' : '—')}</span>
        {progress?.at && <span className="shrink-0 text-faint">{relative(progress.at)}</span>}
      </div>
    </div>
  );
}

export const CLAIMABLE_REASON: Record<string, string> = {
  dueño_fuera_de_linea: 'Dueño fuera de línea',
  mucho_en_cola: 'Mucho tiempo en cola',
  soltado: 'Lo soltó su dueño',
  fallos: 'Falló varias veces',
};

// ---- Pasos mini (`.steps-mini` del mock): plan → código → PR

export type StepState = 'done' | 'wip' | 'wait' | 'todo';

/** Pasos del trabajo derivados del estado y la fase. `null` = no aplica (en cola, jalado, cancelado). */
export function planSteps(p: Pick<AgentPlanSummary, 'status' | 'phase' | 'prNumber'>): { label: string; state: StepState }[] | null {
  const s = p.status;
  if (s === 'cancelado' || s === 'jalado' || (s === 'en_cola' && p.phase === 'planear')) return null;
  const shipped = s === 'pr_abierto' || s === 'hecho';
  const plan: StepState = p.phase === 'implementar' || shipped ? 'done' : s === 'planeando' ? 'wip' : s === 'esperando_aprobacion' ? 'wait' : 'todo';
  const code: StepState = shipped ? 'done' : s === 'implementando' ? 'wip' : 'todo';
  const pr: StepState = shipped ? 'done' : 'todo';
  return [
    { label: plan === 'wait' ? 'plan esperando' : 'plan', state: plan },
    { label: 'código', state: code },
    { label: p.prNumber ? `PR #${p.prNumber}` : 'PR', state: pr },
  ];
}

const STEP_DOT: Record<StepState, string> = {
  done: 'bg-green text-white',
  wip: 'animate-pulse bg-purple-deep text-background',
  wait: 'bg-yellow text-yellow-ink',
  todo: 'bg-toggle-off',
};
const STEP_GLYPH: Record<StepState, string> = { done: '✓', wip: '·', wait: '?', todo: '' };

export function StepsMini({ steps, className }: { steps: { label: string; state: StepState }[]; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-xs', className)}>
      {steps.map((st) => (
        <span key={st.label} className={cn('inline-flex items-center gap-1.5', st.state === 'todo' && 'text-faint')}>
          <i className={cn('inline-grid size-3.5 place-items-center rounded-full text-[9px] font-bold not-italic leading-none', STEP_DOT[st.state])}>
            {STEP_GLYPH[st.state]}
          </i>
          {st.label}
        </span>
      ))}
    </div>
  );
}

// ---- Acciones

/** Orden de los botones: lo que avanza primero, lo destructivo al final. */
export const ACTION_ORDER: PlanHumanAction[] = ['aprobar', 'pedir_cambios', 'reclamar', 'jalar', 'soltar', 'cancelar'];

/** Variante del botón de cada acción: aprobar = tinta (fuerte), reclamar algo libre = marca. */
export function actionVariant(a: PlanHumanAction, claimable: boolean): ButtonProps['variant'] {
  if (a === 'aprobar') return 'dark';
  if (a === 'reclamar' && claimable) return 'brand';
  if (a === 'cancelar') return 'ghost';
  return 'secondary';
}
