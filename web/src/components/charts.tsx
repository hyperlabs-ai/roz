// Charts con recharts, responsivos (100% del ancho → sin espacio muerto a la derecha) y alineados
// al tema vía variables CSS. Este archivo es la ÚNICA frontera con recharts en toda la app.
//
// El lenguaje visual viene de la familia "mono" de amicro (amicro.vercel.app/mono-charts), portada
// a roz en vez de copiada: los originales traen los datos como constante de módulo, los colores
// como hex fijo y su propia tarjeta con título y pie inventados. Aquí cada gráfica recibe sus datos
// por prop, toma color de los tokens (`--chart-1..5`, `--hyper`, `--success`…) y no dibuja marco:
// el marco es la `Card` de la página. Lo que sí se adopta es la receta:
//
//   · trazos de 2.5px con puntas y uniones REDONDEADAS (leen como una línea dibujada, no un borde)
//   · rellenos en degradado vertical que se desvanece a 0 (el área no compite con la línea)
//   · barras con radio completo (píldora) y separación generosa
//   · grid punteado 2-2 y solo horizontal (la referencia sin cuadricular la gráfica)
//   · métrica al centro en todo lo circular (el hueco de una dona vacío es espacio desperdiciado)
//   · un tooltip con separador, `tabular-nums` e indicador de color por serie
//
// REGLA DE FORMA (decisión explícita del usuario): **nada de barras horizontales**. Toda comparación
// entre categorías se dibuja con COLUMNAS verticales (`Columns`). La lista rankeada de etiqueta +
// número + barra fina que había antes (`RankedList` / `RankBars`) se eliminó de la app, igual que el
// embudo y el radar. Si hace falta comparar magnitudes → `Columns`; composición → `Donut` /
// `StackedBar`; tiempo → `AreaTrend`.
import { useId, useState, type ReactNode } from 'react';
import {
  Area, AreaChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
  PolarAngleAxis, PieChart, Pie, RadialBar, RadialBarChart,
} from 'recharts';
import { UserAvatar } from '@/components/bits';
import { cn } from '@/lib/utils';
import { compact, shortDate } from '@/lib/format';
import { usePrefersReducedMotion } from '@/lib/motion';

export interface SeriesDef {
  key: string;
  name: string;
  color: string; // p.ej. 'hsl(var(--chart-1))'
}

/** Receta mono compartida: lo que hace que todas las gráficas se vean de la misma familia. */
const STROKE = 2.5;
const CAPS = { strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const GRID = { vertical: false, stroke: 'hsl(var(--border))', strokeDasharray: '2 2' } as const;
const AXIS = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } as const;
const AXIS_OFF = { tickLine: false, axisLine: false } as const;

const DEFAULT_COLOR = 'hsl(var(--chart-1))';

/** Duración de entrada, o nada si el usuario pidió menos movimiento. */
function useAnim(): { isAnimationActive: boolean; animationDuration: number; animationEasing: 'ease-out' } {
  // Antes esto se calculaba UNA vez a nivel de módulo, así que cambiar la preferencia del sistema
  // no tenía efecto hasta recargar. El hook ya existía en lib/motion.ts y no se usaba aquí.
  const reduced = usePrefersReducedMotion();
  return { isAnimationActive: !reduced, animationDuration: 700, animationEasing: 'ease-out' };
}

type Formatter = (n: number) => string;

/**
 * Tooltip único de todas las gráficas de recharts (antes eran cuatro casi idénticos).
 *
 * `labelFormat` existe porque el tooltip viejo aplicaba `shortDate()` a CUALQUIER etiqueta: una
 * gráfica con eje categórico mostraba basura. `valueFormat` porque el eje y el tooltip mostraban el
 * número crudo, así que las líneas cambiadas de un proyecto salían `24571` mientras el resto de la
 * app dice `24.6k`.
 */
