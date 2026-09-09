import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderGit2, ChevronRight, Plus, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { UserAvatar, EmptyState, LineDelta, ErrorCard, Fresh, RefreshButton, Revalidating } from '@/components/bits';
import { useAuth } from '@/auth/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useApi } from '@/lib/useApi';
import { useMirror } from '@/lib/useMirror';
import { invalidate } from '@/lib/store';
import { apiGet, apiSend, type ProjectListItem, type ProjectKind } from '@/lib/api';
import { compact } from '@/lib/format';
import { usePeriod } from '@/lib/usePeriod';

// Orden personalizado de las tarjetas (preferencia local por navegador, no del servidor).
const ORDER_KEY = 'roz.projectOrder';
function loadOrder(): string[] {
  try { const r = localStorage.getItem(ORDER_KEY); return r ? (JSON.parse(r) as string[]) : []; } catch { return []; }
}
function saveOrder(o: string[]) {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(o)); } catch { /* sin storage: solo en memoria */ }
}

export default function Projects() {
  const [period, setPeriod] = usePeriod();
  const [createOpen, setCreateOpen] = useState(false);
  const { user } = useAuth();
  const isAdmin = !!user; // control total para cualquier usuario autenticado (sin roles)
  const nav = useNavigate();
  const { data, loading, refetching, error, reload } = useApi<{ projects: ProjectListItem[] }>(
    () => apiGet('/projects', period.range),
    [period.range.from, period.range.to],
    { key: '/projects', ttl: 60_000 },
  );

  // Espejo: crear o borrar se ve en el frame del clic, sin recargar la lista (que es cara, va con
  // período y se reordena por commits).
  const projects = useMirror<ProjectListItem>(data?.projects, { key: (x) => x.projectId });

  // Reordenamiento por arrastre (drag-and-drop). El orden se guarda por navegador y sobrevive
  // recargas y cambios de período. Los proyectos nuevos (sin posición guardada) van al final.
  const [order, setOrder] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const dragImgRef = useRef<HTMLImageElement | null>(null);

  // Imagen de arrastre transparente: oculta la copia translúcida nativa. Así el arrastre se percibe
  // moviendo la tarjeta REAL entre posiciones (colisión/reorden en vivo), sin fantasma transparente.
  useEffect(() => {
    const img = new Image();
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    dragImgRef.current = img;
  }, []);

  // OJO con las deps: antes dependía del ARRAY `data.projects`, que es nuevo en cada revalidación,
  // así que `setOrder` corría tras cada mutación → cambiaba el índice de cada tarjeta → cambiaba su
  // `animation-delay` de `stagger-children` → la grilla ENTERA volvía a animarse en cascada. Con la
  // lista de ids serializada, solo corre cuando de verdad hay proyectos nuevos o menos.
  const ids = projects.items.map((x) => x.projectId).join(',');
  useEffect(() => {
    const list = ids ? ids.split(',') : [];
    if (!list.length) return;
    const saved = loadOrder();
    // Lo NUEVO va primero, no al final. El backend ordena por commits desc, así que un proyecto
    // recién creado (0 commits) caía en la última posición de la grilla — bajo el fold: el toast
    // decía "creado" y en pantalla no pasaba nada.
    setOrder([...list.filter((id) => !saved.includes(id)), ...saved.filter((id) => list.includes(id))]);
  }, [ids]);

  useEffect(() => { if (order.length) saveOrder(order); }, [order]);

  const ordered = useMemo(() => {
    const map = new Map(projects.items.map((x) => [x.projectId, x]));
    const list = order.map((id) => map.get(id)).filter(Boolean) as ProjectListItem[];
    return list.length ? list : projects.items;
  }, [order, projects.items]);

  // `stagger-children` solo en el primer pintado: es una animación de ENTRADA, y redispararla en
  // cada revalidación es el parpadeo en cascada que se reportó.
  const [stagger, setStagger] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setStagger(false), 700);
    return () => clearTimeout(t);
  }, []);

  const createProject = (input: { name: string; key?: string; kind: ProjectKind; color: string | null }) =>
    projects.create(
      {
        projectId: `nuevo:${input.name}`,
        name: input.name,
        key: (input.key || input.name.slice(0, 6)).toUpperCase(),
        kind: input.kind,
        color: input.color,
        // Un proyecto nuevo no tiene actividad: ceros explícitos, y la revalidación los rellena.
        commits: 0,
        additions: 0,
        deletions: 0,
        contributors: [],
        repos: [],
        ticketsResolved: 0,
      },
      async () => {
        const r = await apiSend<{ project: { id: string; name: string; key: string; kind: ProjectKind; color: string | null } }>(
          'POST', '/projects', { name: input.name, key: input.key || undefined, kind: input.kind, color: input.color },
        );
        // Se adopta lo que devuelve el backend (la `key` la puede haber generado él).
        return {
          projectId: r.project.id,
          name: r.project.name,
          key: r.project.key,
          kind: r.project.kind,
          color: r.project.color,
          commits: 0,
          additions: 0,
          deletions: 0,
          contributors: [],
          repos: [],
          ticketsResolved: 0,
        };
      },
      { success: { title: 'Proyecto creado', description: input.name } },
    ).then((created) => {
      invalidate('/overview'); // el resumen cuenta proyectos
      return created;
    });

  const updateProject = (pr: ProjectListItem, patch: { name: string; key: string; kind: ProjectKind; color: string | null }) =>
    projects.patch(pr, patch, async () => {
      await apiSend('PATCH', `/projects/${pr.projectId}`, patch);
    }, { success: { title: 'Proyecto actualizado', description: patch.name } });

  const deleteProject = (pr: ProjectListItem) =>
    projects.remove(pr, () => apiSend('DELETE', `/projects/${pr.projectId}`), {
      success: { title: 'Proyecto eliminado', description: pr.name },
      error: 'No se pudo eliminar',
    }).then(() => invalidate('/overview'));

  // Reorden en vivo: al pasar por encima de otra tarjeta, la arrastrada toma su posición (colisión).
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

  return (
    <Layout
      title="Proyectos"
      subtitle="Actividad de código por proyecto"
      actions={
        <div className="flex items-center gap-2">
          <RefreshButton busy={refetching} onClick={reload} />
          {isAdmin && <Button onClick={() => setCreateOpen(true)}><Plus /> Nuevo proyecto</Button>}
          <PeriodPicker value={period} onChange={setPeriod} />
        </div>
      }
    >
      {error && <ErrorCard message={error} className="mb-4" />}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : !projects.items.length ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10">
            <EmptyState icon={<FolderGit2 className="size-6" />}>No hay proyectos con actividad en este período</EmptyState>
            {isAdmin && <Button size="sm" onClick={() => setCreateOpen(true)}><Plus /> Crear proyecto</Button>}
          </CardContent>
        </Card>
      ) : (
        <Revalidating active={refetching} className={cn('grid gap-4 md:grid-cols-2 lg:grid-cols-3', stagger && 'stagger-children')}>
          {ordered.map((p) => (
            <div
              key={p.projectId}
              draggable
              onDragStart={(e) => {
                dragIdRef.current = p.projectId;
                setDragging(p.projectId);
                e.dataTransfer.effectAllowed = 'move';
                if (dragImgRef.current) e.dataTransfer.setDragImage(dragImgRef.current, 0, 0);
              }}
              onDragOver={(e) => { e.preventDefault(); liveReorder(p.projectId); }}
              onDragEnd={() => { setDragging(null); dragIdRef.current = null; }}
              className={cn(
                'rounded-xl transition-[transform,box-shadow] duration-200 ease-spring',
                dragging === p.projectId && 'z-10 scale-[1.03] shadow-xl ring-2 ring-primary',
              )}
            >
              <Fresh fresh={projects.isFresh(p.projectId)}>
                <ProjectCard
                  p={p}
                  isAdmin={isAdmin}
                  busy={projects.isBusy(p.projectId)}
                  onUpdate={updateProject}
                  onDelete={deleteProject}
                  onOpen={() => nav(`/app/projects/${p.projectId}`)}
                />
              </Fresh>
            </div>
          ))}
        </Revalidating>
      )}

      <ProjectDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={createProject} />
    </Layout>
  );
}

