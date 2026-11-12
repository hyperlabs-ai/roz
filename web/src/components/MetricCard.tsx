import type { LucideIcon } from 'lucide-react';
import { isValidElement, type ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { Sparkline } from '@/components/charts';
import { cn } from '@/lib/utils';
import { useCountUp } from '@/lib/motion';
import type { Metric } from '@/lib/api';

export function DeltaBadge({ metric, invert = false }: { metric: Metric; invert?: boolean }) {
  if (metric.direction === 'none' || metric.changePct === null) return null;
  const good = invert ? metric.direction === 'down' : metric.direction === 'up';
  const flat = metric.direction === 'flat';
  // Delta del mock (`.kpi .d`): texto en color con flecha sólida, sin píldora.
  const arrow = flat ? '–' : metric.direction === 'up' ? '▲' : '▼';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium tabular-nums',
        flat ? 'text-muted-foreground' : good ? 'text-green' : 'text-red',
      )}
    >
      <span aria-hidden className="text-[9px]">{arrow}</span>
      {Math.abs(metric.changePct)}%
    </span>
  );
}

type Layout = 'stack' | 'row' | 'center' | 'inline';
type Surface = 'card' | 'inset' | 'plain';
type Size = 'sm' | 'md' | 'lg';

const VALUE_SIZE: Record<Size, string> = {
  sm: 'text-lg leading-none',
  md: 'text-[22px] leading-none',
  lg: 'text-[26px] leading-[1.1] sm:text-[28px]',
};

/**
 * Tarjeta de estadística, única en la app.
 *
 * Había CINCO implementaciones con cinco APIs distintas: `MetricCard` (la buena: icono tintado,
 * count-up, delta y comparativo), `MiniStat` en ProjectDetail, `BigStat` en Developers, `Stat` en
 * GithubContributions y `Metric` en Activity. Ninguna de las cuatro últimas tenía count-up ni
 * delta, así que la misma cifra se animaba o no según la página donde la vieras.
 *
 * Los tres ejes que cubren los cinco casos:
 *  · `layout`  — `stack` (icono y etiqueta arriba, cifra grande), `row` (icono a la izquierda,
 *                cifra y etiqueta a la derecha), `center` (todo centrado, para rejillas apretadas),
 *                `inline` (cifra y etiqueta en la misma línea base, para barras de resumen)
 *  · `surface` — `card` (con su propia Card), `inset` (recuadro dentro de otra card), `plain`
 *  · `size`    — el tamaño de la cifra
 *
 * `trend` añade la sparkline embebida de la receta `mono-rounded-kpi` de amicro: la cifra dice
 * dónde estamos y la línea dice cómo llegamos, que es lo que faltaba para leer un KPI sin abrir
 * la gráfica grande.
 */
