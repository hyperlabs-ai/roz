import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  Archive, ArchiveRestore, ArrowLeft, ArrowRight, Bot, GitCommitHorizontal, CircleCheck, Users, Plus, Minus, ExternalLink,
  X, GitBranch, RefreshCw, Check, CircleAlert, Search, MoreHorizontal, Pencil,
} from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { Columns } from '@/components/charts';
import { BalancedGrid } from '@/components/grid';
import { MetricCard } from '@/components/MetricCard';
import { UserAvatar, EmptyState, LineDelta, ErrorCard, Fresh, ProgressBar, RefreshButton, Revalidating } from '@/components/bits';
import { GithubAvatar, IntegrationIcon, ProjectIcon, tokenColor } from '@/components/brand';
import { ProjectDialog, ArchiveProjectDialog, DeleteProjectDialog } from '@/components/projects/ProjectDialogs';
import { ProjectMenu } from '@/components/projects/ProjectMenu';
import { isArchived, projectColor, type ProjectDraft } from '@/components/projects/project-ui';
import { useAuth } from '@/auth/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useApi } from '@/lib/useApi';
import { useMirror } from '@/lib/useMirror';
import { useAction } from '@/lib/useAction';
import { invalidate } from '@/lib/store';
import { useSync } from '@/sync/SyncContext';
import { isSyncDone, isSyncError } from '@/sync/status';
import { apiGet, apiSend, PROJECT_TYPE_LABEL, type ProjectDetail as Detail, type RepoSyncStatus } from '@/lib/api';
import { compact, relative, shortDate } from '@/lib/format';
import { usePeriod } from '@/lib/usePeriod';
import { cn } from '@/lib/utils';
import { PRIO_DOT, stateRank } from '@/lib/labels';

function syncPct(s?: RepoSyncStatus): number | null {
  return s?.totalPages ? Math.min(100, Math.round((s.pages / s.totalPages) * 100)) : null;
}

/**
 * Fila de un repo vinculado. Una sola señal de estado por vez (sin iconos repetidos): mientras
 * sincroniza muestra SOLO una barra de progreso (el botón de re-sync se oculta); al terminar, un
 * "Listo ✓" efímero (solo si la corrida es reciente, para no dejar checks permanentes); en error,
 * una etiqueta roja con reintento. En reposo, la fila queda limpia y las acciones aparecen al hover.
 */