// Color determinístico por proyecto (mismo seed → mismo color) como fallback cuando no hay uno fijado.
function projectHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

/** Color del proyecto: el fijado manualmente (hex) o uno generado a partir de la key. */
function projectColor(p: { color: string | null; key: string; name: string }): string {
  return p.color || `hsl(${projectHue(p.key || p.name)} 52% 48%)`;
}

/** HSL → hex, para previsualizar en el <input type="color"> el color automático generado. */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function ProjectCard({
  p,
  isAdmin,
  busy,
  onUpdate,
  onDelete,
  onOpen,
}: {
  p: ProjectListItem;
  isAdmin: boolean;
  busy: boolean;
  onUpdate: (p: ProjectListItem, patch: { name: string; key: string; kind: ProjectKind; color: string | null }) => Promise<void>;
  onDelete: (p: ProjectListItem) => Promise<void>;
  onOpen: () => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const accent = projectColor(p);
  const monogram = (p.key || p.name).replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();

  return (
    <>
      <Card interactive className={cn('group cursor-grab active:cursor-grabbing', busy && 'opacity-60')} onClick={onOpen}>
        <CardContent className="p-5">
          <div className="flex items-start justify-between">
            <div className="flex min-w-0 items-center gap-2.5">
              <div
                className="flex size-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold tracking-tight text-white shadow-sm transition-transform duration-200 ease-spring group-hover:scale-110"
                style={{ background: accent }}
              >
                {monogram}
              </div>
              <div className="min-w-0">
                <div className="truncate font-semibold">{p.name}</div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <Badge variant={p.kind === 'client' ? 'default' : 'secondary'}>{p.kind === 'client' ? 'Cliente' : 'Interno'}</Badge>
                  <span className="font-mono text-[11px] text-muted-foreground">{p.key}</span>
                  <span className="text-xs text-muted-foreground">· {p.repos.length} repo{p.repos.length !== 1 ? 's' : ''}</span>
                </div>
              </div>
            </div>
            {isAdmin ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="-mr-1 -mt-1 text-muted-foreground"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreVertical className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setEditOpen(true); }}>
                    <Pencil className="size-4" /> Editar
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={(e) => { e.stopPropagation(); setDeleteOpen(true); }}
                  >
                    <Trash2 className="size-4" /> Eliminar
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            )}
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            <Stat label="Commits" value={String(p.commits)} />
            <Stat label="Tickets" value={String(p.ticketsResolved)} />
            <Stat label="Líneas" value={compact(p.additions + p.deletions)} />
          </div>

          <div className="mt-3 flex items-center justify-between">
            <LineDelta additions={p.additions} deletions={p.deletions} />
            <div className="flex -space-x-2">
              {p.contributors.slice(0, 4).map((c, i) => (
                <div key={i} className="ring-2 ring-card rounded-full"><UserAvatar url={null} name={c} className="size-6" /></div>
              ))}
              {p.contributors.length > 4 && (
                <div className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium ring-2 ring-card">+{p.contributors.length - 4}</div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <ProjectDialog project={p} open={editOpen} onOpenChange={setEditOpen} onUpdate={onUpdate} />
      <DeleteProject project={p} open={deleteOpen} onOpenChange={setDeleteOpen} onDelete={onDelete} />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 py-2">
      <div className="text-lg font-bold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

// ---- Dialog crear / editar proyecto ----
function ProjectDialog({
  project,
  open,
  onOpenChange,
  onCreate,
  onUpdate,
}: {
  project?: ProjectListItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreate?: (input: { name: string; key?: string; kind: ProjectKind; color: string | null }) => Promise<unknown>;
  onUpdate?: (p: ProjectListItem, patch: { name: string; key: string; kind: ProjectKind; color: string | null }) => Promise<void>;
}) {
  const editing = !!project;
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [kind, setKind] = useState<ProjectKind>('internal');
  const [color, setColor] = useState(''); // '' = automático (color generado por la key)
  const [busy, setBusy] = useState(false);

  // Al abrir, (re)inicializa el formulario. Dep en el ID, NUNCA en el objeto: la fila se renueva en
  // cada revalidación y depender de ella reescribiría el formulario mientras escribes.
  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setKey(project?.key ?? '');
    setKind(project?.kind ?? 'internal');
    setColor(project?.color ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.projectId]);

  async function save() {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    // La inserción/adopción optimista la hace el espejo del padre; aquí solo se describe la
    // intención y se cierra al terminar.
    if (editing && onUpdate) {
      await onUpdate(project!, { name: n, key: key.trim() || project!.key, kind, color: color || null });
    } else if (onCreate) {
      await onCreate({ name: n, key: key.trim() || undefined, kind, color: color || null });
    }
    setBusy(false);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar proyecto' : 'Nuevo proyecto'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Cambia el nombre, la clave o el tipo. Vincula repos desde el detalle del proyecto.'
              : 'Crea un proyecto para vincularle repos y trackear su actividad. Tras crearlo, abre el detalle para vincular repos.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="proj-name">Nombre</Label>
            <Input id="proj-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="ej. Portal de Clientes" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="proj-key">Clave</Label>
            <Input
              id="proj-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={editing ? undefined : 'Se genera del nombre si la dejas vacía'}
              className="font-mono uppercase"
            />
            <p className="text-xs text-muted-foreground">Identificador único y corto del proyecto (se guarda en MAYÚSCULAS).</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="proj-kind">Tipo</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as ProjectKind)}>
              <SelectTrigger id="proj-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="internal">Interno</SelectItem>
                <SelectItem value="client">Cliente</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="proj-color">Color</Label>
            <div className="flex items-center gap-2">
              <input
                id="proj-color"
                type="color"
                value={color || hslToHex(projectHue(key.trim() || name || 'x'), 62, 45)}
                onChange={(e) => setColor(e.target.value)}
                className="size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
                aria-label="Color del proyecto"
              />
              <Input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="Automático (se genera de la clave)"
                className="font-mono"
              />
              {color && <Button type="button" variant="ghost" size="sm" onClick={() => setColor('')}>Auto</Button>}
            </div>
            <p className="text-xs text-muted-foreground">Color de identidad del proyecto. Déjalo en automático o usa tu hex de marca (#RRGGBB).</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={save} disabled={busy || !name.trim()}>{busy ? 'Guardando…' : editing ? 'Guardar' : 'Crear proyecto'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Confirmación de borrado estilo GitHub (escribe el nombre para habilitar) ----
function DeleteProject({
  project,
  open,
  onOpenChange,
  onDelete,
}: {
  project: ProjectListItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDelete: (p: ProjectListItem) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = confirm.trim() === project.name;

  useEffect(() => { if (open) setConfirm(''); }, [open]);

  async function del() {
    if (!matches) return;
    setBusy(true);
    // La tarjeta desaparece al confirmar (el espejo la quita) y vuelve a su sitio si el DELETE
    // falla. Antes se cerraba el diálogo y la tarjeta seguía ahí hasta que acabara el refetch.
    await onDelete(project);
    setBusy(false);
    onOpenChange(false);
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Eliminar "{project.name}"</AlertDialogTitle>
          <AlertDialogDescription>
            Esta acción es permanente. Se desvinculan sus repos y se quita el proyecto de los commits y tickets
            relacionados. Las tareas no se borran, pero pierden su vínculo con este proyecto. No se puede deshacer.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="confirm-name" className="font-normal text-muted-foreground">
            Escribe <code className="select-all rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-sm font-bold text-destructive">{project.name}</code> para confirmar
          </Label>
          <Input
            id="confirm-name"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && matches && del()}
            autoComplete="off"
            autoFocus
          />
        </div>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant="destructive" onClick={del} disabled={!matches || busy}>
            {busy ? 'Eliminando…' : 'Eliminar este proyecto'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
