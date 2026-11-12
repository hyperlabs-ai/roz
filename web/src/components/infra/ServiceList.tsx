import type { KeyboardEvent } from 'react';
import { Activity, ExternalLink, GitBranch, MoreHorizontal, Pencil, Plus, Rocket, Timer, TriangleAlert, Unlink, PanelRightOpen } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IntegrationIcon } from '@/components/brand';
import { ProjectIcon } from '@/components/avatars';
import { Fresh } from '@/components/bits';
import type { InfraProject } from '@/lib/api';
import { compact, relative } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  AuthorAvatar, DEPLOY, LiveDot, PROVIDER, STATUS, UptimeStrip, aggregate, causeText, deployOf, failureOf, fmtDuration, fmtPct,
  friendlyStatus, hasFailedDeploy, lastDeployOf, serviceTitle, stepLabel, type ServiceRow, type StripsResponse, type UptimeSegment,
} from './infra-ui';

/** Pistas de la fila: servicio · estado · último deploy · 24 h · acciones. */
const ROW_COLS = 'lg:grid-cols-[minmax(0,1.35fr)_minmax(0,0.75fr)_minmax(0,1.9fr)_minmax(150px,1fr)_60px]';

export interface RowActions {
  onOpen: (id: string) => void;
  onEdit: (s: ServiceRow) => void;
  onUnlink: (s: ServiceRow) => void;
  isFresh: (id: string) => boolean;
  isBusy: (id: string) => boolean;
}

function projectUptime(strips: StripsResponse | null | undefined, ids: string[]): number | null {
  if (!strips) return null;
  let up = 0;
  let total = 0;
  for (const id of ids) {
    for (const seg of strips.services[id]?.segments ?? []) {
      up += seg.up;
      total += seg.total;
    }
  }
  return total ? Math.round((up / total) * 1000) / 10 : null;
}

