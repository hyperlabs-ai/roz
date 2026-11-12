import { useEffect, useState } from 'react';
import { MessageSquareQuote, CirclePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UserAvatar } from '@/components/bits';
import { Segmented, ExtLink, useRozV2 } from '@/components/pulse/roz-v2';
import { OverrideReasonDialog } from '@/components/tasks/OverrideReasonDialog';
import { FieldLabel, PRIORITY_LABEL, TEXTAREA_CLS } from '@/components/meetings/meeting-ui';
import type { AcceptCandidateRequest, MeetingCandidate, TicketFilterOptions } from '@/lib/api';
import { cn } from '@/lib/utils';

const NONE = '__none__';
const DEFAULT_POINTS = [1, 2, 3, 5, 8, 13];

/**
 * Aceptar una candidata con ajustes: crear el issue en Linear (título, responsable, prioridad,
 * estimación, tipo de solución, fecha) o comentar en el duplicado que encontró roz. Cambiar al
 * responsable que propuso roz pide motivo, igual que en /ticket.
 */
export function AcceptDialog({
  candidate,
  filters,
  busy,
  onCancel,
  onConfirm,
}: {
  candidate: MeetingCandidate | null;
  filters: TicketFilterOptions | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (body: AcceptCandidateRequest) => void;
}) {
  const c = candidate;
  // Con ROZ_LINEAR_SOT apagado las juntas crean tareas nativas en roz: los textos lo dicen.
  const inLinear = useRozV2().linearSourceOfTruth;
  const [mode, setMode] = useState<'crear' | 'comentar'>('crear');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState<string>(NONE);
  const [priority, setPriority] = useState<string>(NONE);
  const [estimate, setEstimate] = useState<string>(NONE);
  const [solutionType, setSolutionType] = useState<string>(NONE);
  const [dueDate, setDueDate] = useState('');
  const [askOverride, setAskOverride] = useState(false);

  useEffect(() => {
    if (!c) return;
    setMode(c.duplicate ? 'comentar' : 'crear');
    setTitle(c.title);
    setDescription(c.description ?? '');
    setAssignee(c.proposedDev?.id ?? NONE);
    setPriority(c.priority ? String(c.priority) : NONE);
    setEstimate(c.estimate ? String(c.estimate) : NONE);
    setSolutionType(c.solutionTypeId ?? NONE);
    setDueDate(c.dueDate ?? '');
    setAskOverride(false);
  }, [c]);

  if (!c) return null;

  const devs = filters?.devs ?? [];
  const points = filters?.estimatePoints?.length ? filters.estimatePoints : DEFAULT_POINTS;
  const types = (filters?.solutionTypes ?? []).filter((t) => t.active || t.id === c.solutionTypeId);
  const assigneeId = assignee === NONE ? null : assignee;
  const changedAssignee = mode === 'crear' && (c.proposedDev?.id ?? null) !== assigneeId && !!c.proposedDev;

  function body(override?: { category: string; note: string | null }): AcceptCandidateRequest {
    if (mode === 'comentar') return { mode };
    return {
      mode,
      title: title.trim(),
      description: description.trim() || null,
      assigneeDevId: assigneeId,
      priority: priority === NONE ? null : (Number(priority) as 1 | 2 | 3 | 4),
      estimate: estimate === NONE ? null : Number(estimate),
      solutionTypeId: solutionType === NONE ? null : solutionType,
      dueDate: dueDate || null,
      ...(override ? { override } : {}),
    };
  }

  function submit() {
    if (changedAssignee) {
      setAskOverride(true);
      return;
    }
    onConfirm(body());
  }

  const canSubmit = mode === 'comentar' || title.trim().length > 0;

  return (
    <>
      <Dialog open={!!c && !askOverride} onOpenChange={(v) => !v && !busy && onCancel()}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader eyebrow="Juntas · a Linear">
            <DialogTitle>Aceptar candidata</DialogTitle>
            <DialogDescription>{inLinear ? 'Lo que aceptes se crea en Linear; roz solo lo refleja.' : 'Lo que aceptes se crea como tarea en roz.'}</DialogDescription>
          </DialogHeader>

          <blockquote className="rounded-r-md border-l-[3px] border-yellow bg-sidebar px-3 py-2 text-[13px] italic text-muted-foreground">
            «{c.quote}»
          </blockquote>

          {c.duplicate && (
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: 'comentar', label: `Comentar en ${c.duplicate.identifier}`, icon: <MessageSquareQuote className="size-3.5" /> },
                { value: 'crear', label: inLinear ? 'Crear issue nuevo' : 'Crear tarea nueva', icon: <CirclePlus className="size-3.5" /> },
              ]}
              className="w-fit max-w-full flex-wrap"
            />
          )}

          {mode === 'comentar' && c.duplicate ? (
            <div className="rounded-lg border bg-card px-3 py-2.5 text-sm">
              <div className="text-xs text-muted-foreground">Se agrega un comentario con la cita y el enlace a la junta en:</div>
              <div className="mt-1 flex items-center gap-2">
                <span className="font-mono text-xs text-faint">{c.duplicate.identifier}</span>
                <ExtLink href={c.duplicate.url} className="truncate font-medium">{c.duplicate.name}</ExtLink>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-1.5">
                <FieldLabel htmlFor="ac-title">Título</FieldLabel>
                <Input id="ac-title" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <FieldLabel htmlFor="ac-desc">Descripción</FieldLabel>
                <textarea id="ac-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} className={cn(TEXTAREA_CLS, 'resize-y')} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <FieldLabel>Responsable</FieldLabel>
                  <Select value={assignee} onValueChange={setAssignee}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value={NONE}>Sin asignar</SelectItem>
                      {devs.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          <span className="flex items-center gap-2">
                            <UserAvatar url={d.avatarUrl} id={d.id} name={d.name} className="size-4" />
                            {d.name}
                            {d.id === c.proposedDev?.id && <span className="text-[11px] text-faint">· propuesto por roz</span>}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <FieldLabel>Prioridad</FieldLabel>
                  <Select value={priority} onValueChange={setPriority}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Sin prioridad</SelectItem>
                      {([1, 2, 3, 4] as const).map((p) => <SelectItem key={p} value={String(p)}>{PRIORITY_LABEL[p]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <FieldLabel>Estimación</FieldLabel>
                  <Select value={estimate} onValueChange={setEstimate}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Sin estimar</SelectItem>
                      {points.map((p) => <SelectItem key={p} value={String(p)}>{p} pts</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <FieldLabel>Tipo de solución</FieldLabel>
                  <Select value={solutionType} onValueChange={setSolutionType}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value={NONE}>Sin tipo</SelectItem>
                      {types.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <FieldLabel htmlFor="ac-due">Fecha límite</FieldLabel>
                  <Input id="ac-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="sm:w-48" />
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancelar</Button>
            <Button onClick={submit} disabled={!canSubmit || busy}>
              {busy ? (inLinear ? 'Enviando a Linear…' : 'Creando…') : mode === 'comentar' ? (inLinear ? 'Comentar en Linear' : 'Comentar en la tarea') : inLinear ? 'Crear en Linear' : 'Crear tarea'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OverrideReasonDialog
        open={askOverride}
        categories={filters?.overrideCategories ?? []}
        chosenName={c.proposedDev?.name ?? null}
        onCancel={() => setAskOverride(false)}
        onConfirm={(category, note) => {
          setAskOverride(false);
          onConfirm(body({ category, note }));
        }}
      />
    </>
  );
}
