import { useEffect, useState } from 'react';
import {
  GitCommitHorizontal, GitCompareArrows, History, GitBranch, GitPullRequest, Eye, GitMerge,
  FilePlus2, UserPlus, CircleCheck, NotebookPen, FolderGit2, Replace, BellRing, Bell, Layers,
  type LucideIcon,
} from 'lucide-react';
import { UserAvatar, LineDelta } from '@/components/bits';
import { QUEUE_EVENT, QUEUE_FAMILY, type QueueFamily } from '@/lib/labels';
import { relative } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { QueueEvent } from '@/lib/api';

const ICONS: Record<string, LucideIcon> = {
  'commit.received': GitCommitHorizontal,
  'commits.backfill': GitCompareArrows,
  'repo.backfill': History,
  'branch.created': GitBranch,
  'pr.opened': GitPullRequest,
  'pr.reviewed': Eye,
  'pr.merged': GitMerge,
  'work_item.created': FilePlus2,
  'work_item.assigned': UserPlus,
  'work_item.done': CircleCheck,
  'change.documented': NotebookPen,
  'repo.detected': FolderGit2,
  'repo.renamed': Replace,
  'repo.notify': BellRing,
  'notification.requested': Bell,
  'linear.issue_upserted': FilePlus2,
  'linear.issue_removed': Layers,
  'linear.project_upserted': FolderGit2,
};

/** Sustantivo por familia, para la frase natural del indicador ("un commit de Sebas"). */
const NOUN: Record<QueueFamily, string> = {
  commit: 'commit',
  pr: 'PR',
  task: 'tarea',
  doc: 'cambios',
  repo: 'repo',
};

export const iconFor = (type: string): LucideIcon => ICONS[type] ?? Layers;
export const familyOf = (type: string): QueueFamily => QUEUE_EVENT[type]?.family ?? 'repo';

/** Sin la organización: en un dashboard de un solo equipo el prefijo es ruido en todas las filas. */
export const shortRepo = (repo: string | null): string | null => repo?.split('/').pop() ?? null;

/** Persona que representa el evento: la acreditada si ya la hay, si no quien lo originó. */
export const personOf = (ev: QueueEvent) => ev.dev ?? ev.actor;

/**
 * Frase corta para el indicador del header: "Procesando un commit de Sebas".
 *
 * Deliberadamente NO distingue `pending` de `processing`: el indicador es de un vistazo, y verlo
 * saltar entre dos verbos mientras el cron avanza sería ruido. La distinción fina vive en la fila.
 */
export function inflightPhrase(ev: QueueEvent): string {
  const label = QUEUE_EVENT[ev.type];
  const who = personOf(ev)?.name;
  if (!label) return who ? `Procesando trabajo de ${who}` : 'Procesando…';
  if (!who) return label.doing;
  return `Procesando ${NOUN[label.family] === 'PR' ? 'una PR' : `un ${NOUN[label.family]}`} de ${who}`;
}

/** Tiempo relativo que avanza solo, sin depender de la cadencia de red. */
export function Ago({ iso, className }: { iso: string | null; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className={className}>{relative(iso)}</span>;
}

const RAIL: Record<string, string> = {
  processing: 'bg-primary',
  pending: 'bg-muted-foreground/30',
  failed: 'bg-warning',
  dead: 'bg-destructive',
  done: 'bg-transparent',
};

/** Píldora de estado. Solo aparece si el evento sigue vivo o algo va mal: un resuelto no la lleva
 *  —su presencia en el historial ya significa que salió bien— y así la lista se mantiene callada. */
function StatusPill({ ev }: { ev: QueueEvent }) {
  if (ev.status === 'done') return null;

  const base = 'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums';
  if (ev.status === 'dead') {
    return <span className={cn(base, 'bg-destructive/12 text-destructive')}>Muerto · {ev.attempts}/{ev.maxAttempts}</span>;
  }
  if (ev.status === 'failed') {
    return (
      <span className={cn(base, 'bg-warning/12 text-warning')}>
        Reintento {ev.attempts}/{ev.maxAttempts}
      </span>
    );
  }
  if (ev.status === 'processing') return <span className={cn(base, 'bg-primary/12 text-primary')}>Procesando</span>;
  return <span className={cn(base, 'bg-muted text-muted-foreground')}>En cola</span>;
}

export function QueueRow({ ev, isNew }: { ev: QueueEvent; isNew?: boolean }) {
  const label = QUEUE_EVENT[ev.type];
  const Icon = iconFor(ev.type);
  const family = familyOf(ev.type);
  const person = personOf(ev);
  const inflight = ev.phase === 'inflight';
  const text = inflight ? label?.doing ?? ev.type : label?.done ?? ev.type;

  // Quien lo empujó no siempre es a quien se le acredita (un squash-merge es el caso típico).
  // Decirlo explícitamente es justo el punto ciego de atribución que esta vista viene a cerrar.
  const reattributed =
    ev.actor && ev.dev && (ev.actor.devId ?? ev.actor.login) !== (ev.dev.devId ?? ev.dev.login) ? ev.actor : null;

  return (
    <div className={cn('flex items-stretch gap-3 px-4 py-2.5', inflight && 'bg-muted/30', isNew && 'animate-fade-in-up')}>
      <span className={cn('w-0.5 shrink-0 rounded-full transition-colors duration-500 ease-spring', RAIL[ev.status] ?? 'bg-transparent')} />

      {person ? (
        <UserAvatar
          url={person.avatarUrl}
          name={person.name}
          className={cn('size-7 shrink-0', inflight && 'shimmer rounded-full')}
          title={person.name}
        />
      ) : (
        <span className={cn('grid size-7 shrink-0 place-items-center rounded-md', QUEUE_FAMILY[family])}>
          <Icon className="size-3.5" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Icon className={cn('size-3.5 shrink-0', person ? 'text-muted-foreground' : 'hidden')} />
          <span className="truncate text-sm">
            {text}
            {ev.subject && <span className="text-muted-foreground"> · {ev.subject}</span>}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          {ev.repo && (
            <span className="font-mono" title={ev.repo}>{shortRepo(ev.repo)}</span>
          )}
          {ev.sha && <span className="font-mono">{ev.sha}</span>}
          {ev.prNumber != null && <span className="font-mono">#{ev.prNumber}</span>}
          {ev.task && <span className="font-mono">{ev.task.identifier}</span>}
          {ev.page != null && <span>pág. {ev.page}</span>}
          {(ev.additions != null || ev.deletions != null) && (
            <LineDelta additions={ev.additions} deletions={ev.deletions} />
          )}
          {person && <span className="truncate">{person.name}</span>}
          {reattributed && <span className="truncate">· lo empujó {reattributed.name}</span>}
        </div>
        {ev.status === 'dead' && ev.error && (
          <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-destructive">{ev.error}</p>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <Ago iso={ev.resolvedAt ?? ev.createdAt} className="text-[11px] tabular-nums text-muted-foreground" />
        <StatusPill ev={ev} />
      </div>
    </div>
  );
}
