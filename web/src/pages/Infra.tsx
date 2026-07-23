import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import {
  Server, Plus, Pencil, X, ExternalLink, RefreshCw, TriangleAlert, GitCommitHorizontal, GitBranch,
  Triangle, TrainFront, Database, Clock, Timer, Globe, Activity, Cpu, Layers,
} from 'lucide-react';
import { Layout } from '@/components/Layout';
import { EmptyState, ErrorCard } from '@/components/bits';
import { useAuth } from '@/auth/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useApi } from '@/lib/useApi';
import { apiGet, apiSend, type InfraResponse, type InfraProject, type InfraService, type ServiceProvider, type ServiceStatus } from '@/lib/api';
import { compact, relative } from '@/lib/format';

// ---- Paletas ----
// `pill` son clases estáticas completas (Tailwind no detecta clases construidas en runtime).
const STATUS: Record<ServiceStatus, { label: string; dot: string; pill: string }> = {
  healthy: { label: 'Operativo', dot: 'bg-success', pill: 'bg-success/12 text-success' },
  degraded: { label: 'Degradado', dot: 'bg-warning', pill: 'bg-warning/12 text-warning' },
  down: { label: 'Caído', dot: 'bg-destructive', pill: 'bg-destructive/12 text-destructive' },
  paused: { label: 'Pausado', dot: 'bg-muted-foreground', pill: 'bg-muted text-muted-foreground' },
  unknown: { label: 'Sin datos', dot: 'bg-muted-foreground/40', pill: 'bg-muted text-muted-foreground' },
};

const PROVIDER: Record<ServiceProvider, { name: string; Icon: typeof Triangle; accent: string; chip: string }> = {
  vercel: { name: 'Vercel', Icon: Triangle, accent: 'text-foreground', chip: 'bg-foreground/10 text-foreground' },
  railway: { name: 'Railway', Icon: TrainFront, accent: 'text-chart-5', chip: 'bg-chart-5/15 text-chart-5' },
  supabase: { name: 'Supabase', Icon: Database, accent: 'text-chart-3', chip: 'bg-chart-3/15 text-chart-3' },
};

const PROVIDER_ORDER: ServiceProvider[] = ['vercel', 'railway', 'supabase'];

// Estado nativo de cada proveedor → etiqueta legible que dice si está activo / pausado / caído.
const FRIENDLY: Record<string, string> = {
  // Vercel (estado del último deploy de producción)
  READY: 'Activo', ERROR: 'Error de deploy', BUILDING: 'Desplegando', QUEUED: 'En cola',
  INITIALIZING: 'Iniciando', CANCELED: 'Cancelado', DELETED: 'Eliminado',
  // Railway (estado del despliegue)
  SUCCESS: 'Activo', FAILED: 'Falló el deploy', CRASHED: 'Caído', DEPLOYING: 'Desplegando',
  WAITING: 'En espera', SLEEPING: 'Dormido', REMOVED: 'Removido', REMOVING: 'Removiendo', SKIPPED: 'Omitido',
  // Supabase (estado del proyecto)
  ACTIVE_HEALTHY: 'Activo', ACTIVE_UNHEALTHY: 'Con problemas', INACTIVE: 'Pausado',
  COMING_UP: 'Iniciando', GOING_DOWN: 'Apagando', RESTORING: 'Restaurando', UPGRADING: 'Actualizando',
  PAUSING: 'Pausando', RESTARTING: 'Reiniciando', RESIZING: 'Redimensionando',
  INIT_FAILED: 'Falló el inicio', RESTORE_FAILED: 'Falló restauración', PAUSE_FAILED: 'Falló la pausa',
};
function friendlyStatus(s: InfraService): string {
  const f = s.providerStatus ? FRIENDLY[s.providerStatus.toUpperCase()] : undefined;
  return f ?? STATUS[s.status].label;
}

