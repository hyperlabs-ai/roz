import type { ReactNode } from 'react';
import * as SheetPrimitive from '@radix-ui/react-dialog';
import { CircleCheck, ExternalLink, GitBranch, Pencil, Rocket, Timer, TriangleAlert, Unlink, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { CapsLabel, IntegrationIcon } from '@/components/brand';
import { Columns } from '@/components/charts';
import { ErrorCard } from '@/components/bits';
import { useApi } from '@/lib/useApi';
import { apiGet, type InfraDeployRef, type InfraFailure, type ServiceStatus } from '@/lib/api';
import { compact, relative } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  AuthorAvatar, CopyButton, DEPLOY, LiveDot, MetaRow, PROVIDER, STATUS, UptimeStrip, causeText, deployOutcome, fmtDuration, fmtPct,
  friendlyState, friendlyStatus, lastDeployOf, serviceTitle, stepLabel, type DeployEntry, type ServiceDetailResponse, type ServiceRow,
} from './infra-ui';
import './infra.css';

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Panel lateral de detalle de un servicio. Se abre al hacer clic en una fila (o con `?servicio=id`).
 * Un solo scroll (el del panel); el encabezado queda fijo.
 */
export function ServiceSheet({
  serviceId,
  row,
  onClose,
  onEdit,
  onUnlink,
}: {
  serviceId: string | null;
  /** La fila del espejo, para pintar el encabezado al instante mientras llega el detalle. */
  row: ServiceRow | undefined;
  onClose: () => void;
  onEdit: (s: ServiceRow) => void;
  onUnlink: (s: ServiceRow) => void;
}) {
  return (
    <SheetPrimitive.Root open={!!serviceId} onOpenChange={(v) => !v && onClose()}>
      <SheetPrimitive.Portal>
        <SheetPrimitive.Overlay className="t-overlay fixed inset-0 z-50 bg-scrim/30" />
        <SheetPrimitive.Content
          className="infra-sheet fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-card text-card-foreground shadow-xl focus:outline-none sm:w-[560px] xl:w-[620px]"
          aria-describedby={undefined}
        >
          {serviceId && <SheetBody id={serviceId} row={row} onEdit={onEdit} onUnlink={onUnlink} />}
        </SheetPrimitive.Content>
      </SheetPrimitive.Portal>
    </SheetPrimitive.Root>
  );
}

