import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Archive, ArchiveRestore, Bot, ChevronRight, CircleOff, FolderGit2, GitBranch, ListChecks, Loader2, Server, Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { ProjectIcon } from '@/components/avatars';
import { Button } from '@/components/ui/button';
import { ColorField } from '@/components/ui/color-field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { apiSend, PROJECT_TYPES, type ProjectKind, type ProjectProfileSuggestion } from '@/lib/api';
import { hslToHex, projectHue, type ProjectDraft } from './project-ui';

const NO_TYPE = '__none__';

/** Proyecto que el modal sabe editar (sirve la fila de la lista y el detalle). */
export interface EditableProject {
  projectId: string;
  name: string;
  key: string;
  kind: ProjectKind;
  color: string | null;
  projectType?: string | null;
  description?: string | null;
  repos?: string[];
}

/** Disparador de propiedad estilo Linear: píldora baja con hairline. */
const PILL = 'h-8 w-auto gap-1.5 rounded-md border bg-card px-2.5 text-[12.5px] font-medium shadow-none';

/**
 * Alta / edición de proyecto, con la forma de Linear: el nombre grande arriba, la descripción como
 * texto libre debajo y las propiedades (clase, tipo, clave, color) como píldoras en una sola fila.
 * Sin etiquetas encima de cada campo ni párrafos de ayuda: la píldora dice qué es.
 *
 * En edición ofrece "Sugerir con IA" (lee los repos vinculados y propone tipo + descripción; no
 * guarda nada hasta que se guarda el modal). ⌘/Ctrl+Enter guarda.
 */