export function MetricCard({
  label,
  value,
  metric,
  icon,
  invert,
  colorVar = '--primary',
  format = (v) => String(v),
  layout = 'stack',
  surface = 'card',
  size = layout === 'stack' ? 'lg' : 'md',
  accent = false,
  tone,
  sub,
  trend,
  trendKey = 'value',
  className,
}: {
  label: string;
  /** Número → se anima con count-up y pasa por `format`. Texto → se pinta tal cual ("3 días"). */
  value: number | string;
  metric?: Metric;
  /** El componente de lucide (`icon={Zap}`) o un nodo ya construido (`icon={<Zap className="…"/>}`). */
  icon?: LucideIcon | ReactNode;
  invert?: boolean;
  colorVar?: string;
  format?: (v: number) => string;
  layout?: Layout;
  surface?: Surface;
  size?: Size;
  /** Realce de "logro" con el token `--hyper` (hyper points). */
  accent?: boolean;
  tone?: 'warning' | 'destructive' | 'success';
  sub?: string;
  trend?: any[];
  trendKey?: string;
  className?: string;
}) {
  const numeric = typeof value === 'number';
  const shown = useCountUp(numeric ? value : 0);
  const text = numeric ? format(Math.round(shown)) : value;
  const hasCompare = metric && metric.compare !== null && metric.direction !== 'none';

  // Se acepta tanto el componente (`icon={Zap}`) como el nodo ya construido
  // (`icon={<Zap className="…"/>}`) para no reescribir los ~25 llamadores, que usan las dos formas.
  //
  // La discriminación es `isValidElement`, NO `typeof === 'function'`: los iconos de lucide 1.x se
  // crean con `forwardRef`, así que son OBJETOS `{$$typeof, render}`. Con la prueba de función caían
  // del lado del "nodo ya construido" y React recibía el objeto del componente como hijo
  // ("Objects are not valid as a React child (found: object with keys {$$typeof, render})").
  const iconNode = !icon
    ? null
    : isValidElement(icon)
      ? icon
      : (() => {
          const Icon = icon as LucideIcon;
          return <Icon className={layout === 'center' ? 'size-3.5' : 'size-4 sm:size-[18px]'} />;
        })();

  const valueClass = cn(
    'font-semibold tabular-nums tracking-[-0.04em]',
    VALUE_SIZE[size],
    accent && 'text-hyper',
    tone === 'warning' && 'text-warning',
    tone === 'destructive' && 'text-destructive',
    tone === 'success' && 'text-success',
  );

  const body =
    layout === 'inline' ? (
      <div className="flex items-baseline gap-1.5">
        <span className={valueClass}>{text}</span>
        <span className="text-xs text-muted-foreground">{label}</span>
        {metric && <DeltaBadge metric={metric} invert={invert} />}
      </div>
    ) : layout === 'center' ? (
      <>
        {iconNode && <div className="flex items-center justify-center gap-1 text-muted-foreground">{iconNode}</div>}
        <div className={cn('mt-0.5', valueClass)}>{text}</div>
        <div className="label-caps mt-1 block truncate">{label}</div>
      </>
    ) : layout === 'row' ? (
      <div className="flex items-center gap-2.5 sm:gap-3">
        {iconNode && (
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground"
            style={
              colorVar === '--primary'
                ? { backgroundColor: 'hsl(var(--panel))' }
                : { backgroundColor: `hsl(var(${colorVar}) / 0.12)`, color: `hsl(var(${colorVar}))` }
            }
          >
            {iconNode}
          </div>
        )}
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className={valueClass}>{text}</span>
            {sub && <span className="truncate text-[11px] text-muted-foreground">{sub}</span>}
            {metric && <DeltaBadge metric={metric} invert={invert} />}
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground">{label}</div>
        </div>
      </div>
    ) : (
      <>
        {/* KPI del mock (`.kpi`): etiqueta `label-caps` arriba, cifra grande tabular, delta en color. El
            icono pasa a ser un acento chico a la derecha de la etiqueta, no una caja tintada. */}
        <div className="flex items-center justify-between gap-2">
          <span className="label-caps min-w-0 truncate">{label}</span>
          {iconNode && (
            <span
              className="flex shrink-0 items-center [&_svg]:size-3.5"
              style={{ color: colorVar === '--primary' ? 'hsl(var(--faint))' : `hsl(var(${colorVar}))` }}
            >
              {iconNode}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={valueClass}>{text}</span>
          {sub && <span className="truncate text-xs text-muted-foreground">{sub}</span>}
        </div>
        {(metric || hasCompare) && (
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {metric && <DeltaBadge metric={metric} invert={invert} />}
            {hasCompare && <span className="truncate">vs. {format(metric!.compare!)} período anterior</span>}
          </div>
        )}
        {trend && trend.length > 1 && (
          // Márgenes negativos para que la línea toque los bordes de la tarjeta: una sparkline con
          // aire alrededor se lee como una gráfica pequeña, pegada al borde se lee como parte del
          // KPI. `pointer-events-none` porque no tiene tooltip y no debe robar el hover.
          <div className="pointer-events-none -mb-1 -mx-1 mt-2">
            <Sparkline data={trend} dataKey={trendKey} height={32} color={`hsl(var(${colorVar}))`} />
          </div>
        )}
      </>
    );

  if (surface === 'plain') return <div className={className}>{body}</div>;
  if (surface === 'inset') {
    return (
      <div
        className={cn(
          'rounded-md border p-2.5',
          layout === 'center' && 'text-center',
          accent ? 'border-hyper/25 bg-hyper/[0.06]' : 'bg-sidebar',
          className,
        )}
      >
        {body}
      </div>
    );
  }
  return <Card className={cn('group px-4 py-3.5', layout === 'center' && 'text-center', className)}>{body}</Card>;
}
