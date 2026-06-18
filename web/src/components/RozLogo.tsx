import { GitPullRequest } from 'lucide-react';
import { cn } from '@/lib/utils';

// Logo de ROZ: icono de pull request de GitHub. ROZ vive alrededor del flujo de código
// (commits/PRs), así que el glyph de PR comunica de inmediato de qué va el producto.
export function RozLogo({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/70 text-primary-foreground',
        className,
      )}
    >
      <GitPullRequest className="size-[58%]" strokeWidth={2.4} />
    </div>
  );
}
