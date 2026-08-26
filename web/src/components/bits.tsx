import { useEffect, useState, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { initials } from '@/lib/format';
import { STATE_LABEL, stateBadgeVariant, PRIO_DOT, DEV_PRESENCE } from '@/lib/labels';

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

/**
 * Avatar con indicador opcional de presencia (calendario conectado).
 *
 * El punto necesita un contenedor `relative`, pero varios llamadores le pasan a este componente
 * clases que asumen que el avatar ES el elemento (el `-space-x-1.5` de `AvatarStack`, los `ring-2`
 * de las tarjetas). Por eso solo se envuelve cuando de verdad hay algo que indicar: sin `presence`
 * el render queda idéntico al de siempre y ninguna vista existente se mueve.
 */
export function UserAvatar({
  url, name, className, title, presence, presenceTitle,
}: {
  url: string | null;
  name: string;
  className?: string;
  title?: string;
  presence?: 'busy' | 'free' | 'unknown';
  presenceTitle?: string;
}) {
  // Sin presencia: exactamente el render de siempre.
  if (!presence) {
    return (
      <Avatar className={className} title={title}>
        {url && <AvatarImage src={url} alt={name} />}
        <AvatarFallback>{initials(name)}</AvatarFallback>
      </Avatar>
    );
  }

  // Con presencia, `className` va SOLO al envoltorio y el avatar lo llena. Pasarlo a los dos
  // duplicaba el `ring-2` que mandan varias vistas (se veía un doble borde) y dejaba dos reglas de
  // tamaño peleando. El envoltorio lleva `rounded-full` para que ese anillo salga redondo.
  return (
    <span className={cn('relative inline-flex shrink-0 rounded-full', className)}>
      <Avatar className="size-full" title={title}>
        {url && <AvatarImage src={url} alt={name} />}
        <AvatarFallback>{initials(name)}</AvatarFallback>
      </Avatar>
      {/* `bottom-0 right-0`, no offsets negativos: el avatar es un círculo, y en la esquina de su
          caja el borde ya se curvó hacia dentro — un punto ahí flota separado, fuera del círculo.
          Pegado a la caja cae justo sobre el filo y se lee como insignia de estado. */}
      <span
        title={presenceTitle ?? DEV_PRESENCE[presence]?.label}
        className={cn(
          'absolute bottom-0 right-0 size-3 rounded-full ring-2 ring-background',
          DEV_PRESENCE[presence]?.dot ?? DEV_PRESENCE.unknown!.dot,
        )}
      />
    </span>
  );
}

/** Avatares apilados de responsables (máx `max` visibles + "+N"). Vacío → no renderiza nada. */
export function AvatarStack({
  people, max = 3, size = 'size-5', className,
}: {
  people: { name: string; avatarUrl: string | null }[] | null | undefined;
  max?: number;
  size?: string;
  className?: string;
}) {
  // Tolera null/undefined a propósito: lo alimentan respuestas de la API desde muchas páginas, y
  // un campo ausente no debe tumbar el render entero (el ErrorBoundary es global).
  if (!people?.length) return null;
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
