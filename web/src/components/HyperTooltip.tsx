import { Zap } from 'lucide-react';
import { TooltipContent } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Contenido del tooltip que explica los hyper points; sobreescribe el estilo compacto base. */
export function HyperTooltip({ side }: { side?: 'top' | 'bottom' }) {
  return (
    <TooltipContent side={side} className="max-w-[17rem] rounded-lg border bg-popover p-3 text-left font-normal text-popover-foreground shadow-lg">
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <Zap className="size-3.5 text-amber-500" /> ¿Cómo se calculan los hyper points?
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        Cada commit vale según sus líneas cambiadas, con rendimientos decrecientes:
      </p>
      <div className="mt-2 overflow-hidden rounded-md border">
        {[['1 línea', '≈ 0.004 pts'], ['100 líneas', '≈ 1.3 pts'], ['1,000 líneas', '≈ 6.6 pts'], ['10,000 líneas', '≈ 20.8 pts']].map(([lines, pts], i) => (
          <div key={lines} className={cn('flex items-center justify-between px-2.5 py-1 text-[11px] tabular-nums', i % 2 === 0 && 'bg-muted/50')}>
            <span className="text-muted-foreground">{lines}</span>
            <span className="font-semibold">{pts}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        Ni muchos micro-commits ni un mega-commit inflan el top: gana quien entrega trabajo constante y sustancial.
      </p>
      <p className="mt-1.5 font-mono text-[10px] text-muted-foreground/70">log₂(2 + líneas)^4 / 1500 por commit</p>
    </TooltipContent>
  );
}
