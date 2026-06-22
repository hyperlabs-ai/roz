import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { FolderGit2, ChevronRight, Plus, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { UserAvatar, EmptyState, LineDelta } from '@/components/bits';
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
import { apiGet, apiSend, type ProjectListItem, type ProjectKind } from '@/lib/api';
import { compact } from '@/lib/format';
import { defaultPeriod } from '@/lib/period';

export default function Projects() {
  const [period, setPeriod] = useState(defaultPeriod());
  const [createOpen, setCreateOpen] = useState(false);
  const { user } = useAuth();
  const isAdmin = ['admin', 'superadmin'].includes(user?.role ?? '');
  const nav = useNavigate();
  const { data, loading, error, reload } = useApi<{ projects: ProjectListItem[] }>(
    () => apiGet('/projects', period.range),
    [period.range.from, period.range.to],
  );

  return (
    <Layout
      title="Proyectos"
      subtitle="Actividad de código por proyecto"
      actions={
        <div className="flex items-center gap-2">
          {isAdmin && <Button onClick={() => setCreateOpen(true)}><Plus /> Nuevo proyecto</Button>}
          <PeriodPicker value={period} onChange={setPeriod} />
        </div>
      }
    >
      {error && <Card><CardContent className="py-4 text-sm text-destructive">{error}</CardContent></Card>}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : !data?.projects.length ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10">
            <EmptyState icon={<FolderGit2 className="size-6" />}>No hay proyectos con actividad en este período</EmptyState>
            {isAdmin && <Button size="sm" onClick={() => setCreateOpen(true)}><Plus /> Crear proyecto</Button>}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.projects.map((p) => (
            <ProjectCard key={p.projectId} p={p} isAdmin={isAdmin} onChanged={reload} onOpen={() => nav(`/projects/${p.projectId}`)} />
          ))}
        </div>
      )}

      <ProjectDialog open={createOpen} onOpenChange={setCreateOpen} onSaved={reload} />
    </Layout>
  );
}

function ProjectCard({ p, isAdmin, onChanged, onOpen }: { p: ProjectListItem; isAdmin: boolean; onChanged: () => void; onOpen: () => void }) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <Card className="group cursor-pointer transition-shadow hover:shadow-md" onClick={onOpen}>
        <CardContent className="p-5">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><FolderGit2 className="size-[18px]" /></div>
              <div>
                <div className="font-semibold">{p.name}</div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <Badge variant={p.kind === 'client' ? 'default' : 'secondary'}>{p.kind === 'client' ? 'Cliente' : 'Interno'}</Badge>
                  <span className="text-xs text-muted-foreground">{p.repos.length} repo{p.repos.length !== 1 ? 's' : ''}</span>
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

      <ProjectDialog project={p} open={editOpen} onOpenChange={setEditOpen} onSaved={onChanged} />
      <DeleteProject project={p} open={deleteOpen} onOpenChange={setDeleteOpen} onDeleted={onChanged} />
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
function ProjectDialog({ project, open, onOpenChange, onSaved }: { project?: ProjectListItem; open: boolean; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const editing = !!project;
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [kind, setKind] = useState<ProjectKind>('internal');
  const [busy, setBusy] = useState(false);

  // Al abrir, (re)inicializa el formulario con los valores del proyecto (o vacío al crear).
  useEffect(() => {
    if (open) {
      setName(project?.name ?? '');
      setKey(project?.key ?? '');
      setKind(project?.kind ?? 'internal');
    }
  }, [open, project]);

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (editing) {
        await apiSend('PATCH', `/projects/${project!.projectId}`, { name: name.trim(), key: key.trim() || project!.key, kind });
        toast.success('Proyecto actualizado', { description: name.trim() });
      } else {
        await apiSend('POST', '/projects', { name: name.trim(), key: key.trim() || undefined, kind });
        toast.success('Proyecto creado', { description: name.trim() });
      }
      onOpenChange(false);
      onSaved();
    } catch (e: any) {
      toast.error('No se pudo guardar', { description: String(e.message ?? e) });
    }
    setBusy(false);
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
function DeleteProject({ project, open, onOpenChange, onDeleted }: { project: ProjectListItem; open: boolean; onOpenChange: (v: boolean) => void; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = confirm.trim() === project.name;

  useEffect(() => { if (open) setConfirm(''); }, [open]);

  async function del() {
    if (!matches) return;
    setBusy(true);
    try {
      await apiSend('DELETE', `/projects/${project.projectId}`);
      toast.success('Proyecto eliminado', { description: project.name });
      onOpenChange(false);
      onDeleted();
    } catch (e: any) {
      toast.error('No se pudo eliminar', { description: String(e.message ?? e) });
    }
    setBusy(false);
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Eliminar "{project.name}"</AlertDialogTitle>
          <AlertDialogDescription>
            Esta acción es permanente. Se desvinculan sus repos y se quita el proyecto de los commits y tickets
            relacionados. El trabajo de Linear no se borra, pero pierde su vínculo con este proyecto. No se puede deshacer.
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