// Punto de estado. Cuando el servicio está operativo "late" (anillo ping) para
// sugerir que sigue activo; en los demás estados es un punto fijo.
function LiveDot({ status, className }: { status: ServiceStatus; className?: string }) {
  const st = STATUS[status];
  const live = status === 'healthy';
  return (
    <span className={cn('relative inline-flex size-2', className)}>
      {live && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-75', st.dot)} />}
      <span className={cn('relative inline-flex size-2 rounded-full', st.dot)} />
    </span>
  );
}

function fmtDuration(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// Peor estado de un conjunto (para semáforos agregados).
function aggregate(services: InfraService[]): ServiceStatus {
  for (const st of ['down', 'degraded', 'paused', 'healthy', 'unknown'] as ServiceStatus[]) {
    if (services.some((s) => s.status === st)) return st;
  }
  return 'unknown';
}

export default function Infra() {
  const { user } = useAuth();
  const isAdmin = !!user; // control total para cualquier usuario autenticado (sin roles)
  const { data, loading, error, reload } = useApi<InfraResponse>(() => apiGet('/infra'), []);

  const projects = data?.projects ?? [];
  const withServices = projects.filter((p) => p.services.length);
  const emptyProjects = projects.filter((p) => !p.services.length);
  const allServices = withServices.flatMap((p) => p.services);

  // Conteo global por estado.
  const counts = allServices.reduce(
    (a, s) => ((a[s.status] = (a[s.status] ?? 0) + 1), a),
    {} as Record<ServiceStatus, number>,
  );
  const noTokens = allServices.length > 0 && allServices.every((s) => s.ok === null || (!s.ok && /no configurado/i.test(s.error ?? '')));

  return (
    <Layout
      title="Infraestructura"
      subtitle="Estado de deploys, salud y métricas por proyecto"
      actions={<Button variant="outline" size="sm" onClick={reload}><RefreshCw /> Actualizar</Button>}
    >
      {error && <ErrorCard message={error} className="mb-4" />}

      {noTokens && (
        <Card className="mb-4 border-warning/30 bg-warning/5">
          <CardContent className="flex items-start gap-3 py-4 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <p className="font-medium">Aún no hay tokens de API configurados.</p>
              <p className="text-muted-foreground">
                Define <code className="font-mono text-xs">VERCEL_API_TOKEN</code>, <code className="font-mono text-xs">RAILWAY_API_TOKEN</code> y/o{' '}
                <code className="font-mono text-xs">SUPABASE_ACCESS_TOKEN</code> en las variables de entorno. El sondeo poblará el estado en el siguiente ciclo.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <InfraSkeleton />
      ) : !projects.length ? (
        <Card><CardContent className="py-10"><EmptyState icon={<Server className="size-6" />}>No hay proyectos</EmptyState></CardContent></Card>
      ) : (
        <div className="space-y-8">
          {!!allServices.length && (
            <SummaryBar
              total={allServices.length}
              counts={counts}
              projects={withServices.length}
              emptyProjects={emptyProjects}
              isAdmin={isAdmin}
              onSaved={reload}
            />
          )}

          {withServices.map((p) => (
            <ProjectSection key={p.projectId} p={p} isAdmin={isAdmin} onChanged={reload} />
          ))}

          {!withServices.length && (
            <Card><CardContent className="py-10"><EmptyState icon={<Server className="size-6" />}>Ningún proyecto tiene servicios vinculados todavía</EmptyState></CardContent></Card>
          )}

          {/* Sin servicios aún: la barra de resumen no se muestra, así que el selector va aquí de fallback. */}
          {isAdmin && !allServices.length && !!emptyProjects.length && <LinkToEmptyProject projects={emptyProjects} onSaved={reload} />}
        </div>
      )}
    </Layout>
  );
}

// ---- Skeletons de carga (imitan la estructura real: resumen + secciones + tarjetas de servicio) ----
function ServiceCardSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <Skeleton className="size-8 shrink-0 rounded-lg" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/5" />
        <div className="flex items-center justify-between border-t pt-2.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-12" />
        </div>
      </CardContent>
    </Card>
  );
}

