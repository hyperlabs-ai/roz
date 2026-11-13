// Recorrido de puesta en marcha (Llaves y Acceso): pasos numerados unidos por un riel, cada uno con
// su estado real, y la línea de terminal compacta que lleva su comando.
import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CopyButton } from './zeus-ui';

export type StepState = 'done' | 'current' | 'todo';

const STATE_LABEL: Record<StepState, string> = { done: 'Hecho', current: 'Sigue este', todo: 'Después' };

export function Steps({ children, className }: { children: ReactNode; className?: string }) {
  return <ol className={cn('grid', className)}>{children}</ol>;
}

export function Step({
  n,
  state,
  title,
  stateLabel,
  last = false,
  children,
}: {
  n: number;
  state: StepState;
  title: ReactNode;
  /** Sustituye la etiqueta de estado ("Hecho", "Sigue este"…) cuando el paso sabe decir algo mejor. */
  stateLabel?: ReactNode;
  last?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="relative grid grid-cols-[26px_minmax(0,1fr)] gap-x-3" data-state={state}>
      {!last && <span aria-hidden className={cn('absolute bottom-0 left-[12.5px] top-[30px] w-px', state === 'done' ? 'bg-green/50' : 'bg-border')} />}
      <span
        className={cn(
          'grid size-[26px] place-items-center rounded-full text-[12px] font-semibold tabular-nums',
          state === 'done' && 'bg-green-soft text-green',
          state === 'current' && 'bg-orange text-white',
          state === 'todo' && 'border border-dashed border-toggle-off text-faint',
        )}
      >
        {state === 'done' ? <Check className="size-3.5" strokeWidth={2.6} /> : n}
      </span>
      <div className={cn('grid min-w-0 gap-1.5', !last && 'pb-4')}>
        <div className="flex min-h-[26px] items-center justify-between gap-2">
          <h4 className={cn('shrink-0 text-[13px] font-semibold tracking-[-0.01em]', state === 'todo' && 'text-muted-foreground')}>{title}</h4>
          <span className={cn('label-caps min-w-0 truncate text-[10px]', state === 'done' && 'text-green', state === 'current' && 'text-orange-ink')}>
            {stateLabel ?? STATE_LABEL[state]}
          </span>
        </div>
        {children}
      </div>
    </li>
  );
}

/** Texto de apoyo de un paso. */
export function StepNote({ children }: { children: ReactNode }) {
  return <p className="text-[12px] leading-snug text-muted-foreground">{children}</p>;
}

/** Comando en una línea de terminal (oscura en ambos temas) con copiar. `wrap` para los largos. */
export function CmdLine({ command, wrap = false, className }: { command: string; wrap?: boolean; className?: string }) {
  return (
    <div className={cn('flex gap-2 rounded-md bg-terminal py-1 pl-3 pr-1 text-terminal-foreground', wrap ? 'items-start' : 'items-center', className)}>
      <span aria-hidden className={cn('select-none font-mono text-[11.5px] text-terminal-muted', wrap && 'pt-[5px]')}>$</span>
      <code
        className={cn('min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed', wrap ? 'whitespace-pre-wrap py-[3px] [overflow-wrap:anywhere]' : 'truncate')}
        title={wrap ? undefined : command}
      >
        {command}
      </code>
      {/* El texto del botón se oculta a la vista (queda el ícono) pero sigue siendo su nombre accesible. */}
      <CopyButton text={command} className="h-7 shrink-0 gap-0 px-1.5 text-[0px] text-terminal-muted hover:bg-terminal-muted/15 hover:text-terminal-foreground" />
    </div>
  );
}
