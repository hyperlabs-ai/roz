import { useEffect, useMemo, useState } from 'react';
import {
  Server, Plus, Pencil, X, ExternalLink, TriangleAlert, GitCommitHorizontal, GitBranch,
  Triangle, TrainFront, Database, Clock, Timer, Globe, Activity, Cpu, Layers, Loader2,
} from 'lucide-react';
import { Layout } from '@/components/Layout';
import { EmptyState, ErrorCard, Fresh, RefreshButton } from '@/components/bits';
import { MetricCard } from '@/components/MetricCard';
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
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { useApi } from '@/lib/useApi';
import { useMirror, type Mirror } from '@/lib/useMirror';
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

/** Servicio + el proyecto al que pertenece: el espejo es una lista PLANA. */
export type ServiceRow = InfraService & { projectId: string };

export default function Infra() {
  const { user } = useAuth();
  const isAdmin = !!user; // control total para cualquier usuario autenticado (sin roles)
  // Misma clave que el bloque de infra del Resumen: navegar Resumen → Infraestructura ya no vuelve
  // a pedir /infra (que en el backend es un N+1 de snapshots).
  const { data, loading, refetching, error, reload } = useApi<InfraResponse>(() => apiGet('/infra'), [], {
    key: '/infra',
    ttl: 60_000,
  });

  // Se APLANAN los servicios para poder sustituir UNO sin tocar los demás. Antes cualquier cambio
  // hacía `reload()` de /infra entero: todas las tarjetas se remontaban, los puntos de estado
  // relataban su animación y las franjas se reordenaban. Con la clave del espejo en `service.id`,
  // React conserva la identidad de cada tarjeta.
  const flat = useMemo<ServiceRow[]>(
    () => (data?.projects ?? []).flatMap((p) => p.services.map((sv) => ({ ...sv, projectId: p.projectId }))),
    [data],
  );
  const services = useMirror<ServiceRow>(flat);

  // Los metadatos del proyecto vienen del payload; los servicios, del espejo.
  const projects = useMemo<InfraProject[]>(
    () => (data?.projects ?? []).map((p) => ({ ...p, services: services.items.filter((sv) => sv.projectId === p.projectId) })),
    [data, services.items],
  );
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
      actions={<RefreshButton busy={refetching} onClick={reload} title="Volver a leer el estado" />}
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
              services={services}
            />
          )}

          {withServices.map((p) => (
            <ProjectSection key={p.projectId} p={p} isAdmin={isAdmin} services={services} />
          ))}

          {!withServices.length && (
            <Card><CardContent className="py-10"><EmptyState icon={<Server className="size-6" />}>Ningún proyecto tiene servicios vinculados todavía</EmptyState></CardContent></Card>
          )}

          {/* Sin servicios aún: la barra de resumen no se muestra, así que el selector va aquí de fallback. */}
          {isAdmin && !allServices.length && !!emptyProjects.length && <LinkToEmptyProject projects={emptyProjects} services={services} />}
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
  services,
}: {
  total: number;
  counts: Record<ServiceStatus, number>;
  projects: number;
  emptyProjects: InfraProject[];
  isAdmin: boolean;
  services: Mirror<ServiceRow>;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-card px-5 py-3.5">
      {/* Aquí hubo un gauge de anillo con el % de servicios sanos, en dos versiones (arco y
          anillo), y las dos se veían mal. El motivo no era el componente: esta barra mide 56px de
          alto, y dentro de un círculo de ese diámetro el hueco interior da ~36px — "100%" en un
          tamaño legible no cabe ahí sin montarse sobre el trazo. Una gráfica necesita espacio y
          esta franja no lo tiene, así que el dato va como cifra, que es de lo que está hecha la
          franja. Si algún día Infra gana una tarjeta con altura propia, ahí sí tiene sentido. */}
      <MetricCard
        layout="inline"
        surface="plain"
        label="sanos"
        value={total > 0 ? Math.round(((counts.healthy ?? 0) / total) * 100) : 0}
        format={(n) => `${n}%`}
        tone={counts.down ? 'destructive' : counts.degraded ? 'warning' : 'success'}
      />
      <div className="h-8 w-px bg-border" />
      <MetricCard layout="inline" surface="plain" label={projects === 1 ? 'proyecto' : 'proyectos'} value={projects} />
      <div className="h-8 w-px bg-border" />
      <MetricCard layout="inline" surface="plain" label={total === 1 ? 'servicio' : 'servicios'} value={total} />
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
      {/* Antes esto era un <Select> que ABRÍA el diálogo desde `onValueChange`. Radix no dispara ese
          evento si eliges el MISMO valor, y el valor no se limpiaba al cerrar: volver a elegir el
          mismo proyecto no abría nada, nunca. Ahora es un botón y el proyecto se elige DENTRO. */}
      {isAdmin && emptyProjects.length > 0 && (
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setLinkOpen(true)}>
            <Plus /> Vincular a otro proyecto
          </Button>
          <ServiceDialog projects={emptyProjects} open={linkOpen} onOpenChange={setLinkOpen} services={services} />
        </div>
      )}
    </div>
  );
}

