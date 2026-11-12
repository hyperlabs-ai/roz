import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Chip redondeado (identidad roz v2). Fondo suave + texto del mismo tono, sin borde; `dot` antepone
 * un punto del color del texto (estado "vivo": conectado, a tiempo, bloqueado).
 *
 * Por TIPO de origen:  rule (regla determinista) · llm (agente/IA) · human (persona, juntas)
 * Por ESTADO:          ok · warn · bad · info · neutral
 * Los nombres viejos (default, secondary, success, warning, destructive, outline) siguen vivos
 * porque los usa toda la app; apuntan a los mismos colores.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none',
  {
    variants: {
      variant: {
        default: 'bg-panel text-foreground',
        neutral: 'bg-panel text-foreground',
        secondary: 'bg-panel text-muted-foreground',
        outline: 'text-foreground ring-1 ring-inset ring-border',
        brand: 'bg-primary text-primary-foreground',
        rule: 'bg-panel text-foreground',
        llm: 'bg-lavender text-purple-deep',
        human: 'bg-yellow-soft text-yellow-ink',
        ok: 'bg-green-soft text-green',
        success: 'bg-green-soft text-green',
        warn: 'bg-orange-soft text-orange-ink',
        warning: 'bg-orange-soft text-orange-ink',
        bad: 'bg-red-soft text-red',
        destructive: 'bg-red-soft text-red',
        info: 'bg-blue-soft text-blue-ink',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {
  /** Punto del color del texto antes de la etiqueta. */
  dot?: boolean;
}

const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(({ className, variant, dot, children, ...props }, ref) => (
  <div ref={ref} className={cn(badgeVariants({ variant }), className)} {...props}>
    {dot && <i aria-hidden className="inline-block size-[7px] shrink-0 rounded-full bg-current" />}
    {children}
  </div>
));
Badge.displayName = 'Badge';

/** Alias con el nombre del mock (`.chip`). Mismo componente. */
const Chip = Badge;

export { Badge, Chip, badgeVariants };
