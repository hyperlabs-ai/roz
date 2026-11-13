// Planes del agente (roz v2), compuesto como la "Flota" del mock: los equipos (roz-runner) de cada
// dev con su ocupación, los planes que esperan a una persona y la tabla de trabajos. Cada issue
// asignado en Linear genera un plan en la cola de su dueño; el roz-runner de su PC lo toma, escribe
// PLAN.md y, según el riesgo, lo implementa hasta la PR (0), espera aprobación (1) o se queda en plan (2).
//
// Aquí una persona aprueba, pide cambios, reclama (lo pasa a su cola y a su nombre en Linear), jala
// (lo implementa ella; el agente no corre), suelta o cancela. Las acciones que se ofrecen son las que
// el backend dice que ESTA persona puede hacer (`plan.actions`); toda acción se confirma en un modal.
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bot, User, Users, Hand, Inbox, Plus } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { EmptyState, ErrorCard, RefreshButton, Revalidating } from '@/components/bits';
import { Eyebrow } from '@/components/brand';
import { Segmented, V2OffState, isSotOff, useRozV2 } from '@/components/pulse/roz-v2';
import { PlanCard } from '@/components/plans/PlanCard';
import { PlanDetailDialog } from '@/components/plans/PlanDetailDialog';
import { ACTION_COPY, PlanActionDialog, PullResultDialog } from '@/components/plans/PlanActionDialog';
import { FleetCards, BlockHead } from '@/components/plans/FleetCards';
import { JobsTable } from '@/components/plans/JobsTable';
import { ProposedPlanCard } from '@/components/plans/ProposedPlanCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/useApi';
import { useAction } from '@/lib/useAction';
import { usePoll } from '@/lib/usePoll';
import { invalidate } from '@/lib/store';
import {
  PLAN_RUNNING, PLAN_STATUSES, PLAN_STATUS_LABEL, PLAN_TERMINAL, rozV2Api,
  type AgentPlanSummary, type PlanDevRef, type PlanHumanAction, type PlanScope, type PlanStatus, type PlansResponse,
  type RunnerPullResponse, type RunnersResponse,
} from '@/lib/api';
import { cn } from '@/lib/utils';

const SCOPES: PlanScope[] = ['mine', 'team', 'claimable'];
const LIVE = '__vivos__';
const ALL = '__todos__';

/** Orden de lectura: lo que espera a una persona arriba, luego lo que corre, luego la cola. */
const STATUS_ORDER: Record<PlanStatus, number> = {
  esperando_aprobacion: 0,
  planeando: 1,
  implementando: 1,
  pr_abierto: 2,
  en_cola: 3,
  jalado: 4,
  hecho: 5,
  cancelado: 6,
};