export function ChartTooltip({
  active, payload, label, labelFormat, valueFormat = compact, indicator = 'dot', total,
}: {
  active?: boolean;
  payload?: any[];
  label?: string | number;
  labelFormat?: (v: string) => string;
  valueFormat?: Formatter;
  indicator?: 'dot' | 'line';
  /** Si se pasa, cada valor añade su porcentaje sobre el total (donas, splits). */
  total?: number;
}) {
  if (!active || !payload?.length) return null;
  const head = labelFormat && label != null ? labelFormat(String(label)) : label != null ? String(label) : null;
  return (
    <div className="rounded-lg border bg-popover/95 px-3 py-2 text-xs shadow-md backdrop-blur-sm">
      {head && <div className="mb-1.5 border-b pb-1 font-medium text-foreground">{head}</div>}
      <div className="flex flex-col gap-1">
        {payload.map((p: any, i: number) => {
          const color = p.color || p.fill || p.payload?.color || DEFAULT_COLOR;
          // `Math.abs`: las series de líneas borradas llegan negativas para dibujarse hacia abajo,
          // pero el número que se lee es la magnitud.
          const value = Math.abs(Number(p.value) || 0);
          const pct = total ? Math.round((value / total) * 100) : null;
          return (
            <div key={i} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span
                  className={cn('shrink-0 rounded-full', indicator === 'dot' ? 'size-2' : 'h-0.5 w-2.5')}
                  style={{ background: color }}
                />
                {p.name || p.payload?.label || p.dataKey}
              </span>
              <span className="font-medium tabular-nums text-foreground">
                {valueFormat(value)}
                {pct !== null && <span className="ml-1 font-normal text-muted-foreground">{pct}%</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EmptyChart({ height, children = 'Sin actividad en este período' }: { height: number | string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
      {children}
    </div>
  );
}

/**
 * Leyenda propia: etiqueta + dot + valor (+ % si hay total).
 *
 * Sustituye a la `Legend` de recharts, que envolvía a varias líneas sin control y dejaba las
 * etiquetas descolgadas de su color cuando había cinco o más categorías.
 */
function ChartLegend({
  data, total, valueFormat = compact, className,
}: {
  data: { label: string; value: number; color: string }[];
  total?: number;
  valueFormat?: Formatter;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {data.map((d) => (
        <div key={d.label} className="flex items-center justify-between gap-2 text-xs">
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <span className="size-2 shrink-0 rounded-full" style={{ background: d.color }} />
            <span className="truncate">{d.label}</span>
          </span>
          <span className="shrink-0 font-mono tabular-nums text-foreground">
            {valueFormat(d.value)}
            {total ? <span className="ml-1 font-sans font-normal text-muted-foreground">{Math.round((d.value / total) * 100)}%</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Comparación entre categorías — SIEMPRE columnas verticales
// ============================================================================

export interface ColumnDatum {
  label: string;
  value: number;
  color?: string;
  /** Si está presente (aunque valga `null`), la etiqueta del eje se dibuja como avatar + nombre. */
  avatarUrl?: string | null;
  /** Línea extra bajo la etiqueta (p.ej. "completados"). */
  sub?: string;
}

/**
 * Columnas verticales tipo píldora. **La única forma de comparar categorías en la app.**
 *
 * Está escrita en DOM y no con recharts a propósito, y vale explicar por qué: necesita tres cosas
 * que en SVG cuestan mucho más — el avatar del dev como etiqueta del eje (en recharts habría que
 * meter un `<image>` con `clipPath` dentro de un tick custom), el valor impreso encima de cada
 * columna sin que la etiqueta de la más alta se salga del marco, y el plegado a top-N.
 *
 * `sort={false}` conserva el orden de entrada, y es OBLIGATORIO en escalas ordinales: la prioridad
 * va urgente→baja y los estados van planificada→cerrada. Ordenar por valor ahí destruye la escala
 * (si hay más medias que altas quedan al revés y deja de leerse como escala).
 *
 * Al expandir, el excedente NO se dibuja como más columnas: con 20 categorías cada columna queda de
 * 4px y no se compara nada. Se lista como texto, que a esa cantidad es lo honesto.
 */
export function Columns({
  data,
  height = 200,
  fill = false,
  color = DEFAULT_COLOR,
  topN,
  valueFormat = compact,
  sort = true,
  hideZeros = true,
  onPick,
  className,
}: {
  data: ColumnDatum[];
  height?: number;
  /**
   * Crecer hasta llenar el alto disponible; `height` pasa a ser el PISO.
   *
   * Es lo que resuelve el hueco de las rejillas: las tarjetas de una fila se estiran a la altura de
   * la más alta (así sus fondos quedan alineados, que es como debe verse), y si la gráfica midiera
   * un alto fijo, ese estirón se convertiría en espacio vacío dentro de la tarjeta. Con `fill`, el
   * estirón se lo queda la gráfica. Requiere que la cadena de padres tenga altura definida:
   * `<Card className="flex flex-col">` + `<CardContent className="flex flex-1 flex-col">`.
   *
   * El piso es imprescindible: con `flex-1` + `min-h-0` el área puede encogerse hasta 0, y en una
   * fila donde las DOS tarjetas son gráficas ninguna impone alto — las dos colapsarían.
   */
  fill?: boolean;
  color?: string;
  topN?: number;
  valueFormat?: Formatter;
  sort?: boolean;
  hideZeros?: boolean;
  onPick?: (d: ColumnDatum) => void;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const ordered = sort ? [...data].sort((a, b) => b.value - a.value) : data;
  const rows = hideZeros ? ordered.filter((d) => d.value > 0) : ordered;
  const zeros = ordered.length - rows.length;
  if (!rows.length) return <EmptyChart height={fill ? '100%' : height} />;

  const cap = topN ?? rows.length;
  const shown = rows.slice(0, cap);
  const rest = rows.slice(cap);
  const peak = Math.max(1, ...shown.map((d) => d.value));
  // 18% de aire arriba: sin él, la etiqueta del valor de la columna más alta se sale del marco.
  const scale = peak * 1.18;
  const hasAvatars = shown.some((d) => 'avatarUrl' in d);
  // Dos referencias bastan (el pico y su mitad): más rayas en una gráfica de seis columnas es
  // ruido, y el valor exacto ya va impreso encima de cada columna.
  const ticks = [peak, Math.round(peak / 2)].filter((t, i, a) => t > 0 && a.indexOf(t) === i);

  return (
    <div className={cn(fill && 'flex min-h-0 flex-1 flex-col', className)}>
      {/* `min-h-0` es obligatorio en el modo fill: sin él, un hijo flex se niega a encogerse por
          debajo de su contenido y la gráfica desborda la tarjeta en vez de adaptarse. */}
      <div className={cn('relative', fill && 'min-h-0 flex-1')} style={fill ? { minHeight: height } : { height }}>
        {ticks.map((t) => (
          <div key={t} className="absolute inset-x-0 flex items-center gap-2" style={{ bottom: `${(t / scale) * 100}%` }}>
            <span className="w-8 shrink-0 text-right font-mono text-[10px] leading-none tabular-nums text-muted-foreground">
              {valueFormat(t)}
            </span>
            <span className="flex-1 border-t border-dashed border-border" />
          </div>
        ))}
        {/* Línea base: da el suelo del que nacen las columnas. */}
        <div className="absolute bottom-0 left-8 right-0 border-t border-border" />
        <div className="absolute inset-y-0 left-10 right-0 flex items-end gap-1.5 sm:gap-2.5">
          {shown.map((d) => {
            const pct = (d.value / scale) * 100;
            return (
              <div
                key={d.label}
                className="flex h-full min-w-0 flex-1 items-end justify-center"
                title={`${d.label}: ${valueFormat(d.value)}`}
              >
                <div
                  onClick={onPick ? () => onPick(d) : undefined}
                  className={cn(
                    // `rounded-lg` (8px fijo) y NO `rounded-full`: con radio 9999 una columna baja
                    // —48px de ancho por 20 de alto— se redondea por completo y sale una PASTILLA
                    // HORIZONTAL flotando sobre el eje, que se lee como un error de render. Ocho
                    // píxeles es además el radio que fija la receta mono para barras verticales.
                    'relative w-full max-w-10 rounded-lg transition-[height,filter] duration-slow ease-spring',
                    onPick && 'cursor-pointer hover:brightness-110',
                  )}
                  // Piso doble: 2% del alto y 6px absolutos. El porcentaje solo no basta — en una
                  // gráfica de 170px con un pico de 522, un valor de 21 daría 3px y no se vería
                  // como barra; y sin piso alguno, una categoría con actividad real parecería no
                  // existir.
                  style={{ height: `${Math.max(pct, 2)}%`, minHeight: 6, background: d.color ?? color }}
                >
                  <span className="absolute -top-[18px] left-1/2 -translate-x-1/2 font-mono text-[11px] font-medium leading-none tabular-nums">
                    {valueFormat(d.value)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Etiquetas del eje, alineadas con las columnas por el mismo `flex-1` y el mismo `gap`. */}
      <div className="mt-2 flex gap-1.5 pl-10 sm:gap-2.5">
        {shown.map((d) => (
          <div key={d.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            {hasAvatars && <UserAvatar url={d.avatarUrl ?? null} name={d.label} className="size-6" />}
            {/* Dos líneas y no `truncate`: con `truncate` "Hyperflow" y "Hyperdigital" quedaban
                los dos como "Hype…" en una tarjeta angosta, o sea dos categorías distintas con la
                misma etiqueta. En dos renglones caben, y el `title` da el nombre completo. */}
            <span className="line-clamp-2 w-full break-words text-center text-[11px] leading-tight text-muted-foreground" title={d.label}>
              {d.label}
            </span>
            {d.sub && <span className="w-full truncate text-center text-[10px] leading-tight text-muted-foreground/70">{d.sub}</span>}
          </div>
        ))}
      </div>

      {(rest.length > 0 || zeros > 0) && (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="press mt-3 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground"
          >
            {expanded
              ? 'Ver menos'
              : `Ver todos${rest.length > 0 ? ` (+${rest.length})` : ''}${zeros > 0 ? ` · ${zeros} sin actividad` : ''}`}
          </button>
          {expanded && rest.length > 0 && (
            <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 border-t pt-2 sm:grid-cols-2">
              {rest.map((d) => (
                <div key={d.label} className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate text-muted-foreground">{d.label}</span>
                  <span className="shrink-0 font-mono tabular-nums">{valueFormat(d.value)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Barra apilada al 100% con extremos redondeados (receta `mono-rounded-stacked-bar`).
 *
 * Es la única excepción a la regla de "nada horizontal", y lo es porque no compara categorías entre
 * sí: muestra la COMPOSICIÓN de un único total en una sola línea (tamaño de commits, storage).
 */
export function StackedBar({
  data, height = 10, valueFormat = compact, className,
}: {
  data: { label: string; value: number; color: string }[];
  height?: number;
  valueFormat?: Formatter;
  className?: string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (!total) return <div className={cn('rounded-full bg-muted', className)} style={{ height }} />;
  return (
    <div className={cn('flex w-full gap-0.5 overflow-hidden rounded-full', className)} style={{ height }}>
      {data.filter((d) => d.value > 0).map((d) => (
        <div
          key={d.label}
          className="h-full rounded-full transition-[flex-grow] duration-slow ease-spring"
          style={{ flexGrow: d.value, background: d.color }}
          title={`${d.label}: ${valueFormat(d.value)} · ${Math.round((d.value / total) * 100)}%`}
        />
      ))}
    </div>
  );
}

// ============================================================================
// Series temporales
// ============================================================================

/** Área multi-serie con degradado. La gráfica de tendencia de Overview y ProjectDetail. */
export function AreaTrend({
  data, series, height = 240, fill = false, xKey = 'date', valueFormat = compact,
}: {
  data: any[];
  series: SeriesDef[];
  height?: number;
  /** Igual que en `Columns`: crecer hasta llenar la tarjeta estirada, con `height` como piso. */
  fill?: boolean;
  xKey?: string;
  valueFormat?: Formatter;
}) {
  const anim = useAnim();
  // `useId` y no el nombre de la serie: dos AreaTrend en la misma página con la misma clave
  // compartían el id del degradado y la segunda pintaba con el color de la primera.
  const uid = useId().replace(/:/g, '');
  if (!data.length) return <EmptyChart height={fill ? '100%' : height} />;
  const isDate = xKey === 'date';
  // En modo fill hace falta el envoltorio: `ResponsiveContainer` con `height="100%"` necesita un
  // padre con alto resuelto, y como hijo directo de un flex column sin `flex-1` no lo tiene.
  const chart = (
    <ResponsiveContainer width="100%" height={fill ? '100%' : height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.45} />
              <stop offset="60%" stopColor={s.color} stopOpacity={0.12} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid {...GRID} />
        <XAxis dataKey={xKey} tickFormatter={isDate ? shortDate : undefined} tick={AXIS} {...AXIS_OFF} minTickGap={24} />
        <YAxis tick={AXIS} {...AXIS_OFF} width={40} allowDecimals={false} tickFormatter={valueFormat} />
        <Tooltip
          content={<ChartTooltip labelFormat={isDate ? shortDate : undefined} valueFormat={valueFormat} />}
          cursor={{ stroke: 'hsl(var(--border))' }}
        />
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={STROKE}
            {...CAPS}
            fill={`url(#${uid}-${s.key})`}
            activeDot={{ r: 4, strokeWidth: 0 }}
            dot={false}
            {...anim}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
  return fill ? <div className="min-h-0 flex-1" style={{ minHeight: height }}>{chart}</div> : chart;
}

/**
 * Sparkline: la línea sola, sin ejes ni tooltip, con el último punto marcado.
 *
 * El punto final es lo que la vuelve legible a este tamaño: sin él no se sabe si la línea termina
 * arriba o si está cortada por el borde.
 */
export function Sparkline({
  data, color = DEFAULT_COLOR, dataKey = 'commits', height = 48, showLast = true,
}: {
  data: any[];
  color?: string;
  dataKey?: string;
  height?: number;
  showLast?: boolean;
}) {
  const uid = useId().replace(/:/g, '');
  if (!data.length) return <div className="text-xs text-muted-foreground">—</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 3, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.4} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={2}
          {...CAPS}
          fill={`url(#${uid})`}
          isAnimationActive={false}
          activeDot={false}
          // Recharts pinta el mismo dot en todos los puntos, así que se filtra por índice y se
          // devuelve un nodo vacío para el resto. Un `<g/>` y no `null` porque el renderer espera
          // siempre un elemento.
          dot={
            showLast
              ? (props: any) =>
                  props.index === data.length - 1
                    ? <circle key="last" cx={props.cx} cy={props.cy} r={2.5} fill={color} />
                    : <g key={props.index} />
              : false
          }
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Alias histórico de `Sparkline` (lo usan el perfil del dev y las tarjetas de KPI). */
export const MiniArea = Sparkline;

// ============================================================================
// Circulares y radiales
// ============================================================================

/**
 * Dona con leyenda propia y **métrica al centro**. Para composiciones (cliente/interno, origen).
 *
 * `layout="side"` pone la leyenda a la derecha en vez de debajo. Importa en tarjetas anchas: la
 * dona es cuadrada, así que en una tarjeta de dos tercios queda un anillo chico en el medio con
 * hueco a los dos lados y la leyenda descolgada muy abajo. Al lado, la tarjeta se acorta y no
 * sobra espacio. `stack` sigue siendo el default porque en tarjetas angostas es lo correcto.
 */
export function Donut({
  data, height = 220, centerLabel, valueFormat = compact, legend = true, layout = 'stack',
}: {
  data: { label: string; value: number; color: string }[];
  height?: number;
  /** Rótulo bajo el total (p.ej. "commits"). Sin él se muestra solo el número. */
  centerLabel?: string;
  valueFormat?: Formatter;
  legend?: boolean;
  layout?: 'stack' | 'side';
}) {
  const anim = useAnim();
  const total = data.reduce((s, d) => s + d.value, 0);
  if (!total) return <EmptyChart height={height} />;
  const rows = data.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  const side = layout === 'side';
  return (
    <div className={cn(side && 'flex flex-col items-center gap-5 sm:flex-row sm:gap-6')}>
      {/* El centro va como overlay del DOM y no como `<Label>` de recharts: así hereda la tipografía
          y el `tabular-nums` de la app en vez de renderizarse como texto SVG que no calza con nada.
          Con la leyenda al lado el contenedor se hace cuadrado: si no, la dona se queda chica en
          medio de una caja ancha y el hueco vuelve. */}
      <div className={cn('relative', side ? 'w-full shrink-0 sm:w-auto' : '')} style={side ? { height, width: height } : { height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={rows}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius="62%"
              outerRadius="88%"
              paddingAngle={3}
              cornerRadius={4}
              strokeWidth={0}
              {...anim}
            >
              {rows.map((d, i) => <Cell key={i} fill={d.color} />)}
            </Pie>
            <Tooltip content={<ChartTooltip total={total} valueFormat={valueFormat} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold tabular-nums tracking-tight">{valueFormat(total)}</span>
          {centerLabel && <span className="text-[11px] text-muted-foreground">{centerLabel}</span>}
        </div>
      </div>
      {legend && <ChartLegend data={rows} total={total} valueFormat={valueFormat} className={side ? 'w-full min-w-0 flex-1' : 'mt-3'} />}
    </div>
  );
}

/**
 * Gauge de anillo con el valor al centro. Para un porcentaje único con techo natural:
 * disponibilidad, % de definición, ocupación.
 *
 * Es un anillo completo y no el semicírculo de la receta original: el arco obliga a mover el centro
 * (`cy`) en función del alto, y a tamaños chicos el texto y el arco se pisaban — se veía roto dentro
 * de la barra de resumen de Infra. El anillo se centra solo y aguanta cualquier tamaño.
 */
export function RadialGauge({
  pct, height = 140, color = DEFAULT_COLOR, label, format = (n) => `${Math.round(n)}%`, size = 'md',
}: {
  pct: number;
  height?: number;
  color?: string;
  label?: string;
  format?: Formatter;
  /** `sm` para meterlo en una barra o una fila; `md` cuando es el protagonista de una card. */
  size?: 'sm' | 'md';
}) {
  const anim = useAnim();
  const value = Math.max(0, Math.min(100, pct));
  return (
    // Cuadrado: el anillo necesita el mismo ancho que alto o sale ovalado.
    <div className="relative shrink-0" style={{ height, width: height }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          data={[{ value }]}
          startAngle={90}
          endAngle={-270}
          innerRadius="70%"
          outerRadius="100%"
          barSize={size === 'sm' ? 6 : 11}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
          <RadialBar
            dataKey="value"
            angleAxisId={0}
            cornerRadius={999}
            fill={color}
            background={{ fill: 'hsl(var(--muted))' }}
            {...anim}
          />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn('font-bold tabular-nums tracking-tight', size === 'sm' ? 'text-sm leading-none' : 'text-2xl')}>
          {format(value)}
        </span>
        {label && (
          <span className={cn('leading-none text-muted-foreground', size === 'sm' ? 'mt-0.5 text-[9px]' : 'mt-1 text-[11px]')}>
            {label}
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Matriz / mapa de calor
// ============================================================================

/**
 * Celda de mapa de calor con nodo redondeado (receta `mono-activity-*`).
 *
 * Es una primitiva y no una rejilla completa a propósito: los dos mapas de calor de la app tienen
 * estructuras distintas — el de contribuciones es 52×7 por fecha, y la matriz de skills lleva
 * cabeceras y celdas editables por Popover. Lo que sí deben compartir es el nodo: mismo radio,
 * misma rampa de intensidad y mismo realce al hover.
 */
export function HeatCell({
  level, levels = 4, colorVar = '--chart-1', ramp, size = 'size-2.5', title, className, children, onClick,
}: {
  /** 0 = vacío. */
  level: number;
  /** Nivel máximo de la rampa. */
  levels?: number;
  /** NOMBRE del token, no el color compuesto: la rampa necesita inyectar alfa dentro del `hsl()`. */
  colorVar?: string;
  /**
   * Rampa explícita de clases por nivel (índice 0 = vacío), cuando la escala NO se puede derivar de
   * un token: las contribuciones de GitHub usan sus verdes de marca en claro por decisión de
   * diseño, y esos no salen de la paleta del tema.
   */
  ramp?: readonly string[];
  size?: string;
  title?: string;
  className?: string;
  children?: ReactNode;
  onClick?: () => void;
}) {
  const lvl = Math.max(0, Math.min(levels, level));
  // Rampa por opacidad sobre UN token en vez de N colores: mantiene la escala secuencial (más
  // oscuro = más) que una paleta categórica rompería.
  const alpha = lvl === 0 ? 0 : 0.18 + (lvl / levels) * 0.82;
  return (
    <div
      title={title}
      onClick={onClick}
      className={cn(
        'relative rounded-[3px] transition-[transform,box-shadow] duration-fast ease-spring',
        'hover:z-10 hover:scale-[1.35] hover:shadow-sm',
        ramp ? ramp[lvl] : lvl === 0 && 'bg-muted',
        onClick && 'cursor-pointer',
        size,
        className,
      )}
      style={!ramp && lvl > 0 ? { background: `hsl(var(${colorVar}) / ${alpha})` } : undefined}
    >
      {children}
    </div>
  );
}

/** Leyenda "Menos → Más" de una rampa de calor. */
export function HeatLegend({
  levels = 4, colorVar = '--chart-1', ramp, className,
}: {
  levels?: number;
  colorVar?: string;
  ramp?: readonly string[];
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-1 text-[10px] text-muted-foreground', className)}>
      <span>Menos</span>
      {Array.from({ length: levels + 1 }, (_, i) => (
        // Sin realce al hover: en la leyenda no hay nada que inspeccionar.
        <HeatCell key={i} level={i} levels={levels} colorVar={colorVar} ramp={ramp} size="size-3" className="hover:scale-100 hover:shadow-none" />
      ))}
      <span>Más</span>
    </div>
  );
}
