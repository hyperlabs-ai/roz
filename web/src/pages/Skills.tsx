import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, TriangleAlert, Loader2 } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { UserAvatar, EmptyState, ErrorCard, Fresh, RefreshButton, Revalidating, SegmentMeter } from '@/components/bits';
import { useAuth } from '@/auth/AuthContext';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { useApi } from '@/lib/useApi';
import { useMirror } from '@/lib/useMirror';
import { invalidateOnly } from '@/lib/store';
import { apiGet, apiSend, type SkillCatalogItem, type SkillMatrix } from '@/lib/api';

type Cell = SkillMatrix['cells'][number];

/** Las celdas no tienen id propio: su identidad es el par (dev, skill). */
const cellKey = (c: { devId: string; skillId: string }) => `${c.devId}:${c.skillId}`;

export default function Skills() {
  const { user } = useAuth();
  const isAdmin = !!user; // control total para cualquier usuario autenticado (sin roles)
  // Catálogo y matriz cambian poco: TTL largo. Volver a la sección no vuelve a pedirlos.
  const catalog = useApi<{ skills: SkillCatalogItem[] }>(() => apiGet('/skills'), [], { key: '/skills', ttl: 300_000 });
  const matrix = useApi<SkillMatrix>(() => apiGet('/skills/matrix'), [], { key: '/skills/matrix', ttl: 300_000 });

  // Espejos locales. Antes cada clic en una celda hacía DOS refetches (`/skills` + `/skills/matrix`)
  // y repintaba el heatmap completo, mientras el toast ya afirmaba el nivel nuevo y la celda seguía
  // mostrando el viejo. Con el espejo, la celda cambia en el frame del clic y nada más se mueve.
  const skills = useMirror<SkillCatalogItem>(catalog.data?.skills, { key: (s) => s.skillId });
  const cells = useMirror<Cell>(matrix.data?.cells, { key: cellKey });

  const levels = useMemo(() => new Map(cells.items.map((c) => [cellKey(c), c.level])), [cells.items]);

  // Filas de la matriz: las que sirve el backend más las skills recién creadas aquí, para poder
  // asignarles nivel sin esperar el siguiente refetch.
  const rows = useMemo(() => {
    const served = matrix.data?.skills ?? [];
    const ids = new Set(served.map((s) => s.id));
    const extra = skills.items.filter((s) => !ids.has(s.skillId)).map((s) => ({ id: s.skillId, tag: s.tag }));
    return [...extra, ...served];
  }, [matrix.data?.skills, skills.items]);

  /**
   * Nivel de una celda (0–5). Un solo punto de verdad para los seis botones del popover.
   * El backend responde `{ok:true}` a este endpoint, así que `send` no devuelve fila y se queda el
   * optimista — que es correcto: el nivel lo eligió el cliente, no hay nada que adoptar.
   */
  const setLevel = useCallback(
    async (devId: string, skillId: string, level: number) => {
      const id = cellKey({ devId, skillId });
      const cell = cells.items.find((c) => cellKey(c) === id);
      // Sin toast de éxito: el número ya cambió en pantalla, y un toast por clic es puro ruido.
      const notes = { success: false as const, error: 'No se pudo guardar el nivel' };

      if (level <= 0) {
        if (cell) await cells.remove(cell, () => apiSend('DELETE', `/devs/${devId}/skills/${skillId}`), notes);
      } else if (!cell) {
        await cells.create({ devId, skillId, level }, async () => {
          await apiSend('POST', `/devs/${devId}/skills`, { skillId, level });
          return { devId, skillId, level };
        }, notes);
      } else {
        await cells.patch(cell, { level }, async () => {
          await apiSend('POST', `/devs/${devId}/skills`, { skillId, level });
        }, notes);
      }
      // El catálogo muestra cobertura y nivel promedio: se revalida en silencio. `invalidateOnly`
      // para NO arrastrar `/skills/matrix`, que es justo lo que no queremos repintar.
      invalidateOnly('/skills');
    },
    [cells],
  );

  const createSkill = useCallback(
    (tag: string, description: string | null) =>
      skills.create(
        { skillId: `nueva:${tag}`, tag, description, devCount: 0, avgLevel: 0, busFactorRisk: false },
        async () => {
          // El backend devuelve la fila cruda (`id, tag, description`), no el item del catálogo con
          // sus agregados: se mapea aquí con ceros y el refetch silencioso los rellena.
          const r = await apiSend<{ skill: { id: string; tag: string; description: string | null } }>(
            'POST', '/skills', { tag, description },
          );
          return { skillId: r.skill.id, tag: r.skill.tag, description: r.skill.description, devCount: 0, avgLevel: 0, busFactorRisk: false };
        },
        { success: { title: 'Skill creada', description: tag } },
      ),
    [skills],
  );

  const updateSkill = useCallback(
    (s: SkillCatalogItem, tag: string, description: string | null) =>
      skills.patch(s, { tag, description }, async () => {
        await apiSend('PATCH', `/skills/${s.skillId}`, { tag, description });
      }, { success: { title: 'Skill actualizada', description: tag } }),
    [skills],
  );

  const deleteSkill = useCallback(
    (s: SkillCatalogItem) =>
      skills.remove(s, () => apiSend('DELETE', `/skills/${s.skillId}`), {
        success: { title: 'Skill borrada', description: s.tag },
        error: 'No se pudo borrar',
      }).then(() => invalidateOnly('/skills/matrix')),
    [skills],
  );

  const refetching = catalog.refetching || matrix.refetching;

  return (
    <Layout
      title="Skills"
      subtitle="Capacidades y cobertura del equipo"
      actions={
        <>
          <RefreshButton
            busy={refetching}
            onClick={() => { catalog.reload(); matrix.reload(); }}
            title="Traer cambios del equipo"
          />
          {isAdmin && <SkillDialog onCreate={createSkill} />}
        </>
      }
    >
      {(catalog.error || matrix.error) && <ErrorCard className="mb-4" message={catalog.error ?? matrix.error} />}
      <Tabs defaultValue="map">
        <TabsList className="mx-auto flex w-fit">
          <TabsTrigger value="map">Mapa de habilidades</TabsTrigger>
          <TabsTrigger value="catalog">Catálogo</TabsTrigger>
        </TabsList>

        <TabsContent value="map">
          <Card>
            <CardHeader>
              <CardTitle>Quién domina qué</CardTitle>
              <CardDescription>{isAdmin ? 'Click en una celda para asignar el nivel (0–5)' : 'Nivel de cada persona por habilidad (0–5)'}</CardDescription>
            </CardHeader>
            <CardContent>
              {matrix.loading ? (
                <Skeleton className="h-72" />
              ) : matrix.data ? (
                <Matrix
                  devs={matrix.data.devs}
                  rows={rows}
                  levels={levels}
                  isAdmin={isAdmin}
                  isBusy={cells.isBusy}
                  onSet={setLevel}
                />
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="catalog">
          {catalog.loading ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-32" />)}</div>
          ) : !skills.items.length ? (
            <Card><CardContent className="py-10"><EmptyState>No hay skills</EmptyState></CardContent></Card>
          ) : (
            <Revalidating active={catalog.refetching}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {skills.items.map((s) => (
                  <Fresh key={s.skillId} fresh={skills.isFresh(s.skillId)} className="h-full">
                    <SkillCard
                      s={s}
                      isAdmin={isAdmin}
                      busy={skills.isBusy(s.skillId)}
                      onUpdate={updateSkill}
                      onDelete={deleteSkill}
                    />
                  </Fresh>
                ))}
              </div>
            </Revalidating>
          )}
        </TabsContent>
      </Tabs>
    </Layout>
  );
}

// ---- Tarjeta de skill (catálogo) ----
function SkillCard({
  s,
  isAdmin,
  busy,
  onUpdate,
  onDelete,
}: {
  s: SkillCatalogItem;
  isAdmin: boolean;
  busy: boolean;
  onUpdate: (s: SkillCatalogItem, tag: string, description: string | null) => Promise<void>;
  onDelete: (s: SkillCatalogItem) => Promise<void>;
}) {
  const max = 6; // referencia visual de cobertura (equipo ~6 devs activos)
  return (
    <Card className={cn('group flex h-full flex-col p-4', s.busFactorRisk && 'border-warning/30', busy && 'opacity-60')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{s.tag}</span>
            {busy && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
            {s.busFactorRisk && (
              <Tooltip>
                <TooltipTrigger asChild><Badge variant="warning"><TriangleAlert className="size-3" /></Badge></TooltipTrigger>
                <TooltipContent>Solo {s.devCount} persona(s) domina(n) esta habilidad</TooltipContent>
              </Tooltip>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{s.description ?? 'Sin descripción'}</p>
        </div>
        {isAdmin && (
          <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <SkillDialog
              skill={s}
              onUpdate={onUpdate}
              trigger={<Button variant="ghost" size="icon-sm" disabled={busy}><Pencil className="size-4" /></Button>}
            />
            <DeleteSkill skill={s} busy={busy} onDelete={onDelete} />
          </div>
        )}
      </div>

      <div className="mt-auto pt-3">
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{s.devCount} {s.devCount === 1 ? 'persona' : 'personas'}</span>
          <span className="text-muted-foreground">nivel prom. <span className="font-semibold text-foreground">{s.avgLevel || '—'}</span></span>
        </div>
        {/* Medidor segmentado (no barra continua): un segmento por dev cubierto, sobre el equipo de
            referencia. Es la misma primitiva que los niveles de skill, así que la escala se lee
            igual en las dos pantallas. */}
        <SegmentMeter value={s.devCount} max={max} tone={s.busFactorRisk ? 'warning' : 'success'} />
      </div>
    </Card>
  );
}

// Escala de color del heatmap (0–5). Intensidad creciente del primary; nivel 0 = base sutil.
const CELL_STYLE = (level: number): { backgroundColor: string; color: string } => {
  const ramp = [0, 0.2, 0.38, 0.58, 0.78, 1];
  if (level <= 0) return { backgroundColor: 'hsl(var(--muted) / 0.55)', color: 'transparent' };
  return {
    backgroundColor: `hsl(var(--primary) / ${ramp[level]})`,
    color: level >= 3 ? 'hsl(var(--primary-foreground))' : 'hsl(var(--primary))',
  };
};

// ---- Matriz heatmap: skills en filas (sticky), devs en columnas (avatares) ----
function Matrix({
  devs,
  rows,
  levels,
  isAdmin,
  isBusy,
  onSet,
}: {
  devs: SkillMatrix['devs'];
  rows: { id: string; tag: string }[];
  levels: Map<string, number>;
  isAdmin: boolean;
  isBusy: (id: string) => boolean;
  onSet: (devId: string, skillId: string, level: number) => Promise<void>;
}) {
  if (!devs.length || !rows.length) return <EmptyState>Sin datos para la matriz</EmptyState>;

  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground sm:hidden">Desliza horizontalmente para ver a todo el equipo →</p>
      <div className="overflow-x-auto scrollbar-thin pb-1">
        <table className="border-separate border-spacing-1 sm:border-spacing-1.5">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-card" />
              {devs.map((d) => (
                <th key={d.id} className="px-0.5 pb-2 align-bottom">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="mx-auto w-fit cursor-default"><UserAvatar url={d.avatarUrl} name={d.name} className="size-6 sm:size-8" /></div>
                    </TooltipTrigger>
                    <TooltipContent>{d.name}</TooltipContent>
                  </Tooltip>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td className="sticky left-0 z-10 border-r border-border/60 bg-card py-1 pr-2 text-xs font-medium sm:pr-3 sm:text-sm">
                  <span className="block min-w-[68px] max-w-[100px] truncate sm:min-w-[110px] sm:max-w-[140px]">{s.tag}</span>
                </td>
                {devs.map((d) => (
                  <td key={d.id} className="p-0">
                    <SkillCell
                      devName={d.name}
                      skillTag={s.tag}
                      level={levels.get(`${d.id}:${s.id}`) ?? 0}
                      isAdmin={isAdmin}
                      busy={isBusy(`${d.id}:${s.id}`)}
                      onSet={(n) => onSet(d.id, s.id, n)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Leyenda de escala */}
      <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <span>Menos</span>
        <div className="flex gap-1">
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <div key={n} className="flex size-5 items-center justify-center rounded text-[10px] font-semibold" style={CELL_STYLE(n)}>
              {n || ''}
            </div>
          ))}
        </div>
        <span>Más</span>
      </div>
    </div>
  );
}

function SkillCell({
  devName,
  skillTag,
  level,
  isAdmin,
  busy,
  onSet,
}: {
  devName: string;
  skillTag: string;
  level: number;
  isAdmin: boolean;
  busy: boolean;
  onSet: (level: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const cell = (
    <div
      className={cn(
        'mx-auto flex size-7 items-center justify-center rounded-md text-xs font-bold tabular-nums transition-all sm:size-10 sm:rounded-lg sm:text-sm',
        isAdmin && 'cursor-pointer hover:ring-2 hover:ring-ring hover:ring-offset-1 hover:ring-offset-card',
        busy && 'animate-pulse',
      )}
      style={CELL_STYLE(level)}
    >
      {level || ''}
    </div>
  );

  if (!isAdmin)
    return (
      <Tooltip>
        <TooltipTrigger asChild>{cell}</TooltipTrigger>
        <TooltipContent>{devName} · {skillTag}: {level || 'sin nivel'}</TooltipContent>
      </Tooltip>
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{cell}</PopoverTrigger>
      <PopoverContent className="w-auto p-3">
        <div className="mb-2.5 flex items-center gap-2 text-xs">
          <UserAvatar url={null} name={devName} className="size-5" />
          <span className="text-muted-foreground">{devName} · <span className="font-medium text-foreground">{skillTag}</span></span>
        </div>
        <div className="flex gap-1.5">
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              // El popover se cierra CUANDO TERMINA, no antes: cerrarlo primero dejaba al usuario
              // mirando la celda con el valor viejo y un toast que afirmaba el nuevo.
              onClick={() => { void onSet(n).finally(() => setOpen(false)); }}
              disabled={busy}
              title={n === 0 ? 'Quitar' : `Nivel ${n}`}
              className={cn(
                'flex size-9 items-center justify-center rounded-lg text-sm font-bold tabular-nums transition-all hover:ring-2 hover:ring-ring disabled:opacity-50',
                n === level && 'ring-2 ring-ring ring-offset-1 ring-offset-popover',
              )}
              style={CELL_STYLE(n)}
            >
              {n || '–'}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---- Dialog crear/editar skill ----
function SkillDialog({
  skill,
  onCreate,
  onUpdate,
  trigger,
}: {
  skill?: SkillCatalogItem;
  onCreate?: (tag: string, description: string | null) => Promise<unknown>;
  onUpdate?: (s: SkillCatalogItem, tag: string, description: string | null) => Promise<void>;
  trigger?: React.ReactNode;
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
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar skill' : 'Nueva skill'}</DialogTitle>
          <DialogDescription>El tag se usa para clasificar y se reindexa para búsqueda semántica.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tag">Tag</Label>
            <Input id="tag" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="ej. kubernetes" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="desc">Descripción</Label>
            <Input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Para qué sirve esta skill" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancelar</Button>
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
                tarjeta se queda en pantalla como si nada hubiera pasado. */}
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
