import * as React from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Marca de guardado de UN campo: girando mientras viaja, palomita verde un momento al volver.
 * Es la respuesta a "¿se guardó?" en los formularios que guardan solos, donde no hay botón que
 * lo confirme.
 */
export function SaveMark({ state, className }: { state: SaveState; className?: string }) {
  if (state === 'idle') return null;
  return (
    <span
      role="status"
      className={cn(
        'inline-flex items-center gap-1 text-[11px] font-medium leading-none',
        state === 'saving' && 'text-faint',
        state === 'saved' && 'text-green',
        state === 'error' && 'text-red',
        className,
      )}
    >
      {state === 'saving' && <><Loader2 className="size-3 animate-spin" />Guardando</>}
      {state === 'saved' && <><Check className="size-3" strokeWidth={3} />Guardado</>}
      {state === 'error' && <><AlertCircle className="size-3" />No se guardó</>}
    </span>
  );
}

/**
 * Sigue una acción de guardado y devuelve su estado para `SaveMark` / `Field save=`. "Guardado" se
 * queda 1.6 s y se va solo. `track` devuelve el resultado, o `undefined` si la promesa falló.
 */
export function useSaveState(): [SaveState, <T>(p: Promise<T> | T) => Promise<T | undefined>] {
  const [state, setState] = React.useState<SaveState>('idle');
  const timer = React.useRef<ReturnType<typeof setTimeout>>();
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clearTimeout(timer.current); };
  }, []);

  const track = React.useCallback(async <T,>(p: Promise<T> | T): Promise<T | undefined> => {
    clearTimeout(timer.current);
    setState('saving');
    try {
      const out = await p;
      if (alive.current) {
        setState('saved');
        timer.current = setTimeout(() => { if (alive.current) setState('idle'); }, 1600);
      }
      return out;
    } catch {
      if (alive.current) {
        setState('error');
        timer.current = setTimeout(() => { if (alive.current) setState('idle'); }, 3000);
      }
      return undefined;
    }
  }, []);
  return [state, track];
}

export interface FieldProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  label?: React.ReactNode;
  /** Id del control, para que el click en la etiqueta lo enfoque. */
  htmlFor?: string;
  /** Ayuda bajo el campo. Si hay `error`, el error la sustituye. */
  hint?: React.ReactNode;
  error?: React.ReactNode;
  /** Añade "opcional" junto a la etiqueta. */
  optional?: boolean;
  required?: boolean;
  /** A la derecha de la etiqueta: contador, enlace, o lo que haga falta. */
  aside?: React.ReactNode;
  /** Estado de guardado del campo (formularios que guardan solos). */
  save?: SaveState;
  children: React.ReactNode;
}

/**
 * Un campo de formulario completo: etiqueta, control, y UNA línea debajo (ayuda o error). Todos los
 * formularios usan esta misma pieza, así que la etiqueta, los huecos y el tono de la ayuda son
 * iguales en todas partes.
 */
export function Field({ label, htmlFor, hint, error, optional, required, aside, save, className, children, ...props }: FieldProps) {
  const hasTop = label != null || aside != null || save != null;
  return (
    <div className={cn('grid min-w-0 content-start gap-1.5', className)} {...props}>
      {hasTop && (
        <div className="flex min-h-4 items-center justify-between gap-2">
          {label != null && (
            <label htmlFor={htmlFor} className="truncate text-[12.5px] font-medium leading-none text-foreground/80">
              {label}
              {required && <span className="ml-0.5 text-orange">*</span>}
              {optional && <span className="ml-1.5 font-normal text-faint">opcional</span>}
            </label>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] leading-none text-faint">
            {save && <SaveMark state={save} />}
            {aside}
          </span>
        </div>
      )}
      {children}
      {error ? (
        <p role="alert" className="flex items-start gap-1 text-[11.5px] leading-snug text-red">
          <AlertCircle className="mt-px size-3 shrink-0" />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p className="text-[11.5px] leading-snug text-faint">{hint}</p>
      ) : null}
    </div>
  );
}

/** Bloque de formulario con título en mayúsculas; separa grupos de campos. */
export function FormSection({ title, aside, children, className }: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-2.5 flex min-h-5 items-center justify-between gap-2">
        <h3 className="label-caps text-muted-foreground">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}