/** Un proyecto = una tarjeta con su lista densa de servicios (nada de tarjetas sueltas). */
export function ProjectServices({
  project,
  services,
  strips,
  actions,
  onLink,
}: {
  project: InfraProject;
  services: ServiceRow[];
  strips: StripsResponse | null | undefined;
  actions: RowActions;
  onLink: (projectId: string) => void;
}) {
  const worst = aggregate(services.map((s) => s.status));
  const pct = projectUptime(strips, services.map((s) => s.id));
  const client = project.kind === 'client';
  const failedDeploys = services.filter(hasFailedDeploy).length;
  return (
    <Card className="overflow-hidden">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        <ProjectIcon id={project.projectId} name={project.name} size="md" className="size-7" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h3 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{project.name}</h3>
          <Badge variant={client ? 'brand' : 'neutral'}>{client ? 'Cliente' : 'Interno'}</Badge>
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <LiveDot status={worst} />
            {services.length} {services.length === 1 ? 'servicio' : 'servicios'}
          </span>
          {failedDeploys > 0 && (
            <Badge variant="human" dot>
              {failedDeploys} {failedDeploys === 1 ? 'deploy fallido' : 'deploys fallidos'}
            </Badge>
          )}
        </div>
        {pct != null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1.5 text-[12px] tabular-nums text-muted-foreground">
                <Activity className="size-3.5 text-faint" />
                {fmtPct(pct)}
              </span>
            </TooltipTrigger>
            <TooltipContent>Disponibilidad del proyecto en 24 h</TooltipContent>
          </Tooltip>
        )}
        <Button variant="ghost" size="sm" onClick={() => onLink(project.projectId)}>
          <Plus /> Vincular
        </Button>
      </header>

      <div className={cn('hidden gap-4 border-b bg-sidebar px-4 py-1.5 lg:grid', ROW_COLS)}>
        <span className="label-caps">Servicio</span>
        <span className="label-caps">Estado</span>
        <span className="label-caps">Último intento de deploy</span>
        <span className="label-caps">Últimas 24 h</span>
        <span />
      </div>

      <ul className="divide-y">
        {services.map((s) => (
          <li key={s.id}>
            <Fresh fresh={actions.isFresh(s.id)}>
              <ServiceLine s={s} strip={strips?.services[s.id]?.segments} pct={strips?.services[s.id]?.uptimePct ?? null} count={strips?.segments ?? 24} actions={actions} />
            </Fresh>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ServiceLine({
  s,
  strip,
  pct,
  count,
  actions,
}: {
  s: ServiceRow;
  strip: UptimeSegment[] | undefined;
  pct: number | null;
  count: number;
  actions: RowActions;
}) {
  const st = STATUS[s.status];
  const title = serviceTitle(s);
  const busy = actions.isBusy(s.id);
  const pending = s.id.startsWith('nuevo:');
  const url = s.details?.productionUrl ?? s.details?.serving?.url ?? deployOf(s)?.url ?? null;
  const cause = s.status === 'down' || s.status === 'degraded' || s.status === 'paused' ? causeText(failureOf(s)) : null;
  const open = () => !pending && actions.onOpen(s.id);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKey}
      aria-label={`Ver detalle de ${title}`}
      className={cn(
        'group grid cursor-pointer items-center gap-x-4 gap-y-2.5 px-4 py-3 transition-colors hover:bg-sidebar focus-visible:bg-sidebar focus-visible:outline-none',
        'grid-cols-[minmax(0,1fr)_auto]',
        ROW_COLS,
        busy && 'pointer-events-none opacity-60',
      )}
    >
      {/* Servicio */}
      <div className="flex min-w-0 items-center gap-2.5">
        <IntegrationIcon name={PROVIDER[s.provider].icon} size="sm" framed />
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold leading-tight">{title}</div>
          <div className="truncate font-mono text-[11px] text-faint">{s.externalRef}</div>
        </div>
      </div>

      {/* Estado (en móvil, arriba a la derecha) */}
      <div className="flex min-w-0 flex-col items-end gap-0.5 lg:items-start">
        <span className={cn('inline-flex items-center gap-1.5 text-[12.5px] font-semibold', st.ink)}>
          <LiveDot status={s.status} />
          <span className="truncate">{friendlyStatus(s)}</span>
        </span>
        {s.ok === false ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1 text-[11px] text-yellow-ink">
                <TriangleAlert className="size-3" /> no se pudo consultar
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{s.error ?? 'Error del proveedor'}</TooltipContent>
          </Tooltip>
        ) : cause ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn('max-w-full truncate text-[11px]', s.status === 'down' ? 'text-red' : 'text-muted-foreground')}>{cause}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">{cause}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-[11px] tabular-nums text-faint">{s.capturedAt ? `sondeo ${relative(s.capturedAt)}` : 'sin sondear'}</span>
        )}
      </div>

      {/* Último deploy / salud de Supabase */}
      <div className="col-span-2 min-w-0 lg:col-span-1">
        {s.ok === null ? (
          <span className="text-[12px] text-muted-foreground">Aún sin sondear · llega en el próximo ciclo (≤ 15 min)</span>
        ) : s.provider === 'supabase' ? (
          <SupabaseLine s={s} />
        ) : (
          <DeployLine s={s} />
        )}
      </div>

      {/* Franja de 24 h */}
      <div className="col-span-2 flex min-w-0 items-center gap-2.5 lg:col-span-1">
        <UptimeStrip segments={strip} count={count} height={18} className="flex-1" />
        <span className="w-11 shrink-0 text-right text-[11.5px] font-semibold tabular-nums text-muted-foreground">{fmtPct(pct)}</span>
      </div>

      {/* Acciones */}
      <div className="col-span-2 flex items-center justify-end gap-0.5 max-lg:hidden lg:col-span-1" onClick={(e) => e.stopPropagation()}>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            title="Abrir sitio"
            className="grid size-7 place-items-center rounded-sm text-faint transition-colors hover:bg-panel hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
        <RowMenu s={s} actions={actions} disabled={pending} />
      </div>
    </div>
  );
}

function RowMenu({ s, actions, disabled }: { s: ServiceRow; actions: RowActions; disabled?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        onClick={(e) => e.stopPropagation()}
        className="grid size-7 place-items-center rounded-sm text-faint transition-colors hover:bg-panel hover:text-foreground disabled:opacity-40"
        aria-label="Acciones"
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => actions.onOpen(s.id)}><PanelRightOpen /> Ver detalle</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onEdit(s)}><Pencil /> Editar</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => actions.onUnlink(s)} className="text-red focus:bg-red-soft focus:text-red"><Unlink /> Desvincular</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * El último INTENTO de deploy, con su propio resultado (no es el estado del servicio). Si falló,
 * dice en qué paso y por qué, y qué commit sigue atendiendo producción.
 */
