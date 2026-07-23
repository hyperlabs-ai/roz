// Charts con recharts, responsivos (100% del ancho → sin espacio muerto a la derecha) y
// alineados al tema vía variables CSS. Tooltip propio para respetar claro/oscuro.
import { useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PieChart, Pie, Legend,
} from 'recharts';
import { cn } from '@/lib/utils';

export interface SeriesDef {
  key: string;
  name: string;
  color: string; // p.ej. 'hsl(var(--chart-1))'
}

// Movimiento de charts: se dibujan con una entrada suave, salvo que el usuario pida menos movimiento.
const REDUCED_MOTION = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ANIMATE = !REDUCED_MOTION;

function shortDate(v: string) {
  // "2026-06-18" -> "18 jun"
  const [, mm, dd] = v.split('-');
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return dd && mm ? `${parseInt(dd, 10)} ${months[parseInt(mm, 10) - 1]}` : v;
}

const axis = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium text-foreground">{shortDate(String(label))}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-muted-foreground">
          <span className="size-2 rounded-full" style={{ background: p.color || p.fill }} />
          <span className="text-foreground">{Math.abs(p.value)}</span> {p.name}
        </div>
      ))}
    </div>
  );
}

/** Tooltip para ejes categóricos (no fechas): muestra la etiqueta tal cual, sin formatear como día. */
function CategoryTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full" style={{ background: p.color || p.fill }} />
        <span className="font-medium text-foreground">{p.payload.label}</span>
      </div>
      <div className="mt-0.5 text-muted-foreground"><span className="text-foreground">{p.value}</span></div>
    </div>
  );
}

