import type { LucideIcon } from 'lucide-react';
import { TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { Metric } from '@/lib/api';

export function DeltaBadge({ metric, invert = false }: { metric: Metric; invert?: boolean }) {
  if (metric.direction === 'none' || metric.changePct === null) return null;
  const good = invert ? metric.direction === 'down' : metric.direction === 'up';
  const flat = metric.direction === 'flat';
  const Icon = flat ? Minus : metric.direction === 'up' ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold',
        flat ? 'bg-muted text-muted-foreground' : good ? 'bg-success/12 text-success' : 'bg-destructive/12 text-destructive',
      )}
    >
      <Icon className="size-3" />
      {Math.abs(metric.changePct)}%
    </span>
  );
}

export function MetricCard({
  label,
  value,
  metric,
  icon: Icon,
  invert,
  colorVar = '--primary',
  format = (v) => String(v),
  className,
}: {
  label: string;
  value: number;
  metric?: Metric;
  icon: LucideIcon;
  invert?: boolean;
  colorVar?: string; // var CSS de color del icono (p.ej. '--chart-1')
  format?: (v: number) => string;
  className?: string;
}) {
  const hasCompare = metric && metric.compare !== null && metric.direction !== 'none';
  return (
    <Card className={cn('p-5', className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg" style={{ backgroundColor: `hsl(var(${colorVar}) / 0.12)`, color: `hsl(var(${colorVar}))` }}>
            <Icon className="size-[18px]" />
          </div>
          <span className="text-sm font-medium text-muted-foreground">{label}</span>
        </div>
        {metric && <DeltaBadge metric={metric} invert={invert} />}
      </div>
      <div className="mt-3 text-3xl font-bold tracking-tight tabular-nums">{format(value)}</div>
      {hasCompare && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          vs. {format(metric!.compare!)} período anterior
        </div>
      )}
    </Card>
  );
}
