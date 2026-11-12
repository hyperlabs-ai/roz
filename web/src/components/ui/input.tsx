import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Piel común de todo campo de texto (input, textarea, disparador de select, combobox): un solo
 * sitio para el borde, el hover, el foco y el estado inválido, para que ningún formulario tenga
 * que volver a escribirlos a mano.
 *
 *  · reposo  — hairline cálida sobre tarjeta
 *  · hover   — la hairline se oscurece (se nota que es editable antes de hacer click)
 *  · foco    — borde + halo del color de foco
 *  · error   — `aria-invalid` lo pinta de rojo, con halo rojo al enfocar
 */
export const fieldSkin =
  'rounded-md border border-input bg-card text-[13.5px] text-foreground transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-faint hover:border-foreground/25 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-input aria-[invalid=true]:border-red aria-[invalid=true]:focus-visible:ring-red/15';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Ícono o texto DENTRO del campo, a la izquierda (lupa, `@`, `https://`). */
  leading?: React.ReactNode;
  /** Unidad o acción DENTRO del campo, a la derecha (`h`, `%`, un botón de limpiar). */
  trailing?: React.ReactNode;
  /** `sm` = 32px para filas densas; `md` = 36px (por defecto). */
  fieldSize?: 'sm' | 'md';
  /** Pinta el estado de error (equivale a `aria-invalid`). */
  invalid?: boolean;
  /** Clases del envoltorio cuando hay `leading`/`trailing` (el ancho va aquí). */
  wrapperClassName?: string;
}

/** Campo del mock (`.inp`). Con `leading`/`trailing` se envuelve solo y reserva su hueco. */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, leading, trailing, fieldSize = 'md', invalid, wrapperClassName, ...props }, ref) => {
    const input = (
      <input
        type={type}
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          fieldSkin,
          'flex w-full px-3 py-1 file:border-0 file:bg-transparent file:text-sm file:font-medium',
          fieldSize === 'sm' ? 'h-8 text-[13px]' : 'h-9',
          leading != null && 'pl-9',
          trailing != null && 'pr-9',
          className,
        )}
        {...props}
      />
    );
    if (leading == null && trailing == null) return input;
    return (
      <div className={cn('relative w-full', wrapperClassName)}>
        {leading != null && (
          <span className="pointer-events-none absolute inset-y-0 left-0 flex w-9 items-center justify-center text-[12.5px] text-faint [&_svg]:size-4">
            {leading}
          </span>
        )}
        {input}
        {trailing != null && (
          <span className="pointer-events-none absolute inset-y-0 right-0 flex min-w-9 items-center justify-center px-1 text-[12.5px] text-faint [&>*]:pointer-events-auto [&_svg]:size-4">
            {trailing}
          </span>
        )}
      </div>
    );
  },
);
Input.displayName = 'Input';

export { Input };
