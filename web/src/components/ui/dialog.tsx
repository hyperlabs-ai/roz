import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

/** Fondo del modal del mock: tinta translúcida con desenfoque. */
const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('t-overlay fixed inset-0 z-50 bg-scrim/45 backdrop-blur-[3px]', className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * Lo que el contenido le cuenta a su cabecera y a su pie:
 *  · `padded` — el contenido conserva su `p-6`, así que cabecera y pie tienen que salirse hasta los
 *    filos. Con `p-0` (layout propio) no se mueven.
 *  · `claimClose` — la cabecera avisa de que ELLA pinta la X, en su misma fila y centrada con el
 *    título; el contenido deja entonces de pintar la X flotante de la esquina.
 */
const DialogChrome = React.createContext<{ padded: boolean; claimClose: (() => () => void) | null }>({
  padded: false,
  claimClose: null,
});

const CLOSE_CLS =
  'grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-panel hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4';

/**
 * La X del modal como pieza suelta, para cabeceras hechas a mano: va EN EL FLUJO de la barra (un
 * `flex items-center`), así que queda centrada con lo que tenga al lado, mida lo que mida la barra.
 * Úsala junto con `<DialogContent showClose={false}>`.
 */
const DialogCloseButton = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Close ref={ref} className={cn(CLOSE_CLS, className)} {...props}>
    {children ?? <X />}
    <span className="sr-only">Cerrar</span>
  </DialogPrimitive.Close>
));
DialogCloseButton.displayName = 'DialogCloseButton';

export interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** `false` quita la X flotante: la cabecera propia pinta un `<DialogCloseButton />` en su fila. */
  showClose?: boolean;
}

/**
 * Modal del mock: tarjeta de radio 14px con cabecera separada por hairline y pie gris.
 *
 * El contenido conserva su `p-6 gap-4` de siempre (los ~20 diálogos de la app cuentan con él). La
 * cabecera y el pie llegan hasta los filos con márgenes negativos, y SOLO cuando el contenido tiene
 * ese padding: los diálogos que pasan `p-0` y arman su propio layout no se mueven. Eso lo decide
 * este componente y lo pasa por contexto — antes lo adivinaba un selector CSS y, cuando fallaba, la
 * hairline de la cabecera se salía del modal.
 *
 * Nunca es más alto ni más ancho que la ventana: si el contenido no cabe, hace scroll dentro y la
 * cabecera y el pie se quedan pegados arriba y abajo.
 */
const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  ({ className, children, showClose = true, ...props }, ref) => {
    const merged = cn(
      't-modal scroll-thin fixed left-[50%] top-[50%] z-50 grid max-h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-xl border bg-card p-6 text-card-foreground shadow-lg',
      className,
    );
    const padded = !/(^|\s)p-0(\s|$)/.test(merged);
    const [claims, setClaims] = React.useState(0);
    const claimClose = React.useCallback(() => {
      setClaims((n) => n + 1);
      return () => setClaims((n) => n - 1);
    }, []);
    const chrome = React.useMemo(() => ({ padded, claimClose }), [padded, claimClose]);

    return (
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content ref={ref} className={merged} {...props}>
          <DialogChrome.Provider value={chrome}>{children}</DialogChrome.Provider>
          {showClose && claims === 0 && <DialogCloseButton className="absolute right-3 top-3" />}
        </DialogPrimitive.Content>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

export interface DialogHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Etiqueta `label-caps` con cuadrito sobre el título. */
  eyebrow?: React.ReactNode;
  /** Acciones de la barra (menú, estado de guardado…): a la derecha, antes de la X y centradas con ella. */
  actions?: React.ReactNode;
}

/**
 * Cabecera: título a la izquierda; acciones y X a la derecha, en la MISMA fila y centradas en
 * vertical. La X ya no flota en una esquina con medidas propias, así que no puede quedar
 * descuadrada respecto de la barra.
 */
const DialogHeader = ({ className, eyebrow, actions, children, ...props }: DialogHeaderProps) => {
  const { padded, claimClose } = React.useContext(DialogChrome);
  React.useLayoutEffect(() => claimClose?.(), [claimClose]);
  return (
    <div
      className={cn(
        'flex items-center gap-3 text-left',
        padded && 'sticky -top-6 z-10 -mx-6 -mt-6 border-b bg-card px-6 pb-3.5 pt-4',
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        {children}
      </div>
      {(actions || claimClose) && (
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {claimClose && <DialogCloseButton className="-mr-1.5" />}
        </div>
      )}
    </div>
  );
};

/** Pie gris con las acciones (primaria a la derecha). En móvil los botones ocupan el ancho. */
const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => {
  const { padded } = React.useContext(DialogChrome);
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 border-t bg-sidebar sm:flex-row sm:items-center sm:justify-end',
        padded && 'sticky -bottom-6 z-10 -mx-6 -mb-6 mt-1 px-6 py-3.5',
        className,
      )}
      {...props}
    />
  );
};

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('text-xl font-semibold leading-tight tracking-[-0.03em]', className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog, DialogPortal, DialogOverlay, DialogClose, DialogCloseButton, DialogTrigger, DialogContent,
  DialogHeader, DialogFooter, DialogTitle, DialogDescription,
};
