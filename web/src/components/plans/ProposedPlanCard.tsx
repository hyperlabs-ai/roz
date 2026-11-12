import { FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Eyebrow } from '@/components/brand';
import { BalancedGrid } from '@/components/grid';
import { RiskBadge } from '@/components/plans/plan-ui';
import { ACTION_COPY } from '@/components/plans/PlanActionDialog';
import { useApi } from '@/lib/useApi';
import { rozV2Api, type AgentPlanDetail, type AgentPlanSummary, type PlanHumanAction } from '@/lib/api';
import { relative } from '@/lib/format';

/** Pasos del PLAN.md: los renglones de lista (numerados o con viñeta), sin markdown en línea. */
function stepsFrom(md: string | null, max = 6): string[] {
  if (!md) return [];
  const clean = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
  const numbered = md.split('\n').map((l) => l.match(/^\s{0,3}\d+[.)]\s+(.+)/)?.[1]).filter((s): s is string => !!s);
  const bullets = md.split('\n').map((l) => l.match(/^\s{0,1}[-*]\s+(.+)/)?.[1]).filter((s): s is string => !!s);
  const list = numbered.length >= 2 ? numbered : bullets;
  return list.map(clean).filter(Boolean).slice(0, max);
}

/**
 * Plan que espera a una persona (tarjeta de borde amarillo del mock): de quién es, su riesgo, los
 * pasos del PLAN.md en paneles numerados y Aprobar / Pedir cambios (confirman en modal).
 */
export function ProposedPlanCard({
  plan,
  onOpen,
  onAction,
}: {
  plan: AgentPlanSummary;
  onOpen: () => void;
  onAction: (a: PlanHumanAction) => void;
}) {
  const { data, loading } = useApi<{ plan: AgentPlanDetail }>(() => rozV2Api.plan(plan.id), [plan.id], {
    key: '/plans/detail',
    ttl: 30_000,
  });
  const steps = stepsFrom(data?.plan.planMd ?? null);
  const can = (a: PlanHumanAction) => plan.actions.includes(a);

  return (
    <div className="grid gap-3 rounded-lg border border-yellow bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1.5">
          <Eyebrow color="yellow">Esperando aprobación · {relative(plan.updatedAt)}</Eyebrow>
          <span className="text-sm font-semibold tracking-[-0.01em]">
            <span className="font-mono text-faint">{plan.identifier}</span> · plan propuesto por el agente de {plan.owner.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">{plan.issue.name}</span>
        </div>
        <RiskBadge risk={plan.risk} reasons={plan.riskReasons} long />
      </div>

      {loading ? (
        <div className="grid gap-2.5 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
        </div>
      ) : steps.length ? (
        <BalancedGrid max={{ base: 1, sm: 2, xl: 3 }} className="gap-2.5">
          {steps.map((s, i) => (
            <div key={i} className="grid h-full content-start gap-1 rounded-lg bg-sidebar p-2.5">
              <span className="text-[11px] text-faint tabular-nums">{i + 1}</span>
              <span className="text-[13px] leading-snug">{s}</span>
            </div>
          ))}
        </BalancedGrid>
      ) : (
        <button type="button" onClick={onOpen} className="flex items-center gap-2 rounded-lg bg-sidebar p-3 text-left text-[13px] text-muted-foreground hover:text-foreground">
          <FileText className="size-4 shrink-0" /> El PLAN.md no trae pasos en lista: ábrelo para leerlo completo.
        </button>
      )}

      {plan.riskReasons.length > 0 && (
        <p className="text-[11.5px] text-muted-foreground">Pide aprobación porque: {plan.riskReasons.map((r) => r.detail).join(' · ')}</p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {can('aprobar') && <Button size="sm" variant="dark" onClick={() => onAction('aprobar')}>{ACTION_COPY.aprobar.label} plan</Button>}
        {can('pedir_cambios') && <Button size="sm" variant="secondary" onClick={() => onAction('pedir_cambios')}>{ACTION_COPY.pedir_cambios.label}</Button>}
        <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onOpen}><FileText /> Ver PLAN.md</Button>
      </div>
    </div>
  );
}
