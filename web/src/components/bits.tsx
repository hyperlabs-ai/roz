import { useEffect, useState, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { initials } from '@/lib/format';
import { STATE_LABEL, stateBadgeVariant, PRIO_DOT } from '@/lib/labels';

/** Barra de progreso que crece suave desde 0 al montar (y anima cambios de valor). `pct` 0–100. */
export function ProgressBar({ pct, className, barClassName }: { pct: number; className?: string; barClassName?: string }) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const r = requestAnimationFrame(() => setW(Math.max(0, Math.min(100, pct))));
    return () => cancelAnimationFrame(r);
  }, [pct]);
  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-muted', className)}>
      <div
        className={cn('h-full rounded-full bg-primary transition-[width] duration-700 ease-spring', barClassName)}
        style={{ width: `${w}%` }}
      />
    </div>
  );
}

export function UserAvatar({ url, name, className, title }: { url: string | null; name: string; className?: string; title?: string }) {
  return (
    <Avatar className={className} title={title}>
      {url && <AvatarImage src={url} alt={name} />}
      <AvatarFallback>{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

/** Avatares apilados de responsables (máx `max` visibles + "+N"). Vacío → no renderiza nada. */
export function AvatarStack({
  people, max = 3, size = 'size-5', className,
}: {
  people: { name: string; avatarUrl: string | null }[];
  max?: number;
  size?: string;
  className?: string;
}) {
  if (!people.length) return null;
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <div className={cn('flex -space-x-1.5', className)}>
      {shown.map((p, i) => (
        <UserAvatar key={i} url={p.avatarUrl} name={p.name} className={cn(size, 'ring-2 ring-background')} title={p.name} />
      ))}
      {extra > 0 && (
        <span className={cn('grid place-items-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-background', size)} title={`+${extra} más`}>
          +{extra}
        </span>
      )}
    </div>
  );
}

export function StateBadge({ state }: { state: string }) {
  return <Badge variant={stateBadgeVariant(state)}>{STATE_LABEL[state] ?? state}</Badge>;
}

export function PriorityDot({ priority }: { priority: string | null }) {
  if (!priority) return <span className="size-2 rounded-full bg-muted" />;
  return <span className={cn('size-2 rounded-full', PRIO_DOT[priority] ?? 'bg-muted')} title={priority} />;
}

export function EmptyState({ icon, children, action }: { icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
      {icon && (
        <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">{icon}</div>
      )}
      <span className="max-w-xs text-sm text-muted-foreground">{children}</span>
      {action}
    </div>
  );
}

/** Aviso de error consistente (reemplaza las "Card roja suelta" repetidas en cada página). */
export function ErrorCard({ message, className }: { message: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive',
        className,
      )}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{message}</span>
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
