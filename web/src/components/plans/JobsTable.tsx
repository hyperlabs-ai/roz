import { AlertTriangle, GitPullRequest } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { GithubAvatar, ProjectIcon } from '@/components/brand';
import { ExtLink } from '@/components/pulse/roz-v2';
import { ACTION_COPY } from '@/components/plans/PlanActionDialog';
import {
  ACTION_ORDER, PlanProgressLine, RiskBadge, StepsMini, actionVariant, planSteps,
} from '@/components/plans/plan-ui';
import { PLAN_RUNNING, PLAN_STATUS_LABEL, type AgentPlanSummary, type PlanHumanAction } from '@/lib/api';
import { relative } from '@/lib/format';
import { cn } from '@/lib/utils';

/** "Dónde" corre: el runner, una persona o la cola. */
function where(p: AgentPlanSummary): string {
  if (p.pulledBy) return `a mano · ${p.pulledBy.name}`;
  if (p.runner) return p.runner.name;
  if (p.status === 'en_cola') return 'en cola';
  if (p.status === 'esperando_aprobacion') return 'en pausa';
  return '—';
}

/**
 * Tabla "Trabajos" de la flota: issue, dueño, dónde corre, pasos mini (plan → código → PR) con el
 * avance del runner, riesgo, cuándo se movió y las acciones de ESTA persona. Un clic en la fila
 * abre el detalle.
 */
export function JobsTable({
  plans,
  busy,
  onOpen,
  onAction,
}: {
  plans: AgentPlanSummary[];
  busy: boolean;
  onOpen: (p: AgentPlanSummary) => void;
  onAction: (p: AgentPlanSummary, a: PlanHumanAction) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="pl-4">Issue</TableHead>
          <TableHead>Dueño</TableHead>
          <TableHead>Dónde</TableHead>
          <TableHead>Progreso</TableHead>
          <TableHead>Riesgo</TableHead>
          <TableHead className="text-right">Movido</TableHead>
          <TableHead className="pr-4 text-right">Acciones</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {plans.map((p) => {
          const running = PLAN_RUNNING.includes(p.status);
          const steps = planSteps(p);
          const actions = ACTION_ORDER.filter((a) => p.actions.includes(a));
          return (
            <TableRow
              key={p.id}
              onClick={() => onOpen(p)}
              className={cn('cursor-pointer', p.status === 'esperando_aprobacion' && 'bg-yellow-soft/50 hover:bg-yellow-soft')}
            >
              <TableCell className="max-w-[300px] pl-4">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-mono text-[11px] text-faint">{p.identifier}</span>
                  <ExtLink href={p.issue.url} className="truncate font-medium">
                    <span className="truncate">{p.issue.name}</span>
                  </ExtLink>
                </div>
                {p.issue.projectName && (
                  <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                    <ProjectIcon id={p.issue.projectId} size="xs" />
                    <span className="truncate">{p.issue.projectName}</span>
                  </div>
                )}
              </TableCell>
              <TableCell>
                <span className="flex items-center gap-2 whitespace-nowrap">
                  <GithubAvatar login={p.owner.githubLogin} id={p.owner.id} url={p.owner.avatarUrl} name={p.owner.name} className="size-5" />
                  {p.owner.name}
                </span>
                {p.claimable && <Badge variant="warn" className="mt-1 px-2 text-[10.5px]">reclamable</Badge>}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">{where(p)}</TableCell>
              <TableCell className="min-w-[190px]">
                {steps ? (
                  <StepsMini steps={steps} />
                ) : (
                  <Badge variant={p.status === 'jalado' ? 'human' : 'neutral'}>{PLAN_STATUS_LABEL[p.status].toLowerCase()}</Badge>
                )}
                {running && <PlanProgressLine progress={p.progress} running className="mt-1.5 max-w-[220px]" />}
                {p.prUrl && p.status !== 'pr_abierto' && p.status !== 'hecho' && (
                  <ExtLink href={p.prUrl} className="mt-1 text-[11px]"><GitPullRequest className="size-3" />PR #{p.prNumber}</ExtLink>
                )}
                {p.error && (
                  <div className="mt-1 flex max-w-[240px] items-center gap-1 text-[11px] text-red" title={p.error}>
                    <AlertTriangle className="size-3 shrink-0" /><span className="truncate">{p.error}</span>
                  </div>
                )}
              </TableCell>
              <TableCell><RiskBadge risk={p.risk} reasons={p.riskReasons} /></TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">{relative(p.updatedAt)}</TableCell>
              <TableCell className="pr-4" onClick={(e) => e.stopPropagation()}>
                <div className="flex justify-end gap-1.5">
                  {actions.map((a) => (
                    <Button
                      key={a}
                      size="sm"
                      variant={actionVariant(a, p.claimable)}
                      className={cn('h-7 px-2.5', a === 'cancelar' && 'text-muted-foreground hover:text-destructive')}
                      disabled={busy}
                      onClick={() => onAction(p, a)}
                    >
                      {ACTION_COPY[a].label}
                    </Button>
                  ))}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
