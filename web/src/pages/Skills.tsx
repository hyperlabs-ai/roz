import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, TriangleAlert } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { UserAvatar, EmptyState } from '@/components/bits';
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
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { useApi } from '@/lib/useApi';
import { apiGet, apiSend, type SkillCatalogItem, type SkillMatrix } from '@/lib/api';

export default function Skills() {
  const { user } = useAuth();
  const isAdmin = ['admin', 'superadmin'].includes(user?.role ?? '');
  const catalog = useApi<{ skills: SkillCatalogItem[] }>(() => apiGet('/skills'), []);
  const matrix = useApi<SkillMatrix>(() => apiGet('/skills/matrix'), []);
  const reload = () => {
    catalog.reload();
    matrix.reload();
  };

  return (
    <Layout title="Skills" subtitle="Capacidades y cobertura del equipo" actions={isAdmin ? <SkillDialog onSaved={reload} /> : undefined}>
      <Tabs defaultValue="map">
        <TabsList>
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
              {matrix.loading ? <Skeleton className="h-72" /> : matrix.data ? <Matrix data={matrix.data} isAdmin={isAdmin} onChanged={reload} /> : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="catalog">
          {catalog.loading ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-32" />)}</div>
          ) : !catalog.data?.skills.length ? (
            <Card><CardContent className="py-10"><EmptyState>No hay skills</EmptyState></CardContent></Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {catalog.data.skills.map((s) => (
                <SkillCard key={s.skillId} s={s} isAdmin={isAdmin} onSaved={reload} onDeleted={reload} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </Layout>
  );
}

// ---- Tarjeta de skill (catálogo) ----
function SkillCard({ s, isAdmin, onSaved, onDeleted }: { s: SkillCatalogItem; isAdmin: boolean; onSaved: () => void; onDeleted: () => void }) {
  const max = 6; // referencia visual de cobertura (equipo ~6 devs activos)
  return (
    <Card className={cn('group flex flex-col p-4', s.busFactorRisk && 'border-warning/30')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{s.tag}</span>
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
            <SkillDialog skill={s} onSaved={onSaved} trigger={<Button variant="ghost" size="icon-sm"><Pencil className="size-4" /></Button>} />
            <DeleteSkill skill={s} onDeleted={onDeleted} />
          </div>
        )}
      </div>

      <div className="mt-auto pt-3">
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{s.devCount} {s.devCount === 1 ? 'persona' : 'personas'}</span>
          <span className="text-muted-foreground">nivel prom. <span className="font-semibold text-foreground">{s.avgLevel || '—'}</span></span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full', s.busFactorRisk ? 'bg-warning' : 'bg-success')}
            style={{ width: `${Math.max((s.devCount / max) * 100, 6)}%` }}
          />
        </div>
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
function Matrix({ data, isAdmin, onChanged }: { data: SkillMatrix; isAdmin: boolean; onChanged: () => void }) {
  const level = new Map(data.cells.map((c) => [`${c.devId}:${c.skillId}`, c.level]));
  if (!data.devs.length || !data.skills.length) return <EmptyState>Sin datos para la matriz</EmptyState>;

  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground sm:hidden">Desliza horizontalmente para ver a todo el equipo →</p>
      <div className="overflow-x-auto scrollbar-thin pb-1">
        <table className="border-separate border-spacing-1.5">
          <thead>
            <tr>
              <th className="sticky left-0 z-20 bg-card" />
              {data.devs.map((d) => (
                <th key={d.id} className="px-0.5 pb-2 align-bottom">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="mx-auto w-fit cursor-default"><UserAvatar url={d.avatarUrl} name={d.name} className="size-8" /></div>
                    </TooltipTrigger>
                    <TooltipContent>{d.name}</TooltipContent>
                  </Tooltip>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.skills.map((s) => (
              <tr key={s.id}>
                <td className="sticky left-0 z-20 border-r border-border/60 bg-card py-1 pr-3 text-sm font-medium">
                  <span className="block min-w-[80px] max-w-[140px] truncate sm:min-w-[110px]">{s.tag}</span>
                </td>
                {data.devs.map((d) => {
                  const lvl = level.get(`${d.id}:${s.id}`) ?? 0;
                  return (
                    <td key={d.id} className="p-0">
                      <SkillCell devId={d.id} skillId={s.id} devName={d.name} skillTag={s.tag} level={lvl} isAdmin={isAdmin} onChanged={onChanged} />
                    </td>
                  );
                })}
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

function SkillCell({ devId, skillId, devName, skillTag, level, isAdmin, onChanged }: { devId: string; skillId: string; devName: string; skillTag: string; level: number; isAdmin: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const cell = (
    <div
      className={cn(
        'mx-auto flex size-9 items-center justify-center rounded-lg text-sm font-bold tabular-nums transition-all sm:size-10',
        isAdmin && 'cursor-pointer hover:ring-2 hover:ring-ring hover:ring-offset-1 hover:ring-offset-card',
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

  async function set(newLevel: number) {
    setOpen(false);
    try {
      if (newLevel <= 0) await apiSend('DELETE', `/devs/${devId}/skills/${skillId}`);
      else await apiSend('POST', `/devs/${devId}/skills`, { skillId, level: newLevel });
      toast.success(`${devName} · ${skillTag}`, { description: newLevel <= 0 ? 'Skill removida' : `Nivel ${newLevel}` });
      onChanged();
    } catch (e: any) {
      toast.error('No se pudo guardar', { description: String(e.message ?? e) });
    }
  }

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
              onClick={() => set(n)}
              title={n === 0 ? 'Quitar' : `Nivel ${n}`}
              className={cn(
                'flex size-9 items-center justify-center rounded-lg text-sm font-bold tabular-nums transition-all hover:ring-2 hover:ring-ring',
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
function SkillDialog({ skill, onSaved, trigger }: { skill?: SkillCatalogItem; onSaved: () => void; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState(skill?.tag ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [busy, setBusy] = useState(false);
  const editing = !!skill;

  async function save() {
    if (!tag.trim()) return;
    setBusy(true);
    try {
      if (editing) await apiSend('PATCH', `/skills/${skill!.skillId}`, { tag: tag.trim(), description: description.trim() || null });
      else await apiSend('POST', '/skills', { tag: tag.trim(), description: description.trim() || null });
      toast.success(editing ? 'Skill actualizada' : 'Skill creada', { description: tag.trim() });
      setOpen(false);
      if (!editing) {
        setTag('');
        setDescription('');
      }
      onSaved();
    } catch (e: any) {
      toast.error('No se pudo guardar', { description: String(e.message ?? e) });
    }
    setBusy(false);
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
          <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button onClick={save} disabled={busy || !tag.trim()}>{busy ? 'Guardando…' : 'Guardar'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteSkill({ skill, onDeleted }: { skill: SkillCatalogItem; onDeleted: () => void }) {
  async function del() {
    try {
      await apiSend('DELETE', `/skills/${skill.skillId}`);
      toast.success('Skill borrada', { description: skill.tag });
      onDeleted();
    } catch (e: any) {
      toast.error('No se pudo borrar', { description: String(e.message ?? e) });
    }
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive"><Trash2 className="size-4" /></Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>¿Borrar la skill "{skill.tag}"?</AlertDialogTitle>
          <AlertDialogDescription>Se quitará de todos los developers que la tengan asignada. Esta acción no se puede deshacer.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={del} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Borrar</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