function RepoRow({ repo, status, live, isAdmin, active, busy, onResync, onRemove }: {
  repo: string;
  status?: RepoSyncStatus;
  live: boolean;
  isAdmin: boolean;
  active: boolean;
  busy: boolean;
  onResync: () => void;
  onRemove: () => void;
}) {
  const name = repo.replace('hyperlabs-ai/', '');
  const pct = syncPct(status);
  const isError = !!status && isSyncError(status);
  const justDone = !!status && isSyncDone(status) && live;

  return (
    <div className="group relative flex items-center gap-2.5 rounded-md bg-card px-2.5 py-2 shadow-[0_1px_1px_hsl(var(--foreground)/0.04)] transition-colors hover:bg-sidebar">
      <IntegrationIcon name="github" size="sm" framed />
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={repo}>{name}</span>

      {active ? (
        <div className="flex shrink-0 items-center gap-1.5" title={`${status?.commits ?? 0} commits · ${status?.pages ?? 0}${status?.totalPages ? `/${status.totalPages}` : ''} páginas`}>
          {/* `pct == null` cuando el backfill todavía no sabe cuántas páginas hay: indeterminado,
              que es justo lo que `ProgressBar` pinta con el barrido en vez de un 35% inventado. */}
          <ProgressBar pct={pct} color="orange" className="h-1.5 w-12" />
          <span className="w-7 text-right text-[11px] tabular-nums text-muted-foreground">
            {status?.status === 'queued' ? '···' : pct != null ? `${pct}%` : status?.commits ?? 0}
          </span>
        </div>
      ) : justDone ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-success animate-fade-in"><Check className="size-3.5" /> Listo</span>
      ) : isError ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-soft px-2 py-0.5 text-[11px] font-medium text-red" title={status?.error ?? 'Error al sincronizar'}>
          <CircleAlert className="size-3" /> Error
        </span>
      ) : null}

      {isAdmin && (
        <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-sidebar/95 pl-1.5 opacity-0 backdrop-blur-sm transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
          {!active && (
            <button
              onClick={onResync}
              disabled={busy}
              title={isError ? 'Reintentar sincronización' : 'Re-sincronizar historial'}
              className="press rounded-md p-1.5 text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
            </button>
          )}
          <button
            onClick={onRemove}
            disabled={busy}
            title="Desvincular"
            className="press rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/** Autocomplete propio para vincular un repo: input con búsqueda + lista flotante navegable con
 *  teclado. Reemplaza el <datalist> nativo (feo y con estilos del sistema). */
function RepoCombobox({ available, linked, busy, error, onAdd }: {
  available: string[];
  linked: string[];
  busy: boolean;
  /** Falló traer la lista de la org: se dice, en vez de mostrar un combo vacío sin explicación. */
  error: string | null;
  onAdd: (repo: string) => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const linkedSet = new Set(linked);
    const needle = q.trim().toLowerCase();
    return available
      .filter((r) => !linkedSet.has(r))
      .filter((r) => !needle || r.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [available, q, linked]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  function submit(repo: string) {
    const v = repo.trim();
    if (!v) return;
    onAdd(v);
    setQ('');
    setOpen(false);
  }

  return (
    <div ref={boxRef} className="relative max-w-md">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((i) => Math.min(i + 1, matches.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); submit(matches[hi] ?? q); }
              else if (e.key === 'Escape') setOpen(false);
            }}
            placeholder="Buscar repositorio…"
            className="pl-8"
          />
        </div>
        <Button onClick={() => submit(q)} disabled={busy || !q.trim()}><Plus /> Vincular</Button>
      </div>
      {error && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          No se pudo traer la lista de repos de la organización ({error}). Puedes escribir{' '}
          <span className="font-mono">org/repo</span> a mano.
        </p>
      )}
      {open && matches.length > 0 && (
        <div className="animate-fade-in-up absolute z-20 mt-1.5 w-full overflow-hidden rounded-lg border bg-popover shadow-lg">
          <ul className="scrollbar-thin max-h-64 overflow-y-auto py-1">
            {matches.map((r, i) => (
              <li key={r}>
                <button
                  type="button"
                  onMouseEnter={() => setHi(i)}
                  onClick={() => submit(r)}
                  className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors', i === hi ? 'bg-orange-soft text-orange-ink' : 'hover:bg-panel')}
                >
                  <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{r.replace('hyperlabs-ai/', '')}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Piezas visuales de la pantalla "Proyecto" (solo presentación: todo sale del payload).
// ---------------------------------------------------------------------------------------------

type StatusKind = 'done' | 'active' | 'open' | 'cancel';

/** Clasifica una ETIQUETA de estado (el backend agrupa por etiqueta en español). */
function statusKind(label: string): StatusKind {
  const l = label.toLowerCase();
  if (/cancel/.test(l)) return 'cancel';
  if (/(complet|hecho|done|cerrad)/.test(l)) return 'done';
  if (/(curso|revis|progress|review)/.test(l)) return 'active';
  return 'open';
}

const KIND_DOT: Record<StatusKind, string> = {
  done: 'bg-orange',
  active: 'bg-purple',
  open: 'bg-toggle-off',
  cancel: 'bg-red',
};

/**
 * Anillo doble: exterior naranja = alcance hecho, interior morado = alcance en marcha (hecho + en
 * curso + en revisión). Los cancelados no cuentan en el total.
 */
function ProgressRing({ done, started, size = 150 }: { done: number; started: number; size?: number }) {
  const c1 = 2 * Math.PI * 60;
  const c2 = 2 * Math.PI * 42;
  const [shown, setShown] = useState({ done: 0, started: 0 });
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown({ done, started }));
    return () => cancelAnimationFrame(r);
  }, [done, started]);
  const arc = 'transition-[stroke-dasharray] duration-1000 ease-spring';
  return (
    <div className="relative grid shrink-0 place-items-center">
      <svg width={size} height={size} viewBox="0 0 150 150" aria-label={`${Math.round(done * 100)}% del alcance hecho`}>
        <circle cx="75" cy="75" r="60" fill="none" stroke={tokenColor('panel')} strokeWidth="14" />
        <circle
          cx="75" cy="75" r="60" fill="none" stroke={tokenColor('orange')} strokeWidth="14" strokeLinecap="round"
          strokeDasharray={`${c1 * shown.done} ${c1}`} transform="rotate(-90 75 75)" className={arc}
        />
        <circle cx="75" cy="75" r="42" fill="none" stroke={tokenColor('panel')} strokeWidth="8" />
        <circle
          cx="75" cy="75" r="42" fill="none" stroke={tokenColor('purple')} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={`${c2 * shown.started} ${c2}`} transform="rotate(-90 75 75)" className={arc}
        />
      </svg>
      <b className="absolute text-[24px] font-semibold tabular-nums tracking-[-0.04em]">{Math.round(done * 100)}%</b>
    </div>
  );
}

/**
 * Burnup de líneas del período: acumulado de líneas agregadas (naranja, con área) frente al de
 * eliminadas (morado). Marca "hoy" en el último punto.
 */
function LinesBurnup({ trend }: { trend: { date: string; additions: number; deletions: number }[] }) {
  const W = 520, H = 200, L = 44, R = 500, T = 20, B = 170;
  let a = 0, d = 0;
  const pts = trend.map((p) => ({ date: p.date, add: (a += p.additions), del: (d += p.deletions) }));
  const max = Math.max(1, ...pts.map((p) => Math.max(p.add, p.del)));
  const n = Math.max(1, pts.length - 1);
  const x = (i: number) => L + ((R - L) * i) / n;
  const y = (v: number) => B - ((B - T) * v) / max;
  const line = (k: 'add' | 'del') => pts.map((p, i) => `${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const lx = x(pts.length - 1);
  const ly = last ? y(last.add) : B;
  const ticks = [0, 0.33, 0.66, 1];
  const labelIdx = pts.length > 2 ? [0, Math.floor((pts.length - 1) / 2), pts.length - 1] : pts.map((_, i) => i);
  const pillText = last ? `hoy · ${compact(last.add)}` : '';
  const pillW = Math.max(54, pillText.length * 6.4 + 14);
  const pillX = Math.min(lx + 8, W - pillW - 2);
  const pillLeft = pillX < lx; // si no cabe a la derecha, va a la izquierda del punto

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Líneas agregadas y eliminadas acumuladas en el período">
      <g stroke={tokenColor('border')}>
        {ticks.map((t) => <line key={t} x1={L} x2={R} y1={y(max * t)} y2={y(max * t)} />)}
      </g>
      <g fontSize="10" fill={tokenColor('faint')} textAnchor="end" className="tabular-nums">
        {ticks.map((t) => <text key={t} x={L - 8} y={y(max * t) + 4}>{compact(Math.round(max * t))}</text>)}
      </g>
      {pts.length > 1 && (
        <>
          <line x1={L} y1={B} x2={lx} y2={ly} stroke={tokenColor('toggle-off')} strokeWidth="1.2" strokeDasharray="3 4" />
          <polygon points={`${line('add')} ${lx.toFixed(1)},${B} ${L},${B}`} fill={tokenColor('orange', 0.1)} />
          <polyline points={line('del')} fill="none" stroke={tokenColor('purple')} strokeWidth="2" strokeLinejoin="round" />
          <polyline points={line('add')} fill="none" stroke={tokenColor('orange')} strokeWidth="2.5" strokeLinejoin="round" />
          <circle cx={lx} cy={ly} r="4.5" fill={tokenColor('orange')} />
          <rect x={pillLeft ? lx - pillW - 8 : pillX} y={Math.max(T, ly - 22)} width={pillW} height="20" rx="4" fill={tokenColor('ink')} />
          <text
            x={(pillLeft ? lx - pillW - 8 : pillX) + pillW / 2} y={Math.max(T, ly - 22) + 14}
            fontSize="10.5" fill={tokenColor('ink-foreground')} textAnchor="middle"
          >
            {pillText}
          </text>
        </>
      )}
      <g fontSize="10" fill={tokenColor('faint')} textAnchor="middle" className="tabular-nums">
        {labelIdx.map((i) => (
          <text key={i} x={x(i)} y={H - 10} textAnchor={i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}>
            {shortDate(pts[i].date)}
          </text>
        ))}
      </g>
    </svg>
  );
}

/** Leyenda del anillo: cada estado con su punto y conteo (reemplaza las columnas que solo decían "N tareas → Tablero"). */
function StatusLegend({ byStatus }: { byStatus: Detail['ticketsByStatus'] }) {
  const rows = [...byStatus].sort((a, b) => stateRank(a.label) - stateRank(b.label));
  const total = rows.reduce((s, r) => s + r.count, 0) || 1;
  return (
    <ul className="grid min-w-0 flex-1 content-center gap-1">
      {rows.map((s) => (
        <li key={s.status} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-sidebar">
          <i aria-hidden className={cn('size-2 shrink-0 rounded-[2px]', KIND_DOT[statusKind(s.label)])} />
          <span className="min-w-0 flex-1 truncate">{s.label}</span>
          <span className="text-[11px] text-faint tabular-nums">{Math.round((s.count / total) * 100)}%</span>
          <b className="w-8 text-right font-semibold tabular-nums">{s.count}</b>
        </li>
      ))}
    </ul>
  );
}

function SectionLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 label-caps hover:text-foreground">
      {children} <ArrowRight className="size-3" />
    </Link>
  );
}

export default function ProjectDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = !!user; // control total para cualquier usuario autenticado (sin roles)
  const [period, setPeriod] = usePeriod();
  const [confirmRepo, setConfirmRepo] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const action = useAction();
  const { syncs, trigger, track, isActive } = useSync();
  const { data, loading, refetching, error, reload } = useApi<Detail>(
    () => apiGet(`/projects/${id}`, period.range),
    [id, period.range.from, period.range.to],
    { key: '/projects/detail', ttl: 60_000 },
  );

  // Espejo de los repos vinculados: vincular o desvincular sustituye UNA fila en vez de recargar la
  // consulta más pesada de la página (historial, tendencia, contribuidores, tickets).
  const repos = useMirror<string>(data?.repos, { key: (r) => r });

  /**
   * Autocomplete: repos de la org. En el backend son hasta 20 páginas SECUENCIALES a GitHub: va por
   * la caché (10 min, compartida entre proyectos).
   */
  const repoList = useApi<{ repos: string[] }>(
    () => apiGet('/repos/available'),
    [],
    { key: '/repos/available', ttl: 600_000 },
  );
  const available = isAdmin ? repoList.data?.repos ?? [] : [];

  // Estado de sync en vivo desde el widget global; el inicial del payload sirve de fallback.
  const liveByRepo = new Map(syncs.map((s) => [s.repo, s]));
  const liveSet = new Set(syncs.map((s) => s.repo));
  const statusFor = (r: string) => liveByRepo.get(r) ?? (data?.repoSync ?? []).find((x) => x.repo === r);

  // Un ÚNICO reload cuando un repo de este proyecto termina de sincronizar.
  const doneSeen = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const s of syncs) {
      const key = `${s.repo}:${s.updatedAt}`;
      if (isSyncDone(s) && (data?.repos ?? []).includes(s.repo) && !doneSeen.current.has(key)) {
        doneSeen.current.add(key);
        reload();
        invalidate('/projects');
        invalidate('/overview');
        invalidate('/developers');
      }
    }
  }, [syncs]); // eslint-disable-line react-hooks/exhaustive-deps

  const resyncRepo = (repo: string) =>
    action.run(`resync:${repo}`, () => trigger(id!, repo), {
      success: { title: 'Re-sincronizando', description: 'El avance va abajo a la derecha.' },
      error: 'No se pudo re-sincronizar',
    });

  const linkRepo = (repo: string) =>
    repos.create(
      repo.trim(),
      async () => {
        const r = await apiSend<{ repo?: string }>('POST', `/projects/${id}/repos`, { repo: repo.trim() });
        // El POST YA encoló el backfill; `track` solo empieza a mirarlo (con `trigger` se encolaría
        // un segundo backfill del mismo repo).
        const normalized = r.repo ?? repo.trim();
        track(id!, normalized);
        return normalized;
      },
      {
        success: {
          title: 'Repo vinculado',
          description: 'Trayendo su historial — verás el avance abajo a la derecha (≈1 min por cada 100 commits).',
        },
        error: 'No se pudo vincular',
      },
    );

  const removeRepo = (repo: string) =>
    repos.remove(repo, () => apiSend('DELETE', `/projects/${id}/repos?repo=${encodeURIComponent(repo)}`), {
      success: { title: 'Repo desvinculado', description: repo },
      error: 'No se pudo desvincular',
    }).then(() => invalidate('/projects'));

  const project = data?.project as (Detail['project'] & { active?: boolean }) | undefined;
  const archived = !!project && isArchived(project);

  // ---- CRUD del proyecto ----
  const saveProject = (d: ProjectDraft) =>
    action.run('save', async () => {
      if (!project) return;
      const body: Record<string, unknown> = { name: d.name, kind: d.kind, color: d.color };
      if (d.key) body.key = d.key;
      if ((d.projectType ?? null) !== (project.projectType ?? null)) body.projectType = d.projectType;
      if ((d.description ?? null) !== (project.description ?? null)) body.description = d.description;
      await apiSend('PATCH', `/projects/${project.id}`, body);
      invalidate('/projects'); // la lista y este detalle se revalidan por prefijo, en silencio
    }, { success: { title: 'Proyecto actualizado', description: d.name }, error: 'No se pudo guardar' });

  const toggleArchive = () =>
    action.run('archive', async () => {
      if (!project) return;
      await apiSend('PATCH', `/projects/${project.id}`, { active: archived });
      invalidate('/projects');
      invalidate('/overview');
    }, { success: archived ? 'Proyecto restaurado' : 'Proyecto archivado', error: 'No se pudo cambiar' });

  const deleteProject = () =>
    action.run('delete', async () => {
      if (!project) return;
      await apiSend('DELETE', `/projects/${project.id}`);
      invalidate('/projects');
      invalidate('/overview');
      nav('/app/projects');
    }, { success: { title: 'Proyecto eliminado', description: project?.name }, error: 'No se pudo eliminar' });

  // Avance por estado (para el anillo): hecho / en marcha sobre el total no cancelado.
  const scope = (() => {
    let total = 0, done = 0, active = 0;
    for (const s of data?.ticketsByStatus ?? []) {
      const k = statusKind(s.label);
      if (k === 'cancel') continue;
      total += s.count;
      if (k === 'done') done += s.count;
      if (k === 'active') active += s.count;
    }
    return { total, done, active, pctDone: total ? done / total : 0, pctStarted: total ? (done + active) / total : 0 };
  })();

  const kindLabel = project?.kind === 'client' ? 'Cliente' : 'Interno';
  const editable = project
    ? { projectId: project.id, name: project.name, key: project.key, kind: project.kind, color: project.color, projectType: project.projectType, description: project.description, repos: repos.items }
    : null;

  return (
    <Layout
      title={project?.name ?? 'Proyecto'}
      icon={project ? <ProjectIcon id={project.id} name={project.name} size="lg" className={cn('size-8 md:size-11', archived && 'grayscale')} /> : undefined}
      eyebrow={project ? `Proyecto · ${kindLabel}${archived ? ' · Archivado' : ''}` : 'Proyecto'}
      actions={
        <>
          {data && (
            <Badge variant={scope.total && scope.pctDone >= 0.5 ? 'ok' : 'neutral'} dot className="hidden sm:inline-flex">
              {scope.total ? `${scope.done}/${scope.total} hechas` : 'sin tareas'}
            </Badge>
          )}
          <RefreshButton busy={refetching} onClick={reload} />
          <PeriodPicker value={period} onChange={setPeriod} />
          {isAdmin && project && (
            <ProjectMenu
              archived={archived}
              onEdit={() => setEditOpen(true)}
              onArchive={() => setArchiveOpen(true)}
              onDelete={() => setDeleteOpen(true)}
              trigger={<Button variant="outline" size="icon" aria-label="Acciones del proyecto"><MoreHorizontal /></Button>}
            />
          )}
        </>
      }
    >
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 text-muted-foreground">
        <Link to="/app/projects"><ArrowLeft /> Proyectos</Link>
      </Button>

      {error && <ErrorCard message={error} className="mb-4" />}

      {loading || !data || !project ? (
        <DetailSkeleton />
      ) : (
        <Revalidating active={refetching} className="grid gap-3.5">
          {archived && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-yellow/40 bg-yellow-soft px-4 py-2.5 text-[13px] text-yellow-ink">
              <Archive className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">Archivado: roz no le asigna trabajo nuevo. Su historial sigue aquí.</span>
              {isAdmin && (
                <Button size="sm" variant="secondary" onClick={() => setArchiveOpen(true)}><ArchiveRestore /> Restaurar</Button>
              )}
            </div>
          )}

          {/* Resumen: la descripción (el contexto que antes iba bajo el título) + propiedades */}
          <Card className="flex flex-col gap-3 p-4 sm:p-5 lg:flex-row lg:items-center lg:gap-6">
            <div className="grid min-w-0 flex-1 gap-2.5">
              {project.description ? (
                <p className="max-w-4xl text-[14px] leading-relaxed text-foreground line-clamp-3">{project.description}</p>
              ) : (
                <p className="text-[13.5px] text-faint">
                  Sin descripción. {isAdmin ? 'Agrégala (o pídesela a roz): la usa para clasificar las tareas de este proyecto.' : ''}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={project.kind === 'client' ? 'warn' : 'neutral'} dot>{kindLabel}</Badge>
                <Badge variant="neutral">{project.projectType ? PROJECT_TYPE_LABEL[project.projectType] ?? project.projectType : 'Sin tipo'}</Badge>
                {project.profileSource === 'ia' && <Badge variant="llm"><Bot className="size-3" /> Perfil propuesto por roz</Badge>}
                <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-panel px-2 text-[11.5px] text-muted-foreground">
                  <span className="size-2.5 rounded-[3px]" style={{ background: projectColor(project) }} />
                  <span className="font-mono text-[11px]">{project.key}</span>
                </span>
              </div>
            </div>
            {isAdmin && (
              <div className="flex shrink-0 gap-2">
                <Button variant="secondary" onClick={() => setEditOpen(true)}>
                  {project.description ? <><Pencil /> Editar</> : <><Plus /> Agregar descripción</>}
                </Button>
              </div>
            )}
          </Card>

          {/* KPIs */}
          <BalancedGrid max={{ base: 2, md: 3, lg: 5 }} className="gap-3.5">
            <MetricCard icon={GitCommitHorizontal} label="Commits" value={data.totals.commits} format={compact} />
            <MetricCard icon={Plus} label="Líneas agregadas" value={data.totals.additions} format={compact} colorVar="--success" tone="success" />
            <MetricCard icon={Minus} label="Líneas eliminadas" value={data.totals.deletions} format={compact} colorVar="--destructive" tone="destructive" />
            <MetricCard icon={CircleCheck} label="Tareas cerradas" value={data.totals.ticketsResolved} colorVar="--chart-3" />
            <MetricCard icon={Users} label="Contribuidores" value={data.totals.contributors} />
          </BalancedGrid>

          {/* Avance (anillo + desglose por estado) | burnup. Las dos tarjetas miden lo mismo. */}
          <div className="grid gap-3.5 lg:grid-cols-[1fr_1.4fr]">
            <Card className="flex min-w-0 flex-col">
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle>Avance de tareas</CardTitle>
                <SectionLink to="/app/tasks">Tablero</SectionLink>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-center gap-3">
                {data.ticketsByStatus.length ? (
                  <>
                    <div className="flex flex-col items-center gap-5 sm:flex-row">
                      <ProgressRing done={scope.pctDone} started={scope.pctStarted} size={140} />
                      <StatusLegend byStatus={data.ticketsByStatus} />
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5"><i className="size-2 rounded-[2px] bg-orange" /> hecho {scope.done}/{scope.total}</span>
                      <span className="inline-flex items-center gap-1.5"><i className="size-2 rounded-[2px] bg-purple" /> en marcha {Math.round(scope.pctStarted * 100)}%</span>
                    </div>
                  </>
                ) : (
                  <EmptyState icon={<CircleCheck />}>Este proyecto todavía no tiene tareas</EmptyState>
                )}
              </CardContent>
            </Card>

            <Card className="flex min-w-0 flex-col">
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle>Burnup del período</CardTitle>
                <div className="flex items-center gap-3 text-[11.5px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5"><i className="h-0.5 w-3 rounded bg-orange" /> agregadas</span>
                  <span className="inline-flex items-center gap-1.5"><i className="h-0.5 w-3 rounded bg-purple" /> eliminadas</span>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-center">
                {data.trend.length > 1 ? (
                  <LinesBurnup trend={data.trend} />
                ) : (
                  <EmptyState icon={<GitCommitHorizontal />}>Sin actividad de código en este período</EmptyState>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Historial (2fr) | contribuidores + repos (1fr). La columna DERECHA marca la altura y el
              historial la llena con scroll propio (tabla en absolute). */}
          <div className="grid gap-3.5 lg:grid-cols-[2fr_1fr]">
            <Card className="min-w-0 lg:flex lg:flex-col">
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle>Historial de commits</CardTitle>
                <span className="text-[11px] text-faint tabular-nums">{data.history.length}</span>
              </CardHeader>
              <CardContent className="p-0 sm:p-0 lg:relative lg:min-h-[24rem] lg:flex-1">
                {!data.history.length && <EmptyState icon={<GitCommitHorizontal />}>Sin commits en este período</EmptyState>}

                {data.history.length > 0 && (
                  <div className="hidden md:block lg:absolute lg:inset-0 lg:[&>div]:h-full">
                    <Table className="table-fixed">
                      <TableHeader className="sticky top-0 z-10 bg-card">
                        <TableRow>
                          <TableHead>Commit</TableHead>
                          <TableHead className="w-32">Autor</TableHead>
                          <TableHead className="w-24 text-right">Cambios</TableHead>
                          <TableHead className="w-24 text-right">Fecha</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.history.map((c) => (
                          <TableRow key={c.sha}>
                            <TableCell>
                              <div className="flex min-w-0 items-center gap-2">
                                <code className="shrink-0 font-mono text-[11px] text-faint">{c.sha}</code>
                                {c.url && c.url !== '#' ? (
                                  <a href={c.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 hover:underline">
                                    <span className="truncate text-[13px]">{c.message}</span>
                                    <ExternalLink className="size-3 shrink-0 opacity-50" />
                                  </a>
                                ) : (
                                  <span className="truncate text-[13px]">{c.message}</span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex min-w-0 items-center gap-2">
                                <UserAvatar url={c.avatarUrl} id={c.devId} name={c.author ?? '—'} className="size-5 shrink-0" />
                                <span className="truncate text-xs text-muted-foreground">{c.author ?? '—'}</span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right"><LineDelta additions={c.additions} deletions={c.deletions} /></TableCell>
                            <TableCell className="text-right text-[11px] text-faint tabular-nums">{relative(c.committedAt)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {/* Móvil: lista compacta con alto acotado */}
                <div className="max-h-[28rem] divide-y overflow-y-auto md:hidden">
                  {data.history.map((c) => (
                    <div key={c.sha} className="px-4 py-3">
                      <div className="flex items-start gap-2">
                        <code className="mt-0.5 shrink-0 font-mono text-[11px] text-faint">{c.sha}</code>
                        <span className="min-w-0 flex-1 break-words text-sm leading-snug line-clamp-2">
                          {c.url && c.url !== '#' ? <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">{c.message}</a> : c.message}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                        <UserAvatar url={c.avatarUrl} id={c.devId} name={c.author ?? '—'} className="size-4" />
                        <span className="truncate">{c.author ?? '—'}</span>
                        <span className="ml-auto shrink-0"><LineDelta additions={c.additions} deletions={c.deletions} /></span>
                        <span className="shrink-0 text-[11px] text-faint tabular-nums">· {relative(c.committedAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <div className="grid min-w-0 content-start gap-3.5">
              <Card className="min-w-0">
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                  <CardTitle>Contribuidores</CardTitle>
                  <span className="text-[11px] text-faint tabular-nums">{data.contributors.length}</span>
                </CardHeader>
                <CardContent className="grid gap-2.5">
                  {data.contributors.length ? (
                    data.contributors.slice(0, 8).map((c, i) => (
                      <div key={i} className="flex items-center gap-2.5">
                        <GithubAvatar url={c.avatarUrl} id={c.devId} name={c.name} className="size-7" />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{c.name}</span>
                        <span className="shrink-0 text-[11px] text-faint tabular-nums">{c.commits} · {compact(c.lines)} lín.</span>
                      </div>
                    ))
                  ) : <EmptyState icon={<Users />}>Sin contribuidores en este período</EmptyState>}
                  {data.contributors.length > 8 && (
                    <span className="text-[12px] text-faint">y {data.contributors.length - 8} más</span>
                  )}
                </CardContent>
              </Card>

              <Card className="flex min-w-0 flex-col">
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle>Commits por repo</CardTitle>
                  <span className="text-[11px] text-faint tabular-nums">top 5</span>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col">
                  {data.byRepo.some((r) => r.commits > 0) ? (
                    <Columns
                      fill
                      topN={5}
                      color={tokenColor('orange')}
                      data={data.byRepo.map((r) => ({ label: r.repo.split('/').pop() ?? r.repo, value: r.commits }))}
                    />
                  ) : <EmptyState icon={<GitBranch />}>Sin actividad en repos</EmptyState>}
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Tareas cerradas | repos vinculados. La de repos marca la altura; la lista llena el resto. */}
          <div className="grid gap-3.5 lg:grid-cols-2">
            <Card className="min-w-0 lg:flex lg:flex-col">
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle>Cerradas en el período</CardTitle>
                <span className="text-[11px] text-faint tabular-nums">{data.resolvedTickets.length}</span>
              </CardHeader>
              <CardContent className="lg:relative lg:min-h-[16rem] lg:flex-1">
                {data.resolvedTickets.length ? (
                  <ul className="scroll-list grid max-h-[22rem] content-start gap-0.5 [--edge:1rem] sm:[--edge:1.25rem] lg:absolute lg:inset-x-5 lg:bottom-5 lg:top-0 lg:max-h-none">
                    {data.resolvedTickets.map((t) => (
                      <li key={t.id}>
                        <a
                          href={t.url && t.url !== '#' ? t.url : undefined}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-[13px] transition-colors hover:bg-sidebar"
                        >
                          <span className={cn('size-1.5 shrink-0 rounded-full', PRIO_DOT[t.priority ?? ''] ?? 'bg-toggle-off')} title={t.priority ?? 'sin prioridad'} />
                          <span className="w-[86px] shrink-0 truncate font-mono text-[11px] text-faint">{t.identifier}</span>
                          <span className="min-w-0 flex-1 truncate">{t.name}</span>
                          {t.assignee && <UserAvatar url={t.assignee.avatarUrl} id={t.assignee.id} name={t.assignee.name} className="size-[18px] shrink-0" />}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState icon={<CircleCheck />}>Nada cerrado en este período</EmptyState>
                )}
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                <div className="flex items-center gap-2.5">
                  <IntegrationIcon name="github" framed />
                  <CardTitle>Repositorios</CardTitle>
                </div>
                <span className="text-[11px] text-faint tabular-nums">{repos.items.length}</span>
              </CardHeader>
              <CardContent className="grid gap-3">
                {repos.items.length ? (
                  <div className="grid gap-1.5 rounded-lg bg-panel p-1.5">
                    {repos.items.map((r) => (
                      <Fresh key={r} fresh={repos.isFresh(r)} className="rounded-md">
                        <RepoRow
                          repo={r}
                          status={statusFor(r)}
                          live={liveSet.has(r)}
                          isAdmin={isAdmin}
                          active={isActive(r)}
                          busy={repos.isBusy(r) || action.busy(`resync:${r}`)}
                          onResync={() => resyncRepo(r)}
                          onRemove={() => setConfirmRepo(r)}
                        />
                      </Fresh>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-toggle-off">
                    <EmptyState icon={<GitBranch />}>Sin repos vinculados. Vincula uno para empezar a contar su actividad.</EmptyState>
                  </div>
                )}
                {isAdmin && (
                  <RepoCombobox
                    available={available}
                    linked={repos.items}
                    busy={repos.busyCount > 0}
                    error={repoList.error}
                    onAdd={linkRepo}
                  />
                )}
              </CardContent>
            </Card>
          </div>
        </Revalidating>
      )}

      <ProjectDialog project={editable} open={editOpen} onOpenChange={setEditOpen} onSubmit={saveProject} />
      <ArchiveProjectDialog
        project={project ? { name: project.name, active: !archived } : null}
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        onConfirm={toggleArchive}
      />
      <DeleteProjectDialog
        project={project ? { name: project.name, repos: repos.items } : null}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={deleteProject}
      />

      {/* Desvincular corta el vínculo del repo con el proyecto: se confirma. */}
      <AlertDialog open={!!confirmRepo} onOpenChange={(v) => !v && setConfirmRepo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Desvincular {confirmRepo}?</AlertDialogTitle>
            <AlertDialogDescription>
              El repo deja de contarse en este proyecto. Su historial ya reconciliado no se borra, y
              puedes volver a vincularlo cuando quieras.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                const r = confirmRepo!;
                void removeRepo(r).finally(() => setConfirmRepo(null));
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Desvincular
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}

/** Esqueleto con la MISMA composición que la página (nada salta al llegar los datos). */
function DetailSkeleton() {
  return (
    <div className="grid gap-3.5">
      <Card className="grid gap-3 p-5"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /><div className="flex gap-1.5"><Skeleton className="h-5 w-20 rounded-full" /><Skeleton className="h-5 w-28 rounded-full" /></div></Card>
      <BalancedGrid max={{ base: 2, md: 3, lg: 5 }} className="gap-3.5">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[92px] rounded-lg" />)}
      </BalancedGrid>
      <div className="grid gap-3.5 lg:grid-cols-[1fr_1.4fr]">
        <Card className="flex items-center gap-5 p-5"><Skeleton className="size-[140px] shrink-0 rounded-full" /><div className="grid flex-1 gap-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-5" />)}</div></Card>
        <Card className="grid gap-3 p-5"><Skeleton className="h-4 w-40" /><Skeleton className="h-48" /></Card>
      </div>
      <div className="grid gap-3.5 lg:grid-cols-[2fr_1fr]">
        <Card className="grid gap-2 p-5">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</Card>
        <Card className="grid content-start gap-2.5 p-5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</Card>
      </div>
    </div>
  );
}
