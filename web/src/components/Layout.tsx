import { useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ShellSlotsContext } from '@/components/AppShell';

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
 * Cabecera compacta: eyebrow (cuadrito + etiqueta `label-caps`; por defecto la sección del menú) y
 * el título. A propósito SIN descripción debajo: el usuario la quitó de todas las secciones. Si una
 * pantalla necesita contexto, va dentro del contenido, no en el header.
 */
export function Layout({
  title,
  eyebrow,
  icon,
  actions,
  children,
}: {
  title: string;
  /** Texto del eyebrow sobre el título. Por defecto, la sección del menú ("Visibilidad"…). */
  eyebrow?: ReactNode;
  /** Ícono a la izquierda del bloque de título (p. ej. `ProjectIcon` en el detalle de proyecto). */
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const slots = useContext(ShellSlotsContext);

  if (!slots && import.meta.env.DEV) {
    // Único modo de fallo silencioso del diseño: un <Layout> fuera de <AppShell> pintaría la página
    // sin título en vez de romperse. Mejor gritarlo en dev.
    console.error('[Layout] se está renderizando fuera de <AppShell>: el título y las acciones no se verán.');
  }

  const kicker = eyebrow ?? slots?.section;

  return (
    <>
      {slots?.title &&
        createPortal(
          <div className="flex min-w-0 items-center gap-3">
            {icon}
            <div className="grid min-w-0 gap-0.5 md:gap-1.5">
              {kicker && <span className="eyebrow hidden md:inline-flex">{kicker}</span>}
              <h1 className="truncate text-base font-semibold leading-tight tracking-[-0.02em] md:text-[22px] md:leading-[1.1] md:tracking-[-0.03em]">
                {title}
              </h1>
            </div>
          </div>,
          slots.title,
        )}
      {/* Las acciones se pintan dos veces (desktop en línea, móvil en su propia fila), igual que
          antes de partir el layout. */}
      {actions && slots?.actionsDesktop && createPortal(actions, slots.actionsDesktop)}
      {actions && slots?.actionsMobile && createPortal(actions, slots.actionsMobile)}
      {children}
    </>
  );
}
