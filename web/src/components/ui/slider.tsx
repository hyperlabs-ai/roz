import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SliderProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'min' | 'max' | 'step'> {
  value: number;
  /** En cada movimiento (para pintar el número en vivo). */
  onValueChange?: (v: number) => void;
  /** Al soltar (ratón, dedo o teclado): aquí se guarda. */
  onValueCommit?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Clase de color del tramo lleno, p. ej. `text-orange` (se pinta con `currentColor`). */
  tone?: string;
}

/**
 * Deslizador. Es un `<input type="range">` nativo (teclado, lectores y táctil gratis) con la pista
 * pintada con un gradiente: lleno hasta el valor, gris después. Sin dependencia nueva.
 */
export const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ value, onValueChange, onValueCommit, min = 0, max = 100, step = 1, tone = 'text-orange', className, style, disabled, ...props }, ref) => {
    const pct = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0;
    const commit = (e: React.SyntheticEvent<HTMLInputElement>) => onValueCommit?.(Number(e.currentTarget.value));
    return (
      <input
        ref={ref}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange?.(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        style={{
          ...style,
          background: `linear-gradient(to right, currentColor ${pct}%, hsl(var(--toggle-off)) ${pct}%)`,
        }}
        className={cn(
          'h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none disabled:cursor-not-allowed disabled:opacity-50',
          '[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-[5px] [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-current [&::-webkit-slider-thumb]:bg-card [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:transition-transform hover:[&::-webkit-slider-thumb]:scale-110 active:[&::-webkit-slider-thumb]:scale-125',
          '[&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-[5px] [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-current [&::-moz-range-thumb]:bg-card',
          'focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:ring-offset-2 focus-visible:ring-offset-card',
          tone,
          className,
        )}
        {...props}
      />
    );
  },
);
Slider.displayName = 'Slider';
