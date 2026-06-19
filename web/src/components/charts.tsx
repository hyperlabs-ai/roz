// Charts con recharts, responsivos (100% del ancho → sin espacio muerto a la derecha) y
// alineados al tema vía variables CSS. Tooltip propio para respetar claro/oscuro.
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PieChart, Pie, Legend, LabelList,
} from 'recharts';

export interface SeriesDef {
  key: string;
  name: string;
  color: string; // p.ej. 'hsl(var(--chart-1))'
}

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
          <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2.5} fill={`url(#grad-${s.key})`} activeDot={{ r: 4, strokeWidth: 0 }} dot={false} />
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
        <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} fill={`url(#mini-${dataKey})`} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Barras horizontales rankeadas con el valor al final. data: {label,value,color?}. */
export function RankBars({ data, color = 'hsl(var(--chart-1))', height = 240 }: { data: { label: string; value: number; color?: string }[]; color?: string; height?: number }) {
  if (!data.length) return <EmptyChart height={height} />;
  return (
    <ResponsiveContainer width="100%" height={Math.max(height, data.length * 34)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 28, left: 0, bottom: 0 }} barCategoryGap={8}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="label" tick={{ fontSize: 12, fill: 'hsl(var(--foreground))' }} tickLine={false} axisLine={false} width={120} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: 'hsl(var(--muted))' }} />
        <Bar dataKey="value" radius={[0, 6, 6, 0]} fill={color} maxBarSize={22}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.color ?? color} />
          ))}
          <LabelList dataKey="value" position="right" className="fill-foreground" style={{ fontSize: 12, fontWeight: 600 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
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
    // Un radar de 1–2 ejes no comunica nada; barras es más honesto.
    return <RankBars data={data} height={Math.min(height, 120)} />;
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
        <Pie data={data} dataKey="value" nameKey="label" cx="50%" cy="50%" innerRadius="58%" outerRadius="85%" paddingAngle={2} strokeWidth={0}>
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
