import { Bot, Hand, MessageSquareWarning } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorCard } from '@/components/bits';
import { Eyebrow, GithubAvatar, CapsLabel } from '@/components/brand';
import { Markdown } from '@/components/Markdown';
import { ExtLink } from '@/components/pulse/roz-v2';
import { ACTION_COPY } from '@/components/plans/PlanActionDialog';
import { ACTION_ORDER, PHASE_LABEL, PlanStatusBadge, RiskBadge, StepsMini, actionVariant, planSteps } from '@/components/plans/plan-ui';
import { useApi } from '@/lib/useApi';
import { PLAN_STATUS_LABEL, rozV2Api, type AgentPlanDetail, type AgentPlanEvent, type PlanEventKind, type PlanHumanAction } from '@/lib/api';
import { relative } from '@/lib/format';
import { cn } from '@/lib/utils';

const EVENT_LABEL: Record<PlanEventKind, string> = {
  enqueued: 'Entró a la cola',
  started: 'El agente lo tomó',
  progress: 'Avance',
  plan_ready: 'Plan listo',
  approved: 'Aprobado',
  changes_requested: 'Pidieron cambios',
  claimed: 'Reclamado',
  pulled: 'Jalado por una persona',
  released: 'Soltado',
  canceled: 'Cancelado',
  pr_opened: 'PR abierta',
  done: 'Terminado',
  requeued: 'Regresó a la cola (sin latido)',
  failed: 'Falló',
  claimable: 'Quedó reclamable',
};

/** Detalle del plan: PLAN.md, comentarios pendientes, riesgo explicado y la bitácora completa. */
export function PlanDetailDialog({
  planId,
  onClose,
  onAction,
}: {
  planId: string;
  onClose: () => void;
  onAction: (plan: AgentPlanDetail, a: PlanHumanAction) => void;
}) {
  const { data, loading, error } = useApi<{ plan: AgentPlanDetail }>(() => rozV2Api.plan(planId), [planId], {
    key: '/plans/detail',
    ttl: 10_000,
  });
  const plan = data?.plan ?? null;
  // Quién lo reclamó: el último evento 'claimed' con persona (los de Linear vienen sin actor).
  const claim = plan ? [...plan.events].reverse().find((e) => e.kind === 'claimed') ?? null : null;
  const steps = plan ? planSteps(plan) : null;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        {error ? (
          <ErrorCard message={error} />
        ) : loading || !plan ? (
          <div className="grid gap-3"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-6 w-2/3" /><Skeleton className="h-64" /></div>
        ) : (
          <>
            <DialogHeader>
              <Eyebrow color="purple-deep">Plan del agente · {plan.identifier}</Eyebrow>
              <DialogTitle>
                <ExtLink href={plan.issue.url}>{plan.issue.name}</ExtLink>
              </DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-1.5 pt-1">
                <PlanStatusBadge status={plan.status} />
                <RiskBadge risk={plan.risk} reasons={plan.riskReasons} long />
                <span className="text-[11px] text-faint tabular-nums">{PHASE_LABEL[plan.phase]} · v{plan.planVersion}</span>
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
              <span className="flex items-center gap-2">
                <GithubAvatar login={plan.owner.githubLogin} id={plan.owner.id} url={plan.owner.avatarUrl} name={plan.owner.name} className="size-6" />
                <span>Cola de <span className="font-semibold">{plan.owner.name}</span></span>
              </span>
              {steps && <StepsMini steps={steps} />}
              {claim && (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Hand className="size-3.5" />
                  {claim.actor ? <>Reclamado por <span className="font-medium text-foreground">{claim.actor.name}</span></> : 'Reasignado en Linear'} · {relative(claim.createdAt)}
                </span>
              )}
              {plan.repo && <span className="font-mono text-[11px] text-faint">{plan.repo}{plan.branch ? ` · ${plan.branch}` : ''}</span>}
            </div>

            {plan.riskReasons.length > 0 && (
              <ul className="grid gap-0.5 rounded-lg bg-sidebar px-3 py-2 text-xs text-muted-foreground">
                {plan.riskReasons.map((r, i) => <li key={i}>· {r.detail}</li>)}
              </ul>
            )}

            {plan.feedback && (
              <div className="flex items-start gap-2 rounded-lg border border-yellow bg-yellow-soft px-3 py-2 text-sm">
                <MessageSquareWarning className="mt-0.5 size-4 shrink-0 text-yellow-ink" />
                <div><div className="text-xs font-semibold text-yellow-ink">Cambios pedidos</div>{plan.feedback}</div>
              </div>
            )}

            {plan.actions.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {ACTION_ORDER.filter((a) => plan.actions.includes(a)).map((a) => (
                  <Button
                    key={a}
                    size="sm"
                    variant={actionVariant(a, plan.claimable)}
                    className={cn(a === 'cancelar' && 'ml-auto text-muted-foreground hover:text-destructive')}
                    onClick={() => onAction(plan, a)}
                  >
                    {ACTION_COPY[a].label}
                  </Button>
                ))}
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_15rem]">
              <div className="grid min-w-0 content-start gap-1.5">
                <CapsLabel>PLAN.md</CapsLabel>
                {plan.planMd ? (
                  <div className="max-h-[50dvh] overflow-y-auto rounded-lg border bg-sidebar p-4 scrollbar-thin">
                    <Markdown>{plan.planMd}</Markdown>
                  </div>
                ) : (
                  <div className="rounded-lg border bg-sidebar">
                    <EmptyState icon={<Bot />}>El agente todavía no escribe el plan.</EmptyState>
                  </div>
                )}
              </div>
              <div className="grid min-w-0 content-start gap-1.5">
                <CapsLabel>Bitácora</CapsLabel>
                <Timeline events={plan.events} />
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Timeline({ events }: { events: AgentPlanEvent[] }) {
  const shown = events.filter((e) => e.kind !== 'progress').slice().reverse();
  if (!shown.length) return <div className="text-xs text-muted-foreground">Sin eventos.</div>;
  return (
    <ol className="relative ml-1 grid max-h-[50dvh] gap-3 overflow-y-auto border-l pl-4 scrollbar-thin">
      {shown.map((e) => (
        <li key={e.id} className="relative">
          <span
            className={cn(
              'absolute -left-[21px] top-1 size-2.5 rounded-full ring-2 ring-card',
              e.kind === 'failed'
                ? 'bg-red'
                : e.kind === 'claimed' || e.kind === 'claimable' || e.kind === 'changes_requested'
                  ? 'bg-yellow'
                  : e.kind === 'done' || e.kind === 'pr_opened' || e.kind === 'approved'
                    ? 'bg-green'
                    : 'bg-purple-deep',
            )}
          />
          <div className="text-xs font-semibold">{EVENT_LABEL[e.kind] ?? e.kind}</div>
          <div className="text-[11px] text-muted-foreground">
            {e.actor?.name ?? e.runner?.name ?? 'roz'} · {relative(e.createdAt)}
            {e.toStatus && e.fromStatus !== e.toStatus ? ` · → ${PLAN_STATUS_LABEL[e.toStatus]}` : ''}
          </div>
          {typeof e.data?.note === 'string' && e.data.note && <div className="mt-0.5 text-[11px] italic text-muted-foreground">«{e.data.note}»</div>}
          {typeof e.data?.error === 'string' && e.data.error && <div className="mt-0.5 line-clamp-2 text-[11px] text-red">{e.data.error}</div>}
        </li>
      ))}
    </ol>
  );
}