export default function Plans() {
  const v2 = useRozV2();
  const [params, setParams] = useSearchParams();
  const scopeParam = params.get('scope') as PlanScope | null;
  const scope: PlanScope = scopeParam && SCOPES.includes(scopeParam) ? scopeParam : 'mine';
  const status = params.get('status') ?? LIVE;
  const openId = params.get('plan');
  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v === null) p.delete(k);
    else p.set(k, v);
    setParams(p, { replace: true });
  };

  const { data, loading, refetching, error, reload } = useApi<PlansResponse>(() => rozV2Api.plans(scope), [scope], {
    key: '/plans',
    ttl: 15_000,
  });
  // La flota completa (todos los runners), solo para leer: ocupación por equipo.
  const fleet = useApi<RunnersResponse>(() => rozV2Api.runners(true), [true], { key: '/runners', ttl: 30_000 });
  const running = (data?.plans ?? []).some((p) => PLAN_RUNNING.includes(p.status));
  // Con planes corriendo el avance se mueve: se sondea más seguido.
  usePoll(() => { reload(); fleet.reload(); }, data ? (running ? 15_000 : 60_000) : null);

  const act = useAction();
  const [pending, setPending] = useState<{ plan: AgentPlanSummary; action: PlanHumanAction } | null>(null);
  const [pulled, setPulled] = useState<RunnerPullResponse | null>(null);

  const visible = useMemo(() => {
    const list = (data?.plans ?? []).filter((p) =>
      status === ALL ? true : status === LIVE ? !PLAN_TERMINAL.includes(p.status) || p.status === 'jalado' : p.status === status,
    );
    return list.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.enqueuedAt.localeCompare(b.enqueuedAt));
  }, [data, status]);

  // Planes que esperan a ESTA persona: se destacan arriba con sus pasos.
  const proposals = useMemo(
    () => (data?.plans ?? []).filter((p) => p.status === 'esperando_aprobacion' && p.actions.includes('aprobar')).slice(0, 2),
    [data],
  );

  // Foto de GitHub por dev, sacada de los dueños de planes (los runners solo traen el nombre).
  const people = useMemo(() => {
    const m = new Map<string, PlanDevRef>();
    for (const p of data?.plans ?? []) {
      m.set(p.owner.id, p.owner);
      if (p.pulledBy) m.set(p.pulledBy.id, p.pulledBy);
    }
    return m;
  }, [data]);
  const runners = useMemo(
    () => (fleet.data?.runners ?? [])
      .filter((r) => !r.revokedAt)
      .sort((a, b) => Number(b.online) - Number(a.online) || b.running - a.running || a.devName.localeCompare(b.devName, 'es')),
    [fleet.data],
  );
  const onlineCount = runners.filter((r) => r.online).length;

  async function confirm(text: string | null) {
    if (!pending) return;
    const { plan, action } = pending;
    const key = `${action}:${plan.id}`;
    const run = (): Promise<unknown> => {
      switch (action) {
        case 'aprobar': return rozV2Api.approvePlan(plan.id);
        case 'pedir_cambios': return rozV2Api.requestPlanChanges(plan.id, text ?? '');
        case 'reclamar': return rozV2Api.claimPlan(plan.id, text);
        case 'jalar': return rozV2Api.pullPlan(plan.id);
        case 'soltar': return rozV2Api.releasePlan(plan.id);
        case 'cancelar': return rozV2Api.cancelPlan(plan.id, text);
      }
    };
    await act.run(key, run, {
      success: action === 'jalar' ? false : `${ACTION_COPY[action].label}: ${plan.identifier}`,
      error: `No se pudo ${ACTION_COPY[action].label.toLowerCase()}`,
      onDone: (r) => {
        if (action === 'jalar') setPulled((r as { pull: RunnerPullResponse }).pull);
        setPending(null);
      },
      // Pase lo que pase (incluido un 409 PLAN_TAKEN: otra persona ganó), la lista se refresca.
      onSettled: () => invalidate('/plans'),
    });
  }

  const off = (!v2.linearSourceOfTruth && v2.ready) || isSotOff(error);
  const counts = data?.counts;
  const statusOptions = [
    { value: LIVE, label: 'Vivos' },
    ...PLAN_STATUSES.filter((s) => (counts?.[s] ?? 0) > 0).map((s) => ({ value: s, label: PLAN_STATUS_LABEL[s], count: counts?.[s] ?? 0 })),
    { value: ALL, label: 'Todos' },
  ];

  return (
    <Layout
      title="Planes"
      eyebrow="Agentes · flota"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {fleet.data && runners.length > 0 && (
            <Badge variant={onlineCount ? 'ok' : 'neutral'} dot>
              {onlineCount} runner{onlineCount === 1 ? '' : 's'} en línea
            </Badge>
          )}
          <RefreshButton busy={refetching || fleet.refetching} onClick={() => { reload(); fleet.reload(); }} />
          <Button asChild variant="secondary"><Link to="/configuracion"><Plus /> Registrar runner</Link></Button>
        </div>
      }
    >
      {off ? (
        <V2OffState what="Los planes del agente" />
      ) : (
        <div className="grid gap-6">
          {error && <ErrorCard message={error} />}

          {/* Equipos */}
          <section className="grid gap-3">
            <BlockHead title="Equipos" meta={runners.length ? `${runners.length} runner${runners.length === 1 ? '' : 's'}` : undefined} />
            <FleetCards
              runners={runners}
              loading={fleet.loading}
              failed={!!fleet.error && !fleet.data}
              people={people}
              counts={counts ?? null}
            />
          </section>

          {/* Planes que esperan a una persona */}
          {proposals.length > 0 && (
            <section className="grid gap-3">
              <Eyebrow color="yellow">Esperan tu aprobación</Eyebrow>
              {proposals.map((p) => (
                <ProposedPlanCard
                  key={p.id}
                  plan={p}
                  onOpen={() => setParam('plan', p.id)}
                  onAction={(a) => setPending({ plan: p, action: a })}
                />
              ))}
            </section>
          )}

          {/* Trabajos */}
          <Card className="overflow-hidden">
            <div className="grid gap-3 border-b p-4">
              <BlockHead title="Trabajos">
                <Segmented
                  value={scope}
                  onChange={(v) => setParam('scope', v === 'mine' ? null : v)}
                  options={[
                    { value: 'mine', label: 'Mi cola', icon: <User className="size-3.5" /> },
                    { value: 'team', label: 'Equipo', icon: <Users className="size-3.5" /> },
                    { value: 'claimable', label: 'Reclamables', icon: <Hand className="size-3.5" /> },
                  ]}
                />
              </BlockHead>
              <div className="flex flex-wrap gap-1.5">
                {statusOptions.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setParam('status', o.value === LIVE ? null : o.value)}
                    aria-pressed={status === o.value}
                    className={cn(
                      'flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors duration-fast',
                      status === o.value ? 'bg-orange-soft text-orange-ink' : 'bg-panel text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {o.label}
                    {'count' in o && <span className="text-[10.5px] tabular-nums opacity-70">{o.count}</span>}
                  </button>
                ))}
              </div>
            </div>

            {loading || !data ? (
              <div className="grid gap-2 p-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 flex-1" />
                    <Skeleton className="h-5 w-5 rounded-full" />
                    <Skeleton className="h-4 w-40" />
                  </div>
                ))}
              </div>
            ) : !visible.length ? (
              <EmptyState icon={scope === 'claimable' ? <Hand /> : scope === 'mine' ? <Inbox /> : <Bot />}>
                {scope === 'claimable'
                  ? 'Nada que reclamar: todas las colas tienen a su dueño en línea.'
                  : scope === 'mine'
                    ? 'Tu cola está vacía. Cuando te asignen un issue en Linear, su plan aparecerá aquí.'
                    : 'Ningún plan con este filtro.'}
              </EmptyState>
            ) : (
              <Revalidating active={refetching}>
                <div className="hidden md:block">
                  <JobsTable
                    plans={visible}
                    busy={act.anyBusy}
                    onOpen={(p) => setParam('plan', p.id)}
                    onAction={(p, a) => setPending({ plan: p, action: a })}
                  />
                </div>
                <div className="grid gap-2.5 bg-sidebar p-3 md:hidden">
                  {visible.map((p) => (
                    <PlanCard
                      key={p.id}
                      plan={p}
                      busy={act.anyBusy}
                      onOpen={() => setParam('plan', p.id)}
                      onAction={(a) => setPending({ plan: p, action: a })}
                    />
                  ))}
                </div>
              </Revalidating>
            )}
          </Card>
        </div>
      )}

      {openId && !off && (
        <PlanDetailDialog
          planId={openId}
          onClose={() => setParam('plan', null)}
          onAction={(plan, a) => setPending({ plan, action: a })}
        />
      )}
      <PlanActionDialog
        plan={pending?.plan ?? null}
        action={pending?.action ?? null}
        busy={pending ? act.busy(`${pending.action}:${pending.plan.id}`) : false}
        onCancel={() => setPending(null)}
        onConfirm={(text) => void confirm(text)}
      />
      <PullResultDialog pull={pulled} onClose={() => setPulled(null)} />
    </Layout>
  );
}