// ---- Sección de proyecto ----
function ProjectSection({ p, isAdmin, services }: { p: InfraProject; isAdmin: boolean; services: Mirror<ServiceRow> }) {
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
              <Fresh key={s.id} fresh={services.isFresh(s.id)} className="h-full">
                <ServiceCard s={s as ServiceRow} isAdmin={isAdmin} services={services} />
              </Fresh>
            ))}
          </div>
        ))}
      </div>

      <ServiceDialog projectId={p.projectId} open={linkOpen} onOpenChange={setLinkOpen} services={services} />
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
function ServiceCard({ s, isAdmin, services }: { s: ServiceRow; isAdmin: boolean; services: Mirror<ServiceRow> }) {
  const { Icon, accent, chip } = PROVIDER[s.provider];
  const st = STATUS[s.status];
  const title = s.label || (s.provider === 'supabase' ? 'Base de datos' : s.externalRef);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const busy = services.isBusy(s.id);

  // Desvincular corta el histórico de disponibilidad y no se deshace desde esta pantalla, así que
  // ahora pide confirmación (antes era un clic en una X de 14px que aparecía al hover) y bloquea el
  // botón mientras viaja (antes un doble clic mandaba dos DELETE).
  const unlink = () =>
    services.remove(s, () => apiSend('DELETE', `/projects/${s.projectId}/services/${s.id}`), {
      success: { title: 'Servicio desvinculado', description: `${PROVIDER[s.provider].name} · ${title}` },
      error: 'No se pudo desvincular',
    });

  return (
    <>
    <Card className="group relative h-full overflow-hidden">
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
                <button onClick={() => setEditOpen(true)} disabled={busy} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50" title="Editar">
                  <Pencil className="size-3.5" />
                </button>
                <button onClick={() => setConfirmOpen(true)} disabled={busy} className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50" title="Desvincular">
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
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
          <div className="rounded-lg bg-muted/50 px-2.5 py-2 text-xs text-muted-foreground">
            Aún sin sondear · su estado llega en el próximo ciclo (≤15 min)
          </div>
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
    {isAdmin && <ServiceDialog projectId={s.projectId} service={s} open={editOpen} onOpenChange={setEditOpen} services={services} />}
    {isAdmin && (
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Desvincular {title}?</AlertDialogTitle>
            <AlertDialogDescription>
              Deja de sondearse y su histórico de disponibilidad se detiene ahí. Puedes volver a
              vincularlo después con la misma referencia.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
            {/* preventDefault: Radix cerraría el diálogo antes de que salga el DELETE. */}
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => { e.preventDefault(); void unlink().finally(() => setConfirmOpen(false)); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? <><Loader2 className="animate-spin" /> Desvinculando…</> : 'Desvincular'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )}
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
                  <TooltipTrigger asChild>
                    <span className={cn('h-3.5 w-1.5 rounded-full transition-transform duration-fast ease-spring hover:scale-y-125', STATUS[ds].dot)} />
                  </TooltipTrigger>
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
function LinkToEmptyProject({ projects, services }: { projects: InfraProject[]; services: Mirror<ServiceRow> }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-wrap items-center gap-3 py-4">
        <span className="text-sm text-muted-foreground">Ningún proyecto tiene servicios vinculados todavía.</span>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Plus /> Vincular el primero
        </Button>
        <ServiceDialog projects={projects} open={open} onOpenChange={setOpen} services={services} />
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

function ServiceDialog({
  projectId,
  projects,
  service,
  open,
  onOpenChange,
  services,
}: {
  /** Proyecto fijo (sección de un proyecto, o edición). */
  projectId?: string;
  /** Si no hay proyecto fijo, se elige aquí dentro. */
  projects?: InfraProject[];
  service?: ServiceRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  services: Mirror<ServiceRow>;
}) {
  const editing = !!service;
  const [pid, setPid] = useState(projectId ?? '');
  const [provider, setProvider] = useState<ServiceProvider>('vercel');
  const [externalRef, setExternalRef] = useState('');
  const [label, setLabel] = useState('');
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset al ABRIR, con dep en el ID del servicio y NUNCA en el objeto: la fila se renueva en cada
  // revalidación de /infra, así que depender de ella reescribía el formulario mientras escribías
  // (el mismo bug que 9d02178 arregló en tareas).
  useEffect(() => {
    if (!open) return;
    const p = service?.provider ?? 'vercel';
    setPid(projectId ?? service?.projectId ?? '');
    setProvider(p);
    setExternalRef(service?.externalRef ?? '');
    setLabel(service?.label ?? '');
    if (service) {
      const cfg = service.config ?? {};
      setExtra(((cfg.teamId as string) || (cfg.environmentId as string) || '') as string);
    } else {
      setExtra(defaultExtra(p));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, service?.id, projectId]);

  // Al cambiar de proveedor, propone el valor por defecto del campo extra (editable).
  function changeProvider(v: ServiceProvider) {
    setProvider(v);
    setExtra(defaultExtra(v));
  }

  async function save() {
    const ref = externalRef.trim();
    if (!ref || !pid) return;
    setBusy(true);
    const config: Record<string, string> = {};
    if (extra.trim()) {
      if (provider === 'vercel') config.teamId = extra.trim();
      else if (provider === 'railway') config.environmentId = extra.trim();
    }
    const body = { provider, externalRef: ref, label: label.trim() || null, config };

    if (editing) {
      // Optimista sobre la tarjeta: el endpoint devuelve la fila cruda de la base (snake_case), no
      // un servicio con estado, así que no hay nada mejor que adoptar — los campos los conocemos.
      await services.patch(service!, { provider, externalRef: ref, label: body.label, config }, async () => {
        await apiSend('PATCH', `/projects/${pid}/services/${service!.id}`, body);
      }, {
        success: { title: 'Servicio actualizado', description: `${PROVIDER[provider].name} · ${ref}` },
        error: 'No se pudo guardar',
      });
    } else {
      const draft: ServiceRow = {
        id: `nuevo:${pid}:${ref}`,
        projectId: pid,
        provider,
        externalRef: ref,
        label: body.label,
        config,
        // `ok: null` es lo que ServiceCard ya pinta como "aún sin sondear": la tarjeta nace honesta.
        capturedAt: null,
        ok: null,
        status: 'unknown',
        providerStatus: null,
        active: null,
        deploy: null,
        metrics: null,
        details: null,
        error: null,
      };
      await services.create(draft, async () => {
        const r = await apiSend<{ service: { id: string } }>('POST', `/projects/${pid}/services`, body);
        return { ...draft, id: r.service.id };
      }, {
        success: {
          title: 'Servicio vinculado',
          description: 'Su estado llega en el próximo sondeo (hasta 15 min).',
        },
        error: 'No se pudo vincular',
      });
    }
    setBusy(false);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar servicio' : 'Vincular servicio'}</DialogTitle>
          <DialogDescription>El sondeo consultará su estado cada 15 min y lo mostrará aquí.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {/* Solo cuando el diálogo no viene de un proyecto concreto. */}
          {!projectId && !!projects?.length && (
            <div className="space-y-1.5">
              <Label htmlFor="svc-project">Proyecto</Label>
              <Select value={pid} onValueChange={setPid}>
                <SelectTrigger id="svc-project"><SelectValue placeholder="Elige un proyecto…" /></SelectTrigger>
                <SelectContent>
                  {projects.map((pr) => <SelectItem key={pr.projectId} value={pr.projectId}>{pr.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
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
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={save} disabled={busy || !externalRef.trim() || !pid}>
            {busy ? <><Loader2 className="animate-spin" /> Guardando…</> : editing ? 'Guardar' : 'Vincular'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
