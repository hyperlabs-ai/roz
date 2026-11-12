import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Botón estilo Stape (identidad roz v2): Inter Tight 600, MAYÚSCULAS, tracking abierto y radio de 4px.
 *
 *  · default     — verde, el CTA principal ("Ver la consola", "Guardar")
 *  · brand       — naranja roz, para la acción de marca de una pantalla (una por vista)
 *  · secondary   — gris cálido (panel), acción secundaria
 *  · dark        — tinta, acción fuerte/irreversible sin ser destructiva
 *  · outline     — hairline sobre tarjeta
 *  · destructive — rojo
 *  · ghost/link  — texto normal (sans, sin mayúsculas): iconos, menús, acciones en línea
 */
const CAPS = 'rounded-btn text-[12px] font-semibold uppercase tracking-[0.05em]';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-200 ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 active:scale-[0.97] [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:transition-transform',
  {
    variants: {
      variant: {
        default: cn(CAPS, 'bg-green text-white hover:bg-green/90'),
        brand: cn(CAPS, 'bg-primary text-primary-foreground hover:bg-primary/90'),
        secondary: cn(CAPS, 'bg-panel text-foreground hover:bg-toggle-off/70'),
        dark: cn(CAPS, 'bg-ink text-ink-foreground hover:bg-ink/85'),
        outline: cn(CAPS, 'border border-border bg-card text-foreground hover:bg-panel'),
        destructive: cn(CAPS, 'bg-destructive text-destructive-foreground hover:bg-destructive/90'),
        ghost: 'rounded-md text-sm font-medium hover:bg-panel hover:text-foreground',
        link: 'rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3',
        lg: 'h-11 px-5',
        icon: 'h-9 w-9',
        'icon-sm': 'h-8 w-8',
      },
    },
    compoundVariants: [
      // Las mayúsculas se leen grandes: en `sm` baja un punto para que quepa en filas densas.
      { variant: ['default', 'brand', 'secondary', 'dark', 'outline', 'destructive'], size: 'sm', className: 'text-[11px]' },
      { variant: ['default', 'brand', 'secondary', 'dark', 'outline', 'destructive'], size: 'lg', className: 'text-[12.5px]' },
      { variant: ['ghost', 'link'], size: 'sm', className: 'text-xs' },
    ],
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