export function AreaTrend({ data, series, height = 240, xKey = 'date' }: { data: any[]; series: SeriesDef[]; height?: number; xKey?: string }) {
  if (!data.length) return <EmptyChart height={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.45} />
              <stop offset="60%" stopColor={s.color} stopOpacity={0.12} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
        <XAxis dataKey={xKey} tickFormatter={shortDate} tick={axis} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
        <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'hsl(var(--border))' }} />
        {series.map((s) => (
          <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2.5} fill={`url(#grad-${s.key})`} activeDot={{ r: 4, strokeWidth: 0 }} dot={false} isAnimationActive={ANIMATE} animationDuration={800} animationEasing="ease-out" />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function MiniArea({ data, color = 'hsl(var(--chart-1))', dataKey = 'commits', height = 48 }: { data: any[]; color?: string; dataKey?: string; height?: number }) {
  if (!data.length) return <div className="text-xs text-muted-foreground">—</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`mini-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.45} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} fill={`url(#mini-${dataKey})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/**
 * Lista rankeada (clean minimal): etiqueta + valor arriba, barra proporcional fina abajo. Ordena
 * desc, OCULTA los ceros por defecto (con nota "N sin actividad") y colapsa a top-N con "ver todos".
 * Sustituye las barras horizontales de recharts (que se estiraban feo con muchas filas / valores 0).
 * data: {label,value,color?}.
 */
export function RankedList({
  data,
  color = 'hsl(var(--chart-1))',
  hideZeros = true,
  topN,
  valueFormat = (n: number) => String(n),
  className,
}: {
  data: { label: string; value: number; color?: string }[];
  color?: string;
  hideZeros?: boolean;
  topN?: number;
  valueFormat?: (n: number) => string;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const nonZero = hideZeros ? sorted.filter((r) => r.value > 0) : sorted;
  const zeros = sorted.length - nonZero.length;
  if (!nonZero.length) return <EmptyChart height={120} />;
  const cap = topN ?? nonZero.length;
  const shown = expanded ? nonZero : nonZero.slice(0, cap);
  const peak = Math.max(1, ...nonZero.map((r) => r.value));
  const overflow = nonZero.length - cap;
  return (
    <div className={cn('space-y-2.5', className)}>
      {shown.map((r) => (
        <div key={r.label} className="row-nudge">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm">{r.label}</span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{valueFormat(r.value)}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{ width: `${(r.value / peak) * 100}%`, background: r.color ?? color }}
            />
          </div>
        </div>
      ))}
      {(overflow > 0 || zeros > 0) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="press pt-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded
            ? 'Ver menos'
            : `Ver todos${overflow > 0 ? ` (+${overflow})` : ''}${zeros > 0 ? ` · ${zeros} sin actividad` : ''}`}
        </button>
      )}
    </div>
  );
}

/** Barras VERTICALES (comparación honesta para N pequeño). data: {label,value,color?}. */
export function BarMini({
  data,
  height = 200,
  color = 'hsl(var(--chart-1))',
}: {
  data: { label: string; value: number; color?: string }[];
  height?: number;
  color?: string;
}) {
  if (!data.length) return <EmptyChart height={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 12, right: 8, left: -16, bottom: 0 }} barCategoryGap="24%">
        <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
        <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} interval={0} />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
        <Tooltip content={<CategoryTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.5)' }} />
        <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={44} isAnimationActive={ANIMATE} animationDuration={700} animationEasing="ease-out">
          {data.map((d, i) => (
            <Cell key={i} fill={d.color ?? color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Compat: `RankBars` (barras horizontales) queda como alias de `RankedList`, así todos los usos
 * existentes adoptan la lista limpia sin cambios en cada página. `height` se ignora (la lista se
 * ajusta al contenido).
 */
export function RankBars({ data, color, topN = 6 }: { data: { label: string; value: number; color?: string }[]; color?: string; height?: number; topN?: number }) {
  return <RankedList data={data} color={color} topN={topN} />;
}

function EmptyChart({ height }: { height: number }) {
  return (
    <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
      Sin actividad en este período
    </div>
  );
}

/**
 * Radar de foco: un vértice por proyecto; el área estirada hacia un eje muestra dónde se
 * concentra el trabajo. Necesita ≥3 proyectos para verse como polígono; con menos cae a barras.
 */
export function FocusRadar({ data, height = 260 }: { data: { label: string; value: number }[]; height?: number }) {
  if (!data.length) return <EmptyChart height={height} />;
  if (data.length < 3) {
    // Un radar de 1–2 ejes no comunica nada; una lista rankeada es más honesta.
    return <RankedList data={data} />;
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RadarChart data={data} outerRadius="72%" margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <PolarGrid stroke="hsl(var(--border))" />
        <PolarAngleAxis dataKey="label" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
        <Radar
          dataKey="value"
          stroke="hsl(var(--chart-1))"
          strokeWidth={2}
          fill="hsl(var(--chart-1))"
          fillOpacity={0.25}
          dot={{ r: 3, fill: 'hsl(var(--chart-1))', strokeWidth: 0 }}
          isAnimationActive={ANIMATE}
          animationDuration={700}
          animationEasing="ease-out"
        />
        <Tooltip content={<RadarTooltip />} />
      </RadarChart>
    </ResponsiveContainer>
  );
}

/** Dona con leyenda — para splits (cliente vs interno, etc). data: {label,value,color}. */
export function Donut({ data, height = 220 }: { data: { label: string; value: number; color: string }[]; height?: number }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (!total) return <EmptyChart height={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="label" cx="50%" cy="50%" innerRadius="58%" outerRadius="85%" paddingAngle={2} strokeWidth={0} isAnimationActive={ANIMATE} animationDuration={700} animationEasing="ease-out">
          {data.map((d, i) => <Cell key={i} fill={d.color} />)}
        </Pie>
        <Tooltip content={<DonutTooltip total={total} />} />
        <Legend verticalAlign="bottom" height={28} iconType="circle" formatter={(v) => <span className="text-xs text-muted-foreground">{v}</span>} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function DonutTooltip({ active, payload, total }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  const pct = total ? Math.round((p.value / total) * 100) : 0;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full" style={{ background: p.payload.color }} />
        <span className="font-medium text-foreground">{p.name}</span>
      </div>
      <div className="mt-0.5 text-muted-foreground"><span className="text-foreground">{p.value}</span> · {pct}%</div>
    </div>
  );
}

function RadarTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-foreground">{p.payload.label}</div>
      <div className="text-muted-foreground"><span className="text-foreground">{p.value}</span> commits</div>
    </div>
  );
}
