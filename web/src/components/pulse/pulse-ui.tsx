import { tokenColor, type BrandColor, type Presence } from '@/components/brand';
import type { BadgeVariant } from '@/components/ui/badge';
import type { PersonState } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Piezas visuales propias del Pulso (mock "Pulso del equipo"). Solo presentación: los datos llegan
 * tal cual del backend y aquí se decide color, chip y forma.
 */

/** Estado de la persona → chip del mock + punto de presencia del avatar. */
export const PERSON_STATE: Record<PersonState, { label: string; chip: BadgeVariant; presence: Presence }> = {
  activo: { label: 'Activo', chip: 'ok', presence: 'on' },
  ocupado: { label: 'Ocupado', chip: 'human', presence: 'meet' },
  inactivo: { label: 'Inactivo', chip: 'neutral', presence: 'off' },
  fuera: { label: 'Fuera', chip: 'secondary', presence: 'off' },
};

/**
 * Color de cada persona (borde de "ahora", sparkline, avance del ciclo). Sale de un hash del id para
 * que no cambie cuando el backend reordena las tarjetas por actividad.
 */
const PERSON_COLORS: BrandColor[] = ['orange', 'purple-deep', 'green', 'yellow', 'chart-5', 'salmon', 'purple', 'ink'];
export function personColor(devId: string): BrandColor {
  let h = 0;
  for (let i = 0; i < devId.length; i++) h = (h * 31 + devId.charCodeAt(i)) >>> 0;
  return PERSON_COLORS[h % PERSON_COLORS.length]!;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** Número de semana ISO de un día YYYY-MM-DD. */
export function isoWeek(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  const dow = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dow + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round((t.getTime() - firstThu.getTime()) / 604_800_000 - ((firstThu.getUTCDay() + 6) % 7 - 3) / 7);
}

/**
 * Sparkline del mock (`polyline` de 84×22): la línea sola en el color de la persona. Sin actividad
 * se dibuja plana abajo en tinta tenue, para que la tarjeta no salte de alto.
 */
export function Spark({
  values,
  color,
  width = 84,
  height = 22,
  className,
}: {
  values: number[];
  color: BrandColor;
  width?: number;
  height?: number;
  className?: string;
}) {
  const max = Math.max(0, ...values);
  const n = values.length;
  const pad = 2;
  const pts = values
    .map((v, i) => {
      const x = n <= 1 ? 0 : (i / (n - 1)) * width;
      const y = max === 0 ? height - pad : height - pad - (v / max) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className={cn('shrink-0 overflow-visible', className)}>
      <polyline
        points={pts}
        fill="none"
        stroke={max === 0 ? tokenColor('toggle-off') : tokenColor(color)}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Punto que late (`.pulse` del mock): agente trabajando, feed conectado. */
export function PulseDot({ className, still = false }: { className?: string; still?: boolean }) {
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-full', !still && 'animate-pulse', className)} />;
}
