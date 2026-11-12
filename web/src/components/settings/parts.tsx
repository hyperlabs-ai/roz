import type { ReactNode } from 'react';
import type { Mail } from 'lucide-react';
import { Eyebrow, IntegrationIcon, type BrandColor, type IntegrationName } from '@/components/brand';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Piezas de Configuración: cabecera de sección, tarjeta de filas y filas alineadas (ícono + texto a
 * la izquierda, control a la derecha). Todas las filas comparten alto y columnas, así los
 * interruptores quedan en una sola línea vertical.
 */

export type LucideIcon = typeof Mail;

/** Cabecera del panel derecho: eyebrow de categoría + título + una línea de contexto. */
export function SettingsHeader({
  eyebrow,
  color = 'orange',
  title,
  lede,
  actions,
}: {
  eyebrow: string;
  color?: BrandColor;
  title: string;
  lede?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b pb-4">
      <div className="grid min-w-0 gap-2">
        <Eyebrow color={color}>{eyebrow}</Eyebrow>
        <h2 className="text-[22px] font-semibold leading-tight tracking-[-0.03em]">{title}</h2>
        {lede && <p className="max-w-[68ch] text-[13.5px] text-muted-foreground">{lede}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Tarjeta de filas: título con hairline y filas separadas por hairline. */
export function RowsCard({
  title,
  icon,
  badge,
  aside,
  className,
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  /** A la derecha del título (columnas de una tabla de interruptores, acción). */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <div className="flex min-h-[46px] flex-wrap items-center gap-x-3 gap-y-1 border-b bg-sidebar px-4 py-2.5 sm:px-5">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold tracking-[-0.01em]">
          {icon}
          {title}
          {badge}
        </span>
        {aside}
      </div>
      <div className="divide-y">{children}</div>
    </Card>
  );
}

/** Ícono de la fila: oficial de la integración (cajita blanca) o lucide sobre panel gris. */
export function RowIcon({ icon: Icon, integration, on }: { icon?: LucideIcon; integration?: IntegrationName; on: boolean }) {
  if (integration) return <IntegrationIcon name={integration} size="sm" framed className={cn(!on && 'opacity-60')} />;
  if (!Icon) return null;
  return (
    <span
      className={cn(
        'grid size-[26px] shrink-0 place-items-center rounded-md transition-colors',
        on ? 'bg-orange-soft text-orange-ink' : 'bg-panel text-faint',
      )}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

/** Fila: ícono + título + pista, y el control a la derecha. */
export function Row({
  icon,
  integration,
  on = true,
  title,
  hint,
  children,
  className,
}: {
  icon?: LucideIcon;
  integration?: IntegrationName;
  on?: boolean;
  title: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-[60px] items-center justify-between gap-3 px-4 py-3 sm:px-5', className)}>
      <div className="flex min-w-0 items-center gap-3">
        <RowIcon icon={icon} integration={integration} on={on} />
        <div className="grid min-w-0">
          <span className="text-[13.5px] font-semibold">{title}</span>
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </div>
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** Aviso en línea: fondo suave del tono (ámbar = cuidado, naranja = marca). */
export function Notice({ tone, icon: Icon, title, children, className }: { tone: 'warn' | 'brand'; icon: LucideIcon; title: string; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-md px-3 py-2.5 text-xs leading-relaxed',
        tone === 'warn' ? 'bg-yellow-soft text-yellow-ink' : 'bg-orange-soft text-orange-ink',
        className,
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div>
        <p className="font-semibold">{title}</p>
        <div className="opacity-90">{children}</div>
      </div>
    </div>
  );
}

/** Esqueleto de una fila. */
export function RowSkeleton({ control = 'switch' }: { control?: 'switch' | 'button' | 'none' }) {
  return (
    <div className="flex min-h-[60px] items-center justify-between gap-3 px-4 py-3 sm:px-5">
      <div className="flex items-center gap-3">
        <Skeleton className="size-[26px] rounded-md" />
        <div className="grid gap-1.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-48" />
        </div>
      </div>
      {control === 'switch' && <Skeleton className="h-[22px] w-10 rounded-full" />}
      {control === 'button' && <Skeleton className="h-8 w-24 rounded-sm" />}
    </div>
  );
}
