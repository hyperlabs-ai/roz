import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { GraduationCap, Loader2, Pencil, Plus, Search, Trash2, TriangleAlert, X } from 'lucide-react';
import { EmptyState, Fresh, Revalidating, SegmentMeter } from '@/components/bits';
import { CapsLabel } from '@/components/brand';
import { Segmented } from '@/components/pulse/roz-v2';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import type { SkillCatalogItem } from '@/lib/api';

type Filter = 'all' | 'risk' | 'empty';

/** Columnas de la lista del catálogo (encabezado y filas comparten la plantilla). */
const ROW = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 sm:grid-cols-[minmax(0,1.6fr)_minmax(7rem,1fr)_4.5rem_6.5rem_4.5rem]';

/**
 * Catálogo de skills como LISTA con buscador (no rejilla de tarjetas): el catálogo crece sin tope y
 * una rejilla de N tarjetas siempre termina con huecos. Cada fila: tag + descripción, cobertura
 * (un tramo por persona), nivel promedio, riesgo y acciones.
 */
export function SkillCatalog({
  items,
  loading,
  refetching,
  teamSize,
  isAdmin,
  isBusy,
  isFresh,
  onCreate,
  onUpdate,
  onDelete,
}: {
  items: SkillCatalogItem[];
  loading: boolean;
  refetching: boolean;
  teamSize: number;
  isAdmin: boolean;
  isBusy: (id: string) => boolean;
  isFresh: (id: string) => boolean;
  onCreate: (tag: string, description: string | null) => Promise<unknown>;
  onUpdate: (s: SkillCatalogItem, tag: string, description: string | null) => Promise<void>;
  onDelete: (s: SkillCatalogItem) => Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const max = Math.max(1, teamSize);

  const counts = useMemo(
    () => ({ risk: items.filter((s) => s.busFactorRisk).length, empty: items.filter((s) => !s.devCount).length }),
    [items],
  );
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items
      .filter((s) => (filter === 'risk' ? s.busFactorRisk : filter === 'empty' ? !s.devCount : true))
      .filter((s) => !needle || s.tag.toLowerCase().includes(needle) || (s.description ?? '').toLowerCase().includes(needle))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, [items, q, filter]);

  if (loading) {
    return (
      <Card className="divide-y">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className={cn(ROW, 'px-4 py-3')}>
            <div className="grid gap-1.5"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-56" /></div>
            <Skeleton className="hidden h-1.5 w-full rounded-full sm:block" />
            <Skeleton className="hidden h-4 w-8 sm:block" />
            <Skeleton className="hidden h-5 w-20 rounded-full sm:block" />
            <span />
          </div>
        ))}
      </Card>
    );
  }

  if (!items.length) {
    return (
      <Card>
        <EmptyState icon={<GraduationCap />} action={isAdmin ? <SkillDialog onCreate={onCreate} /> : undefined}>
          No hay skills todavía. Crea la primera para empezar a mapear al equipo.
        </EmptyState>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3">
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar skill…" className="h-8 pl-8 pr-8" aria-label="Buscar skill" />
          {q && (
            <button type="button" onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-foreground" aria-label="Limpiar búsqueda">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Todas', count: items.length },
            { value: 'risk', label: 'En riesgo', count: counts.risk },
            { value: 'empty', label: 'Sin cubrir', count: counts.empty },
          ]}
        />
        <span className="ml-auto text-xs text-faint tabular-nums">{shown.length} de {items.length}</span>
      </div>

      <div className={cn(ROW, 'hidden border-b bg-sidebar px-4 py-2 sm:grid')}>
        <CapsLabel>Skill</CapsLabel>
        <CapsLabel>Cobertura</CapsLabel>
        <CapsLabel className="text-right">Promedio</CapsLabel>
        <CapsLabel>Estado</CapsLabel>
        <span />
      </div>

      <Revalidating active={refetching}>
        {!shown.length ? (
          <EmptyState icon={<Search />}>Ninguna skill coincide con el filtro.</EmptyState>
        ) : (
          <div className="divide-y">
            {shown.map((s) => (
              <Fresh key={s.skillId} fresh={isFresh(s.skillId)} className="rounded-none">
                <CatalogRow s={s} max={max} isAdmin={isAdmin} busy={isBusy(s.skillId)} onUpdate={onUpdate} onDelete={onDelete} />
              </Fresh>
            ))}
          </div>
        )}
      </Revalidating>
    </Card>
  );
}

