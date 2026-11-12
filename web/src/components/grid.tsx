import { Children, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Rejilla balanceada: NUNCA deja una última fila con huecos (8 tarjetas en 3 columnas = 3+3+2 con
 * un hueco). Reglas en `src/DESIGN.md` → "Rejillas balanceadas".
 *
 * (Vive en `grid.tsx` y no en `layout.tsx` porque en Windows `layout.tsx` y `Layout.tsx` son el
 * mismo archivo.)
 */

/** Breakpoints de Tailwind, en orden. `base` = sin media query. */
export const GRID_BREAKPOINTS = ['base', 'sm', 'md', 'lg', 'xl'] as const;
export type GridBreakpoint = (typeof GRID_BREAKPOINTS)[number];
/** Máximo de columnas por breakpoint. Los que falten heredan del anterior. */
export type GridMax = Partial<Record<GridBreakpoint, number>>;

export interface BalancedLayout {
  /** Columnas de las filas llenas. */
  cols: number;
  /** Elementos de la última fila (= `cols` si todas las filas se llenan). */
  last: number;
  /** Pistas reales del grid: mcm(cols, last), para que la última fila se estire en partes iguales. */
  tracks: number;
  /** Span de un elemento de fila llena / de la última fila, en pistas. */
  span: number;
  lastSpan: number;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const lcm = (a: number, b: number) => (a * b) / gcd(a, b);

/**
 * Columnas para `n` elementos con como mucho `max` por fila:
 *
 *  1. `n <= max` → una sola fila de `n` (5 KPIs con max 5 → 5).
 *  2. Un divisor exacto de `n` entre `max` y `ceil(max/2)` que no agregue más de una fila extra
 *     (8 → 4+4, 6 → 3+3, 9 → 3+3+3).
 *  3. Si no hay, `max` o `max-1` columnas, la que deje la última fila menos vacía, y esa última
 *     fila se ESTIRA a ocupar todo el ancho (7 → 4+3, 5 con max 4 → 3+2, 10 → 4+4+2).
 */
export function balancedCols(n: number, max: number): number {
  const m = Math.max(1, Math.floor(max));
  if (n <= m) return Math.max(1, n);
  const rowLimit = Math.ceil(n / m) + 1;
  for (let c = m; c >= Math.max(2, Math.ceil(m / 2)); c--) {
    if (n % c === 0 && n / c <= rowLimit) return c;
  }
  if (m <= 2) return m;
  const deficit = (c: number) => (n % c === 0 ? 0 : c - (n % c));
  return deficit(m - 1) < deficit(m) ? m - 1 : m;
}

/** Disposición completa (columnas, última fila y spans) para `n` elementos con `max` por fila. */
export function balancedLayout(n: number, max: number): BalancedLayout {
  const cols = balancedCols(n, max);
  const last = n % cols === 0 ? cols : n % cols;
  const tracks = lcm(cols, last);
  return { cols, last, tracks, span: tracks / cols, lastSpan: tracks / last };
}

/** Rellena los breakpoints que faltan con el anterior (mobile-first). */
function resolveMax(max: GridMax): Record<GridBreakpoint, number> {
  let prev = max.base ?? 1;
  const out = {} as Record<GridBreakpoint, number>;
  for (const bp of GRID_BREAKPOINTS) {
    prev = max[bp] ?? prev;
    out[bp] = prev;
  }
  return out;
}

/**
 * Rejilla que elige sus columnas según CUÁNTOS hijos tiene, por breakpoint. Cada hijo va en una
 * celda que se estira a la altura de la fila (las tarjetas de una fila miden lo mismo).
 *
 * ```tsx
 * <BalancedGrid max={{ base: 2, md: 3, xl: 5 }}>{kpis}</BalancedGrid>
 * ```
 *
 * `max` es el tope de columnas por breakpoint (por defecto 1 → sm 2 → lg 4). Los hijos `null` /
 * `false` no cuentan. Para una lista larga y homogénea (más de ~12) usa una lista, no una rejilla.
 */
export function BalancedGrid({
  children,
  max = { base: 1, sm: 2, lg: 4 },
  className,
  itemClassName,
}: {
  children: ReactNode;
  max?: GridMax;
  /** Gap y demás; por defecto `gap-3`. */
  className?: string;
  itemClassName?: string;
}) {
  const items = Children.toArray(children);
  const n = items.length;
  const tops = resolveMax(max);
  const layouts = GRID_BREAKPOINTS.map((bp) => balancedLayout(n, tops[bp]));

  const gridVars: Record<string, number> = {};
  layouts.forEach((l, i) => { gridVars[`--bg-t${i}`] = l.tracks; });

  return (
    <div className={cn('bgrid gap-3', className)} style={gridVars as CSSProperties}>
      {items.map((child, idx) => {
        const vars: Record<string, number> = {};
        layouts.forEach((l, i) => {
          vars[`--bg-s${i}`] = idx >= n - l.last ? l.lastSpan : l.span;
        });
        return (
          <div key={(child as { key?: string | number | null }).key ?? idx} className={cn('bgrid-item', itemClassName)} style={vars as CSSProperties}>
            {child}
          </div>
        );
      })}
    </div>
  );
}
