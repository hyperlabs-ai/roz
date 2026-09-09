import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

const Tabs = TabsPrimitive.Root;

/**
 * Lista de tabs con píldora deslizante (receta `16-tabs-sliding` de transitions.dev).
 *
 * Antes el resaltado era `data-[state=active]:bg-background` en cada disparador: al cambiar de
 * pestaña el fondo desaparecía de una y aparecía en la otra, así que no se leía como "la selección
 * se movió" sino como dos cosas distintas prendiéndose. Aquí hay UNA píldora absoluta que viaja.
 *
 * Se mide en el DOM porque Radix no le avisa a la lista cuando cambia el valor (el estado vive en
 * el Root y solo los disparadores lo reciben). El atributo `data-state` sí cambia, y eso es
 * observable: un MutationObserver sobre él es más barato y menos frágil que levantar el estado a
 * cada llamador.
 */
const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, children, ...props }, forwardedRef) => {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const [pill, setPill] = React.useState<{ left: number; width: number } | null>(null);

  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [forwardedRef],
  );

  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const active = list.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
      // `offsetLeft` es relativo al ancestro posicionado, que es la lista (`relative`).
      setPill(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    };
    measure();
    const mo = new MutationObserver(measure);
    mo.observe(list, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
    // Sin esto la píldora queda desfasada al cambiar el ancho (responsive, fuente que carga tarde).
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, []);

  return (
    <TabsPrimitive.List
      ref={setRefs}
      className={cn(
        'relative inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground',
        className,
      )}
      {...props}
    >
      {pill && (
        // `transition` solo sobre left/width: animar `transform` obligaría a conocer el ancho de
        // destino de antemano. El primer render ya llega con la píldora en su sitio (la medición es
        // en `useLayoutEffect`), así que no se ve viajar desde el borde izquierdo al montar.
        <span
          aria-hidden
          className="absolute bottom-1 top-1 rounded-md bg-background shadow-sm transition-[left,width] duration-fast ease-spring"
          style={{ left: pill.left, width: pill.width }}
        />
      )}
      {children}
    </TabsPrimitive.List>
  );
});
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      // `relative z-10` para quedar por encima de la píldora; el fondo y la sombra del activo ya
      // los pinta ella, así que aquí solo cambia el color del texto.
      'relative z-10 inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-colors duration-fast ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground [&_svg]:size-4',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn('mt-2 focus-visible:outline-none', className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
