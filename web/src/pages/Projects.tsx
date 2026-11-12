import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Archive, ChevronRight, CircleCheck, Code2, FolderGit2, GitCommitHorizontal, GripVertical,
  LayoutGrid, List, Plus, Search, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { BalancedGrid } from '@/components/grid';
import { MetricCard } from '@/components/MetricCard';
import { Segmented } from '@/components/pulse/roz-v2';
import { UserAvatar, LineDelta, ErrorCard, Fresh, RefreshButton, Revalidating, EmptyState } from '@/components/bits';
import { ProjectIcon } from '@/components/avatars';
import { ProjectDialog, ArchiveProjectDialog, DeleteProjectDialog } from '@/components/projects/ProjectDialogs';
import { ProjectMenu } from '@/components/projects/ProjectMenu';
import { fold, isArchived, projectColor, projectHaystack, type ProjectDraft, type ProjectRow } from '@/components/projects/project-ui';
import { useAuth } from '@/auth/AuthContext';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useApi } from '@/lib/useApi';
import { useMirror } from '@/lib/useMirror';
import { invalidate } from '@/lib/store';
import { apiGet, apiSend, PROJECT_TYPES, PROJECT_TYPE_LABEL } from '@/lib/api';
import { compact } from '@/lib/format';
import { usePeriod } from '@/lib/usePeriod';

// ---- Preferencias locales (por navegador): orden manual, orden elegido y vista ----
const ORDER_KEY = 'roz.projectOrder';
const PREFS_KEY = 'roz.projectPrefs';

type StatusFilter = 'active' | 'archived' | 'all';
type KindFilter = 'all' | 'client' | 'internal';
type SortKey = 'custom' | 'activity' | 'name' | 'tickets' | 'lines';
type ViewMode = 'grid' | 'list';

const SORTS: Record<SortKey, { label: string; cmp?: (a: ProjectRow, b: ProjectRow) => number }> = {
  custom: { label: 'Orden manual' },
  activity: { label: 'Más commits', cmp: (a, b) => b.commits - a.commits },
  lines: { label: 'Más líneas', cmp: (a, b) => b.additions + b.deletions - (a.additions + a.deletions) },
  tickets: { label: 'Más tareas cerradas', cmp: (a, b) => b.ticketsResolved - a.ticketsResolved },
  name: { label: 'Nombre (A–Z)', cmp: (a, b) => a.name.localeCompare(b.name, 'es') },
};

function readJson<T>(key: string, fallback: T): T {
  try { const r = localStorage.getItem(key); return r ? (JSON.parse(r) as T) : fallback; } catch { return fallback; }
}
function writeJson(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* sin storage: solo en memoria */ }
}

const typeLabel = (t: string) => PROJECT_TYPE_LABEL[t] ?? t;