export function ProjectDialog({
  project,
  open,
  onOpenChange,
  onSubmit,
}: {
  project?: EditableProject | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Recibe el borrador; el padre decide si es POST o PATCH (y su optimismo). */
  onSubmit: (draft: ProjectDraft) => Promise<unknown>;
}) {
  const editing = !!project;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [key, setKey] = useState('');
  const [kind, setKind] = useState<ProjectKind>('internal');
  const [type, setType] = useState<string>(NO_TYPE);
  const [color, setColor] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestedBy, setSuggestedBy] = useState<ProjectProfileSuggestion | null>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  // Dep en el ID, nunca en el objeto: la fila se renueva en cada revalidación y reescribiría el
  // formulario mientras se escribe.
  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setDescription(project?.description ?? '');
    setKey(project?.key ?? '');
    setKind(project?.kind ?? 'internal');
    setType(project?.projectType ?? NO_TYPE);
    setColor(project?.color ?? '');
    setSuggestedBy(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.projectId]);

  // La descripción crece con el texto (como en Linear) en vez de mostrar un scroll interno.
  useEffect(() => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [description, open]);

  const canSuggest = editing && (project?.repos?.length ?? 1) > 0;

  async function suggest() {
    if (!project) return;
    setSuggesting(true);
    try {
      const { suggestion } = await apiSend<{ suggestion: ProjectProfileSuggestion }>('POST', `/projects/${project.projectId}/profile/suggest`);
      if (suggestion.projectType) setType(suggestion.projectType);
      if (suggestion.description) setDescription(suggestion.description);
      setSuggestedBy(suggestion);
    } catch (e: any) {
      toast.error('No se pudo sugerir', { description: String(e?.message ?? e) });
    }
    setSuggesting(false);
  }

  async function save() {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      await onSubmit({
        name: n,
        key: key.trim().toUpperCase(),
        kind,
        color: color || null,
        projectType: type === NO_TYPE ? null : type,
        description: description.trim() || null,
      });
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  const autoColor = hslToHex(projectHue(key.trim() || name || 'x'), 62, 45);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showClose={false}
        className="gap-0 overflow-hidden p-0 sm:max-w-[640px]"
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } }}
      >
        {/* Migas: dónde se crea, como el "Equipo › Nuevo issue" de Linear. */}
        <div className="flex items-center gap-1.5 px-5 pb-1 pt-3">
          <span className="label-caps">Proyectos</span>
          <ChevronRight className="size-3 text-faint" />
          <span className="label-caps min-w-0 flex-1 truncate text-muted-foreground">{editing ? 'Editar' : 'Nuevo proyecto'}</span>
          <DialogCloseButton className="-mr-2" />
        </div>

        <div className="grid gap-1 px-5 pb-4 pt-2">
          <div className="flex items-start gap-3">
            {project && <ProjectIcon id={project.projectId} name={name || project.name} size="md" className="mt-1 shrink-0" />}
            <div className="grid min-w-0 flex-1 gap-1">
              <DialogTitle className="sr-only">{editing ? 'Editar proyecto' : 'Nuevo proyecto'}</DialogTitle>
              <DialogDescription className="sr-only">Nombre, descripción y propiedades del proyecto.</DialogDescription>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nombre del proyecto"
                aria-label="Nombre del proyecto"
                autoFocus
                className="w-full bg-transparent text-[22px] font-semibold tracking-[-0.03em] outline-none placeholder:text-faint"
              />
              <textarea
                ref={descRef}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                maxLength={1000}
                aria-label="Descripción"
                placeholder="Agrega una descripción: qué es, para quién y cómo está hecho. roz la lee al clasificar sus tareas."
                className="min-h-[52px] w-full resize-none bg-transparent text-[14px] leading-relaxed text-foreground outline-none placeholder:text-faint"
              />
            </div>
          </div>

          {suggestedBy && (
            <p className="mt-1 flex items-center gap-1.5 rounded-md bg-lavender px-2.5 py-1.5 text-xs text-purple-deep">
              <Bot className="size-3.5 shrink-0" />
              Propuesto leyendo {suggestedBy.repos.map((r) => r.split('/').pop()).join(', ')}. Revísalo antes de guardar.
            </p>
          )}

          {/* Propiedades en píldoras */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Select value={kind} onValueChange={(v) => setKind(v as ProjectKind)}>
              <SelectTrigger className={PILL} aria-label="Clase">
                <span className={cn('size-2 rounded-full', kind === 'client' ? 'bg-yellow' : 'bg-toggle-off')} />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="internal">Interno</SelectItem>
                <SelectItem value="client">Cliente</SelectItem>
              </SelectContent>
            </Select>

            <Select value={type} onValueChange={setType}>
              <SelectTrigger className={cn(PILL, type === NO_TYPE && 'text-muted-foreground')} aria-label="Tipo de proyecto">
                <FolderGit2 className="size-3.5 text-faint" />
                <SelectValue placeholder="Tipo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TYPE}>Sin tipo</SelectItem>
                {PROJECT_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>

            <label className={cn('inline-flex items-center', PILL)} title="Clave corta y única (se guarda en mayúsculas)">
              <span className="label-caps text-[10px]">Clave</span>
              <input
                value={key}
                onChange={(e) => setKey(e.target.value.toUpperCase())}
                placeholder={editing ? '' : 'AUTO'}
                maxLength={12}
                aria-label="Clave"
                className="w-[72px] bg-transparent font-mono text-[12px] uppercase outline-none placeholder:text-faint"
              />
            </label>

            <ColorField
              value={color || autoColor}
              onChange={(e) => setColor(e.target.value)}
              aria-label="Color del proyecto"
              title="Color de identidad del proyecto"
              className={cn('inline-flex cursor-pointer items-center', PILL)}
            >
              <span className="size-3.5 rounded-[4px] ring-1 ring-border" style={{ background: color || autoColor }} />
              <span>{color ? 'Color' : 'Color auto'}</span>
            </ColorField>
            {color && (
              <button type="button" onClick={() => setColor('')} className="rounded-sm px-1.5 text-[12px] text-muted-foreground hover:text-foreground">
                Volver a auto
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-sidebar px-5 py-3">
          {canSuggest ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={suggest}
              disabled={suggesting}
              className="-ml-2 text-purple-deep hover:bg-lavender hover:text-purple-deep"
            >
              {suggesting ? <Loader2 className="animate-spin" /> : <Bot />} Sugerir con IA
            </Button>
          ) : (
            <span className="hidden text-[12px] text-faint sm:inline">Después vinculas sus repos desde el detalle.</span>
          )}
          <span className="ml-auto hidden text-[11px] text-faint tabular-nums sm:inline">Ctrl + Enter</span>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={save} disabled={busy || !name.trim()}>
            {busy && <Loader2 className="animate-spin" />}
            {editing ? 'Guardar' : 'Crear proyecto'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Fila de consecuencia: ícono + texto corto. Más legible que un párrafo de advertencias. */
function Consequence({ icon, tone = 'neutral', children }: { icon: ReactNode; tone?: 'neutral' | 'bad' | 'ok'; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[13px] leading-snug">
      <span
        className={cn(
          'mt-px grid size-6 shrink-0 place-items-center rounded-md [&_svg]:size-3.5',
          tone === 'bad' ? 'bg-red-soft text-red' : tone === 'ok' ? 'bg-green-soft text-green' : 'bg-panel text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span className="pt-0.5 text-foreground">{children}</span>
    </li>
  );
}

/**
 * Archivar / restaurar. Archivar es la forma "segura" de quitar un proyecto: roz deja de asignarle
 * trabajo y sale de los selectores, pero conserva todo. Restaurar lo devuelve tal cual.
 */
export function ArchiveProjectDialog({
  project,
  open,
  onOpenChange,
  onConfirm,
}: {
  project: { name: string; active?: boolean } | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  if (!project) return null;
  const restoring = project.active === false;

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{restoring ? `Restaurar "${project.name}"` : `Archivar "${project.name}"`}</AlertDialogTitle>
          <AlertDialogDescription>
            {restoring ? 'Vuelve a la lista de proyectos activos.' : 'Sale de la vista principal sin perder nada.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="grid gap-2">
          {restoring ? (
            <>
              <Consequence icon={<ListChecks />} tone="ok">roz vuelve a asignarle tareas nuevas.</Consequence>
              <Consequence icon={<FolderGit2 />} tone="ok">Aparece otra vez en los selectores (Discord, juntas, tareas).</Consequence>
            </>
          ) : (
            <>
              <Consequence icon={<CircleOff />}>roz deja de asignarle tareas nuevas.</Consequence>
              <Consequence icon={<FolderGit2 />}>Sale de los selectores de Discord, juntas y tareas.</Consequence>
              <Consequence icon={<GitBranch />} tone="ok">Conserva sus repos, commits y tareas. Lo restauras cuando quieras.</Consequence>
            </>
          )}
        </ul>
        <AlertDialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant={restoring ? 'default' : 'dark'} onClick={confirm} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : restoring ? <ArchiveRestore /> : <Archive />}
            {restoring ? 'Restaurar' : 'Archivar'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Borrado definitivo. Solo se ofrece para proyectos YA archivados (archivar primero es el camino
 * normal) y exige escribir el nombre. Dice qué pasa con cada cosa que cuelga del proyecto.
 */
export function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
  onConfirm,
}: {
  project: { name: string; repos?: string[] } | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => Promise<unknown>;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setTyped(''); }, [open]);
  if (!project) return null;
  const matches = typed.trim() === project.name;
  const repoCount = project.repos?.length ?? 0;

  async function confirm() {
    if (!matches || busy) return;
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Eliminar "{project.name}"</AlertDialogTitle>
          <AlertDialogDescription>Es permanente y no se puede deshacer.</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="grid gap-2">
          <Consequence icon={<GitBranch />} tone="bad">
            Se desvinculan {repoCount === 1 ? 'su repo' : `sus ${repoCount} repos`}; sus commits se quedan sin proyecto.
          </Consequence>
          <Consequence icon={<ListChecks />}>Las tareas no se borran: pierden el vínculo con el proyecto.</Consequence>
          <Consequence icon={<Server />} tone="bad">Se quitan sus servicios de infraestructura y los borradores pendientes.</Consequence>
        </ul>
        <div className="grid gap-1.5">
          <label htmlFor="confirm-project-name" className="text-[13px] text-muted-foreground">
            Escribe <span className="select-all rounded-sm bg-red-soft px-1.5 py-0.5 text-[12.5px] font-semibold text-red">{project.name}</span> para confirmar
          </label>
          <Input
            id="confirm-project-name"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirm()}
            autoComplete="off"
            autoFocus
          />
        </div>
        <AlertDialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant="destructive" onClick={confirm} disabled={!matches || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Eliminar para siempre
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
