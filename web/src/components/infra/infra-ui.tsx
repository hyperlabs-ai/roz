import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import type { IntegrationName } from '@/components/brand';
import { PersonAvatar } from '@/components/avatars';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { BadgeVariant } from '@/components/ui/badge';
import type { InfraDeployRef, InfraDeployState, InfraFailure, InfraService, ServiceProvider, ServiceStatus } from '@/lib/api';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------------------------
// Tipos locales. `SnapshotDeploy` es el deploy del snapshot con todos sus campos opcionales
// (`InfraDeploy` de lib/api.ts ya usa `state`, como src/infra/types.ts). Las respuestas nuevas
// (/infra/strips y /infra/services/:id) espejan src/infra/detail.ts.
// ---------------------------------------------------------------------------------------------

/** Servicio + el proyecto al que pertenece: el espejo de la pantalla es una lista PLANA. */
export type ServiceRow = InfraService & { projectId: string };

export interface SnapshotDeploy {
  state?: string | null;
  url?: string | null;
  sha?: string | null;
  createdAt?: string | null;
  commitMessage?: string | null;
  branch?: string | null;
  author?: string | null;
  repo?: string | null;
  durationMs?: number | null;
}

/** El deploy del snapshot con su nombre de campo real. */
export function deployOf(s: Pick<InfraService, 'deploy'>): SnapshotDeploy | null {
  return (s.deploy as unknown as SnapshotDeploy | null) ?? null;
}

export interface UptimeSegment {
  start: string;
  status: ServiceStatus;
  up: number;
  total: number;
}

export interface StripsResponse {
  from: string;
  to: string;
  hours: number;
  segments: number;
  services: Record<string, { segments: UptimeSegment[]; uptimePct: number | null }>;
}

export interface DeployEntry {
  id: string | null;
  state: string;
  url: string | null;
  sha: string | null;
  branch: string | null;
  message: string | null;
  author: string | null;
  createdAt: string | null;
  durationMs: number | null;
  inspectorUrl: string | null;
  /** Resultado normalizado del intento. */
  outcome: InfraDeployState;
  /** Es el que atiende producción ahora. */
  serving: boolean;
  errorMessage: string | null;
}

export interface DeployStats {
  total: number;
  finished: number;
  failed: number;
  successPct: number | null;
  avgDurationMs: number | null;
}

export interface ServiceDetailResponse {
  service: {
    id: string;
    projectId: string;
    projectName: string | null;
    provider: ServiceProvider;
    externalRef: string;
    label: string | null;
    config: Record<string, unknown>;
  };
  snapshot: {
    capturedAt: string;
    ok: boolean;
    status: ServiceStatus;
    providerStatus: string | null;
    active: boolean | null;
    deploy: SnapshotDeploy | null;
    metrics: Record<string, number | null> | null;
    details: InfraService['details'];
    error: string | null;
  } | null;
  uptime: {
    from: string;
    to: string;
    days: number;
    bucketMs: number;
    segments: UptimeSegment[];
    uptimePct: number | null;
    samples: number;
  };
  incidents: { status: 'down' | 'degraded'; start: string; end: string | null; durationMs: number }[];
  lastError: { at: string; status: string; providerStatus: string | null; message: string | null } | null;
  deploys: DeployEntry[];
  deployStats: DeployStats;
  deploysSource: 'live' | 'snapshot' | 'none';
  links: { label: string; url: string }[];
}

// ---------------------------------------------------------------------------------------------
// Paletas y textos
// ---------------------------------------------------------------------------------------------

/** Estado por significado: verde ok, naranja degradado, rojo caído, gris pausado/sin datos. */
export const STATUS: Record<ServiceStatus, { label: string; dot: string; ink: string; soft: string; chip: BadgeVariant }> = {
  healthy: { label: 'En línea', dot: 'bg-green', ink: 'text-green', soft: 'bg-green-soft', chip: 'ok' },
  degraded: { label: 'Degradado', dot: 'bg-orange', ink: 'text-orange-ink', soft: 'bg-orange-soft', chip: 'warn' },
  down: { label: 'Caído', dot: 'bg-red', ink: 'text-red', soft: 'bg-red-soft', chip: 'bad' },
  paused: { label: 'Pausado', dot: 'bg-faint', ink: 'text-muted-foreground', soft: 'bg-panel', chip: 'neutral' },
  unknown: { label: 'Sin datos', dot: 'bg-toggle-off', ink: 'text-muted-foreground', soft: 'bg-panel', chip: 'neutral' },
};

