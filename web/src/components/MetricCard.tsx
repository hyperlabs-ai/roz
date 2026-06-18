import type { LucideIcon } from 'lucide-react';
import { TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MiniArea } from '@/components/charts';
import { cn } from '@/lib/utils';
import type { Metric } from '@/lib/api';

export function DeltaBadge({ metric, invert = false }: { metric: Metric; invert?: boolean }) {
  if (metric.direction === 'none' || metric.changePct === null) return null;
  const good = invert ? metric.direction === 'down' : metric.direction === 'up';
  const flat = metric.direction === 'flat';
  const Icon = flat ? Minus : metric.direction === 'up' ? TrendingUp : TrendingDown;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-semibold',
            flat ? 'bg-muted text-muted-foreground' : good ? 'bg-success/12 text-success' : 'bg-destructive/12 text-destructive',
          )}
        >
          <Icon className="size-3" />
          {Math.abs(metric.changePct)}%
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {metric.value} vs {metric.compare} en el período de comparación
      </TooltipContent>
    </Tooltip>
  );
}

export function MetricCard({
  label,
  value,
  metric,
  icon: Icon,
  invert,
  spark,
  format = (v) => String(v),
  className,
}: {
  label: string;
  value: number;
  metric?: Metric;
  icon: LucideIcon;
  invert?: boolean;
  spark?: { date: string; commits?: number }[];
  format?: (v: number) => string;
  className?: string;
}) {
  return (
    <Card className={cn('overflow-hidden p-4', className)}>
      <div className="flex items-center justify-between">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" />
        </div>
        {metric && <DeltaBadge metric={metric} invert={invert} />}
      </div>
      <div className="mt-3 text-sm text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-2xl font-bold tracking-tight tabular-nums">{format(value)}</div>
      {spark && spark.length > 1 && (
        <div className="-mx-1 mt-2 h-8">
          <MiniArea data={spark} dataKey="commits" />
        </div>
      )}
    </Card>
  );
}
