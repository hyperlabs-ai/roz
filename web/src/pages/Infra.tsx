import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Search, Server, TriangleAlert, X } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { EmptyState, ErrorCard, RefreshButton } from '@/components/bits';
import { CapsLabel, IntegrationIcon } from '@/components/brand';
import { ProjectIcon } from '@/components/avatars';
import { Segmented } from '@/components/pulse/roz-v2';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useApi } from '@/lib/useApi';
import { useMirror } from '@/lib/useMirror';
import { apiGet, type InfraProject, type InfraResponse } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  PROVIDER, PROVIDER_ORDER, SEVERITY, aggregate, deployOf, matchesStatus, serviceTitle, type ServiceRow, type StripsResponse,
} from '@/components/infra/infra-ui';
import { InfraSummary, type ProviderFilter, type StatusFilter } from '@/components/infra/InfraSummary';
import { InfraSkeleton, ProjectServices, type RowActions } from '@/components/infra/ServiceList';
import { ServiceSheet } from '@/components/infra/ServiceSheet';
import { ServiceDialog, UnlinkDialog } from '@/components/infra/ServiceDialog';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'down', label: 'Caídos' },
  { value: 'degraded', label: 'Degradados' },
  { value: 'healthy', label: 'En línea' },
  { value: 'deploy_failed', label: 'Deploy fallido' },
  { value: 'paused', label: 'Pausados' },
  { value: 'unknown', label: 'Sin datos' },
];

