import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { CapsLabel, IntegrationIcon } from '@/components/brand';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ServiceProvider, ServiceStatus } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  DEPLOY, LiveDot, PROVIDER, PROVIDER_ORDER, SEVERITY, STATUS, UptimeStrip, aggregate, fmtPct, hasFailedDeploy, lastDeployOf,
  matchesStatus, serviceTitle, type ServiceRow, type StatusFilter, type StripsResponse, type UptimeSegment,
} from './infra-ui';

export type { StatusFilter };
export type ProviderFilter = 'all' | ServiceProvider;

/** Combina las franjas de todos los servicios: peor estado por bloque y sondeos sanos sumados. */
function combineStrips(strips: StripsResponse | null | undefined, ids: string[]) {
  if (!strips) return { segments: null as UptimeSegment[] | null, pct: null as number | null };
  const lists = ids.map((id) => strips.services[id]?.segments).filter((x): x is UptimeSegment[] => !!x?.length);
  if (!lists.length) return { segments: null, pct: null };
  let up = 0;
  let total = 0;
  const segments = lists[0]!.map((first, i) => {
    const col = lists.map((l) => l[i]).filter((x): x is UptimeSegment => !!x);
    const segUp = col.reduce((a, s) => a + s.up, 0);
    const segTotal = col.reduce((a, s) => a + s.total, 0);
    up += segUp;
    total += segTotal;
    return { start: first.start, status: aggregate(col.map((s) => s.status)), up: segUp, total: segTotal };
  });
  return { segments, pct: total ? Math.round((up / total) * 1000) / 10 : null };
}

function headline(counts: Partial<Record<ServiceStatus, number>>, total: number): { status: ServiceStatus; text: string } {
  const parts: string[] = [];
  if (counts.down) parts.push(`${counts.down} ${counts.down === 1 ? 'caído' : 'caídos'}`);
  if (counts.degraded) parts.push(`${counts.degraded} ${counts.degraded === 1 ? 'degradado' : 'degradados'}`);
  if (parts.length) return { status: counts.down ? 'down' : 'degraded', text: parts.join(' · ') };
  if (counts.healthy === total) return { status: 'healthy', text: 'Todo en línea' };
  if (counts.healthy) return { status: 'healthy', text: `${counts.healthy} de ${total} en línea` };
  return { status: 'unknown', text: 'Sin datos todavía' };
}

/**
 * Banda de resumen: una tarjeta, tres zonas separadas por hairline (no tres tarjetas sueltas).
 * 1. Salud global: disponibilidad 24 h + franja combinada.
 * 2. Servicios por estado: un cuadrito por servicio (clic = detalle) + leyenda que filtra.
 * 3. Proveedores: ícono oficial, cuántos operativos, peor estado (clic = filtra).
 */
