import { useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ShellSlotsContext } from '@/components/AppShell';

/**
 * Encabezado de una página. Conserva la firma de siempre (`title`, `subtitle`, `actions`,
 * `children`) para que las 13 páginas no cambien, pero ya NO dibuja el chrome: eso vive en
 * `AppShell`, que es layout de ruta y permanece montado al navegar.
 *
 * Título y acciones se publican en el header por PORTAL. Se eligió portal y no "pasar el JSX por
 * contexto" porque `actions` es un elemento nuevo en cada render: meterlo en el estado del shell
 * costaría un commit extra por render y, con `actions` en las deps, un bucle. Con el portal el JSX
 * sigue viviendo en el árbol de ESTA página (así `usePeriod`, los `useApi` y los `setState` de sus
 * botones no se mueven de sitio) y solo se pinta en otro nodo del DOM.
 */
export function Layout({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const slots = useContext(ShellSlotsContext);

  if (!slots && import.meta.env.DEV) {
    // Único modo de fallo silencioso del diseño: un <Layout> fuera de <AppShell> pintaría la página
    // sin título en vez de romperse. Mejor gritarlo en dev.
    console.error('[Layout] se está renderizando fuera de <AppShell>: el título y las acciones no se verán.');
  }

  return (
    <>
      {slots?.title &&
        createPortal(
          <>
            <h1 className="truncate text-base font-semibold leading-tight tracking-tight md:text-lg">{title}</h1>
            {subtitle && <p className="truncate text-xs text-muted-foreground md:text-[13px]">{subtitle}</p>}
          </>,
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