function CatalogRow({
  s,
  max,
  isAdmin,
  busy,
  onUpdate,
  onDelete,
}: {
  s: SkillCatalogItem;
  max: number;
  isAdmin: boolean;
  busy: boolean;
  onUpdate: (s: SkillCatalogItem, tag: string, description: string | null) => Promise<void>;
  onDelete: (s: SkillCatalogItem) => Promise<void>;
}) {
  return (
    <div className={cn(ROW, 'group px-4 py-2.5 transition-colors hover:bg-sidebar', busy && 'opacity-60')}>
      <div className="grid min-w-0 gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13.5px] font-semibold tracking-[-0.01em]">{s.tag}</span>
          {busy && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
        </span>
        <span className="truncate text-xs text-muted-foreground">{s.description ?? 'Sin descripción'}</span>
        {/* En móvil, cobertura en línea bajo el nombre. */}
        <span className="mt-1 flex items-center gap-2 sm:hidden">
          <SegmentMeter value={s.devCount} max={max} color={s.busFactorRisk ? 'orange' : 'green'} className="w-24" />
          <span className="text-[11px] text-faint tabular-nums">{s.devCount}/{max}</span>
        </span>
      </div>
      <div className="hidden items-center gap-2 sm:flex">
        <SegmentMeter value={s.devCount} max={max} color={s.busFactorRisk ? 'orange' : 'green'} className="flex-1" />
        <span className="w-8 text-right text-[11.5px] text-muted-foreground tabular-nums">{s.devCount}/{max}</span>
      </div>
      <span className="hidden text-right text-[13px] font-semibold tabular-nums sm:block">{s.avgLevel || '—'}</span>
      <span className="hidden sm:block">
        {s.busFactorRisk ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1 rounded-full bg-orange-soft px-2 py-0.5 text-[11px] font-semibold text-orange-ink">
                <TriangleAlert className="size-3" /> Bus factor
              </span>
            </TooltipTrigger>
            <TooltipContent>Solo {s.devCount} persona(s) domina(n) esta habilidad</TooltipContent>
          </Tooltip>
        ) : !s.devCount ? (
          <span className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">Sin cubrir</span>
        ) : (
          <span className="rounded-full bg-green-soft px-2 py-0.5 text-[11px] font-semibold text-green">Cubierta</span>
        )}
      </span>
      <div className="flex justify-end gap-0.5 transition-opacity sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover:opacity-100">
        {isAdmin && (
          <>
            <SkillDialog
              skill={s}
              onUpdate={onUpdate}
              trigger={<Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`Editar ${s.tag}`}><Pencil className="size-4" /></Button>}
            />
            <DeleteSkill skill={s} busy={busy} onDelete={onDelete} />
          </>
        )}
      </div>
    </div>
  );
}

// ---- Dialog crear/editar skill ----
export function SkillDialog({
  skill,
  onCreate,
  onUpdate,
  trigger,
}: {
  skill?: SkillCatalogItem;
  onCreate?: (tag: string, description: string | null) => Promise<unknown>;
  onUpdate?: (s: SkillCatalogItem, tag: string, description: string | null) => Promise<void>;
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const editing = !!skill;

  // Reset al ABRIR (y al cambiar de skill), nunca con dep en el objeto: la fila se renueva en cada
  // refetch, y depender de ella reescribiría el formulario mientras escribes.
  useEffect(() => {
    if (!open) return;
    setTag(skill?.tag ?? '');
    setDescription(skill?.description ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, skill?.skillId]);

  async function save() {
    const t = tag.trim();
    if (!t) return;
    setBusy(true);
    const desc = description.trim() || null;
    // El diálogo se cierra al terminar; la inserción/adopción optimista la hace el espejo del padre.
    if (editing && onUpdate) await onUpdate(skill!, t, desc);
    else if (onCreate) await onCreate(t, desc);
    setBusy(false);
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger ?? <Button><Plus /> Nueva skill</Button>}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader eyebrow="Catálogo · skill">
          <DialogTitle>{editing ? 'Editar skill' : 'Nueva skill'}</DialogTitle>
          <DialogDescription>El tag se usa para clasificar y se reindexa para búsqueda semántica.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="tag">Tag</Label>
            <Input id="tag" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="ej. kubernetes" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="desc">Descripción</Label>
            <Input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Para qué sirve esta skill" />
          </div>
          <button type="submit" hidden />
        </form>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={save} disabled={busy || !tag.trim()}>
            {busy ? <><Loader2 className="animate-spin" /> Guardando…</> : 'Guardar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteSkill({
  skill,
  busy,
  onDelete,
}: {
  skill: SkillCatalogItem;
  busy: boolean;
  onDelete: (s: SkillCatalogItem) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-destructive hover:text-destructive"
        disabled={busy}
        onClick={() => setOpen(true)}
        aria-label={`Borrar ${skill.tag}`}
      >
        <Trash2 className="size-4" />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Borrar la skill "{skill.tag}"?</AlertDialogTitle>
            <AlertDialogDescription>Se quitará de todos los developers que la tengan asignada. Esta acción no se puede deshacer.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
            {/* preventDefault: sin esto Radix cierra el diálogo ANTES de que salga el DELETE, y la
                fila se queda en pantalla como si nada hubiera pasado. */}
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => { e.preventDefault(); void onDelete(skill).finally(() => setOpen(false)); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? <><Loader2 className="animate-spin" /> Borrando…</> : 'Borrar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
