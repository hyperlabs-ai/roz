import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Gauge, Loader2, Pencil, Shapes } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { UserAvatar } from '@/components/bits';
import { ExtLink } from '@/components/pulse/roz-v2';
import {
  CANDIDATE_STATUS, DECISION_TONE, FieldLabel, KIND_LABEL, PRIORITY_DOT, PRIORITY_LABEL, TEXTAREA_CLS, toneAt,
  type CandidateTone,
} from '@/components/meetings/meeting-ui';
import type { InboxCandidate, MeetingCandidate } from '@/lib/api';
import { relative, shortDate } from '@/lib/format';
import { STATE_LABEL } from '@/lib/labels';
import { cn } from '@/lib/utils';

/** Similitud del duplicado como en el mock: `.89`. */
function score(s: number): string {
  return s.toFixed(2).replace(/^0/, '');
}

/**
 * Una candidata de junta (`.cand` del mock): borde izquierdo del color de su cita, título, chips de
 * tipo / riesgo / responsable y las acciones. Riesgo 0 = sin duplicado, con responsable y con
 * proyecto (la misma regla que "Aceptar riesgo 0"). Las acciones las resuelve quien la pinta.
 */
export function CandidateCard({
  c,
  tone,
  hasProject,
  active,
  busy,
  onQuoteClick,
  onAccept,
  onEdit,
  onDiscard,
}: {
  c: MeetingCandidate | InboxCandidate;
  /** Color de la candidata (el mismo de su resaltado en el transcript). */
  tone?: CandidateTone;
  /** Si su junta tiene proyecto (en la bandeja sale de `c.meeting`). */
  hasProject?: boolean;
  active?: boolean;
  busy?: boolean;
  onQuoteClick?: () => void;
  onAccept: () => void;
  onEdit: () => void;
  onDiscard: () => void;
}) {
  const meeting = 'meeting' in c ? c.meeting : null;
  const pending = c.status === 'pendiente';
  const st = CANDIDATE_STATUS[c.status];
  const t = tone ?? (c.kind === 'decision' ? DECISION_TONE : toneAt(0));
  const projectOk = meeting ? !!meeting.projectId : hasProject ?? true;
  const done = c.status === 'aceptada' || c.status === 'comentada';

  return (
    <div
      className={cn(
        'grid min-w-0 content-start gap-2.5 rounded-lg border border-l-4 bg-card p-3.5 transition-[box-shadow,opacity,border-color] duration-fast hover:shadow-sm',
        t.border,
        active && cn('ring-2', t.ring),
        done && 'bg-green-soft',
        c.status === 'descartada' && 'opacity-50',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-[13.5px] font-semibold leading-snug">{c.title}</h3>
        <span className={cn('shrink-0 text-[11.5px]', pending ? 'text-faint' : done ? 'text-green' : 'text-muted-foreground')}>
          {pending ? 'pendiente' : st.label.toLowerCase()}
        </span>
      </div>

      {meeting && (
        <Link
          to={`/app/meetings?m=${meeting.id}&c=${c.id}`}
          className="-mt-1.5 min-w-0 truncate text-[11.5px] text-muted-foreground hover:text-foreground hover:underline"
        >
          {meeting.title} · {shortDate(meeting.heldAt)}
          {meeting.projectName ? ` · ${meeting.projectName}` : ''}
        </Link>
      )}

      {c.description && <p className="-mt-1 line-clamp-2 text-xs text-muted-foreground">{c.description}</p>}

      <button
        type="button"
        onClick={onQuoteClick}
        disabled={!onQuoteClick}
        className={cn(
          'flex w-full min-w-0 items-start gap-2 rounded-md bg-sidebar px-2.5 py-1.5 text-left text-xs italic text-muted-foreground',
          onQuoteClick && 'transition-colors hover:text-foreground',
        )}
        title={onQuoteClick ? 'Ver en la transcripción' : undefined}
      >
        <span aria-hidden className={cn('mt-[5px] size-1.5 shrink-0 rounded-full', t.dot)} />
        <span className="line-clamp-3">«{c.quote}»</span>
      </button>

      {/* Chips: tipo · riesgo · responsable */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="neutral">{KIND_LABEL[c.kind].toLowerCase()}</Badge>
        {pending && c.kind !== 'decision' && (
          c.duplicate ? (
            <Badge variant="warn">duplicado {c.duplicate.identifier} · {score(c.duplicate.score)}</Badge>
          ) : !projectOk ? (
            <Badge variant="bad">sin proyecto</Badge>
          ) : !c.proposedDev ? (
            <Badge variant="human">sin responsable</Badge>
          ) : (
            <Badge variant="ok">riesgo 0</Badge>
          )
        )}
        {c.proposedDev && (
          <Badge variant="rule" className="pl-1">
            <UserAvatar url={c.proposedDev.avatarUrl} id={c.proposedDev.id} name={c.proposedDev.name} className="size-4 text-[8px]" />→ {c.proposedDev.name}
          </Badge>
        )}
      </div>

      {/* Lo demás que propone roz, en metadato */}
      {(c.ownerHint || c.priority || c.estimate != null || c.solutionTypeName || c.dueDate || c.dueHint) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
          {c.ownerHint && <span title="Quién lo dijo en la junta">dijo: {c.ownerHint}</span>}
          {c.priority && (
            <span className="flex items-center gap-1">
              <span className={cn('size-2 rounded-full', PRIORITY_DOT[c.priority])} />
              {PRIORITY_LABEL[c.priority]}
            </span>
          )}
          {c.estimate != null && <span className="flex items-center gap-1"><Gauge className="size-3" />{c.estimate} pts</span>}
          {c.solutionTypeName && <span className="flex items-center gap-1"><Shapes className="size-3" />{c.solutionTypeName}</span>}
          {(c.dueDate || c.dueHint) && (
            <span className="flex items-center gap-1"><CalendarClock className="size-3" />{c.dueDate ? shortDate(c.dueDate) : c.dueHint}</span>
          )}
        </div>
      )}

      {c.duplicate && pending && (
        <div className="flex min-w-0 items-center gap-2 text-[11.5px]">
          <span className="shrink-0 text-muted-foreground">Parecido a</span>
          <span className="shrink-0 font-mono text-faint">{c.duplicate.identifier}</span>
          <ExtLink href={c.duplicate.url} className="truncate font-medium">{c.duplicate.name}</ExtLink>
          <span className="ml-auto shrink-0 text-faint">{STATE_LABEL[c.duplicate.status] ?? c.duplicate.status}</span>
        </div>
      )}

      {pending ? (
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 border-t pt-2.5">
          <Button size="sm" variant="dark" onClick={onAccept} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {c.duplicate ? `Comentar en ${c.duplicate.identifier}` : 'Crear tarea'}
          </Button>
          <Button size="sm" variant="secondary" onClick={onDiscard} disabled={busy}>Descartar</Button>
          <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={onEdit} disabled={busy}>
            <Pencil /> Ajustar
          </Button>
        </div>
      ) : (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2.5 text-[11.5px] text-muted-foreground">
          {c.issue && (
            <ExtLink href={c.issue.url} className="font-medium text-foreground">
              <span className="font-mono">{c.issue.identifier}</span>
            </ExtLink>
          )}
          {c.status === 'descartada' && c.discardReason && <span>Motivo: {c.discardReason}</span>}
          {c.decidedAt && <span>{c.decidedBy ? `${c.decidedBy.name} · ` : ''}{relative(c.decidedAt)}</span>}
        </div>
      )}
    </div>
  );
}

/** Descartar con motivo opcional (se guarda para afinar la extracción). */
export function DiscardDialog({
  candidate,
  busy,
  onCancel,
  onConfirm,
}: {
  candidate: MeetingCandidate | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string | null) => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (candidate) setReason('');
  }, [candidate]);
  return (
    <Dialog open={!!candidate} onOpenChange={(v) => !v && !busy && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader eyebrow="Juntas · candidata">
          <DialogTitle>Descartar candidata</DialogTitle>
          <DialogDescription className="line-clamp-2">{candidate?.title}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <FieldLabel htmlFor="dc-reason">Motivo (opcional)</FieldLabel>
          <textarea
            id="dc-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="No es trabajo nuestro, ya se hizo, era solo una idea…"
            className={cn(TEXTAREA_CLS, 'resize-y')}
          />
          <span className="text-[11.5px] text-faint">roz usa el motivo para afinar lo que extrae de las juntas.</span>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancelar</Button>
          <Button variant="destructive" onClick={() => onConfirm(reason.trim() || null)} disabled={busy}>
            {busy ? 'Descartando…' : 'Descartar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
