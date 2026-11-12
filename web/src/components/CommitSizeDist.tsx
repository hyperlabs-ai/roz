import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Columns, StackedBar } from '@/components/charts';
import { compact } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { SizeBucket } from '@/lib/api';

/**
 * Distribución de commits por tamaño: describe el estilo de trabajo de un dev (¿muchos
 * commits chicos constantes, o pocos grandes?). Es informativa: los hyper points se
 * calculan sobre los totales del período (√(commits × líneas) / 10), así que cómo se
 * empaqueta el trabajo en commits no cambia el puntaje.
 */

// Rampa ORDINAL de un solo hue (naranja roz) micro→grande: magnitud creciente = intensidad
// creciente, coherente con el tema en light y dark (antes eran sky/violet/amber sueltos).
// `color` (y no solo la clase `bar`) porque las primitivas de gráfica reciben un color, no una
// clase de Tailwind: el mismo valor sirve para el segmento apilado y para la barra proporcional.
const META: Record<SizeBucket['key'], { label: string; range: string; color: string; dot: string }> = {
  micro: { label: 'Micro', range: '<30 líneas', color: 'hsl(var(--chart-1) / 0.3)', dot: 'bg-chart-1/40' },
  chico: { label: 'Chico', range: '30–300', color: 'hsl(var(--chart-1) / 0.55)', dot: 'bg-chart-1/60' },
  mediano: { label: 'Mediano', range: '300–2k', color: 'hsl(var(--chart-1) / 0.8)', dot: 'bg-chart-1/80' },
  grande: { label: 'Grande', range: '>2k', color: 'hsl(var(--chart-1))', dot: 'bg-chart-1' },
};

/** Segmentos de la barra apilada (líneas por franja), con la rampa de este módulo. */
export function sizeDistSegments(dist: SizeBucket[]) {
  return dist.map((b) => ({ label: META[b.key].label, value: b.lines, color: META[b.key].color }));
}

/**
 * Leyenda de la barra: franja + % de líneas, en una línea. Sin ella la barra era cuatro tonos de
 * naranja sin clave y había que pasar el cursor para saber qué era cada uno.
 */
export function SizeDistLegend({ dist, className }: { dist: SizeBucket[]; className?: string }) {
  const totalLines = dist.reduce((s, b) => s + b.lines, 0);
  if (!totalLines) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-none tabular-nums', className)}>
      {dist.map((b) => {
        const pct = Math.round((b.lines / totalLines) * 100);
        return (
          <span key={b.key} className={cn('inline-flex items-center gap-1', !b.lines && 'opacity-45')}>
            <span className={cn('size-1.5 shrink-0 rounded-[2px]', META[b.key].dot)} />
            <span className="text-muted-foreground">{META[b.key].label}</span>
            <span className="font-medium text-foreground">{pct}%</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * Barra compacta (para la fila del listado): segmentos = % de líneas por franja de tamaño.
 *
 * `placeholder` la dibuja vacía cuando no hay commits en vez de no dibujar nada: en un listado, que
 * la barra desaparezca en unas filas y en otras no las desalinea entre sí.
 */
export function SizeDistBar({ dist, placeholder = false, className }: { dist: SizeBucket[]; placeholder?: boolean; className?: string }) {
  const totalLines = dist.reduce((s, b) => s + b.lines, 0);
  if (!totalLines) {
    if (!placeholder) return null;
    return (
      <div className={cn('mt-2', className)}>
        <StackedBar height={6} data={[]} />
        <div className="mt-2 text-[11px] leading-none text-faint">Sin commits en el período</div>
      </div>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn('mt-2', className)}>
          <StackedBar height={6} data={sizeDistSegments(dist)} />
          <SizeDistLegend dist={dist} className="mt-2" />
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-[19rem] rounded-lg border bg-popover p-3 text-left font-normal text-popover-foreground shadow-lg">
        <div className="text-xs font-semibold">Cómo se reparte su trabajo</div>
        <div className="mt-2 space-y-1">
          {dist.map((b) => (
            <div key={b.key} className="flex items-center gap-2 text-[11px] tabular-nums">
              <span className={cn('size-2 shrink-0 rounded-full', META[b.key].dot)} />
              <span className="w-[7.5rem] shrink-0 text-muted-foreground">{META[b.key].label} ({META[b.key].range})</span>
              <span className="flex-1 text-right">{b.commits} commits · {compact(b.lines)} líneas</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Los hyper points salen de los totales del período (√ de commits × líneas); el tamaño de
          cada commit no cambia el puntaje, esta barra solo muestra el estilo de trabajo.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Panel detallado (para el perfil): compara el reparto de COMMITS contra el de LÍNEAS por franja.
 *
 * Dos gráficas de columnas y no ocho barras horizontales apareadas. El contraste entre las dos es
 * justo el dato: si "grande" es una rebanada chica en commits pero enorme en líneas, esta persona
 * mete pocos commits muy gordos. Con dos ejes verticales lado a lado esa diferencia de forma se ve
 * de un golpe; con barras acostadas había que leer ocho porcentajes.
 *
 * `sort={false}`: micro → grande es una escala ordinal y ordenarla por valor la destruye.
 */
export function SizeDistPanel({ dist }: { dist: SizeBucket[] }) {
  const totalLines = dist.reduce((s, b) => s + b.lines, 0);
  const totalCommits = dist.reduce((s, b) => s + b.commits, 0);
  if (!totalLines || !totalCommits) return null;
  const axis = (pick: (b: SizeBucket) => number) =>
    dist.map((b) => ({ label: META[b.key].label, value: pick(b), color: META[b.key].color }));
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <div>
        <div className="label-caps mb-2 block">Commits por tamaño</div>
        <Columns data={axis((b) => b.commits)} sort={false} hideZeros={false} height={170} valueFormat={(n) => String(n)} />
      </div>
      <div>
        <div className="label-caps mb-2 block">Líneas por tamaño</div>
        <Columns data={axis((b) => b.lines)} sort={false} hideZeros={false} height={170} />
      </div>
    </div>
  );
}