export default function Projects() {
  const [period, setPeriod] = usePeriod();
  const { user } = useAuth();
  const isAdmin = !!user; // control total para cualquier usuario autenticado (sin roles)
  const nav = useNavigate();
  const { data, loading, refetching, error, reload } = useApi<{ projects: ProjectRow[] }>(
    () => apiGet('/projects', period.range),
    [period.range.from, period.range.to],
    { key: '/projects', ttl: 60_000 },
  );

  // Espejo: crear, editar, archivar o borrar se ve en el frame del clic, sin recargar la lista.
  const projects = useMirror<ProjectRow>(data?.projects, { key: (x) => x.projectId });

  // ---- Buscador, filtros, orden y vista ----
  const prefs = useMemo(() => readJson<{ sort?: SortKey; view?: ViewMode }>(PREFS_KEY, {}), []);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [kind, setKind] = useState<KindFilter>('all');
  const [type, setType] = useState<string>('all');
  const [sort, setSort] = useState<SortKey>(prefs.sort && prefs.sort in SORTS ? prefs.sort : 'custom');
  const [view, setView] = useState<ViewMode>(prefs.view === 'list' ? 'list' : 'grid');
  useEffect(() => writeJson(PREFS_KEY, { sort, view }), [sort, view]);

  // "/" enfoca el buscador (como en Linear y GitHub), salvo que ya se esté escribiendo en algo.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || t?.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- Orden manual por arrastre (se guarda por navegador; lo nuevo va primero) ----
  const [order, setOrder] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const dragImgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    // Imagen de arrastre transparente: se mueve la tarjeta REAL, sin fantasma translúcido.
    const img = new Image();
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    dragImgRef.current = img;
  }, []);
  // Deps en la lista de ids serializada, no en el array (que es nuevo en cada revalidación y
  // redisparaba la animación de entrada de toda la grilla).
  const ids = projects.items.map((x) => x.projectId).join(',');
  useEffect(() => {
    const list = ids ? ids.split(',') : [];
    if (!list.length) return;
    const saved = readJson<string[]>(ORDER_KEY, []);
    setOrder([...list.filter((id) => !saved.includes(id)), ...saved.filter((id) => list.includes(id))]);
  }, [ids]);
  useEffect(() => { if (order.length) writeJson(ORDER_KEY, order); }, [order]);

  function liveReorder(overId: string) {
    const from = dragIdRef.current;
    if (!from || from === overId) return;
    setOrder((prev) => {
      const a = [...prev];
      const fi = a.indexOf(from);
      const ti = a.indexOf(overId);
      if (fi < 0 || ti < 0) return prev;
      a.splice(fi, 1);
      a.splice(ti, 0, from);
      return a;
    });
  }

  // `stagger-children` solo en el primer pintado (es animación de ENTRADA).
  const [stagger, setStagger] = useState(true);
  useEffect(() => { const t = setTimeout(() => setStagger(false), 700); return () => clearTimeout(t); }, []);

  // ---- Derivados ----
  const counts = useMemo(() => {
    const archived = projects.items.filter(isArchived).length;
    return { active: projects.items.length - archived, archived, all: projects.items.length };
  }, [projects.items]);

  const activeOnes = useMemo(() => projects.items.filter((p) => !isArchived(p)), [projects.items]);
  const totals = useMemo(() => activeOnes.reduce(
    (s, p) => ({ commits: s.commits + p.commits, lines: s.lines + p.additions + p.deletions, tickets: s.tickets + p.ticketsResolved, idle: s.idle + (p.commits === 0 ? 1 : 0) }),
    { commits: 0, lines: 0, tickets: 0, idle: 0 },
  ), [activeOnes]);

  // Tipos que de verdad existen (el filtro no ofrece opciones vacías).
  const presentTypes = useMemo(() => {
    const set = new Set(projects.items.map((p) => p.projectType).filter(Boolean) as string[]);
    return PROJECT_TYPES.filter((t) => set.has(t.value));
  }, [projects.items]);

  const needle = fold(q.trim());
  const filtersOn = !!needle || kind !== 'all' || type !== 'all';

  const visible = useMemo(() => {
    const byId = new Map(projects.items.map((p) => [p.projectId, p]));
    const base = sort === 'custom'
      ? [...order.map((id) => byId.get(id)).filter(Boolean) as ProjectRow[], ...projects.items.filter((p) => !order.includes(p.projectId))]
      : [...projects.items].sort(SORTS[sort].cmp);
    return base.filter((p) => {
      if (status === 'active' && isArchived(p)) return false;
      if (status === 'archived' && !isArchived(p)) return false;
      if (kind !== 'all' && p.kind !== kind) return false;
      if (type === 'none' ? !!p.projectType : type !== 'all' && p.projectType !== type) return false;
      return !needle || fold(projectHaystack(p, typeLabel)).includes(needle);
    });
  }, [projects.items, order, sort, status, kind, type, needle]);

  const canDrag = sort === 'custom' && !filtersOn && view === 'grid';
  const clearFilters = () => { setQ(''); setKind('all'); setType('all'); };

  // ---- Mutaciones (optimistas vía espejo) ----
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectRow | null>(null);
  const [archiving, setArchiving] = useState<ProjectRow | null>(null);
  const [deleting, setDeleting] = useState<ProjectRow | null>(null);

  const createProject = (d: ProjectDraft) => {
    const zero = { commits: 0, additions: 0, deletions: 0, contributors: [], repos: [], ticketsResolved: 0 };
    return projects.create(
      {
        projectId: `nuevo:${d.name}`, name: d.name, key: (d.key || d.name.slice(0, 6)).toUpperCase(), kind: d.kind,
        color: d.color, projectType: d.projectType, description: d.description, profileSource: d.projectType || d.description ? 'humano' : null,
        active: true, ...zero,
      },
      async () => {
        const r = await apiSend<{ project: { id: string; name: string; key: string; kind: ProjectRow['kind']; color: string | null } }>(
          'POST', '/projects',
          { name: d.name, key: d.key || undefined, kind: d.kind, color: d.color, projectType: d.projectType, description: d.description },
        );
        // Se adopta lo que devuelve el backend (la `key` la puede haber generado él).
        return {
          projectId: r.project.id, name: r.project.name, key: r.project.key, kind: r.project.kind, color: r.project.color,
          projectType: d.projectType, description: d.description, profileSource: d.projectType || d.description ? 'humano' : null,
          active: true, ...zero,
        };
      },
      { success: { title: 'Proyecto creado', description: d.name } },
    ).then((created) => {
      invalidate('/overview');
      // Si había filtros que lo esconderían, se limpian: crear y no ver nada parece un fallo.
      if (created) { setStatus('active'); clearFilters(); }
      return created;
    });
  };

  const updateProject = (p: ProjectRow, d: ProjectDraft) => {
    const body: Record<string, unknown> = { name: d.name, kind: d.kind, color: d.color };
    if (d.key) body.key = d.key;
    // El perfil solo se manda si cambió: tocarlo lo marca como "revisado por una persona".
    if ((d.projectType ?? null) !== (p.projectType ?? null)) body.projectType = d.projectType;
    if ((d.description ?? null) !== (p.description ?? null)) body.description = d.description;
    const profileTouched = 'projectType' in body || 'description' in body;
    return projects.patch(
      p,
      { name: d.name, key: d.key || p.key, kind: d.kind, color: d.color, projectType: d.projectType, description: d.description, ...(profileTouched ? { profileSource: 'humano' as const } : {}) },
      async () => { await apiSend('PATCH', `/projects/${p.projectId}`, body); },
      { success: { title: 'Proyecto actualizado', description: d.name } },
    ).then(() => invalidate('/projects/detail'));
  };

  const toggleArchive = (p: ProjectRow) => {
    const next = isArchived(p); // archivado → se restaura (active: true)
    return projects.patch(
      p,
      { active: next },
      async () => { await apiSend('PATCH', `/projects/${p.projectId}`, { active: next }); },
      { success: { title: next ? 'Proyecto restaurado' : 'Proyecto archivado', description: p.name } },
    ).then(() => { invalidate('/overview'); invalidate('/projects/detail'); });
  };

  const deleteProject = (p: ProjectRow) =>
    projects.remove(p, () => apiSend('DELETE', `/projects/${p.projectId}`), {
      success: { title: 'Proyecto eliminado', description: p.name },
      error: 'No se pudo eliminar',
    }).then(() => invalidate('/overview'));

  const menu = (p: ProjectRow) =>
    isAdmin ? (
      <ProjectMenu
        archived={isArchived(p)}
        onEdit={() => setEditing(p)}
        onArchive={() => setArchiving(p)}
        onDelete={() => setDeleting(p)}
      />
    ) : null;

  return (
    <Layout
      title="Proyectos"
      actions={
        <div className="flex items-center gap-2">
          <RefreshButton busy={refetching} onClick={reload} />
          <PeriodPicker value={period} onChange={setPeriod} />
          {isAdmin && <Button variant="brand" onClick={() => setCreateOpen(true)}><Plus /> <span className="hidden sm:inline">Nuevo proyecto</span></Button>}
        </div>
      }
    >
      {error && <ErrorCard message={error} className="mb-4" />}

      {loading ? (
        <ProjectsSkeleton />
      ) : !projects.items.length ? (
        <div className="grid justify-items-center gap-3 rounded-xl bg-panel px-6 py-16 text-center">
          <div className="grid size-12 place-items-center rounded-lg bg-card text-muted-foreground"><FolderGit2 className="size-5" /></div>
          <h3 className="text-xl font-semibold tracking-[-0.03em]">Todavía no hay proyectos</h3>
          <p className="max-w-sm text-sm text-muted-foreground">Crea uno y vincúlale sus repos: roz empieza a contar commits, líneas y tareas cerradas.</p>
          {isAdmin && <Button variant="brand" className="mt-1" onClick={() => setCreateOpen(true)}><Plus /> Crear proyecto</Button>}
        </div>
      ) : (
        <div className="grid gap-4">
          {/* Resumen de los activos en el período */}
          <BalancedGrid max={{ base: 2, lg: 4 }} className="gap-3.5">
            <MetricCard icon={FolderGit2} label="Proyectos activos" value={counts.active} sub={totals.idle ? `${totals.idle} sin commits en el período` : 'todos con actividad'} />
            <MetricCard icon={GitCommitHorizontal} label="Commits" value={totals.commits} format={compact} colorVar="--chart-1" />
            <MetricCard icon={Code2} label="Líneas cambiadas" value={totals.lines} format={compact} colorVar="--chart-4" />
            <MetricCard icon={CircleCheck} label="Tareas cerradas" value={totals.tickets} colorVar="--chart-3" />
          </BalancedGrid>

          {/* Barra de herramientas: buscar, filtrar, ordenar, cambiar vista */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" />
              <Input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQ('')}
                placeholder="Buscar por nombre, clave, repo o persona"
                aria-label="Buscar proyectos"
                className="pl-8 pr-8"
              />
              {q ? (
                <button type="button" onClick={() => setQ('')} aria-label="Limpiar búsqueda" className="absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-faint hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              ) : (
                <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-[4px] border bg-panel px-1.5 text-[11px] text-faint sm:block">/</kbd>
              )}
            </div>

            <Segmented<StatusFilter>
              value={status}
              onChange={setStatus}
              options={[
                { value: 'active', label: 'Activos', count: counts.active },
                { value: 'archived', label: 'Archivados', count: counts.archived },
                { value: 'all', label: 'Todos' },
              ]}
            />

            <Select value={kind} onValueChange={(v) => setKind(v as KindFilter)}>
              <SelectTrigger className={cn('h-8 w-auto gap-1.5 text-[12.5px]', kind !== 'all' && 'border-orange/50 bg-orange-soft text-orange-ink')} aria-label="Filtrar por clase">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Cliente e interno</SelectItem>
                <SelectItem value="client">Solo clientes</SelectItem>
                <SelectItem value="internal">Solo internos</SelectItem>
              </SelectContent>
            </Select>

            <Select value={type} onValueChange={setType}>
              <SelectTrigger className={cn('h-8 w-auto gap-1.5 text-[12.5px]', type !== 'all' && 'border-orange/50 bg-orange-soft text-orange-ink')} aria-label="Filtrar por tipo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los tipos</SelectItem>
                {presentTypes.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                <SelectItem value="none">Sin tipo</SelectItem>
              </SelectContent>
            </Select>

            {filtersOn && (
              <Button variant="ghost" size="sm" onClick={clearFilters} className="text-muted-foreground"><X /> Limpiar</Button>
            )}

            <div className="ml-auto flex items-center gap-2">
              <span className="hidden text-[12px] text-faint tabular-nums md:inline">
                {visible.length} de {status === 'all' ? counts.all : counts[status]}
              </span>
              <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                <SelectTrigger className="h-8 w-auto gap-1.5 text-[12.5px]" aria-label="Ordenar"><SelectValue /></SelectTrigger>
                <SelectContent align="end">
                  {(Object.keys(SORTS) as SortKey[]).map((k) => <SelectItem key={k} value={k}>{SORTS[k].label}</SelectItem>)}
                </SelectContent>
              </Select>
              <div role="group" aria-label="Vista" className="inline-flex rounded-md bg-panel p-[3px]">
                {([['grid', LayoutGrid, 'Tarjetas'], ['list', List, 'Lista']] as const).map(([v, Icon, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    aria-pressed={view === v}
                    aria-label={label}
                    title={label}
                    className={cn('grid h-[26px] w-8 place-items-center rounded-sm transition-colors', view === v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                  >
                    <Icon className="size-3.5" />
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Resultado */}
          {!visible.length ? (
            <Card>
              <EmptyState
                icon={filtersOn ? <Search /> : status === 'archived' ? <Archive /> : <FolderGit2 />}
                action={filtersOn ? <Button size="sm" variant="secondary" onClick={clearFilters}>Limpiar filtros</Button> : undefined}
              >
                {filtersOn
                  ? q ? `Ningún proyecto coincide con "${q.trim()}".` : 'Ningún proyecto coincide con estos filtros.'
                  : status === 'archived' ? 'No hay proyectos archivados.' : 'No hay proyectos activos. Restaura uno desde Archivados o crea uno nuevo.'}
              </EmptyState>
            </Card>
          ) : view === 'grid' ? (
            <Revalidating active={refetching}>
              <BalancedGrid max={{ base: 1, md: 2, lg: 3, xl: 4 }} className={cn('gap-3.5', stagger && 'stagger-children')}>
                {visible.map((p) => (
                  <div
                    key={p.projectId}
                    draggable={canDrag}
                    onDragStart={(e) => {
                      if (!canDrag) return;
                      dragIdRef.current = p.projectId;
                      setDragging(p.projectId);
                      e.dataTransfer.effectAllowed = 'move';
                      if (dragImgRef.current) e.dataTransfer.setDragImage(dragImgRef.current, 0, 0);
                    }}
                    onDragOver={(e) => { if (!canDrag) return; e.preventDefault(); liveReorder(p.projectId); }}
                    onDragEnd={() => { setDragging(null); dragIdRef.current = null; }}
                    className={cn(
                      'h-full rounded-lg transition-[transform,box-shadow] duration-200 ease-spring',
                      dragging === p.projectId && 'z-10 scale-[1.02] shadow-lg ring-2 ring-orange',
                    )}
                  >
                    <Fresh fresh={projects.isFresh(p.projectId)} className="h-full">
                      <ProjectCard
                        p={p}
                        draggable={canDrag}
                        busy={projects.isBusy(p.projectId)}
                        menu={menu(p)}
                        onOpen={() => nav(`/app/projects/${p.projectId}`)}
                      />
                    </Fresh>
                  </div>
                ))}
              </BalancedGrid>
            </Revalidating>
          ) : (
            <Revalidating active={refetching}>
              <ProjectTable rows={visible} isFresh={projects.isFresh} isBusy={projects.isBusy} menu={menu} onOpen={(p) => nav(`/app/projects/${p.projectId}`)} />
            </Revalidating>
          )}
        </div>
      )}

      <ProjectDialog open={createOpen} onOpenChange={setCreateOpen} onSubmit={createProject} />
      <ProjectDialog
        project={editing}
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        onSubmit={(d) => (editing ? updateProject(editing, d) : Promise.resolve())}
      />
      <ArchiveProjectDialog
        project={archiving}
        open={!!archiving}
        onOpenChange={(v) => !v && setArchiving(null)}
        onConfirm={() => (archiving ? toggleArchive(archiving) : Promise.resolve())}
      />
      <DeleteProjectDialog
        project={deleting}
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        onConfirm={() => (deleting ? deleteProject(deleting) : Promise.resolve())}
      />
    </Layout>
  );
}

function KindBadge({ kind }: { kind: ProjectRow['kind'] }) {
  return <Badge variant={kind === 'client' ? 'warn' : 'neutral'} dot className="text-[11px]">{kind === 'client' ? 'Cliente' : 'Interno'}</Badge>;
}

function Contributors({ names, max = 4 }: { names: string[]; max?: number }) {
  if (!names.length) return <span className="text-[12px] text-faint">sin actividad</span>;
  return (
    <div className="flex -space-x-1.5">
      {names.slice(0, max).map((c, i) => (
        <div key={i} className="rounded-full ring-2 ring-card" title={c}><UserAvatar url={null} name={c} className="size-6" /></div>
      ))}
      {names.length > max && (
        <div className="flex size-6 items-center justify-center rounded-full bg-panel text-[10px] font-medium ring-2 ring-card tabular-nums">+{names.length - max}</div>
      )}
    </div>
  );
}

function ProjectCard({
  p,
  draggable,
  busy,
  menu,
  onOpen,
}: {
  p: ProjectRow;
  draggable: boolean;
  busy: boolean;
  menu: ReactNode;
  onOpen: () => void;
}) {
  const archived = isArchived(p);
  return (
    <Card
      interactive
      className={cn('group flex h-full flex-col', draggable && 'cursor-grab active:cursor-grabbing', busy && 'opacity-60', archived && 'bg-sidebar')}
      onClick={onOpen}
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        {/* Ícono generado (semilla = id) + el color propio del proyecto como punto. */}
        <div className={cn('relative shrink-0 transition-transform duration-200 ease-spring group-hover:scale-105', archived && 'grayscale')}>
          <ProjectIcon id={p.projectId} name={p.name} size="lg" className="size-10" />
          <span aria-hidden className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-card" style={{ background: projectColor(p) }} />
        </div>
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="truncate text-[15px] font-semibold leading-tight tracking-[-0.02em]">{p.name}</div>
          <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-faint">
            <span className="font-mono text-[11px]">{p.key}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{p.projectType ? typeLabel(p.projectType) : 'Sin tipo'}</span>
          </div>
        </div>
        <div className="-mr-1.5 -mt-1 flex shrink-0 items-center">
          {draggable && <GripVertical className="size-4 text-faint opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />}
          {menu ?? <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
        <KindBadge kind={p.kind} />
        {archived && <Badge variant="neutral" className="text-[11px]"><Archive className="size-3" /> Archivado</Badge>}
        {p.profileSource === 'ia' && <Badge variant="llm" className="text-[11px]">Perfil por revisar</Badge>}
        <span className="ml-auto inline-flex items-center gap-1 text-[12px] text-faint tabular-nums">
          <FolderGit2 className="size-3.5" /> {p.repos.length}
        </span>
      </div>

      <div className="mx-4 mb-3 grid grid-cols-3 gap-1.5">
        <Stat label="Commits" value={compact(p.commits)} />
        <Stat label="Tareas" value={String(p.ticketsResolved)} />
        <Stat label="Líneas" value={compact(p.additions + p.deletions)} />
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t px-4 py-2.5">
        <LineDelta additions={p.additions} deletions={p.deletions} />
        <Contributors names={p.contributors} />
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5 rounded-md bg-panel px-2.5 py-2">
      <span className="label-caps truncate text-[10px]">{label}</span>
      <span className="text-lg font-semibold leading-tight tabular-nums tracking-[-0.03em]">{value}</span>
    </div>
  );
}

/** Vista de lista: una fila por proyecto con las mismas cifras. Para muchos proyectos se escanea mejor. */
const TABLE_COLS = 'lg:grid-cols-[minmax(0,2.4fr)_96px_minmax(0,1.4fr)_64px_80px_80px_120px_104px_36px]';

function ProjectTable({
  rows,
  isFresh,
  isBusy,
  menu,
  onOpen,
}: {
  rows: ProjectRow[];
  isFresh: (id: string) => boolean;
  isBusy: (id: string) => boolean;
  menu: (p: ProjectRow) => ReactNode;
  onOpen: (p: ProjectRow) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className={cn('hidden items-center gap-3 border-b bg-sidebar px-4 py-2 lg:grid', TABLE_COLS)}>
        {['Proyecto', 'Clase', 'Tipo', 'Repos', 'Commits', 'Tareas', 'Cambios', 'Equipo', ''].map((h, i) => (
          <span key={i} className={cn('label-caps', i >= 3 && i <= 5 && 'text-right')}>{h}</span>
        ))}
      </div>
      <div className="divide-y">
        {rows.map((p) => {
          const archived = isArchived(p);
          return (
            <Fresh key={p.projectId} fresh={isFresh(p.projectId)}>
              <div
                role="link"
                tabIndex={0}
                onClick={() => onOpen(p)}
                onKeyDown={(e) => e.key === 'Enter' && onOpen(p)}
                className={cn(
                  'group grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-2.5 transition-colors hover:bg-sidebar focus-visible:bg-sidebar focus-visible:outline-none',
                  TABLE_COLS,
                  isBusy(p.projectId) && 'opacity-60',
                )}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className={cn('relative shrink-0', archived && 'grayscale')}>
                    <ProjectIcon id={p.projectId} name={p.name} size="sm" />
                    <span aria-hidden className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-card" style={{ background: projectColor(p) }} />
                  </div>
                  <span className="truncate text-[13.5px] font-medium">{p.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-faint">{p.key}</span>
                  {archived && <Archive className="size-3.5 shrink-0 text-faint" aria-label="Archivado" />}
                </div>
                <div className="hidden lg:block"><KindBadge kind={p.kind} /></div>
                <span className="hidden truncate text-[12.5px] text-muted-foreground lg:block">{p.projectType ? typeLabel(p.projectType) : '—'}</span>
                <span className="hidden text-right text-[13px] tabular-nums text-muted-foreground lg:block">{p.repos.length}</span>
                <span className="hidden text-right text-[13px] font-medium tabular-nums lg:block">{compact(p.commits)}</span>
                <span className="hidden text-right text-[13px] tabular-nums lg:block">{p.ticketsResolved}</span>
                <span className="hidden text-[12px] lg:block"><LineDelta additions={p.additions} deletions={p.deletions} /></span>
                <div className="hidden lg:block"><Contributors names={p.contributors} max={3} /></div>
                <div className="flex justify-end">{menu(p) ?? <ChevronRight className="size-4 text-faint" />}</div>
                {/* Móvil: las cifras clave en una línea bajo el nombre */}
                <div className="col-span-2 flex items-center gap-3 text-[12px] text-muted-foreground tabular-nums lg:hidden">
                  <KindBadge kind={p.kind} />
                  <span>{compact(p.commits)} commits</span>
                  <span>{p.ticketsResolved} tareas</span>
                  <span className="ml-auto"><LineDelta additions={p.additions} deletions={p.deletions} /></span>
                </div>
              </div>
            </Fresh>
          );
        })}
      </div>
    </Card>
  );
}

function ProjectsSkeleton() {
  return (
    <div className="grid gap-4">
      <BalancedGrid max={{ base: 2, lg: 4 }} className="gap-3.5">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[92px] rounded-lg" />)}
      </BalancedGrid>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-72" /><Skeleton className="h-8 w-56" /><Skeleton className="h-8 w-32" />
        <Skeleton className="ml-auto h-8 w-40" />
      </div>
      <BalancedGrid max={{ base: 1, md: 2, lg: 3, xl: 4 }} className="gap-3.5">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i} className="grid gap-3 p-4">
            <div className="flex items-center gap-3"><Skeleton className="size-10 rounded-md" /><div className="grid flex-1 gap-1.5"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/3" /></div></div>
            <Skeleton className="h-5 w-24 rounded-full" />
            <div className="grid grid-cols-3 gap-1.5"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
            <Skeleton className="h-5 w-full" />
          </Card>
        ))}
      </BalancedGrid>
    </div>
  );
}