export function InfraSummary({
  services,
  projects,
  strips,
  status,
  provider,
  onStatus,
  onProvider,
  onOpen,
}: {
  services: ServiceRow[];
  projects: number;
  strips: StripsResponse | null | undefined;
  status: StatusFilter;
  provider: ProviderFilter;
  onStatus: (s: StatusFilter) => void;
  onProvider: (p: ProviderFilter) => void;
  onOpen: (id: string) => void;
}) {
  const counts = useMemo(
    () => services.reduce((a, s) => ((a[s.status] = (a[s.status] ?? 0) + 1), a), {} as Partial<Record<ServiceStatus, number>>),
    [services],
  );
  const global = useMemo(() => combineStrips(strips, services.map((s) => s.id)), [strips, services]);
  const head = headline(counts, services.length);
  const tiles = useMemo(
    () => [...services].sort((a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status) || serviceTitle(a).localeCompare(serviceTitle(b))),
    [services],
  );
  const providers = PROVIDER_ORDER.filter((pr) => services.some((s) => s.provider === pr));
  const failedDeploys = useMemo(() => services.filter(hasFailedDeploy), [services]);
  const building = useMemo(() => services.filter((s) => lastDeployOf(s)?.state === 'building').length, [services]);

  return (
    <Card className="grid overflow-hidden lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.3fr)_minmax(0,1fr)] max-lg:divide-y lg:divide-x">
      {/* 1 · Salud global */}
      <section className="flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <CapsLabel>Disponibilidad · 24 h</CapsLabel>
          <span className="text-[11px] tabular-nums text-faint">
            {services.length} {services.length === 1 ? 'servicio' : 'servicios'} · {projects} {projects === 1 ? 'proyecto' : 'proyectos'}
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
          <span className="text-[34px] font-semibold leading-none tracking-[-0.03em] tabular-nums">{fmtPct(global.pct)}</span>
          <span className={cn('mb-1 inline-flex items-center gap-1.5 text-sm font-semibold', STATUS[head.status].ink)}>
            <LiveDot status={head.status} />
            {head.text}
          </span>
        </div>
        {(failedDeploys.length > 0 || building > 0) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            {failedDeploys.length > 0 && (
              <span className={cn('inline-flex items-center gap-1.5 font-semibold', DEPLOY.failed.ink)}>
                <span className={cn('size-2 rounded-[2px]', DEPLOY.failed.dot)} />
                {failedDeploys.length} {failedDeploys.length === 1 ? 'deploy fallido' : 'deploys fallidos'}
                <span className="font-normal text-muted-foreground">· producción sigue en línea</span>
              </span>
            )}
            {building > 0 && (
              <span className={cn('inline-flex items-center gap-1.5', DEPLOY.building.ink)}>
                <span className={cn('size-2 animate-pulse rounded-[2px]', DEPLOY.building.dot)} />
                {building} desplegando
              </span>
            )}
          </div>
        )}
        <div className="mt-auto grid gap-1.5">
          <UptimeStrip segments={global.segments} count={strips?.segments ?? 24} height={22} />
          <div className="flex justify-between text-[10.5px] text-faint">
            <span>hace 24 h</span>
            <span>ahora</span>
          </div>
        </div>
      </section>

      {/* 2 · Servicios por estado */}
      <section className="flex flex-col gap-3 p-5">
        <CapsLabel>Servicios por estado</CapsLabel>
        <div className="flex flex-wrap gap-1">
          {tiles.map((s) => (
            <Tooltip key={s.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onOpen(s.id)}
                  aria-label={`${serviceTitle(s)}: ${STATUS[s.status].label}`}
                  className={cn(
                    'relative size-[18px] rounded-[4px] transition-transform duration-fast ease-spring hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    STATUS[s.status].dot,
                    !matchesStatus(s, status) && 'opacity-30',
                    provider !== 'all' && provider !== s.provider && 'opacity-30',
                  )}
                >
                  {/* Esquina amarilla: en línea, pero su último deploy falló. */}
                  {hasFailedDeploy(s) && <span className={cn('absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card', DEPLOY.failed.dot)} />}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <span className="font-semibold">{serviceTitle(s)}</span> · {PROVIDER[s.provider].name} · {STATUS[s.status].label}
                {hasFailedDeploy(s) && ' · último deploy fallido'}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        <div className="mt-auto flex flex-wrap gap-1">
          {SEVERITY.filter((st) => counts[st]).map((st) => {
            const on = status === st;
            return (
              <button
                key={st}
                type="button"
                aria-pressed={on}
                onClick={() => onStatus(on ? 'all' : st)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-[12.5px] transition-colors',
                  on ? cn(STATUS[st].soft, STATUS[st].ink, 'font-semibold') : 'text-muted-foreground hover:bg-panel hover:text-foreground',
                )}
              >
                <span className={cn('size-2 rounded-[2px]', STATUS[st].dot)} />
                <span className="font-semibold tabular-nums text-foreground">{counts[st]}</span>
                {STATUS[st].label.toLowerCase()}
              </button>
            );
          })}
          {failedDeploys.length > 0 && (
            <button
              type="button"
              aria-pressed={status === 'deploy_failed'}
              onClick={() => onStatus(status === 'deploy_failed' ? 'all' : 'deploy_failed')}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-[12.5px] transition-colors',
                status === 'deploy_failed' ? cn(DEPLOY.failed.soft, DEPLOY.failed.ink, 'font-semibold') : 'text-muted-foreground hover:bg-panel hover:text-foreground',
              )}
            >
              <span className={cn('size-2 rounded-full', DEPLOY.failed.dot)} />
              <span className="font-semibold tabular-nums text-foreground">{failedDeploys.length}</span>
              con deploy fallido
            </button>
          )}
        </div>
      </section>

      {/* 3 · Proveedores */}
      <section className="flex flex-col gap-2 p-5">
        <CapsLabel className="mb-1">Proveedores</CapsLabel>
        {providers.map((pr) => {
          const list = services.filter((s) => s.provider === pr);
          const ok = list.filter((s) => s.status === 'healthy').length;
          const worst = aggregate(list.map((s) => s.status));
          const on = provider === pr;
          return (
            <button
              key={pr}
              type="button"
              aria-pressed={on}
              onClick={() => onProvider(on ? 'all' : pr)}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
                on ? 'bg-orange-soft' : 'hover:bg-sidebar',
              )}
            >
              <IntegrationIcon name={PROVIDER[pr].icon} size="sm" framed />
              <span className="min-w-0 flex-1">
                <span className={cn('block text-[13px] font-semibold leading-tight', on && 'text-orange-ink')}>{PROVIDER[pr].name}</span>
                <span className="block text-[11.5px] tabular-nums text-muted-foreground">
                  {ok} de {list.length} en línea
                  {list.some(hasFailedDeploy) && <span className={DEPLOY.failed.ink}> · {list.filter(hasFailedDeploy).length} deploy fallido</span>}
                </span>
              </span>
              {/* Un punto por servicio: se lee la mezcla de un vistazo. */}
              <span className="flex max-w-[96px] flex-wrap justify-end gap-[3px]">
                {list.map((s) => <span key={s.id} className={cn('size-1.5 rounded-full', STATUS[s.status].dot)} />)}
              </span>
              <span className="sr-only">{STATUS[worst].label}</span>
            </button>
          );
        })}
      </section>
    </Card>
  );
}
