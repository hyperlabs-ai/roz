// Logo de roz (PNG en web/public/roz.png). El tamaño lo da `className` (p. ej. size-8).
export function RozLogo({ className }: { className?: string }) {
  return <img src="/roz.png" alt="roz" className={className} draggable={false} />;
}