function InfraSkeleton() {
  return (
    <div className="space-y-8">
      {/* Barra de resumen */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-card px-5 py-3.5">
        <Skeleton className="h-6 w-24" />
        <div className="h-8 w-px bg-border" />
        <Skeleton className="h-6 w-24" />
        <div className="h-8 w-px bg-border" />
        <Skeleton className="h-5 w-48" />
      </div>
      {/* Dos secciones de proyecto con su grilla de servicios */}
      {Array.from({ length: 2 }).map((_, i) => (
        <section key={i}>
          <div className="mb-3 flex items-center gap-2.5">
            <Skeleton className="size-2.5 rounded-full" />
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <div className="stagger-children grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, j) => <ServiceCardSkeleton key={j} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---- Resumen global ----
function SummaryBar({
  total,
  counts,
  projects,
  emptyProjects,
  isAdmin,
  onSaved,
}: {
  total: number;
  counts: Record<ServiceStatus, number>;
  projects: number;
  emptyProjects: InfraProject[];
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [linkProject, setLinkProject] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-card px-5 py-3.5">
      <Metric value={projects} label={projects === 1 ? 'proyecto' : 'proyectos'} />
      <div className="h-8 w-px bg-border" />
      <Metric value={total} label={total === 1 ? 'servicio' : 'servicios'} />
      <div className="h-8 w-px bg-border" />
      <div className="flex flex-wrap items-center gap-4">
        {(['healthy', 'degraded', 'down', 'paused', 'unknown'] as ServiceStatus[])
          .filter((s) => counts[s])
          .map((s) => (
            <div key={s} className="flex items-center gap-1.5">
              <span className={cn('size-2.5 rounded-full', STATUS[s].dot)} />
              <span className="text-sm font-semibold tabular-nums">{counts[s]}</span>
              <span className="text-xs text-muted-foreground">{STATUS[s].label.toLowerCase()}</span>
            </div>
          ))}
      </div>

      {/* Agregar servicios a otro proyecto (admin): alineado a la derecha de la barra de resumen. */}
      {isAdmin && emptyProjects.length > 0 && (
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">Agregar a proyecto:</span>
          <Select value={linkProject} onValueChange={(v) => { setLinkProject(v); setLinkOpen(true); }}>
            <SelectTrigger className="h-8 w-48"><SelectValue placeholder="Elige un proyecto…" /></SelectTrigger>
            <SelectContent>
              {emptyProjects.map((p) => <SelectItem key={p.projectId} value={p.projectId}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {linkProject && <ServiceDialog projectId={linkProject} open={linkOpen} onOpenChange={setLinkOpen} onSaved={onSaved} />}
        </div>
      )}
    </div>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-xl font-bold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

// ---- Sección de proyecto ----
function ProjectSection({ p, isAdmin, onChanged }: { p: InfraProject; isAdmin: boolean; onChanged: () => void }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const worst = aggregate(p.services);

  // Franjas: Vercel sola (suele acumular muchos servicios), y Railway + Supabase comparten una
  // franja (pocos cada uno → caben en la misma línea). Orden estable por PROVIDER_ORDER.
  const sortByProvider = (a: InfraService, b: InfraService) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider);
  const vercel = p.services.filter((s) => s.provider === 'vercel');
  const others = p.services.filter((s) => s.provider !== 'vercel').sort(sortByProvider);
  const bands: { providers: ServiceProvider[]; items: InfraService[] }[] = [];
  if (vercel.length) bands.push({ providers: ['vercel'], items: vercel });
  if (others.length) bands.push({ providers: PROVIDER_ORDER.filter((pr) => others.some((s) => s.provider === pr)), items: others });

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Tooltip>
            <TooltipTrigger asChild><span className={cn('size-2.5 rounded-full', STATUS[worst].dot)} /></TooltipTrigger>
            <TooltipContent>{STATUS[worst].label}</TooltipContent>
          </Tooltip>
          <h2 className="text-lg font-semibold tracking-tight">{p.name}</h2>
          <Badge variant={p.kind === 'client' ? 'default' : 'secondary'}>{p.kind === 'client' ? 'Cliente' : 'Interno'}</Badge>
          <span className="text-xs text-muted-foreground">{p.services.length} {p.services.length === 1 ? 'servicio' : 'servicios'}</span>
        </div>
        {isAdmin && <Button variant="outline" size="sm" onClick={() => setLinkOpen(true)}><Plus /> Vincular</Button>}
      </div>

      {/* Cada franja es su propia grilla densa (2–3 col). Vercel va sola; Railway + Supabase
          comparten franja para que sus pocos servicios queden en la misma línea. */}
      <div className="space-y-5">
        {bands.map((b) => (
          <div key={b.providers.join('-')} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <BandHeader providers={b.providers} />
            {b.items.map((s) => (
              <ServiceCard key={s.id} projectId={p.projectId} s={s} isAdmin={isAdmin} onChanged={onChanged} />
            ))}
          </div>
        ))}
      </div>

      <ServiceDialog projectId={p.projectId} open={linkOpen} onOpenChange={setLinkOpen} onSaved={onChanged} />
    </section>
  );
}

// Encabezado de franja: lista los proveedores presentes (icono + nombre). Ocupa la fila completa.
function BandHeader({ providers }: { providers: ServiceProvider[] }) {
  return (
    <div className="col-span-full flex items-center gap-3 pt-1">
      {providers.map((prov) => {
        const { name, Icon, accent } = PROVIDER[prov];
        return (
          <span key={prov} className="flex items-center gap-1.5">
            <Icon className={cn('size-3.5', accent)} />
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{name}</span>
          </span>
        );
      })}
      <span className="ml-1 h-px flex-1 bg-border" />
    </div>
  );
}

// ---- Tarjeta de servicio ----
function ServiceCard({ projectId, s, isAdmin, onChanged }: { projectId: string; s: InfraService; isAdmin: boolean; onChanged: () => void }) {
  const { Icon, accent, chip } = PROVIDER[s.provider];
  const st = STATUS[s.status];
  const title = s.label || (s.provider === 'supabase' ? 'Base de datos' : s.externalRef);
  const [editOpen, setEditOpen] = useState(false);

  async function unlink() {
    try {
      await apiSend('DELETE', `/projects/${projectId}/services/${s.id}`);
      toast.success('Servicio desvinculado', { description: `${PROVIDER[s.provider].name} · ${title}` });
      onChanged();
    } catch (e: any) {
      toast.error('No se pudo desvincular', { description: String(e.message ?? e) });
    }
  }

  return (
    <>
    <Card className="group relative overflow-hidden">
      <CardContent className="space-y-3 p-4">
        {/* Encabezado */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', chip)}><Icon className={cn('size-4', accent)} /></span>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-bold leading-tight tracking-tight">{title}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">{s.externalRef}</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold', st.pill)} title={s.providerStatus ?? st.label}>
              <LiveDot status={s.status} />
              {friendlyStatus(s)}
            </span>
            {isAdmin && (
              <div className="flex items-center opacity-0 transition group-hover:opacity-100">
                <button onClick={() => setEditOpen(true)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="Editar">
                  <Pencil className="size-3.5" />
                </button>
                <button onClick={unlink} className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title="Desvincular">
                  <X className="size-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Cuerpo */}
        {s.ok === false ? (
          <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-words">{s.error ?? 'No se pudo consultar'}</span>
          </div>
        ) : s.ok === null ? (
          <div className="rounded-lg bg-muted/50 px-2.5 py-2 text-xs text-muted-foreground">Pendiente de sondear…</div>
        ) : s.provider === 'supabase' ? (
          <SupabaseBody s={s} />
        ) : (
          <DeployBody s={s} />
        )}

        {/* Pie */}
        <div className="flex items-center justify-between border-t pt-2.5 text-[11px] text-muted-foreground">
          <span>{s.capturedAt ? `actualizado ${relative(s.capturedAt)}` : 'sin sondear'}</span>
          {(s.deploy?.url || s.details?.productionUrl) && (
            <a href={s.deploy?.url ?? s.details?.productionUrl ?? '#'} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
              Abrir <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </CardContent>
    </Card>
    {isAdmin && <ServiceDialog projectId={projectId} service={s} open={editOpen} onOpenChange={setEditOpen} onSaved={onChanged} />}
    </>
  );
}

// Cuerpo para Vercel / Railway (tienen deploy).
function DeployBody({ s }: { s: InfraService }) {
  const d = s.deploy;
  const det = s.details;
  const duration = fmtDuration(d?.durationMs);
  return (
    <div className="space-y-2.5">
      {d?.commitMessage ? (
        <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <GitCommitHorizontal className="mt-0.5 size-3 shrink-0" />
          <span className="line-clamp-2 leading-snug">{d.commitMessage}</span>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">Sin deploy reciente</div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {d?.branch && <span className="inline-flex items-center gap-1"><GitBranch className="size-3" />{d.branch}</span>}
        {d?.author && <span>@{d.author}</span>}
        {d?.createdAt && <span className="inline-flex items-center gap-1"><Clock className="size-3" />{relative(d.createdAt)}</span>}
        {duration && <span className="inline-flex items-center gap-1"><Timer className="size-3" />{duration}</span>}
        {det?.framework && <Tag>{det.framework}</Tag>}
        {det?.runtime && <Tag>{det.runtime}</Tag>}
        {typeof det?.replicas === 'number' && <Tag>{det.replicas}× réplica{det.replicas !== 1 ? 's' : ''}</Tag>}
        {det?.region && <span className="inline-flex items-center gap-1"><Globe className="size-3" />{det.region}</span>}
      </div>

      {!!det?.recent?.length && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">Recientes</span>
          <div className="flex gap-1">
            {det.recent.slice(0, 8).map((r, i) => {
              const ds = mapDeployState(r.state);
              return (
                <Tooltip key={i}>
                  <TooltipTrigger asChild><span className={cn('h-3.5 w-1.5 rounded-sm', STATUS[ds].dot)} /></TooltipTrigger>
                  <TooltipContent>{r.state}{r.createdAt ? ` · ${relative(r.createdAt)}` : ''}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Cuerpo para Supabase (salud por subsistema + métricas).
function SupabaseBody({ s }: { s: InfraService }) {
  const det = s.details;
  const m = s.metrics;
  return (
    <div className="space-y-2.5">
      {!!det?.subsystems?.length && (
        <div className="flex flex-wrap gap-1.5">
          {det.subsystems.map((sub) => (
            <span key={sub.name} className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium', sub.healthy ? 'bg-success/12 text-success' : 'bg-destructive/12 text-destructive')}>
              <span className={cn('size-1.5 rounded-full', sub.healthy ? 'bg-success' : 'bg-destructive')} />
              {sub.name}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {m && typeof m.requests === 'number' && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1 text-foreground"><Activity className="size-3 text-muted-foreground" /><span className="font-semibold tabular-nums">{compact(m.requests)}</span> peticiones/24h</span>
            </TooltipTrigger>
            <TooltipContent>
              <div className="space-y-0.5 text-xs">
                <div>REST: {compact(m.rest ?? 0)}</div>
                <div>Auth: {compact(m.auth ?? 0)}</div>
                <div>Realtime: {compact(m.realtime ?? 0)}</div>
                <div>Storage: {compact(m.storage ?? 0)}</div>
              </div>
            </TooltipContent>
          </Tooltip>
        )}
        {det?.region && <span className="inline-flex items-center gap-1"><Globe className="size-3" />{det.region}</span>}
        {det?.dbVersion && <span className="inline-flex items-center gap-1"><Cpu className="size-3" />PG {det.dbVersion.split('.').slice(0, 2).join('.')}</span>}
      </div>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"><Layers className="size-2.5" />{children}</span>;
}

function mapDeployState(state: string): ServiceStatus {
  const s = state.toUpperCase();
  if (['READY', 'SUCCESS'].includes(s)) return 'healthy';
  if (['ERROR', 'FAILED', 'CRASHED'].includes(s)) return 'down';
  if (['BUILDING', 'QUEUED', 'DEPLOYING', 'INITIALIZING', 'WAITING'].includes(s)) return 'degraded';
  if (['REMOVED', 'CANCELED', 'SLEEPING'].includes(s)) return 'paused';
  return 'unknown';
}

// ---- Vincular a un proyecto que aún no tiene servicios (admin) ----
function LinkToEmptyProject({ projects, onSaved }: { projects: InfraProject[]; onSaved: () => void }) {
  const [projectId, setProjectId] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-wrap items-center gap-3 py-4">
        <span className="text-sm text-muted-foreground">Agregar servicios a otro proyecto:</span>
        <Select value={projectId} onValueChange={(v) => { setProjectId(v); setOpen(true); }}>
          <SelectTrigger className="h-9 w-64"><SelectValue placeholder="Elige un proyecto…" /></SelectTrigger>
          <SelectContent>
            {projects.map((p) => <SelectItem key={p.projectId} value={p.projectId}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {projectId && <ServiceDialog projectId={projectId} open={open} onOpenChange={setOpen} onSaved={onSaved} />}
      </CardContent>
    </Card>
  );
}

// ---- Dialog: vincular un servicio externo a un proyecto ----
const REF_HINT: Record<ServiceProvider, string> = {
  vercel: 'Project ID de Vercel (prj_…)',
  railway: 'Service ID de Railway (UUID del servicio, NO del proyecto)',
  supabase: 'Project ref de Supabase (el ref corto, NO la URL/dominio)',
};

// Team de Vercel por defecto (editable). La mayoría de los proyectos viven bajo este team.
const VERCEL_DEFAULT_TEAM = 'team_0lS30dpDZz11G10eqcdLJ9VZ';
function defaultExtra(p: ServiceProvider): string {
  return p === 'vercel' ? VERCEL_DEFAULT_TEAM : '';
}

function ServiceDialog({ projectId, service, open, onOpenChange, onSaved }: { projectId: string; service?: InfraService; open: boolean; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const editing = !!service;
  const [provider, setProvider] = useState<ServiceProvider>('vercel');
  const [externalRef, setExternalRef] = useState('');
  const [label, setLabel] = useState('');
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const p = service?.provider ?? 'vercel';
    setProvider(p);
    setExternalRef(service?.externalRef ?? '');
    setLabel(service?.label ?? '');
    if (service) {
      const cfg = service.config ?? {};
      setExtra(((cfg.teamId as string) || (cfg.environmentId as string) || '') as string);
    } else {
      setExtra(defaultExtra(p));
    }
  }, [open, service]);

  // Al cambiar de proveedor, propone el valor por defecto del campo extra (editable).
  function changeProvider(v: ServiceProvider) {
    setProvider(v);
    setExtra(defaultExtra(v));
  }

  async function save() {
    if (!externalRef.trim()) return;
    setBusy(true);
    try {
      const config: Record<string, string> = {};
      if (extra.trim()) {
        if (provider === 'vercel') config.teamId = extra.trim();
        else if (provider === 'railway') config.environmentId = extra.trim();
      }
      const body = { provider, externalRef: externalRef.trim(), label: label.trim() || null, config };
      if (editing) {
        await apiSend('PATCH', `/projects/${projectId}/services/${service!.id}`, body);
        toast.success('Servicio actualizado', { description: `${PROVIDER[provider].name} · ${externalRef.trim()}` });
      } else {
        await apiSend('POST', `/projects/${projectId}/services`, body);
        toast.success('Servicio vinculado', { description: `${PROVIDER[provider].name} · ${externalRef.trim()}` });
      }
      onOpenChange(false);
      onSaved();
    } catch (e: any) {
      toast.error(editing ? 'No se pudo guardar' : 'No se pudo vincular', { description: String(e.message ?? e) });
    }
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar servicio' : 'Vincular servicio'}</DialogTitle>
          <DialogDescription>El sondeo consultará su estado cada 15 min y lo mostrará aquí.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="svc-provider">Proveedor</Label>
            <Select value={provider} onValueChange={(v) => changeProvider(v as ServiceProvider)}>
              <SelectTrigger id="svc-provider"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="vercel">Vercel</SelectItem>
                <SelectItem value="railway">Railway</SelectItem>
                <SelectItem value="supabase">Supabase</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="svc-ref">Referencia</Label>
            <Input id="svc-ref" value={externalRef} onChange={(e) => setExternalRef(e.target.value)} placeholder={REF_HINT[provider]} className="font-mono" autoFocus />
            <p className="text-xs text-muted-foreground">{REF_HINT[provider]}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="svc-label">Nombre del servicio <span className="text-muted-foreground">(opcional)</span></Label>
            <Input id="svc-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ej. frontend prod" />
          </div>
          {provider !== 'supabase' && (
            <div className="space-y-1.5">
              <Label htmlFor="svc-extra">{provider === 'vercel' ? 'Team ID' : 'Environment ID'} <span className="text-muted-foreground">(opcional)</span></Label>
              <Input id="svc-extra" value={extra} onChange={(e) => setExtra(e.target.value)} className="font-mono" />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={save} disabled={busy || !externalRef.trim()}>{busy ? 'Guardando…' : editing ? 'Guardar' : 'Vincular'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
