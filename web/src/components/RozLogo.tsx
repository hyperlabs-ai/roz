import { cn } from '@/lib/utils';

/**
 * Logo de roz v2: el monograma «rz» (la «r» y la «z» en un solo trazo continuo, como una firma)
 * en blanco sobre el cuadrado redondeado naranja. Lo eligió el usuario en la ronda 2 de identidad.
 * Vectorial y por token, así que es nítido a cualquier tamaño y sigue al naranja del tema. El tamaño
 * lo da `className` (p. ej. size-7). `wordmark` añade "roz" al lado.
 *
 * Los PNG del favicon y de la PWA (web/public/roz.png, icon-*.png, apple-touch-icon.png,
 * favicon.svg, brand/roz-logo.svg) salen de este mismo trazo: si cambias la ruta aquí, regénéralos.
 */
export const ROZ_MONOGRAM_PATH = 'M12 34V21c0-5 3-7 8-7h15L19 34h17';

export function RozLogo({ className, wordmark = false }: { className?: string; wordmark?: boolean }) {
  const mark = (
    <svg viewBox="0 0 48 48" role="img" aria-label="roz" className={cn('shrink-0', !wordmark && className)}>
      <rect width="48" height="48" rx="12" className="fill-orange" />
      <path
        d={ROZ_MONOGRAM_PATH}
        className="stroke-white"
        strokeWidth="4.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
  if (!wordmark) return mark;
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn('inline-flex', className)}>{mark}</span>
      <span className="text-[21px] font-bold leading-none tracking-[-0.04em]">roz</span>
    </span>
  );
}