/**
 * Resultado de un INTENTO de deploy. Paleta distinta a la del servicio a propósito: un deploy
 * fallido es amarillo (hay que mirarlo), no rojo (rojo = producción sin atender).
 */
export const DEPLOY: Record<InfraDeployState, { label: string; dot: string; ink: string; soft: string; chip: BadgeVariant }> = {
  ready: { label: 'Listo', dot: 'bg-green', ink: 'text-green', soft: 'bg-green-soft', chip: 'ok' },
  building: { label: 'Desplegando', dot: 'bg-blue', ink: 'text-blue-ink', soft: 'bg-blue-soft', chip: 'info' },
  failed: { label: 'Falló', dot: 'bg-yellow', ink: 'text-yellow-ink', soft: 'bg-yellow-soft', chip: 'human' },
  canceled: { label: 'Reemplazado', dot: 'bg-faint', ink: 'text-muted-foreground', soft: 'bg-panel', chip: 'neutral' },
  unknown: { label: 'Sin dato', dot: 'bg-toggle-off', ink: 'text-muted-foreground', soft: 'bg-panel', chip: 'neutral' },
};

/** Estado nativo de un deploy → resultado normalizado (respaldo para snapshots sin el modelo). */
export function deployOutcome(state: string | null | undefined): InfraDeployState {
  const s = (state ?? '').toUpperCase();
  if (['READY', 'SUCCESS', 'SLEEPING'].includes(s)) return 'ready';
  if (['ERROR', 'FAILED', 'CRASHED'].includes(s)) return 'failed';
  if (['BUILDING', 'QUEUED', 'DEPLOYING', 'INITIALIZING', 'WAITING', 'NEEDS_APPROVAL'].includes(s)) return 'building';
  if (['REMOVED', 'REMOVING', 'CANCELED', 'DELETED', 'SKIPPED'].includes(s)) return 'canceled';
  return 'unknown';
}

/** Último intento de deploy del servicio (del modelo nuevo, o reconstruido del snapshot viejo). */
export function lastDeployOf(s: Pick<InfraService, 'deploy' | 'details' | 'provider'>): InfraDeployRef | null {
  if (s.provider === 'supabase') return null;
  if (s.details?.lastDeploy) return s.details.lastDeploy;
  const d = s.deploy as unknown as SnapshotDeploy | null;
  if (!d?.state) return null;
  return {
    id: null, state: deployOutcome(d.state), nativeState: d.state, sha: d.sha ?? null, branch: d.branch ?? null,
    message: d.commitMessage ?? null, author: d.author ?? null, createdAt: d.createdAt ?? null,
    durationMs: d.durationMs ?? null, url: d.url ?? null, inspectorUrl: null,
  };
}

export function failureOf(s: Pick<InfraService, 'details'>): InfraFailure | null {
  return s.details?.failure ?? null;
}

/** El último intento falló pero el servicio sigue atendiendo con otro deploy. */
export function hasFailedDeploy(s: Pick<InfraService, 'deploy' | 'details' | 'provider' | 'status'>): boolean {
  return s.status !== 'down' && lastDeployOf(s)?.state === 'failed';
}

/** Filtro de la lista: un estado del servicio, o "con deploy fallido" (que es otra dimensión). */
export type StatusFilter = 'all' | ServiceStatus | 'deploy_failed';
export function matchesStatus(s: Pick<InfraService, 'deploy' | 'details' | 'provider' | 'status'>, f: StatusFilter): boolean {
  if (f === 'all') return true;
  if (f === 'deploy_failed') return hasFailedDeploy(s);
  return s.status === f;
}

/** Línea corta de causa: código + mensaje del proveedor, o la última línea de error del log. */
export function causeText(f: InfraFailure | null | undefined): string | null {
  if (!f) return null;
  const msg = f.message ?? f.logTail[f.logTail.length - 1] ?? null;
  if (!msg) return f.code;
  return f.code && !msg.includes(f.code) ? `${f.code}: ${msg}` : msg;
}

