import { useEffect, useState } from 'react';
import { toast } from '@/lib/toast';
import { Loader2, Pencil, Plus } from 'lucide-react';
import { EmptyState, ErrorCard, Revalidating } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { SectionHeader } from '@/components/brand';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { apiGet, apiSend, type SkillCatalogItem, type SolutionType } from '@/lib/api';
import { invalidateOnly } from '@/lib/store';
import { useApi } from '@/lib/useApi';
import { cn } from '@/lib/utils';

const POINTS = [1, 2, 3, 5, 8, 13];
const MODULE = '__module__';
const NONE = '__none__';

/**
 * Skills → Tipos de solución: qué CLASE de trabajo es una tarea y qué pide. Cuando roz lee un ticket,
 * Jev solo elige el tipo; esta tabla decide la skill primaria (o "la del módulo afectado"), el nivel
 * mínimo, la skill que ayuda y el tamaño típico. El nombre y la descripción son lo que lee roz.
 */
export function SolutionTypesPanel({ skills, isAdmin }: { skills: SkillCatalogItem[]; isAdmin: boolean }) {
  const list = useApi<{ types: SolutionType[] }>(() => apiGet('/solution-types'), [], { key: '/solution-types', ttl: 300_000 });
  const [editing, setEditing] = useState<SolutionType | 'new' | null>(null);
  const types = list.data?.types ?? [];

  async function saved(t: SolutionType, isNew: boolean) {
    toast.success(isNew ? 'Tipo creado' : 'Tipo actualizado', { description: t.name });
    setEditing(null);
    invalidateOnly('/tickets/filters'); // el select de "Tipo de solución" en las tareas
    list.reload();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-2">
          <SectionHeader size="sm" eyebrow="Clasificación · roz" eyebrowColor="purple-deep" title="Tipos de solución" />
          <CardDescription>
            Qué clase de trabajo es cada tarea y qué pide. roz clasifica cada ticket en un tipo; la skill, el nivel mínimo y el tamaño salen
            de aquí. Nivel 4 o más manda la tarea primero al especialista.
          </CardDescription>
        </div>
        {isAdmin && (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="size-4" /> Nuevo tipo
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {list.error && <ErrorCard className="mb-4" message={list.error} />}
        {list.loading ? (
          <Skeleton className="h-72" />
        ) : !types.length ? (
          <EmptyState>No hay tipos de solución. Créalos aquí (o aplica la migración 0032, que trae la tabla del equipo).</EmptyState>
        ) : (
          <Revalidating active={list.refetching}>
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b bg-sidebar text-left label-caps text-faint">
                    <th className="py-2 pl-3 pr-3 font-medium">Tipo</th>
                    <th className="py-2 pr-3 font-medium">Skill primaria</th>
                    <th className="py-2 pr-3 font-medium">Nivel mín.</th>
                    <th className="py-2 pr-3 font-medium">Secundaria</th>
                    <th className="py-2 pr-3 font-medium">Tamaño típico</th>
                    <th className="py-2 pr-3 font-medium">Tareas</th>
                    {isAdmin && <th className="py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {types.map((t) => (
                    <tr key={t.id} className={cn('border-b last:border-0 align-top transition-colors hover:bg-sidebar', !t.active && 'opacity-50')}>
                      <td className="py-3 pl-3 pr-3">
                        <div className="font-semibold tracking-[-0.01em]">
                          {t.name} {!t.active && <Badge variant="secondary" className="ml-1 label-caps">retirado</Badge>}
                        </div>
                        <div className="mt-0.5 max-w-md text-xs leading-relaxed text-muted-foreground">{t.description}</div>
                      </td>
                      <td className="py-3 pr-3">
                        {t.primarySkillTag
                          ? <span className="inline-block rounded-md bg-orange-soft px-2 py-0.5 text-xs font-semibold text-orange-ink">{t.primarySkillTag}</span>
                          : <span className="text-xs text-muted-foreground">la del módulo afectado</span>}
                      </td>
                      <td className="py-3 pr-3">
                        <span className={cn('inline-grid size-6 place-items-center rounded-md text-xs font-semibold tabular-nums', t.minLevel >= 4 ? 'bg-orange-soft text-orange-ink' : 'bg-panel')}>{t.minLevel}</span>
                        {t.minLevel >= 4 && <span className="mt-1 block text-[10.5px] text-orange-ink tabular-nums">especialista primero</span>}
                      </td>
                      <td className="py-3 pr-3">
                        {t.secondarySkillTag
                          ? <span className="inline-block rounded-md bg-panel px-2 py-0.5 text-xs font-medium">{t.secondarySkillTag}</span>
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="py-3 pr-3 whitespace-nowrap text-xs tabular-nums">
                        {/* La escala de puntos completa con el rango del tipo encendido: se compara de un vistazo entre filas. */}
                        <span className="flex items-center gap-0.5" aria-hidden>
                          {POINTS.map((p) => (
                            <span
                              key={p}
                              className={cn(
                                'grid h-5 min-w-5 place-items-center rounded px-1 text-[10.5px] font-semibold',
                                p >= t.sizeMin && p <= t.sizeMax ? 'bg-ink text-ink-foreground' : 'bg-panel text-faint',
                              )}
                            >
                              {p}
                            </span>
                          ))}
                        </span>
                        <span className="sr-only">{t.sizeMin === t.sizeMax ? t.sizeMin : `${t.sizeMin}–${t.sizeMax}`} pts</span>
                      </td>
                      <td className="py-3 pr-3 text-xs text-muted-foreground tabular-nums">{t.taskCount}</td>
                      {isAdmin && (
                        <td className="py-3 pr-2 text-right">
                          <Button size="icon-sm" variant="ghost" onClick={() => setEditing(t)} aria-label={`Editar ${t.name}`}>
                            <Pencil className="size-3.5" />
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Revalidating>
        )}
      </CardContent>

      <SolutionTypeDialog
        type={editing === 'new' ? null : editing}
        open={editing !== null}
        skills={skills}
        onOpenChange={(v) => !v && setEditing(null)}
        onSaved={saved}
      />
    </Card>
  );
}

function SolutionTypeDialog({
  type,
  open,
  skills,
  onOpenChange,
  onSaved,
}: {
  type: SolutionType | null;
  open: boolean;
  skills: SkillCatalogItem[];
  onOpenChange: (v: boolean) => void;
  onSaved: (t: SolutionType, isNew: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [primary, setPrimary] = useState(MODULE);
  const [minLevel, setMinLevel] = useState('3');
  const [secondary, setSecondary] = useState(NONE);
  const [sizeMin, setSizeMin] = useState('2');
  const [sizeMax, setSizeMax] = useState('5');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(type?.name ?? '');
    setDescription(type?.description ?? '');
    setPrimary(type ? type.primarySkillId ?? MODULE : skills[0]?.skillId ?? MODULE);
    setMinLevel(String(type?.minLevel ?? 3));
    setSecondary(type?.secondarySkillId ?? NONE);
    setSizeMin(String(type?.sizeMin ?? 2));
    setSizeMax(String(type?.sizeMax ?? 5));
    setActive(type?.active ?? true);
  }, [open, type, skills]);

  const sorted = [...skills].sort((a, b) => a.tag.localeCompare(b.tag));
  const rangeBad = Number(sizeMin) > Number(sizeMax);
  const sameSkill = primary !== MODULE && primary === secondary;
  const canSave = !!name.trim() && !!description.trim() && !rangeBad && !sameSkill && !busy;

  async function save() {
    setBusy(true);
    const body = {
      name: name.trim(),
      description: description.trim(),
      primarySkillId: primary === MODULE ? null : primary,
      minLevel: Number(minLevel),
      secondarySkillId: secondary === NONE ? null : secondary,
      sizeMin: Number(sizeMin),
      sizeMax: Number(sizeMax),
      ...(type ? { active } : {}),
    };
    try {
      const { type: savedType } = type
        ? await apiSend<{ type: SolutionType }>('PATCH', `/solution-types/${type.id}`, body)
        : await apiSend<{ type: SolutionType }>('POST', '/solution-types', body);
      onSaved(savedType, !type);
    } catch (e: any) {
      toast.error('No se pudo guardar el tipo', { description: String(e?.message ?? e) });
    }
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader eyebrow="Skills · tipo de solución">
          <DialogTitle>{type ? 'Editar tipo de solución' : 'Nuevo tipo de solución'}</DialogTitle>
          <DialogDescription>
            El nombre y la descripción son lo que lee roz para clasificar cada ticket: cambiarlos cambia cómo clasifica.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="st-name">Nombre</Label>
            <Input id="st-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Endpoint / CRUD" maxLength={80} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="st-desc">Qué trabajo entra aquí</Label>
            <textarea
              id="st-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="Describe el trabajo con ejemplos concretos: así roz distingue este tipo de los demás."
              className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-[13.5px] transition-colors placeholder:text-faint focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Skill primaria</Label>
              <Select value={primary} onValueChange={setPrimary}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={MODULE}>La del módulo afectado</SelectItem>
                  {sorted.map((s) => (
                    <SelectItem key={s.skillId} value={s.skillId}>{s.tag}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Nivel mínimo</Label>
              <Select value={minLevel} onValueChange={setMinLevel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5].map((l) => (
                    <SelectItem key={l} value={String(l)}>
                      {l}
                      {l >= 4 ? ' · especialista primero' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Skill secundaria (ayuda; no excluye a nadie)</Label>
              <Select value={secondary} onValueChange={setSecondary}>
                <SelectTrigger className={cn(sameSkill && 'border-destructive')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Ninguna</SelectItem>
                  {sorted.map((s) => (
                    <SelectItem key={s.skillId} value={s.skillId}>{s.tag}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {sameSkill && <p className="text-xs text-destructive">La secundaria no puede ser la misma que la primaria.</p>}
            </div>
            <div className="space-y-2">
              <Label>Tamaño típico, desde</Label>
              <Select value={sizeMin} onValueChange={setSizeMin}>
                <SelectTrigger className={cn(rangeBad && 'border-destructive')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {POINTS.map((p) => <SelectItem key={p} value={String(p)}>{p} pts</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>hasta</Label>
              <Select value={sizeMax} onValueChange={setSizeMax}>
                <SelectTrigger className={cn(rangeBad && 'border-destructive')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {POINTS.map((p) => <SelectItem key={p} value={String(p)}>{p} pts</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Si roz lee el ticket más chico que el mínimo, usa el mínimo; si lo lee más grande que el máximo, respeta su lectura y lo marca.
          </p>
          {type && (
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-3.5 accent-primary" />
              Activo (roz lo puede elegir). Un tipo retirado se conserva en las tareas que ya lo tienen.
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={save} disabled={!canSave}>
            {busy && <Loader2 className="size-4 animate-spin" />} Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