function DeployLine({ s }: { s: ServiceRow }) {
  const last = lastDeployOf(s);
  if (!last?.createdAt && !last?.message) return <span className="text-[12px] text-faint">Sin deploy reciente</span>;
  const d = { commitMessage: last.message, author: last.author, branch: last.branch, createdAt: last.createdAt };
  const duration = fmtDuration(last.durationMs);
  const tone = DEPLOY[last.state];
  const failed = last.state === 'failed';
  const failure = failed ? failureOf(s) : null;
  const cause = causeText(failure);
  const step = stepLabel(failure);
  const serving = s.details?.serving ?? null;
  const showOutcome = last.state === 'failed' || last.state === 'building';
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <AuthorAvatar author={d.author} className="size-6" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {showOutcome && (
            <span className={cn('inline-flex h-[18px] shrink-0 items-center gap-1 rounded-sm px-1.5 text-[10.5px] font-semibold', tone.soft, tone.ink)}>
              <span className={cn('size-1.5 rounded-full', tone.dot, last.state === 'building' && 'animate-pulse')} />
              {failed ? (step ? `Falló · ${step}` : 'Deploy fallido') : tone.label}
            </span>
          )}
          <span className="truncate text-[12.5px] leading-snug" title={d.commitMessage ?? undefined}>
            {d.commitMessage ?? <span className="text-faint">Sin mensaje de commit</span>}
          </span>
        </div>
        {failed && (cause || (s.status === 'healthy' && serving)) && (
          <div className="flex min-w-0 items-center gap-x-2 text-[11px]">
            {cause && <span className="min-w-0 truncate text-yellow-ink" title={cause}>{cause}</span>}
            {s.status === 'healthy' && serving?.sha && (
              <span className="inline-flex shrink-0 items-center gap-1 text-green">
                <Rocket className="size-3" />
                sirve <span className="font-mono">{serving.sha.slice(0, 7)}</span>
              </span>
            )}
          </div>
        )}
        <div className="flex min-w-0 items-center gap-x-2.5 text-[11px] text-faint">
          {d.branch && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate font-mono">{d.branch}</span>
            </span>
          )}
          {d.createdAt && <span className="shrink-0 tabular-nums">{relative(d.createdAt)}</span>}
          {duration && (
            <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
              <Timer className="size-3" />
              {duration}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function SupabaseLine({ s }: { s: ServiceRow }) {
  const subs = s.details?.subsystems ?? [];
  const bad = subs.filter((x) => !x.healthy);
  const req = s.metrics?.requests;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex items-center gap-1">
        {subs.map((sub) => (
          <Tooltip key={sub.name}>
            <TooltipTrigger asChild>
              <span className={cn('h-[18px] w-1.5 rounded-[2px]', sub.healthy ? 'bg-green' : 'bg-red')} />
            </TooltipTrigger>
            <TooltipContent>{sub.name} · {sub.healthy ? 'operativo' : 'con fallas'}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="min-w-0 text-[12px] leading-snug">
        <div className={cn('truncate', bad.length ? 'text-red' : 'text-foreground')}>
          {subs.length ? (bad.length ? `Con fallas: ${bad.map((b) => b.name).join(', ')}` : `${subs.length} subsistemas operativos`) : 'Sin subsistemas reportados'}
        </div>
        <div className="truncate text-[11px] tabular-nums text-faint">
          {typeof req === 'number' && `${compact(req)} peticiones / 24 h`}
          {typeof req === 'number' && s.details?.region && ' · '}
          {s.details?.region}
        </div>
      </div>
    </div>
  );
}

// ---- Carga ----

export function InfraSkeleton() {
  return (
    <div className="grid gap-5">
      <Card className="grid lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.3fr)_minmax(0,1fr)] max-lg:divide-y lg:divide-x">
        {[0, 1, 2].map((i) => (
          <div key={i} className="grid content-start gap-3 p-5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-5 w-full" />
          </div>
        ))}
      </Card>
      <Skeleton className="h-9 w-full rounded-md" />
      {[3, 2].map((n, i) => (
        <Card key={i} className="overflow-hidden">
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <Skeleton className="size-7 rounded-md" />
            <Skeleton className="h-4 w-40" />
          </div>
          <div className="divide-y">
            {Array.from({ length: n }).map((_, j) => (
              <div key={j} className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3.5', ROW_COLS)}>
                <div className="flex items-center gap-2.5">
                  <Skeleton className="size-[26px] rounded-md" />
                  <div className="grid gap-1.5">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-2.5 w-20" />
                  </div>
                </div>
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="hidden h-3.5 w-full lg:block" />
                <Skeleton className="hidden h-[18px] w-full lg:block" />
                <span className="hidden lg:block" />
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
