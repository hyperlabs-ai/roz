import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
const META: Record<SizeBucket['key'], { label: string; range: string; bar: string; dot: string }> = {
  micro: { label: 'Micro', range: '<30 líneas', bar: 'bg-chart-1/30', dot: 'bg-chart-1/40' },
  chico: { label: 'Chico', range: '30–300', bar: 'bg-chart-1/55', dot: 'bg-chart-1/60' },
  mediano: { label: 'Mediano', range: '300–2k', bar: 'bg-chart-1/80', dot: 'bg-chart-1/80' },
  grande: { label: 'Grande', range: '>2k', bar: 'bg-chart-1', dot: 'bg-chart-1' },
};

/** Barra compacta (para la fila del listado): segmentos = % de líneas por franja de tamaño. */
export function SizeDistBar({ dist }: { dist: SizeBucket[] }) {
  const totalLines = dist.reduce((s, b) => s + b.lines, 0);
  if (!totalLines) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="mt-2">
          <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted">
            {dist.filter((b) => b.lines > 0).map((b) => (
              <div key={b.key} className={cn('h-full', META[b.key].bar)} style={{ width: `${(100 * b.lines) / totalLines}%` }} />
            ))}
          </div>
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

/** Panel detallado (para el perfil): por franja, compara % de commits contra % de líneas. */
export function SizeDistPanel({ dist }: { dist: SizeBucket[] }) {
  const totalLines = dist.reduce((s, b) => s + b.lines, 0);
  const totalCommits = dist.reduce((s, b) => s + b.commits, 0);
  if (!totalLines || !totalCommits) return null;
  return (
    <div className="space-y-4">
      {dist.map((b) => {
        const commitPct = (100 * b.commits) / totalCommits;
        const linePct = (100 * b.lines) / totalLines;
        return (
          <div key={b.key}>
            <div className="flex items-baseline justify-between">
              <span className="inline-flex items-center gap-2 text-sm font-medium">
                <span className={cn('size-2.5 rounded-full', META[b.key].dot)} />
                {META[b.key].label} <span className="text-xs font-normal text-muted-foreground">{META[b.key].range === '<30 líneas' ? META[b.key].range : `${META[b.key].range} líneas`}</span>
              </span>
            </div>
            <div className="mt-1.5 grid grid-cols-[3.5rem_1fr_5.5rem] items-center gap-x-2 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
              <span>commits</span>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn('h-full', META[b.key].bar)} style={{ width: `${commitPct}%` }} /></div>
              <span className="text-right">{b.commits} ({Math.round(commitPct)}%)</span>
              <span>líneas</span>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn('h-full', META[b.key].bar)} style={{ width: `${linePct}%` }} /></div>
              <span className="text-right">{compact(b.lines)} ({Math.round(linePct)}%)</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