function matches(s: ServiceRow, projectName: string, q: string): boolean {
  if (!q) return true;
  const d = deployOf(s);
  const hay = [serviceTitle(s), s.externalRef, projectName, PROVIDER[s.provider].name, d?.branch, d?.commitMessage, d?.author]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

export default function Infra() {
  // Misma clave que el bloque de infra del Resumen: navegar Resumen → Infraestructura no repite /infra.
  const { data, loading, refetching, error, reload } = useApi<InfraResponse>(() => apiGet('/infra'), [], { key: '/infra', ttl: 60_000 });
  const strips = useApi<StripsResponse>(() => apiGet('/infra/strips'), [], { key: '/infra/strips', ttl: 60_000 });

  // Servicios APLANADOS en un espejo: crear/editar/desvincular toca UNA fila sin recargar /infra.
  const flat = useMemo<ServiceRow[]>(
    () => (data?.projects ?? []).flatMap((p) => p.services.map((sv) => ({ ...sv, projectId: p.projectId }))),
    [data],
  );
  const services = useMirror<ServiceRow>(flat);
  const projects = data?.projects ?? [];

  // Filtros
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [provider, setProvider] = useState<ProviderFilter>('all');
  const q = query.trim().toLowerCase();
  const filtering = !!q || status !== 'all' || provider !== 'all';
  const clearFilters = () => {
    setQuery('');
    setStatus('all');
    setProvider('all');
  };

  // Panel de detalle en la URL (`?servicio=id`): se puede compartir y sobrevive a recargar.
  const [params, setParams] = useSearchParams();
  const openId = params.get('servicio');
  const openService = (id: string) => setParams((p) => { p.set('servicio', id); return p; });
  const closeService = () => setParams((p) => { p.delete('servicio'); return p; }, { replace: true });

  // Diálogos (uno por página, no uno por fila)
  const [linkTo, setLinkTo] = useState<string | null | undefined>(undefined); // undefined = cerrado; null = elegir proyecto
  const [editing, setEditing] = useState<ServiceRow | null>(null);
  const [unlinking, setUnlinking] = useState<ServiceRow | null>(null);

  const all = services.items;
  const groups = useMemo(() => {
    const out: { project: InfraProject; services: ServiceRow[] }[] = [];
    for (const p of projects) {
      const list = all
        .filter((s) => s.projectId === p.projectId)
        .filter((s) => matchesStatus(s, status) && (provider === 'all' || s.provider === provider) && matches(s, p.name, q))
        .sort((a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status) || PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider) || serviceTitle(a).localeCompare(serviceTitle(b)));
      if (list.length) out.push({ project: p, services: list });
    }
    // Proyectos con problemas primero; luego los más grandes.
    return out.sort(
      (a, b) =>
        SEVERITY.indexOf(aggregate(a.services.map((s) => s.status))) - SEVERITY.indexOf(aggregate(b.services.map((s) => s.status))) ||
        b.services.length - a.services.length ||
        a.project.name.localeCompare(b.project.name),
    );
  }, [projects, all, status, provider, q]);

  const emptyProjects = projects.filter((p) => !all.some((s) => s.projectId === p.projectId));
  const shown = groups.reduce((a, g) => a + g.services.length, 0);
  const noTokens = all.length > 0 && all.every((s) => s.ok === false && /no configurado/i.test(s.error ?? ''));

  const actions: RowActions = {
    onOpen: openService,
    onEdit: setEditing,
    onUnlink: setUnlinking,
    isFresh: services.isFresh,
    isBusy: services.isBusy,
  };
  const providersPresent = PROVIDER_ORDER.filter((pr) => all.some((s) => s.provider === pr));

  return (
    <Layout
      title="Infraestructura"
      actions={
        <>
          <RefreshButton
            busy={refetching || strips.refetching}
            onClick={() => {
              reload();
              strips.reload();
            }}
            title="Volver a leer el estado"
          />
          {!!projects.length && (
            <Button size="sm" onClick={() => setLinkTo(null)}>
              <Plus /> Vincular servicio
            </Button>
          )}
        </>
      }
    >
      {error && <ErrorCard message={error} className="mb-4" />}

      {noTokens && (
        <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-yellow/40 bg-yellow-soft px-4 py-2.5 text-[13px] text-yellow-ink">
          <TriangleAlert className="size-4 shrink-0" />
          <span className="min-w-0">
            Faltan tokens de API: define <code className="font-mono text-xs">VERCEL_API_TOKEN</code>,{' '}
            <code className="font-mono text-xs">RAILWAY_API_TOKEN</code> o <code className="font-mono text-xs">SUPABASE_ACCESS_TOKEN</code>.
          </span>
        </div>
      )}

      {loading ? (
        <InfraSkeleton />
      ) : !projects.length ? (
        <Card>
          <EmptyState icon={<Server />}>Todavía no hay proyectos. Crea uno en Proyectos para vincular sus servicios.</EmptyState>
        </Card>
      ) : !all.length ? (
        <Card>
          <EmptyState
            icon={<Server />}
            action={<Button size="sm" onClick={() => setLinkTo(null)}><Plus /> Vincular el primero</Button>}
          >
            <span className="mb-3 flex justify-center gap-2">
              {PROVIDER_ORDER.map((pr) => <IntegrationIcon key={pr} name={PROVIDER[pr].icon} size="sm" framed />)}
            </span>
            Vincula un proyecto de Vercel, un servicio de Railway o una base de Supabase y roz vigila su estado cada 15 min.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-5">
          <InfraSummary
            services={all}
            projects={projects.length - emptyProjects.length}
            strips={strips.data}
            status={status}
            provider={provider}
            onStatus={setStatus}
            onProvider={setProvider}
            onOpen={openService}
          />

          {/* Barra de filtros */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar servicio, proyecto, rama o commit…"
                className="h-8 pl-8 pr-8 text-[13px]"
                aria-label="Buscar servicios"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-faint hover:text-foreground"
                  aria-label="Limpiar búsqueda"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            {providersPresent.length > 1 && (
              <Segmented<ProviderFilter>
                value={provider}
                onChange={setProvider}
                options={[
                  { value: 'all', label: 'Todos' },
                  ...providersPresent.map((pr) => ({
                    value: pr as ProviderFilter,
                    label: PROVIDER[pr].name,
                    icon: <IntegrationIcon name={PROVIDER[pr].icon} size="xs" />,
                    count: all.filter((s) => s.provider === pr).length,
                  })),
                ]}
              />
            )}
            <Segmented<StatusFilter>
              value={status}
              onChange={setStatus}
              className="scroll-none max-w-full overflow-x-auto"
              options={STATUS_OPTIONS.filter((o) => o.value === 'all' || o.value === status || all.some((s) => matchesStatus(s, o.value))).map((o) => ({
                ...o,
                count: o.value === 'all' ? undefined : all.filter((s) => matchesStatus(s, o.value)).length,
              }))}
            />
            <span className="ml-auto text-[12px] tabular-nums text-faint">
              {filtering ? `${shown} de ${all.length}` : `${all.length}`} {all.length === 1 ? 'servicio' : 'servicios'}
            </span>
          </div>

          {groups.length ? (
            groups.map((g) => (
              <ProjectServices
                key={g.project.projectId}
                project={g.project}
                services={g.services}
                strips={strips.data}
                actions={actions}
                onLink={(id) => setLinkTo(id)}
              />
            ))
          ) : (
            <Card>
              <EmptyState
                icon={<Search />}
                action={<Button variant="secondary" size="sm" onClick={clearFilters}>Quitar filtros</Button>}
              >
                Ningún servicio coincide con los filtros.
              </EmptyState>
            </Card>
          )}

          {/* Proyectos sin servicios: una línea de chips, no tarjetas vacías. */}
          {!filtering && !!emptyProjects.length && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed px-4 py-3">
              <CapsLabel className="mr-1">Sin servicios</CapsLabel>
              {emptyProjects.map((p) => (
                <button
                  key={p.projectId}
                  type="button"
                  onClick={() => setLinkTo(p.projectId)}
                  className={cn(
                    'group inline-flex h-7 items-center gap-1.5 rounded-sm bg-panel px-2 text-[12.5px] font-medium text-muted-foreground transition-colors',
                    'hover:bg-orange-soft hover:text-orange-ink',
                  )}
                  title={`Vincular un servicio a ${p.name}`}
                >
                  <ProjectIcon id={p.projectId} name={p.name} size="xs" className="size-4" />
                  {p.name}
                  <Plus className="size-3 opacity-50 group-hover:opacity-100" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <ServiceSheet
        serviceId={openId}
        row={openId ? all.find((s) => s.id === openId) : undefined}
        onClose={closeService}
        onEdit={setEditing}
        onUnlink={setUnlinking}
      />

      <ServiceDialog
        projectId={linkTo ?? undefined}
        projects={projects}
        open={linkTo !== undefined}
        onOpenChange={(v) => !v && setLinkTo(undefined)}
        services={services}
      />
      {editing && (
        <ServiceDialog
          projectId={editing.projectId}
          service={editing}
          open
          onOpenChange={(v) => !v && setEditing(null)}
          services={services}
        />
      )}
      {unlinking && (
        <UnlinkDialog
          service={unlinking}
          open
          onOpenChange={(v) => !v && setUnlinking(null)}
          services={services}
          onDone={() => openId === unlinking.id && closeService()}
        />
      )}
    </Layout>
  );
}
