import { useContext, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ShellSlotsContext } from '@/components/AppShell';
import { cn } from '@/lib/utils';

/**
 * Ancho del contenido de una página (ver DESIGN.md → "Marco"):
 *  · `full`    — todo el ancho disponible. Tableros, matrices, lienzos: zeus, Pulso, Tareas, Capacidad.
 *  · `wide`    — tope de 1680px, centrado. El default: rejillas de tarjetas que a 2400px se deshacen.
 *  · `reading` — tope de 1120px, centrado. Formularios y texto corrido.
 */
export type PageWidth = 'full' | 'wide' | 'reading';

const WIDTH: Record<Exclude<PageWidth, 'full'>, string> = {
  wide: 'max-w-[1680px]',
  reading: 'max-w-[1120px]',
};

/**
 * Encabezado de una página (`title`, `eyebrow`, `icon`, `actions`, `children`). NO dibuja el chrome:
 * eso vive en `AppShell`, que es layout de ruta y permanece montado al navegar.
 *
 * Título y acciones se publican en el header por PORTAL. Se eligió portal y no "pasar el JSX por
 * contexto" porque `actions` es un elemento nuevo en cada render: meterlo en el estado del shell
 * costaría un commit extra por render y, con `actions` en las deps, un bucle. Con el portal el JSX
 * sigue viviendo en el árbol de ESTA página (así `usePeriod`, los `useApi` y los `setState` de sus
 * botones no se mueven de sitio) y solo se pinta en otro nodo del DOM.
 *
 * Cabecera en UNA franja: eyebrow (cuadrito + etiqueta `label-caps`; por defecto la sección del
 * menú), separador y título, todo en la misma línea, con las acciones a la derecha. A propósito SIN
 * descripción: el usuario la quitó de todas las secciones. Si una pantalla necesita contexto, va
 * dentro del contenido, no en el header.
 */
export function Layout({
  title,
  eyebrow,
  icon,
  actions,
  width = 'wide',
  children,
}: {
  title: string;
  /** Texto del eyebrow junto al título. Por defecto, la sección del menú ("Visibilidad"…). */
  eyebrow?: ReactNode;
  /** Ícono a la izquierda del bloque de título (p. ej. `ProjectIcon` en el detalle de proyecto). */
  icon?: ReactNode;
  actions?: ReactNode;
  /** Ancho máximo del contenido. En las páginas a sangre (chat) no aplica. */
  width?: PageWidth;
  children: ReactNode;
}) {
  const slots = useContext(ShellSlotsContext);

  if (!slots && import.meta.env.DEV) {
    // Único modo de fallo silencioso del diseño: un <Layout> fuera de <AppShell> pintaría la página
    // sin título en vez de romperse. Mejor gritarlo en dev.
    console.error('[Layout] se está renderizando fuera de <AppShell>: el título y las acciones no se verán.');
  }

  // Título de la pestaña del navegador: la pantalla primero, que es lo que distingue dos pestañas.
  useEffect(() => {
    const prev = document.title;
    document.title = `${title} · roz`;
    return () => { document.title = prev; };
  }, [title]);

  const kicker = eyebrow ?? slots?.section;
  // A sangre (chat) la página gobierna su propio alto y ancho: un envoltorio rompería su `h-full`.
  const bounded = width !== 'full' && !slots?.fullBleed;

  return (
    <>
      {slots?.title &&
        createPortal(
          <div className="flex min-w-0 items-center gap-2.5">
            {icon}
            {kicker && (
              <>
                <span className="eyebrow hidden shrink-0 md:inline-flex">{kicker}</span>
                <span aria-hidden className="hidden text-toggle-off md:inline">/</span>
              </>
            )}
            <h1 className="truncate text-base font-semibold leading-tight tracking-[-0.02em] md:text-[15.5px]">
              {title}
            </h1>
          </div>,
          slots.title,
        )}
      {/* Las acciones se pintan dos veces (desktop en línea, móvil en su propia fila), igual que
          antes de partir el layout. */}
      {actions && slots?.actionsDesktop && createPortal(actions, slots.actionsDesktop)}
      {actions && slots?.actionsMobile && createPortal(actions, slots.actionsMobile)}
      {bounded ? <div className={cn('mx-auto w-full', WIDTH[width])}>{children}</div> : children}
    </>
  );
}
