// Carga por persona contra su capacidad: una COLUMNA vertical por persona (regla de forma de la
// app: nada de barras horizontales para comparar), con la línea del 100% como referencia.
//
// No usa `Columns` de charts.tsx porque esta gráfica necesita dos cosas que esa no tiene: el
// "hueco" de la capacidad dibujado detrás de cada columna (lo que le falta para llenarse se ve, no
// se calcula) y la línea del 100% que las columnas saturadas atraviesan. La forma (radio 8px, eje
// de dos referencias, valor impreso encima, avatar como etiqueta) es la misma receta.
import { tokenColor } from '@/components/brand';
import { PersonAvatar } from '@/components/avatars';
import type { CapacityDev } from '@/lib/api';
import { groupMeta, hoursLine, stateLabel } from './cells';

export function LoadChart({
  devs,
  onPick,
  height = 220,
}: {
  devs: CapacityDev[];
  onPick?: (dev: CapacityDev) => void;
  height?: number;
}) {
  const peak = Math.max(0, ...devs.map((d) => d.load.pct));
  // Techo con aire: 100% nunca toca el borde (su línea necesita etiqueta encima) y una columna
  // saturada deja sitio para su valor.
  const top = Math.max(125, Math.ceil((peak + 15) / 25) * 25);
  const y = (v: number) => `${(v / top) * 100}%`;

  return (
    <div>
      <div className="relative" style={{ height }}>
        {/* Referencia de la mitad: tenue, sin competir con la del 100%. */}
        <Tick at={y(50)} label="50%" />
        <div className="absolute bottom-0 left-9 right-0 border-t border-border" />

        <div className="absolute inset-y-0 left-10 right-0 flex items-end gap-1.5 sm:gap-2.5">
          {devs.map((d) => {
            const g = groupMeta(d);
            return (
              <button
                key={d.id}
                type="button"
                onClick={onPick ? () => onPick(d) : undefined}
                title={`${d.name}: ${d.load.pct}% · ${stateLabel(d)}\n${hoursLine(d)}`}
                className="group/col relative flex h-full min-w-0 flex-1 items-end justify-center rounded-md outline-none transition-colors hover:bg-sidebar focus-visible:ring-2 focus-visible:ring-ring"
              >
                {/* El hueco de la capacidad: lo que falta hasta el 100% se ve como pista gris. */}
                <span
                  aria-hidden
                  className="absolute bottom-0 left-1/2 w-full max-w-11 -translate-x-1/2 rounded-lg bg-panel"
                  style={{ height: y(100) }}
                />
                <span
                  className="relative w-full max-w-11 rounded-lg transition-[height] duration-slow ease-spring"
                  style={{ height: y(Math.max(d.load.pct, 0)), minHeight: d.load.pct > 0 ? 6 : 0, background: tokenColor(g.bar) }}
                >
                  <span className="absolute -top-[18px] left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold leading-none tabular-nums">
                    {d.load.pct}%
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {/* La línea de capacidad va ENCIMA de las columnas: una saturada la atraviesa y se ve. */}
        <div className="pointer-events-none absolute left-9 right-0 flex items-center" style={{ bottom: y(100) }}>
          <span className="flex-1 border-t-[1.5px] border-dashed border-foreground/45" />
        </div>
        <span
          className="pointer-events-none absolute left-0 w-8 translate-y-1/2 text-right text-[10px] font-semibold leading-none tabular-nums text-foreground"
          style={{ bottom: y(100) }}
        >
          100%
        </span>
      </div>

      {/* Etiquetas del eje: el mismo `flex-1` + `gap` que las columnas, para quedar alineadas. */}
      <div className="mt-2 flex gap-1.5 pl-10 sm:gap-2.5">
        {devs.map((d) => (
          <div key={d.id} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <PersonAvatar url={d.avatarUrl} id={d.id} name={d.name} className="size-6" />
            <span className="w-full truncate text-center text-[11px] leading-tight text-muted-foreground" title={d.name}>
              {d.name.split(' ')[0]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Tick({ at, label }: { at: string; label: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 flex translate-y-1/2 items-center gap-1" style={{ bottom: at }}>
      <span className="w-8 shrink-0 text-right text-[10px] leading-none tabular-nums text-faint">{label}</span>
      <span className="flex-1 border-t border-dashed border-border" />
    </div>
  );
}

/** Esqueleto de la gráfica: columnas de alturas variadas sobre la línea base. */
export function LoadChartSkeleton({ height = 220 }: { height?: number }) {
  const hs = [62, 88, 45, 100, 74, 30, 92, 58];
  return (
    <div aria-hidden>
      <div className="relative" style={{ height }}>
        <div className="absolute bottom-0 left-9 right-0 border-t border-border" />
        <div className="absolute inset-y-0 left-10 right-0 flex items-end gap-2.5">
          {hs.map((h, i) => (
            <div key={i} className="flex h-full flex-1 items-end justify-center">
              <div className="shimmer w-full max-w-11 rounded-lg bg-panel" style={{ height: `${h * 0.8}%` }} />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex gap-2.5 pl-10">
        {hs.map((_, i) => (
          <div key={i} className="flex flex-1 flex-col items-center gap-1">
            <div className="size-6 rounded-full bg-panel" />
            <div className="h-2.5 w-10 rounded bg-panel" />
          </div>
        ))}
      </div>
    </div>
  );
}