function SheetBody({
  id,
  row,
  onEdit,
  onUnlink,
}: {
  id: string;
  row: ServiceRow | undefined;
  onEdit: (s: ServiceRow) => void;
  onUnlink: (s: ServiceRow) => void;
}) {
  const { data, loading, error } = useApi<ServiceDetailResponse>(() => apiGet(`/infra/services/${id}`), [id], {
    key: '/infra/services',
    ttl: 60_000,
  });

  const provider = row?.provider ?? data?.service.provider ?? 'vercel';
  const title = row ? serviceTitle(row) : data ? serviceTitle(data.service) : 'Servicio';
  const status: ServiceStatus = row?.status ?? data?.snapshot?.status ?? 'unknown';
  const native = row?.providerStatus ?? data?.snapshot?.providerStatus ?? null;
  const capturedAt = row?.capturedAt ?? data?.snapshot?.capturedAt ?? null;
  const ref = row?.externalRef ?? data?.service.externalRef ?? '';
  // Último intento de deploy: va aparte del estado del servicio, con su propio color.
  const lastDeploy = row ? lastDeployOf(row) : data?.snapshot ? lastDeployOf({ provider, deploy: data.snapshot.deploy as never, details: data.snapshot.details }) : null;
  const deployNote = lastDeploy && (lastDeploy.state === 'failed' || lastDeploy.state === 'building') && status !== 'down' ? lastDeploy : null;

  return (
    <>
      {/* Encabezado fijo */}
      <header className="border-b px-5 pb-4 pt-5">
        <div className="flex items-start gap-3">
          <IntegrationIcon name={PROVIDER[provider].icon} size="md" framed />
          <div className="min-w-0 flex-1">
            <span className="eyebrow">{[data?.service.projectName, PROVIDER[provider].name].filter(Boolean).join(' · ')}</span>
            <SheetPrimitive.Title className="mt-1 truncate text-[20px] font-semibold leading-tight tracking-[-0.03em]">{title}</SheetPrimitive.Title>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
              <span className={cn('inline-flex items-center gap-1.5 font-semibold', STATUS[status].ink)}>
                <LiveDot status={status} />
                {friendlyStatus({ status, providerStatus: native })}
              </span>
              {deployNote && (
                <span className={cn('inline-flex h-5 items-center gap-1.5 rounded-sm px-1.5 text-[11.5px] font-semibold', DEPLOY[deployNote.state].soft, DEPLOY[deployNote.state].ink)}>
                  <span className={cn('size-1.5 rounded-full', DEPLOY[deployNote.state].dot, deployNote.state === 'building' && 'animate-pulse')} />
                  {deployNote.state === 'failed' ? 'Último deploy fallido' : 'Desplegando'}
                </span>
              )}
              <span className="tabular-nums text-faint">{capturedAt ? `sondeo ${relative(capturedAt)}` : 'sin sondear'}</span>
              {ref && (
                <span className="inline-flex min-w-0 items-center gap-0.5 text-faint">
                  <span className="truncate font-mono text-[11.5px]">{ref}</span>
                  <CopyButton value={ref} label="Copiar referencia" />
                </span>
              )}
            </div>
          </div>
          <SheetPrimitive.Close className="grid size-8 shrink-0 place-items-center rounded-md bg-panel text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X className="size-4" />
            <span className="sr-only">Cerrar</span>
          </SheetPrimitive.Close>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {data?.links.map((l) => (
            <Button key={l.url} asChild variant="outline" size="sm">
              <a href={l.url} target="_blank" rel="noreferrer"><ExternalLink /> {l.label}</a>
            </Button>
          ))}
          {row && (
            <span className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => onEdit(row)}><Pencil /> Editar</Button>
              <Button variant="ghost" size="sm" className="text-red hover:bg-red-soft hover:text-red" onClick={() => onUnlink(row)}>
                <Unlink /> Desvincular
              </Button>
            </span>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="p-5"><ErrorCard message={error} /></div>
        ) : loading && !data ? (
          <SheetSkeleton />
        ) : data ? (
          <DetailContent d={data} />
        ) : null}
      </div>
    </>
  );
}

function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('grid gap-3 border-b px-5 py-5 last:border-b-0', className)}>
      <div className="flex items-center justify-between gap-3">
        <CapsLabel>{title}</CapsLabel>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="grid content-start gap-1 px-4 py-3">
      <CapsLabel>{label}</CapsLabel>
      <span className={cn('text-[22px] font-semibold leading-none tracking-[-0.02em] tabular-nums', tone)}>{value}</span>
      {sub && <span className="truncate text-[11.5px] text-faint">{sub}</span>}
    </div>
  );
}

/**
 * Por qué falló, con lo que el proveedor reporta y nada más: paso, código, mensaje y la cola del
 * log. Rojo si el servicio no atiende; amarillo si solo falló un intento y producción sigue arriba.
 */
