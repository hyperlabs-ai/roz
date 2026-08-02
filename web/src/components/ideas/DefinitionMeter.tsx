import { Check, Circle } from 'lucide-react';
import { ProgressBar } from '@/components/bits';
import { definitionBarClass, definitionHint, type DefinitionCheck, type DefinitionScore } from '@/lib/ideas';
import { cn } from '@/lib/utils';

/**
 * Qué tan aterrizada está la idea: barra + los 8 checks.
 *
 * La checklist no es decorativa: cada ítem pendiente es un botón que lleva al campo que falta. Es
 * la respuesta a "no sé qué más escribir" — en vez de una hoja en blanco, una lista de lo que
 * queda por contestar.
 */
export function DefinitionMeter({
  score,
  onJump,
  className,
}: {
  score: DefinitionScore;
  onJump?: (target: DefinitionCheck['target']) => void;
  className?: string;
}) {
  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xl font-semibold tabular-nums">{score.pct}%</span>
        <span className="text-[11px] text-muted-foreground">{definitionHint(score.pct)}</span>
      </div>
      <ProgressBar pct={score.pct} barClassName={definitionBarClass(score.pct)} />
      <ul className="space-y-0.5">
        {[...score.done, ...score.missing].map((check) => {
          const ok = score.done.includes(check);
          return (
            <li key={check.key}>
              <button
                type="button"
                onClick={() => onJump?.(check.target)}
                disabled={!onJump}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors',
                  onJump && 'hover:bg-muted/60',
                  ok ? 'text-muted-foreground' : 'font-medium',
                )}
              >
                {ok ? (
                  <Check className="size-3.5 shrink-0 text-success" />
                ) : (
                  <Circle className="size-3.5 shrink-0 text-muted-foreground/50" />
                )}
                <span className={cn('min-w-0 truncate', ok && 'line-through decoration-muted-foreground/40')}>
                  {check.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Versión de una línea para las tarjetas de la rejilla. */
export function DefinitionBar({ pct, className }: { pct: number; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <ProgressBar pct={pct} className="h-1.5 flex-1" barClassName={definitionBarClass(pct)} />
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}
