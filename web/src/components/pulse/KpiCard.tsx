import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { DeltaBadge } from '@/components/MetricCard';
import { tokenColor, type BrandColor } from '@/components/brand';
import { Card } from '@/components/ui/card';
import type { Metric } from '@/lib/api';
import { useCountUp } from '@/lib/motion';
import { cn } from '@/lib/utils';

const DAY_LETTER = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const DAY_NAME = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

/**
 * KPI del Pulso. Misma lectura que `MetricCard` (etiqueta, cifra grande, delta contra la semana
 * anterior) más lo que a esa le falta aquí: el ícono en su caja de color, una línea de contexto y,
 * al pie, el reparto de la semana día por día para ver CUÁNDO se hizo el número, no solo cuánto.
 * `children` reemplaza el pie cuando el KPI no es una serie diaria (personas, planes).
 */
export function KpiCard({
  label,
  value,
  icon: Icon,
  color = 'orange',
  metric,
  context,
  days,
  todayIndex,
  children,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  color?: BrandColor;
  metric?: Metric;
  /** Línea junto a la cifra ("+3 nuevos", "de 8"). */
  context?: string;
  /** Serie lunes→domingo. Si no se pasa (o no cuadra con la cifra) no se dibuja. */
  days?: number[] | null;
  /** Índice de hoy dentro de la semana, o -1 si la semana no es la actual. */
  todayIndex?: number;
  children?: ReactNode;
}) {
  const shown = Math.round(useCountUp(value));
  const hasCompare = metric && metric.compare !== null && metric.direction !== 'none';

  return (
    <Card className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="label-caps min-w-0 truncate">{label}</span>
        <span
          className="grid size-7 shrink-0 place-items-center rounded-md"
          style={{ background: tokenColor(color, 0.14), color: tokenColor(color) }}
        >
          <Icon className="size-4" />
        </span>
      </div>

      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[32px] font-semibold leading-none tabular-nums tracking-[-0.045em]">{shown}</span>
          {context && <span className="truncate text-xs text-muted-foreground">{context}</span>}
        </div>
        {metric && (
          <div className="flex min-h-4 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <DeltaBadge metric={metric} />
            {hasCompare ? (
              <span className="truncate">vs. {metric.compare} la semana anterior</span>
            ) : (
              <span className="truncate text-faint">sin semana anterior</span>
            )}
          </div>
        )}
      </div>

      <div className="mt-auto">{children ?? (days ? <WeekColumns days={days} todayIndex={todayIndex ?? -1} color={color} unit={label.toLowerCase()} /> : null)}</div>
    </Card>
  );
}

/**
 * Reparto diario de la semana en columnas (verticales, radio fijo): hoy va en color pleno, los días
 * pasados atenuados y los que aún no llegan como un punto en la base. Piso en px para que un día
 * con poco no desaparezca.
 */
function WeekColumns({ days, todayIndex, color, unit }: { days: number[]; todayIndex: number; color: BrandColor; unit: string }) {
  const max = Math.max(0, ...days);
  const live = todayIndex >= 0;
  return (
    <div className="grid grid-cols-7 gap-1.5 border-t pt-3">
      {days.map((n, i) => {
        const future = live && i > todayIndex;
        const today = i === todayIndex;
        const h = n > 0 && max > 0 ? Math.max(4, Math.round((n / max) * 28)) : 3;
        return (
          <div key={i} className="grid justify-items-center gap-1" title={`${DAY_NAME[i]}: ${n} ${unit}`}>
            <div className="flex h-7 w-full items-end">
              <div
                className={cn('w-full rounded-[3px] transition-[height] duration-500 ease-spring', n === 0 && 'bg-toggle-off/60')}
                style={{
                  height: h,
                  background: n > 0 ? tokenColor(color, today || !live ? 1 : 0.45) : undefined,
                  opacity: future ? 0.4 : 1,
                }}
              />
            </div>
            <span className={cn('text-[9.5px] font-semibold leading-none', today ? 'text-foreground' : 'text-faint')}>{DAY_LETTER[i]}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Pie de KPI con cifras pequeñas etiquetadas (planes del agente: corriendo, por aprobar…). */
export function KpiBreakdown({ items }: { items: { label: string; value: number; color?: BrandColor }[] }) {
  return (
    <div className="grid gap-1.5 border-t pt-3" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((it) => (
        <div key={it.label} className="grid min-w-0 gap-1" title={`${it.value} ${it.label.toLowerCase()}`}>
          <span
            className={cn('text-[15px] font-semibold leading-none tabular-nums', it.value === 0 && 'font-medium text-faint')}
            style={it.value > 0 && it.color ? { color: tokenColor(it.color) } : undefined}
          >
            {it.value}
          </span>
          <span className="label-caps truncate text-[9.5px]">{it.label}</span>
        </div>
      ))}
    </div>
  );
}
