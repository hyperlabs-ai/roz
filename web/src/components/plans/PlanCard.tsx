import { AlertTriangle, Cpu, GitPullRequest, GitBranch, Hand, HeartPulse } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GithubAvatar, ProjectIcon } from '@/components/brand';
import { ExtLink } from '@/components/pulse/roz-v2';
import { ACTION_COPY } from '@/components/plans/PlanActionDialog';
import {
  ACTION_ORDER, CLAIMABLE_REASON, PlanProgressLine, PlanStatusBadge, RiskBadge, StepsMini, actionVariant, planSteps,
} from '@/components/plans/plan-ui';
import { PLAN_RUNNING, type AgentPlanSummary, type PlanHumanAction } from '@/lib/api';
import { relative } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Un trabajo de la flota como tarjeta (la vista de teléfono de la tabla "Trabajos"): el issue, de
 * quién es, sus pasos (plan → código → PR), qué hace el runner ahora y las acciones que ESTA persona
 * puede hacer (las decide el backend).
 */
export function PlanCard({
  plan,
  busy,
  onOpen,
  onAction,
}: {
  plan: AgentPlanSummary;
  busy: boolean;
  onOpen: () => void;
  onAction: (a: PlanHumanAction) => void;
}) {
  const running = PLAN_RUNNING.includes(plan.status);
  const actions = ACTION_ORDER.filter((a) => plan.actions.includes(a));
  const steps = planSteps(plan);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
      className={cn(
        'grid cursor-pointer gap-3 rounded-lg border bg-card p-3.5 text-left transition-colors duration-fast hover:border-toggle-off',
        plan.status === 'esperando_aprobacion' && 'border-yellow',
        plan.claimable && 'border-l-4 border-l-orange',
      )}
    >
      <div className="flex items-start gap-3">
        <GithubAvatar login={plan.owner.githubLogin} id={plan.owner.id} url={plan.owner.avatarUrl} name={plan.owner.name} className="size-8" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="font-mono text-faint">{plan.identifier}</span>
            {plan.issue.projectName && (
              <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
                · <ProjectIcon id={plan.issue.projectId} size="xs" />
                <span className="truncate">{plan.issue.projectName}</span>
              </span>
            )}
          </div>
          <ExtLink href={plan.issue.url} className="mt-0.5 text-[13.5px] font-semibold leading-snug">
            <span className="line-clamp-2">{plan.issue.name}</span>
          </ExtLink>
          <div className="mt-0.5 text-[11.5px] text-muted-foreground">Cola de {plan.owner.name}</div>
        </div>
        <PlanStatusBadge status={plan.status} />
      </div>

      {steps && <StepsMini steps={steps} />}

      <div className="flex flex-wrap items-center gap-1.5">
        <RiskBadge risk={plan.risk} reasons={plan.riskReasons} />
        {plan.claimable && (
          <Badge variant="warn">
            <Hand className="size-3" /> Reclamable{plan.claimableReason ? ` · ${CLAIMABLE_REASON[plan.claimableReason] ?? plan.claimableReason}` : ''}
          </Badge>
        )}
        {plan.attempts > 0 && <Badge variant="neutral">{plan.attempts} intento{plan.attempts === 1 ? '' : 's'}</Badge>}
      </div>

      {(running || plan.progress) && <PlanProgressLine progress={plan.progress} running={running} />}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
        {plan.runner && <span className="flex items-center gap-1"><Cpu className="size-3" />{plan.runner.name}</span>}
        {plan.heartbeatAt && running && (
          <span className="flex items-center gap-1"><HeartPulse className="size-3" />latido {relative(plan.heartbeatAt)}</span>
        )}
        {plan.branch && (
          <span className="flex min-w-0 items-center gap-1"><GitBranch className="size-3 shrink-0" /><span className="truncate font-mono">{plan.branch}</span></span>
        )}
        {plan.prUrl && (
          <ExtLink href={plan.prUrl} className="text-foreground"><GitPullRequest className="size-3" />PR #{plan.prNumber}</ExtLink>
        )}
        {plan.pulledBy && <span>lo implementa {plan.pulledBy.name}</span>}
        <span className="ml-auto text-faint">{relative(plan.updatedAt)}</span>
      </div>

      {plan.error && (
        <div className="flex items-start gap-1.5 rounded-md bg-red-soft px-2.5 py-1.5 text-xs text-red">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-2">{plan.error}</span>
        </div>
      )}

      {actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t pt-3" onClick={(e) => e.stopPropagation()}>
          {actions.map((a) => (
            <Button
              key={a}
              size="sm"
              variant={actionVariant(a, plan.claimable)}
              className={cn(a === 'cancelar' && 'ml-auto text-muted-foreground hover:text-destructive')}
              disabled={busy}
              onClick={() => onAction(a)}
            >
              {ACTION_COPY[a].label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
