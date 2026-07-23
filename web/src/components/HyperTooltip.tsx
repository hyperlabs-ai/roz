import { Zap } from 'lucide-react';
import { TooltipContent } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Contenido del tooltip que explica los hyper points; sobreescribe el estilo compacto base. */
export function HyperTooltip({ side }: { side?: 'top' | 'bottom' }) {
  return (
    <TooltipContent side={side} className="max-w-[17rem] rounded-lg border bg-popover p-3 text-left font-normal text-popover-foreground shadow-lg">
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <Zap className="size-3.5 text-hyper" /> ¿Cómo se calculan los hyper points?
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        Media geométrica entre actividad y volumen del período — necesitas ambas: entregar seguido y entregar sustancia.
      </p>
      <div className="mt-2 overflow-hidden rounded-md border">
        {[['20 commits · 2k líneas', '20 pts'], ['50 commits · 20k líneas', '100 pts'], ['100 commits · 60k líneas', '245 pts']].map(([combo, pts], i) => (
          <div key={combo} className={cn('flex items-center justify-between px-2.5 py-1 text-[11px] tabular-nums', i % 2 === 0 && 'bg-muted/50')}>
            <span className="text-muted-foreground">{combo}</span>
            <span className="font-semibold">{pts}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        Ni muchos micro-commits ni un mega-commit inflan el top: solo cuentan los totales, así que cómo empaquetes el trabajo no cambia el puntaje.
      </p>
      <p className="mt-1.5 font-mono text-[10px] text-muted-foreground/70">√(commits × líneas) / 10 en el período</p>
    </TooltipContent>
  );
}
