import type { ReactNode } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { initials } from '@/lib/format';

export function UserAvatar({ url, name, className, title }: { url: string | null; name: string; className?: string; title?: string }) {
  return (
    <Avatar className={className} title={title}>
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

// ---- Skill chips ----
/** Chip compacto de skill con dots de nivel (1–5). Para listas densas (tarjetas de dev). */
export function SkillChip({ tag, level }: { tag: string; level: number }) {
  const lvl = Math.max(0, Math.min(5, level));
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2 py-1 text-xs">
      <span className="font-medium">{tag}</span>
      <span className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} className={cn('size-1.5 rounded-full', n <= lvl ? 'bg-primary' : 'bg-muted')} />
        ))}
      </span>
    </span>
  );
}

// ---- Skill meters ----
const LEVEL_LABEL = ['', 'Básico', 'Junior', 'Intermedio', 'Avanzado', 'Experto'];

/** Medidor de una skill: nombre + barra segmentada (1–5) + etiqueta de dominio. */
export function SkillMeter({ tag, level }: { tag: string; level: number }) {
  const lvl = Math.max(0, Math.min(5, level));
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-semibold">{tag}</span>
        <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{LEVEL_LABEL[lvl] ?? '—'}</span>
      </div>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <div
            key={n}
            className={cn('h-1.5 flex-1 rounded-full transition-colors', n <= lvl ? 'bg-primary' : 'bg-muted')}
            style={n <= lvl ? { opacity: 0.45 + (n / 5) * 0.55 } : undefined}
          />
        ))}
      </div>
    </div>
  );
}

/** Grid de medidores de skills, ordenado por nivel desc. */
export function SkillMeters({ skills }: { skills: { tag: string; level: number }[] }) {
  if (!skills.length) return <EmptyState>Sin skills asignadas</EmptyState>;
  const sorted = [...skills].sort((a, b) => b.level - a.level);
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
      {sorted.map((s) => <SkillMeter key={s.tag} tag={s.tag} level={s.level} />)}
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
