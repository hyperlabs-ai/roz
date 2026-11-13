import * as React from 'react';
import { cn } from '@/lib/utils';

/** Token de color para el canto de una tarjeta `neon` o con `tone` (`'green'`, `'purple-deep'`, `'chart-5'`…). */
type CardTone = string;

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Superficie clicable: elevación + sombra + borde acentuado al hover, y feedback de presión. */
  interactive?: boolean;
  /**
   * · `default` — tarjeta de siempre: hairline + un velo de luz casi imperceptible.
   * · `glass`   — vidrio: SOLO para lo que flota sobre un lienzo o una imagen (hay algo que desenfocar).
   * · `stage`   — rejilla de puntos + resplandor: el bloque protagonista de una pantalla.
   * · `neon`    — canto y halo de color: lo seleccionado o lo que pide atención. Una por pantalla.
   */
  variant?: 'default' | 'glass' | 'stage' | 'neon';
  /** Color del canto/resplandor (nombre de token). En `default` pinta solo una línea de luz arriba. */
  tone?: CardTone;
}

/**
 * Tarjeta: blanca (negro cálido en oscuro), hairline cálida y radio 10px. La separación sigue siendo
 * por borde; encima lleva la superficie del lenguaje "instrumento" (`.surface`: velo de luz + canto
 * interior), que en claro apenas se nota y en oscuro le da volumen. Para un bloque gris numerado usa
 * `Panel` de `@/components/brand`.
 */
const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, interactive, variant = 'default', tone, style, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'min-w-0 rounded-lg text-card-foreground',
      variant === 'glass' ? 'glass' : 'surface border bg-card',
      variant === 'stage' && 'stage',
      variant === 'neon' && 'neon',
      variant === 'default' && tone && 'edge-glow',
      interactive && 'hover-lift press cursor-pointer hover:border-foreground/20 hover:shadow-md',
      className,
    )}
    style={tone ? ({ '--neon': `var(--${tone})`, '--glow': `var(--${tone})`, ...style } as React.CSSProperties) : style}
    {...props}
  />
));
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex flex-col space-y-1.5 p-4 sm:p-5', className)} {...props} />
));
CardHeader.displayName = 'CardHeader';

/** Título de tarjeta: 14px semibold, como `.ct` del mock. */
const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('text-sm font-semibold leading-tight tracking-[-0.01em]', className)} {...props} />
));
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('text-xs text-muted-foreground', className)} {...props} />
));
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('p-4 pt-0 sm:p-5 sm:pt-0', className)} {...props} />
));
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex items-center p-4 pt-0 sm:p-5 sm:pt-0', className)} {...props} />
));
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