function FailurePanel({
  failure,
  status,
  attempt,
  serving,
  provider,
}: {
  failure: InfraFailure;
  status: ServiceStatus;
  attempt: InfraDeployRef | null;
  serving: InfraDeployRef | null;
  provider: string;
}) {
  const severe = status === 'down';
  const online = status === 'healthy';
  const cause = causeText(failure);
  const step = stepLabel(failure);
  const title =
    failure.scope === 'platform'
      ? status === 'paused' ? 'Proyecto pausado' : severe ? 'El proyecto no está sano' : 'Subsistemas con problemas'
      : failure.scope === 'runtime'
        ? 'El proceso se cayó al ejecutarse'
        : online ? 'Falló el último deploy · producción sigue en línea' : 'Falló el deploy y no hay otro sirviendo';
  const tone = severe ? 'border-red/25 bg-red-soft' : status === 'paused' ? 'border-border bg-panel' : 'border-yellow/40 bg-yellow-soft';
  const ink = severe ? 'text-red' : status === 'paused' ? 'text-foreground' : 'text-yellow-ink';
  return (
    <div className={cn('grid gap-3 rounded-lg border px-3.5 py-3', tone)}>
      <div className={cn('flex items-start gap-2 text-[13px] font-semibold leading-snug', ink)}>
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{title}</span>
      </div>
      {(step || failure.code) && (
        <div className="flex flex-wrap gap-1.5">
          {step && <span className="inline-flex h-6 items-center gap-1.5 rounded-sm bg-card px-2 text-[12px]"><span className="label-caps">Paso</span><span className="font-semibold">{step}</span></span>}
          {failure.code && <span className="inline-flex h-6 items-center gap-1.5 rounded-sm bg-card px-2 text-[12px]"><span className="label-caps">Código</span><span className="font-mono text-[11.5px]">{failure.code}</span></span>}
        </div>
      )}
      {cause && <p className="break-words text-[13px] leading-relaxed text-foreground">{failure.message ?? cause}</p>}
      {attempt && failure.scope !== 'platform' && (
        <div className="grid gap-1 rounded-md bg-card px-3 py-2 text-[12px]">
          <div className="flex min-w-0 items-center gap-2">
            <span className="label-caps w-24 shrink-0">{failure.scope === 'runtime' ? 'Deploy caído' : 'Intento'}</span>
            <AuthorAvatar author={attempt.author} className="size-4" />
            <span className="min-w-0 flex-1 truncate">{attempt.message ?? 'Sin mensaje de commit'}</span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 pl-[104px] text-[11.5px] text-muted-foreground">
            {attempt.author && <span>{attempt.author}</span>}
            {attempt.sha && <span className="font-mono">{attempt.sha.slice(0, 7)}</span>}
            {attempt.branch && <span className="inline-flex items-center gap-1"><GitBranch className="size-3" /><span className="font-mono">{attempt.branch}</span></span>}
            {attempt.createdAt && <span className="tabular-nums">{relative(attempt.createdAt)}</span>}
            {fmtDuration(attempt.durationMs) && <span className="inline-flex items-center gap-1 tabular-nums"><Timer className="size-3" />duró {fmtDuration(attempt.durationMs)}</span>}
          </div>
          {online && serving && (
            <div className="mt-1 flex min-w-0 items-center gap-2 border-t pt-2">
              <span className="label-caps w-24 shrink-0 text-green">Sirviendo</span>
              <Rocket className="size-3.5 shrink-0 text-green" />
              <span className="min-w-0 flex-1 truncate">{serving.message ?? 'Deploy anterior'}</span>
              {serving.sha && <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">{serving.sha.slice(0, 7)}</span>}
              {serving.createdAt && <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">{relative(serving.createdAt)}</span>}
            </div>
          )}
        </div>
      )}
      {failure.logTail.length > 0 && (
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between">
            <span className="label-caps">Últimas líneas del log</span>
            <CopyButton value={failure.logTail.join('\n')} label="Copiar log" />
          </div>
          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-card px-3 py-2 font-mono text-[11.5px] leading-relaxed text-foreground">{failure.logTail.join('\n')}</pre>
        </div>
      )}
      {(attempt?.inspectorUrl || failure.helpUrl) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] font-medium">
          {attempt?.inspectorUrl && (
            <a href={attempt.inspectorUrl} target="_blank" rel="noreferrer" className={cn('inline-flex items-center gap-1 hover:underline', ink)}>
              <ExternalLink className="size-3" /> Ver el deploy en {provider}
            </a>
          )}
          {failure.helpUrl && (
            <a href={failure.helpUrl} target="_blank" rel="noreferrer" className={cn('inline-flex items-center gap-1 hover:underline', ink)}>
              <ExternalLink className="size-3" /> Cómo resolverlo
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function DetailContent({ d }: { d: ServiceDetailResponse }) {
  const snap = d.snapshot;
  const det = snap?.details ?? null;
  const isDb = d.service.provider === 'supabase';
  const last = d.deploys[0];
  const failure = det?.failure ?? null;
  const status: ServiceStatus = snap?.status ?? 'unknown';
  // El intento al que se refiere la causa: el deploy con ese id, o el último.
  const attempt: InfraDeployRef | null = isDb
    ? null
    : (failure?.deployId && det?.serving?.id === failure.deployId ? det.serving : null) ??
      det?.lastDeploy ??
      null;
  const serving = det?.serving ?? null;
  const stats = d.deployStats;
  // Duración de build de los intentos recientes, en orden cronológico (los que la reportan).
  const buildTimes = [...d.deploys]
    .filter((x) => x.durationMs && x.outcome !== 'canceled')
    .slice(0, 10)
    .reverse()
    .map((x) => ({
      label: x.sha ? x.sha.slice(0, 5) : '·',
      value: Math.round(x.durationMs! / 1000),
      sub: x.outcome === 'failed' ? 'falló' : undefined,
    }));
  const openIncident = d.incidents.find((i) => !i.end);
  const m = snap?.metrics ?? null;
  const cfg = d.service.config ?? {};

  return (
    <>
      {/* Tres cifras clave (cantidad fija: siempre 3) */}
      <div className="px-5 pt-5">
        <div className="grid grid-cols-3 divide-x rounded-lg border">
          <Stat
            label={`Disponib. ${d.uptime.days} d`}
            value={fmtPct(d.uptime.uptimePct)}
            tone={d.uptime.uptimePct != null && d.uptime.uptimePct < 99 ? 'text-orange-ink' : undefined}
            sub={`${d.uptime.samples} sondeos`}
          />
          <Stat
            label="Incidentes"
            value={d.incidents.length}
            tone={openIncident ? 'text-red' : undefined}
            sub={openIncident ? 'uno en curso' : d.incidents[0] ? `último ${relative(d.incidents[0].start)}` : 'ninguno'}
          />
          {isDb ? (
            <Stat label="Peticiones 24 h" value={typeof m?.requests === 'number' ? compact(m.requests) : '—'} sub={det?.region ?? undefined} />
          ) : (
            <Stat
              label="Último deploy"
              value={last?.createdAt ? relative(last.createdAt).replace('hace ', '') : '—'}
              tone={last?.outcome === 'failed' ? 'text-yellow-ink' : undefined}
              sub={last ? [DEPLOY[last.outcome ?? deployOutcome(last.state)].label, fmtDuration(last.durationMs)].filter(Boolean).join(' · ') : 'sin deploys'}
            />
          )}
        </div>
      </div>

      {/* Dos cosas distintas, lado a lado: qué atiende producción y cómo salió el último intento. */}
      {!isDb && (serving || det?.lastDeploy) && (
        <div className="grid gap-2 px-5 pt-3 sm:grid-cols-2">
          <DeployCard
            kind="serving"
            dep={serving}
            empty={status === 'down' ? 'Ningún deploy está atendiendo' : 'Sin dato del deploy que sirve'}
          />
          <DeployCard kind="attempt" dep={det?.lastDeploy ?? null} same={!!serving && !!det?.lastDeploy && serving.id === det.lastDeploy.id && !!serving.id} empty="Sin intentos recientes" />
        </div>
      )}

      {failure && (
        <div className="px-5 pt-3">
          <FailurePanel failure={failure} status={status} attempt={attempt} serving={serving} provider={PROVIDER[d.service.provider].name} />
        </div>
      )}

      <Section
        title={`Disponibilidad · ${d.uptime.days} días`}
        aside={<span className="text-[11px] tabular-nums text-faint">bloques de {Math.round(d.uptime.bucketMs / 3_600_000)} h</span>}
      >
        <UptimeStrip segments={d.uptime.segments} count={d.uptime.segments.length} bucketMs={d.uptime.bucketMs} height={34} />
        <div className="flex justify-between text-[10.5px] text-faint">
          <span>hace {d.uptime.days} d</span>
          <span>ahora</span>
        </div>
        {d.incidents.length ? (
          <ul className="grid gap-1">
            {d.incidents.map((inc) => (
              <li key={inc.start} className="flex items-center gap-2.5 rounded-md bg-sidebar px-3 py-2 text-[12.5px]">
                <span className={cn('size-2 shrink-0 rounded-[2px]', STATUS[inc.status].dot)} />
                <span className="font-semibold">{STATUS[inc.status].label}</span>
                <span className="tabular-nums text-muted-foreground">{fmtWhen(inc.start)}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">{fmtDuration(inc.durationMs) ?? '< 15 min'}</span>
                {!inc.end && <Badge variant="bad" dot>en curso</Badge>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="inline-flex items-center gap-1.5 text-[12.5px] text-green">
            <CircleCheck className="size-3.5" /> Sin incidentes en {d.uptime.days} días
          </p>
        )}
      </Section>

      {d.lastError && !failure && (
        <Section title="Último error registrado" aside={<span className="text-[11px] tabular-nums text-faint">{relative(d.lastError.at)}</span>}>
          <div className="grid gap-1.5 rounded-md border border-red/25 bg-red-soft px-3 py-2.5 text-red">
            <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold">
              <TriangleAlert className="size-3.5" />
              {friendlyState(d.lastError.providerStatus) ?? STATUS[(d.lastError.status as ServiceStatus) in STATUS ? (d.lastError.status as ServiceStatus) : 'down'].label}
              <span className="font-normal opacity-80">· {fmtWhen(d.lastError.at)}</span>
            </span>
            {d.lastError.message && (
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed">{d.lastError.message}</pre>
            )}
          </div>
        </Section>
      )}

      {isDb ? (
        <SupabaseSections d={d} />
      ) : (
        <Section
          title="Deploys de producción"
          aside={
            <span className="text-[11px] tabular-nums text-faint">
              {d.deploysSource === 'snapshot'
                ? 'del último sondeo'
                : [
                    `${d.deploys.length} recientes`,
                    stats.successPct != null ? `${stats.successPct}% exitosos` : null,
                    stats.failed ? `${stats.failed} ${stats.failed === 1 ? 'fallido' : 'fallidos'}` : null,
                    stats.avgDurationMs ? `build ~${fmtDuration(stats.avgDurationMs)}` : null,
                  ].filter(Boolean).join(' · ')}
            </span>
          }
        >
          {buildTimes.length >= 3 && (
            <div className="grid gap-1.5 rounded-lg border px-3 pb-2 pt-3">
              <span className="label-caps">Duración de build · segundos</span>
              <Columns data={buildTimes} height={110} sort={false} hideZeros={false} />
            </div>
          )}
          {d.deploys.length ? (
            <ol className="-mx-2 grid">
              {d.deploys.map((dep, i) => <DeployItem key={dep.id ?? `${dep.createdAt}-${i}`} dep={dep} />)}
            </ol>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">El proveedor no reporta deploys de producción.</p>
          )}
        </Section>
      )}

      <Section title="Metadatos">
        <div className="grid divide-y">
          <MetaRow label="ID" mono copy={d.service.externalRef}>{d.service.externalRef}</MetaRow>
          {typeof cfg.teamId === 'string' && cfg.teamId && <MetaRow label="Team" mono copy={cfg.teamId}>{cfg.teamId}</MetaRow>}
          {typeof cfg.environmentId === 'string' && cfg.environmentId && <MetaRow label="Entorno" mono copy={cfg.environmentId}>{cfg.environmentId}</MetaRow>}
          {det?.region && <MetaRow label="Región">{det.region}</MetaRow>}
          {det?.framework && <MetaRow label="Framework">{det.framework}</MetaRow>}
          {det?.runtime && <MetaRow label="Runtime">{det.runtime}</MetaRow>}
          {typeof det?.replicas === 'number' && <MetaRow label="Réplicas">{det.replicas}</MetaRow>}
          {det?.plan && <MetaRow label="Plan">{det.plan}</MetaRow>}
          {det?.dbVersion && <MetaRow label="Postgres" mono copy={det.dbVersion}>{det.dbVersion}</MetaRow>}
          {det?.productionUrl && (
            <MetaRow label="URL" copy={det.productionUrl}>
              <a href={det.productionUrl} target="_blank" rel="noreferrer" className="hover:underline">{det.productionUrl.replace(/^https?:\/\//, '')}</a>
            </MetaRow>
          )}
          {snap?.capturedAt && <MetaRow label="Último sondeo">{fmtWhen(snap.capturedAt)}</MetaRow>}
        </div>
      </Section>
    </>
  );
}

/** Tarjeta de un deploy concreto: el que sirve producción, o el último intento. */
function DeployCard({ kind, dep, empty, same }: { kind: 'serving' | 'attempt'; dep: InfraDeployRef | null; empty: string; same?: boolean }) {
  const tone = dep ? DEPLOY[dep.state] : DEPLOY.unknown;
  const serving = kind === 'serving';
  return (
    <div className="grid content-start gap-1.5 rounded-lg border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="label-caps">{serving ? 'Sirviendo producción' : 'Último intento'}</span>
        {dep && (
          <span className={cn('inline-flex h-5 items-center gap-1.5 rounded-sm px-1.5 text-[11px] font-semibold', serving ? 'bg-green-soft text-green' : cn(tone.soft, tone.ink))}>
            <span className={cn('size-1.5 rounded-full', serving ? 'bg-green' : tone.dot, !serving && dep.state === 'building' && 'animate-pulse')} />
            {serving ? 'En línea' : tone.label}
          </span>
        )}
      </div>
      {dep ? (
        <>
          <div className="flex min-w-0 items-center gap-2">
            <AuthorAvatar author={dep.author} className="size-5" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={dep.message ?? undefined}>
              {same ? 'El mismo deploy que sirve' : dep.message ?? 'Sin mensaje de commit'}
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11.5px] text-faint">
            {dep.author && <span className="truncate text-muted-foreground">{dep.author}</span>}
            {dep.sha && <span className="font-mono">{dep.sha.slice(0, 7)}</span>}
            {dep.createdAt && <span className="tabular-nums">{relative(dep.createdAt)}</span>}
            {fmtDuration(dep.durationMs) && <span className="inline-flex items-center gap-1 tabular-nums"><Timer className="size-3" />{fmtDuration(dep.durationMs)}</span>}
          </div>
        </>
      ) : (
        <span className="text-[12.5px] text-muted-foreground">{empty}</span>
      )}
    </div>
  );
}

function DeployItem({ dep }: { dep: DeployEntry }) {
  const outcome = dep.outcome ?? deployOutcome(dep.state);
  const st = DEPLOY[outcome];
  const href = dep.inspectorUrl ?? dep.url;
  const duration = fmtDuration(dep.durationMs);
  const body = (
    <>
      {/* Riel con punto: la lista se lee como línea de tiempo. */}
      <span className="relative flex w-3 shrink-0 justify-center">
        <span className="absolute bottom-[-8px] top-[18px] w-px bg-border group-last:hidden" />
        <span className={cn('relative mt-[5px] size-2.5 rounded-full', st.dot, dep.serving && 'ring-2 ring-green/30')} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium">{dep.message ?? <span className="text-faint">Sin mensaje de commit</span>}</span>
          {dep.serving && <Badge variant="ok" dot className="shrink-0">sirviendo</Badge>}
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11.5px] text-faint">
          <span className={cn('font-semibold', st.ink)}>{dep.serving ? 'En línea' : st.label}</span>
          {dep.sha && <span className="font-mono">{dep.sha.slice(0, 7)}</span>}
          {dep.branch && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate font-mono">{dep.branch}</span>
            </span>
          )}
          {dep.author && (
            <span className="inline-flex items-center gap-1">
              <AuthorAvatar author={dep.author} className="size-4" />
              {dep.author}
            </span>
          )}
        </div>
        {outcome === 'failed' && dep.errorMessage && (
          <p className="mt-1 line-clamp-2 break-words text-[11.5px] leading-snug text-yellow-ink">{dep.errorMessage}</p>
        )}
      </div>
      <div className="grid shrink-0 justify-items-end gap-0.5 text-[11.5px] tabular-nums text-muted-foreground">
        <span>{dep.createdAt ? relative(dep.createdAt) : '—'}</span>
        {duration && (
          <span className="inline-flex items-center gap-1 text-faint">
            <Timer className="size-3" />
            {duration}
          </span>
        )}
      </div>
    </>
  );
  return (
    <li className="group">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="flex gap-3 rounded-md px-2 py-2 transition-colors hover:bg-sidebar">
          {body}
        </a>
      ) : (
        <div className="flex gap-3 px-2 py-2">{body}</div>
      )}
    </li>
  );
}

function SupabaseSections({ d }: { d: ServiceDetailResponse }) {
  const det = d.snapshot?.details ?? null;
  const m = d.snapshot?.metrics ?? null;
  const subs = det?.subsystems ?? [];
  const byType = [
    { label: 'REST', value: m?.rest ?? 0 },
    { label: 'Auth', value: m?.auth ?? 0 },
    { label: 'Realtime', value: m?.realtime ?? 0 },
    { label: 'Storage', value: m?.storage ?? 0 },
  ];
  const hasReq = byType.some((x) => x.value > 0);
  return (
    <>
      <Section title="Subsistemas" aside={<span className="text-[11px] tabular-nums text-faint">{subs.filter((s) => s.healthy).length} de {subs.length} operativos</span>}>
        {subs.length ? (
          <div className="flex flex-wrap gap-1.5">
            {subs.map((sub) => (
              <span
                key={sub.name}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-[12.5px] font-medium',
                  sub.healthy ? 'bg-green-soft text-green' : 'bg-red-soft text-red',
                )}
              >
                <span className={cn('size-1.5 rounded-full', sub.healthy ? 'bg-green' : 'bg-red')} />
                {sub.name}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">Supabase no reportó subsistemas en el último sondeo.</p>
        )}
      </Section>
      <Section title="Peticiones · 24 h" aside={typeof m?.requests === 'number' ? <span className="text-[11px] tabular-nums text-faint">{compact(m.requests)} en total</span> : undefined}>
        {hasReq ? (
          <Columns data={byType} height={150} sort={false} hideZeros={false} />
        ) : (
          <p className="text-[12.5px] text-muted-foreground">Sin peticiones registradas en las últimas 24 h.</p>
        )}
      </Section>
    </>
  );
}

function SheetSkeleton() {
  return (
    <div className="grid gap-5 p-5">
      <Skeleton className="h-[74px] w-full rounded-lg" />
      <div className="grid gap-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-[34px] w-full" />
      </div>
      <div className="grid gap-3">
        <Skeleton className="h-3 w-36" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-2.5 rounded-full" />
            <Skeleton className="h-3.5 flex-1" />
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}
