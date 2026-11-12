import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Interruptor del mock (`.toggle`): pista naranja al encender y pulgar cuadrado-redondeado que
 * viaja con rebote (receta `27-toggle`, `.t-toggle` en styles.css). Sin dependencia nueva: un
 * botón con `role="switch"`, accesible por teclado.
 */
export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, className, disabled, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        't-toggle relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 [--toggle-travel:19px]',
        checked ? 'bg-orange' : 'bg-toggle-off',
        className,
      )}
      {...props}
    >
      {/* `t-toggle-thumb` mueve el pulgar con translateX: 3px de holgura a cada lado. */}
      <span className="t-toggle-thumb pointer-events-none absolute left-0 top-[2px] size-[18px] rounded-[4px] bg-white shadow-sm" />
    </button>
  ),
);
Switch.displayName = 'Switch';
