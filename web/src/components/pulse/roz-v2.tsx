import type { ReactNode } from 'react';
import { ExternalLink, Unplug } from 'lucide-react';
import { EmptyState } from '@/components/bits';
import { Card } from '@/components/ui/card';
import { useApi } from '@/lib/useApi';
import { ApiError, rozV2Api, type RozV2Status } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Piezas compartidas de las pantallas de roz v2 (Pulso, Juntas, Planes, Tareas en solo lectura).
 *
 * `useRozV2` lee `/roz-v2/status` una vez por sesión (TTL largo: es configuración del servidor, no
 * cambia sin un redeploy). Mientras no responde, `ready` es false y quien decide la pantalla
 * principal espera en vez de pintar la equivocada y saltar. Si el backend aún no tiene el endpoint
 * (deploy viejo) o falla, se asume TODO apagado: roz se ve exactamente como antes.
 */
const OFF: RozV2Status = { linearSourceOfTruth: false, linearConfigured: false, granolaEnabled: false };

export function useRozV2(): RozV2Status & { ready: boolean } {
  const { data, error } = useApi<RozV2Status>(() => rozV2Api.status(), [], { key: '/roz-v2/status', ttl: 600_000 });
  if (data) return { ...data, ready: true };
  return { ...OFF, ready: error !== null };
}

/** ¿El error es el 409 de "roz v2 apagado"? Las pantallas lo pintan como estado vacío, no como falla. */
export function isSotOff(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'LINEAR_SOT_OFF';
}

/** Estado vacío de una sección de roz v2 con el flag apagado. */
export function V2OffState({ what }: { what: string }) {
  return (
    <Card>
      <EmptyState icon={<Unplug />}>
        {what} viven con Linear como fuente de verdad, y en este entorno está apagado
        (<span className="font-mono text-xs">ROZ_LINEAR_SOT</span>). Cuando se encienda, aparecerán aquí.
      </EmptyState>
    </Card>
  );
}

/** Control segmentado del mock (`.seg`): pista gris, segmento activo blanco con sombra leve. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: string; icon?: ReactNode; count?: number }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div role="group" className={cn('inline-flex items-center rounded-md bg-panel p-[3px]', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            'flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-[12.5px] transition-colors [&_svg]:size-3.5',
            value === o.value
              ? 'bg-card font-semibold text-foreground shadow-sm'
              : 'font-medium text-muted-foreground hover:text-foreground',
          )}
        >
          {o.icon}
          {o.label}
          {o.count != null && o.count > 0 && (
            <span className="text-[10.5px] tabular-nums text-faint">{o.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Link externo discreto (Linear, GitHub, PR). */
export function ExtLink({ href, children, className }: { href: string | null; children: ReactNode; className?: string }) {
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => e.stopPropagation()}
      className={cn('inline-flex min-w-0 items-center gap-1 hover:text-primary hover:underline', className)}
    >
      {children}
      <ExternalLink className="size-3 shrink-0 opacity-60" />
    </a>
  );
}
