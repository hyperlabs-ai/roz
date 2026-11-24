// Equipo · "Quién se encarga de qué": por tema (revisión de código, deploys, arquitectura, clientes,
// accesos avanzados), las personas que lo atienden EN ORDEN. zeus enruta ahí las solicitudes con tema
// y el MCP lo usa para contestar "¿a quién le pido…?". Un admin de zeus lo edita.
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Building2, Eye, GitPullRequest, KeyRound, Loader2, MessagesSquare, Network, Pencil, Rocket, X } from 'lucide-react';
import { PersonAvatar } from '@/components/avatars';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { invalidate } from '@/lib/store';
import { useAction } from '@/lib/useAction';
import { cn } from '@/lib/utils';
import { zeusApi, type ZeusOrgDuty, type ZeusOrgMember } from '@/lib/zeus';
import { ORG_KEY } from './hooks';
import { RailTitle } from './zeus-ui';

/** Ícono y par suave/tinta de cada tema (tabla de chips de DESIGN.md). */
const DUTY_META: Record<string, { icon: typeof Eye; tone: string }> = {
  code_review: { icon: GitPullRequest, tone: 'bg-blue-soft text-blue-ink' },
  deploys: { icon: Rocket, tone: 'bg-orange-soft text-orange-ink' },
  architecture: { icon: Network, tone: 'bg-lavender text-purple-deep' },
  client_feedback: { icon: MessagesSquare, tone: 'bg-yellow-soft text-yellow-ink' },
  clients: { icon: Building2, tone: 'bg-yellow-soft text-yellow-ink' },
  advanced_access: { icon: KeyRound, tone: 'bg-green-soft text-green' },
};
const metaOf = (duty: string) => DUTY_META[duty] ?? { icon: Eye, tone: 'bg-panel text-muted-foreground' };

function Person({ member, rank, total }: { member: ZeusOrgMember; rank: number; total: number }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {total > 1 && <span className="grid size-4 shrink-0 place-items-center rounded-full bg-panel text-[10px] font-semibold tabular-nums text-muted-foreground">{rank}</span>}
      <PersonAvatar name={member.name} login={member.githubLogin} email={member.email} id={member.devId} className="size-5" />
      <span className={cn('truncate text-[12.5px]', rank === 1 ? 'font-semibold' : 'text-muted-foreground')}>{member.name}</span>
    </span>
  );
}

function DutyDialog({ duty, members, onClose }: { duty: ZeusOrgDuty | null; members: ZeusOrgMember[]; onClose: () => void }) {
  const act = useAction();
  const [list, setList] = useState<string[]>([]);
  useEffect(() => setList(duty?.devIds ?? []), [duty]);
  const byId = useMemo(() => new Map(members.map((m) => [m.devId, m])), [members]);
  const options = useMemo<ComboboxOption[]>(
    () => members.filter((m) => m.active && !list.includes(m.devId)).map((m) => ({ value: m.devId, label: m.name, hint: m.title ?? m.role })),
    [members, list],
  );
  if (!duty) return null;
  const busy = act.busy(`duty:${duty.duty}`);
  const move = (i: number, d: -1 | 1) =>
    setList((prev) => {
      const next = [...prev];
      const j = i + d;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const dirty = list.join() !== duty.devIds.join();
  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader eyebrow="Zeus · quién se encarga de qué">
          <DialogTitle>{duty.label}</DialogTitle>
          <DialogDescription>En orden: zeus le manda la solicitud a la primera persona; si es quien pide, a la siguiente. Ej.: {duty.hint}.</DialogDescription>
        </DialogHeader>
        <ol className="grid gap-1.5">
          {list.map((id, i) => {
            const m = byId.get(id);
            if (!m) return null;
            return (
              <li key={id} className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5">
                <Person member={m} rank={i + 1} total={list.length} />
                <span className="ml-auto flex items-center gap-0.5">
                  <Button variant="ghost" size="icon-sm" className="size-7" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Subir"><ArrowUp /></Button>
                  <Button variant="ghost" size="icon-sm" className="size-7" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="Bajar"><ArrowDown /></Button>
                  <Button variant="ghost" size="icon-sm" className="size-7" onClick={() => setList((p) => p.filter((x) => x !== id))} aria-label={`Quitar a ${m.name}`}><X /></Button>
                </span>
              </li>
            );
          })}
          {!list.length && <li className="rounded-md border border-dashed px-3 py-3 text-center text-[12.5px] text-muted-foreground">Nadie: las solicitudes de este tema siguen el camino normal (dueño, líder del proyecto, jefe).</li>}
        </ol>
        <Combobox value={null} onChange={(v) => setList((p) => [...p, v])} options={options} placeholder="Agregar persona…" searchPlaceholder="Buscar persona…" emptyText="No queda nadie más" />
        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button
            disabled={!dirty || busy}
            onClick={() =>
              void act.run(`duty:${duty.duty}`, () => zeusApi.setDuty(duty.duty, list), {
                success: 'Guardado',
                error: 'No se pudo guardar',
                onDone: () => {
                  invalidate(ORG_KEY);
                  onClose();
                },
              })
            }
          >
            {busy && <Loader2 className="animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OrgDuties({ duties, members, canEdit, loading }: { duties: ZeusOrgDuty[]; members: ZeusOrgMember[]; canEdit: boolean; loading: boolean }) {
  const [editing, setEditing] = useState<ZeusOrgDuty | null>(null);
  const byId = useMemo(() => new Map(members.map((m) => [m.devId, m])), [members]);
  return (
    <Card className="grid shrink-0 gap-3 p-3.5">
      <RailTitle meta={<span className="text-[11.5px] text-faint">zeus enruta ahí lo que se pide con tema</span>}>Quién se encarga de qué</RailTitle>
      {loading ? (
        <div className="grid gap-2 sm:grid-cols-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[62px] rounded-lg" />)}</div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
          {duties.map((d) => {
            const { icon: Icon, tone } = metaOf(d.duty);
            const people = d.devIds.map((id) => byId.get(id)).filter((m): m is ZeusOrgMember => !!m);
            const body = (
              <>
                <span className="flex min-w-0 items-center gap-2">
                  <span className={cn('grid size-6 shrink-0 place-items-center rounded-md [&_svg]:size-3.5', tone)}><Icon /></span>
                  <span className="truncate text-[12.5px] font-semibold">{d.label}</span>
                  {canEdit && <Pencil className="ml-auto size-3 shrink-0 text-faint opacity-0 transition-opacity group-hover/duty:opacity-100" />}
                </span>
                {people.length ? (
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                    {people.map((m, i) => <Person key={m.devId} member={m} rank={i + 1} total={people.length} />)}
                  </span>
                ) : (
                  <span className="text-[12px] text-faint">Sin asignar</span>
                )}
              </>
            );
            const cls = 'group/duty grid h-full min-w-0 gap-2 rounded-lg border bg-card px-3 py-2.5 text-left';
            return (
              <li key={d.duty} data-tip={`Ej.: ${d.hint}`}>
                {canEdit ? (
                  <button type="button" onClick={() => setEditing(d)} className={cn(cls, 'w-full transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}>
                    {body}
                  </button>
                ) : (
                  <div className={cls}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <DutyDialog duty={editing} members={members} onClose={() => setEditing(null)} />
    </Card>
  );
}