/** Nombre legible del paso que falló. */
export function stepLabel(f: InfraFailure | null | undefined): string | null {
  if (!f?.step) return null;
  const map: Record<string, string> = { buildStep: 'Build', build: 'Build', ejecución: 'Ejecución', deployStep: 'Deploy', checksStep: 'Checks' };
  return map[f.step] ?? f.step;
}

/** Orden de severidad (el peor primero). */
export const SEVERITY: ServiceStatus[] = ['down', 'degraded', 'paused', 'unknown', 'healthy'];

export const PROVIDER: Record<ServiceProvider, { name: string; icon: IntegrationName }> = {
  vercel: { name: 'Vercel', icon: 'vercel' },
  railway: { name: 'Railway', icon: 'railway' },
  supabase: { name: 'Supabase', icon: 'supabase' },
};
export const PROVIDER_ORDER: ServiceProvider[] = ['vercel', 'railway', 'supabase'];

// Estado nativo de cada proveedor → etiqueta legible.
const FRIENDLY: Record<string, string> = {
  READY: 'En línea', ERROR: 'Deploy fallido', BUILDING: 'Desplegando', QUEUED: 'En cola',
  INITIALIZING: 'Iniciando', CANCELED: 'Cancelado', DELETED: 'Eliminado',
  SUCCESS: 'En línea', FAILED: 'Deploy fallido', CRASHED: 'Proceso caído', DEPLOYING: 'Desplegando', PAUSED: 'Pausado',
  WAITING: 'En espera', SLEEPING: 'Dormido', REMOVED: 'Removido', REMOVING: 'Removiendo', SKIPPED: 'Omitido',
  ACTIVE_HEALTHY: 'En línea', ACTIVE_UNHEALTHY: 'Con problemas', INACTIVE: 'Pausado',
  COMING_UP: 'Iniciando', GOING_DOWN: 'Apagando', RESTORING: 'Restaurando', UPGRADING: 'Actualizando',
  PAUSING: 'Pausando', RESTARTING: 'Reiniciando', RESIZING: 'Redimensionando',
  INIT_FAILED: 'Falló el inicio', RESTORE_FAILED: 'Falló restauración', PAUSE_FAILED: 'Falló la pausa',
};

export function friendlyState(state: string | null | undefined): string | null {
  return state ? FRIENDLY[state.toUpperCase()] ?? null : null;
}

/**
 * Estado del SERVICIO en palabras. Manda el estado normalizado; el nativo solo matiza cuando dice
 * algo más (dormido, restaurando…). Nunca deja que el estado de un deploy se cuele aquí.
 */
export function friendlyStatus(s: Pick<InfraService, 'providerStatus' | 'status'>): string {
  if (s.status === 'healthy') return STATUS.healthy.label;
  const native = (s.providerStatus ?? '').toUpperCase();
  if (s.status === 'down' && ['ERROR', 'FAILED'].includes(native)) return 'Caído · sin deploy';
  return friendlyState(native) ?? STATUS[s.status].label;
}

/** Estado nativo de un deploy → estado normalizado (para el punto de color). */
export function mapDeployState(state: string): ServiceStatus {
  const s = state.toUpperCase();
  if (['READY', 'SUCCESS'].includes(s)) return 'healthy';
  if (['ERROR', 'FAILED', 'CRASHED'].includes(s)) return 'down';
  if (['BUILDING', 'QUEUED', 'DEPLOYING', 'INITIALIZING', 'WAITING'].includes(s)) return 'degraded';
  if (['REMOVED', 'CANCELED', 'SLEEPING', 'SKIPPED'].includes(s)) return 'paused';
  return 'unknown';
}

export function serviceTitle(s: Pick<InfraService, 'label' | 'provider' | 'externalRef'>): string {
  return s.label || (s.provider === 'supabase' ? 'Base de datos' : s.externalRef);
}

export function fmtDuration(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  const h = ms / 3_600_000;
  return h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : `${Math.round(h / 24)} d`;
}

export function fmtPct(p: number | null | undefined): string {
  if (p == null) return '—';
  return `${p >= 99.95 ? 100 : p.toFixed(p >= 99 ? 2 : 1)}%`;
}

