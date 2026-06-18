import type { ReactNode } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { initials } from '@/lib/format';

export function UserAvatar({ url, name, className }: { url: string | null; name: string; className?: string }) {
  return (
    <Avatar className={className}>
      {url && <AvatarImage src={url} alt={name} />}
      <AvatarFallback>{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

const STATE_LABEL: Record<string, string> = {
  backlog: 'Backlog', unstarted: 'Sin empezar', triage: 'Triage', started: 'En curso', in_progress: 'En curso',
  completed: 'Completado', done: 'Hecho', canceled: 'Cancelado',
};

export function StateBadge({ state }: { state: string }) {
  const variant = ['completed', 'done'].includes(state) ? 'success' : ['started', 'in_progress'].includes(state) ? 'default' : 'secondary';
  return <Badge variant={variant as any}>{STATE_LABEL[state] ?? state}</Badge>;
}

const PRIO_COLOR: Record<string, string> = { urgent: 'bg-destructive', high: 'bg-warning', medium: 'bg-chart-1', low: 'bg-muted-foreground' };

export function PriorityDot({ priority }: { priority: string | null }) {
  if (!priority) return <span className="size-2 rounded-full bg-muted" />;
  return <span className={cn('size-2 rounded-full', PRIO_COLOR[priority] ?? 'bg-muted')} title={priority} />;
}

export function EmptyState({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground">
      {icon}
      <span>{children}</span>
    </div>
  );
}

/** +/- líneas en verde/rojo, estilo diff. */
export function LineDelta({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  if (additions == null && deletions == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs">
      <span className="text-success">+{additions ?? 0}</span>
      <span className="text-destructive">−{deletions ?? 0}</span>
    </span>
  );
}
