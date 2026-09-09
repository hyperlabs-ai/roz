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

// Rampa ORDINAL de un solo hue (azul de marca) micro→grande: magnitud creciente = intensidad
// creciente, coherente con el tema en light y dark (antes eran sky/violet/amber sueltos).
// `color` (y no solo la clase `bar`) porque las primitivas de gráfica reciben un color, no una
// clase de Tailwind: el mismo valor sirve para el segmento apilado y para la barra proporcional.
const META: Record<SizeBucket['key'], { label: string; range: string; color: string; dot: string }> = {
  micro: { label: 'Micro', range: '<30 líneas', color: 'hsl(var(--chart-1) / 0.3)', dot: 'bg-chart-1/40' },
  chico: { label: 'Chico', range: '30–300', color: 'hsl(var(--chart-1) / 0.55)', dot: 'bg-chart-1/60' },
  mediano: { label: 'Mediano', range: '300–2k', color: 'hsl(var(--chart-1) / 0.8)', dot: 'bg-chart-1/80' },
  grande: { label: 'Grande', range: '>2k', color: 'hsl(var(--chart-1))', dot: 'bg-chart-1' },
};

/** Barra compacta (para la fila del listado): segmentos = % de líneas por franja de tamaño. */
export function SizeDistBar({ dist }: { dist: SizeBucket[] }) {
  const totalLines = dist.reduce((s, b) => s + b.lines, 0);
  if (!totalLines) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="mt-2">
          <StackedBar
            height={6}
            data={dist.map((b) => ({ label: META[b.key].label, value: b.lines, color: META[b.key].color }))}
          />
          <div className="mt-1 text-[10px] text-muted-foreground">líneas por tamaño de commit</div>
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
        <div className="mb-2 text-xs font-medium text-muted-foreground">Commits por tamaño</div>
        <Columns data={axis((b) => b.commits)} sort={false} hideZeros={false} height={170} valueFormat={(n) => String(n)} />
      </div>
      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">Líneas por tamaño</div>
        <Columns data={axis((b) => b.lines)} sort={false} hideZeros={false} height={170} />
      </div>
    </div>
  );
}