/** Peor estado de un conjunto. */
export function aggregate(statuses: ServiceStatus[]): ServiceStatus {
  for (const st of ['down', 'degraded', 'healthy', 'paused'] as ServiceStatus[]) {
    if (statuses.includes(st)) return st;
  }
  return 'unknown';
}

/** ¿El autor parece un login de GitHub (y no un nombre con espacios)? */
export function looksLikeLogin(a: string | null | undefined): a is string {
  return !!a && /^[A-Za-z0-9-]{1,39}$/.test(a);
}

// ---------------------------------------------------------------------------------------------
// Piezas visuales
// ---------------------------------------------------------------------------------------------

/** Punto de estado; operativo "late" (anillo ping). */
export function LiveDot({ status, className }: { status: ServiceStatus; className?: string }) {
  const st = STATUS[status];
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)}>
      {status === 'healthy' && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', st.dot)} />}
      <span className={cn('relative inline-flex size-2 rounded-full', st.dot)} />
    </span>
  );
}

const SEG_FILL: Record<ServiceStatus, string> = {
  healthy: 'bg-green',
  degraded: 'bg-orange',
  down: 'bg-red',
  paused: 'bg-faint opacity-50',
  unknown: 'bg-toggle-off',
};

function segLabel(seg: UptimeSegment, bucketMs: number): string {
  const d = new Date(seg.start);
  const end = new Date(d.getTime() + bucketMs);
  const day = d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric' });
  const t = (x: Date) => x.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  return `${day} · ${t(d)}–${t(end)}`;
}

/**
 * Franja de disponibilidad: un segmento vertical por bloque de tiempo, coloreado por el peor estado
 * del bloque. Sin datos = pista gris. `height` en px.
 */
export function UptimeStrip({
  segments,
  count = 24,
  bucketMs = 3_600_000,
  height = 18,
  className,
}: {
  segments: UptimeSegment[] | null | undefined;
  count?: number;
  bucketMs?: number;
  height?: number;
  className?: string;
}) {
  const segs = segments?.length ? segments : null;
  return (
    <div className={cn('flex min-w-0 items-stretch gap-[2px]', className)} style={{ height }} aria-label="Disponibilidad">
      {segs
        ? segs.map((seg, i) => (
            <Tooltip key={i}>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    'min-w-[2px] flex-1 rounded-[2px] transition-transform duration-fast ease-spring hover:scale-y-110',
                    SEG_FILL[seg.status],
                  )}
                />
              </TooltipTrigger>
              <TooltipContent>
                <div className="text-xs">
                  <div className="font-semibold">{STATUS[seg.status].label}</div>
                  <div className="opacity-80">{segLabel(seg, bucketMs)}</div>
                  {seg.total > 0 && <div className="tabular-nums opacity-80">{seg.up}/{seg.total} sondeos sanos</div>}
                </div>
              </TooltipContent>
            </Tooltip>
          ))
        : Array.from({ length: count }).map((_, i) => <span key={i} className="min-w-[2px] flex-1 rounded-[2px] bg-panel" />)}
    </div>
  );
}

/** Botón de copiar al portapapeles con confirmación breve. */
export function CopyButton({ value, label = 'Copiar', className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1200);
        });
      }}
      className={cn('grid size-6 shrink-0 place-items-center rounded-sm text-faint transition-colors hover:bg-panel hover:text-foreground', className)}
    >
      {done ? <Check className="size-3.5 text-green" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** Avatar del autor de un deploy: foto de GitHub si parece login; si no, iniciales. */
export function AuthorAvatar({ author, className = 'size-5' }: { author: string | null | undefined; className?: string }) {
  if (!author) return null;
  return <PersonAvatar name={author} login={looksLikeLogin(author) ? author : null} className={className} />;
}

/** Fila de metadato: etiqueta a la izquierda, valor a la derecha, copiar opcional. */
export function MetaRow({ label, children, copy, mono }: { label: string; children: ReactNode; copy?: string | null; mono?: boolean }) {
  return (
    <div className="flex min-h-9 items-center gap-3 py-1.5">
      <span className="label-caps w-28 shrink-0">{label}</span>
      <span className={cn('min-w-0 flex-1 truncate text-[13px]', mono && 'font-mono text-[12px]')}>{children}</span>
      {copy && <CopyButton value={copy} />}
    </div>
  );
}
