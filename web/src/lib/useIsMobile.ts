import { useEffect, useState } from 'react';

// Mismo corte que el breakpoint `sm` de Tailwind, para que lo que decide JS y lo que decide CSS no
// se contradigan a mitad de camino.
const QUERY = '(max-width: 639px)';

/** ¿Viewport de móvil? Reactivo: responde a rotaciones y a cambios de tamaño de la ventana. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    onChange();
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
