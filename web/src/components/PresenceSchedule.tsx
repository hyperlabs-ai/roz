import { CalendarDays } from 'lucide-react';
import { TooltipContent } from '@/components/ui/tooltip';
import { clockTime } from '@/components/PresencePanel';
import { cn } from '@/lib/utils';
import type { DevPresence } from '@/lib/api';

/**
 * Desglose horario del resto del día, para el hover del panel de presencia.
 *
 * Existe porque el resumen colapsa las juntas pegadas: "Ocupado hasta 15:00" es la respuesta
 * correcta a "¿puedo interrumpirlo?", pero esconde que en realidad son tres bloques distintos. Aquí
 * se ven las horas exactas, que es lo que hace falta para agendar algo con esa persona.
 *
 * Sigue el molde de `HyperTooltip`: sobreescribe el estilo compacto del tooltip base porque esto es
 * contenido, no una etiqueta.
 */
export function PresenceSchedule({ presence }: { presence: DevPresence }) {
  const { upcoming } = presence;

  return (
    <TooltipContent
      side="bottom"
      align="start"
      className="max-w-[19rem] rounded-lg border bg-popover p-3 text-left font-normal text-popover-foreground shadow-lg"
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <CalendarDays className="size-3.5 text-muted-foreground" /> Próximas 24 h
      </div>

      {!upcoming.length ? (
        <p className="mt-1.5 text-xs text-muted-foreground">Sin eventos por delante.</p>
      ) : (
        <div className="mt-2 overflow-hidden rounded-md border">
          {upcoming.map((b, i) => (
            <div
              key={`${b.startsAt}-${i}`}
              className={cn(
                'flex items-start gap-2.5 px-2.5 py-1.5 text-[11px]',
                i % 2 === 0 && 'bg-muted/50',
                // El bloque en curso se distingue: separa "esto" de "lo que viene", que es la
                // diferencia que importa al mirar el horario.
                b.current && 'bg-warning/10',
              )}
            >
              <span
                className={cn(
                  'shrink-0 font-mono tabular-nums',
                  b.current ? 'font-semibold text-warning' : 'text-muted-foreground',
                )}
              >
                {clockTime(b.startsAt)}–{clockTime(b.endsAt)}
              </span>
              <span className="min-w-0 break-words leading-snug">{b.title ?? 'Sin título'}</span>
            </div>
          ))}
        </div>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/70">
        Horario en tu zona. Los eventos de todo el día y los marcados «Disponible» no cuentan.
      </p>
    </TooltipContent>
  );
}
