// Instrumentos del tablero del mapa: los módulos de vidrio que flotan sobre el lienzo. Cada uno dice
// UNA cosa con una forma propia (columnas, anillo, matriz de puntos, línea de tiempo) en vez de otra
// lista de filas. Siguen el patrón de tarjetas anidadas del dashboard de Orwel y salen de tokens,
// así que respetan el tema de roz.
import type { CSSProperties, ReactNode } from 'react';
import { ChevronRight, Pin } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Tone } from './zeus-ui';

/** `fill-purple-deep` → `--purple-deep`: el token detrás de un tono, para estilos en línea. */
export const toneVar = (tone: Tone | undefined): string => `--${(tone?.fill ?? 'fill-faint').replace(/^fill-/, '')}`;
const hsl = (token: string, alpha = 1): string => (alpha >= 1 ? `hsl(var(${token}))` : `hsl(var(${token}) / ${alpha})`);

/**
 * Módulo del tablero, con el patrón de tarjetas anidadas del dashboard de Orwel: un marco tintado
 * (`bg-panel`, 4px de aire) que guarda una cabecera blanca (título, línea de apoyo e ícono en su
 * cuadro) y el cuerpo en otra tarjeta blanca; debajo, si hace falta, un pie con texto chico.
 */
export function HudCard({
  title,
  sub,
  icon,
  meta,
  footer,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('flex min-h-0 flex-col gap-1 rounded-[18px] border bg-panel p-1 shadow-sm', className)}>
      {title != null && (
        <header className="flex shrink-0 items-center justify-between gap-2 rounded-2xl border bg-card px-3 py-2.5 shadow-sm">
          <div className="grid min-w-0 gap-0.5">
            <h3 className="truncate text-sm font-medium tracking-tight">{title}</h3>
            {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {meta}
            {icon && <IconHolder>{icon}</IconHolder>}
          </div>
        </header>
      )}
      <div className={cn('flex min-h-0 flex-1 flex-col rounded-2xl border bg-card p-3 shadow-sm', bodyClassName)}>{children}</div>
      {footer && <footer className="flex shrink-0 items-center justify-between gap-2 px-3 py-1 text-xs text-muted-foreground">{footer}</footer>}
    </section>
  );
}

/** Ícono en su cuadro tintado, como el IconHolder de Orwel. */
export function IconHolder({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('grid size-8 shrink-0 place-items-center rounded-xl border bg-panel text-muted-foreground shadow-sm [&_svg]:size-4', className)}>{children}</span>;
}

/** Cifra del tablero: etiqueta chica, valor grande e ícono, dentro de su propio marco. */
export function Metric({ label, value, icon, accent }: { label: string; value: ReactNode; icon: ReactNode; accent?: boolean }) {
  return (
    <div className="rounded-[16px] border bg-panel p-1 shadow-sm">
      <div className="flex items-center justify-between gap-2 rounded-xl border bg-card px-3 py-2.5 shadow-sm">
        <div className="grid min-w-0 gap-0.5">
          <span className="truncate text-xs font-medium tracking-tight text-muted-foreground">{label}</span>
          <span className={cn('text-xl font-bold tabular-nums tracking-tight', accent && 'text-orange')}>{value}</span>
        </div>
        <IconHolder className={accent ? 'bg-orange-soft text-orange' : undefined}>{icon}</IconHolder>
      </div>
    </div>
  );
}

export interface SkylineItem {
  id: string;
  label: string;
  count: number;
  tone: Tone;
}

/**
 * El nivel de un vistazo: una columna por zona, alta según lo que contiene. Es el mismo dato que las
 * losas del isométrico, visto de frente. Pasar por una columna enciende su zona; clic entra.
 */
export function Skyline({ items, hot, onHover, onOpen }: { items: SkylineItem[]; hot: string | null; onHover: (id: string | null) => void; onOpen: (id: string) => void }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="zeus-skyline flex h-[92px] items-end gap-1" role="list" aria-label="Tamaño de cada zona">
      {items.map((it) => {
        const token = toneVar(it.tone);
        const on = hot === it.id;
        // Raíz cuadrada: una zona de 2 no desaparece junto a una de 126.
        const h = Math.max(8, Math.round(Math.sqrt(it.count / max) * 100));
        return (
          <button
            key={it.id}
            type="button"
            role="listitem"
            title={`${it.label}: ${it.count}`}
            aria-label={`${it.label}, ${it.count} entradas`}
            onClick={() => onOpen(it.id)}
            onPointerEnter={() => onHover(it.id)}
            onPointerLeave={() => onHover(null)}
            onFocus={() => onHover(it.id)}
            onBlur={() => onHover(null)}
            className="group/col flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className={cn('text-[10px] font-semibold tabular-nums transition-colors', on ? 'text-foreground' : 'text-faint group-hover/col:text-foreground')}>{it.count}</span>
            <span
              className="zeus-column w-full rounded-t-[3px]"
              data-on={on || undefined}
              style={{ height: `${h}%`, '--c': `var(${token})` } as CSSProperties}
            />
          </button>
        );
      })}
    </div>
  );
}

/** Fila con guía punteada entre el nombre y la cifra, como un índice impreso. */
export function LeaderRow({
  tone,
  label,
  sub,
  value,
  pinned,
  diamond,
  active,
  chevron,
  onClick,
  onHover,
}: {
  tone: Tone;
  label: string;
  sub?: string;
  value?: ReactNode;
  pinned?: boolean;
  diamond?: boolean;
  active?: boolean;
  chevron?: boolean;
  onClick: () => void;
  onHover?: (on: boolean) => void;
}) {
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={onClick}
        aria-current={active || undefined}
        data-on={active || undefined}
        onPointerEnter={onHover && (() => onHover(true))}
        onPointerLeave={onHover && (() => onHover(false))}
        onFocus={onHover && (() => onHover(true))}
        onBlur={onHover && (() => onHover(false))}
        style={{ '--c': `var(${toneVar(tone)})` } as CSSProperties}
        className="zeus-leader-row group/row relative flex w-full items-baseline gap-2 rounded-md py-[7px] pl-3 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn('relative top-[-1px] size-[7px] shrink-0 self-center', diamond ? 'rotate-45 rounded-[1px]' : 'rounded-full')} style={{ background: hsl(toneVar(tone)) }} />
        <span className="grid min-w-0 shrink">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px] font-medium leading-tight">{label}</span>
            {pinned && <Pin className="size-3 shrink-0 text-orange" aria-label="Fijada" />}
          </span>
          {sub && <span className="truncate text-[11px] leading-tight text-muted-foreground">{sub}</span>}
        </span>
        {value != null && <span className="zeus-leader" aria-hidden />}
        {value != null && <span className="shrink-0 text-[13px] font-semibold tabular-nums">{value}</span>}
        {chevron && <ChevronRight className="size-3.5 shrink-0 self-center text-faint transition-transform group-hover/row:translate-x-0.5 group-hover/row:text-foreground" />}
      </button>
    </li>
  );
}

export interface MixPart {
  label: string;
  value: number;
  /** Token CSS del color (`--green`). */
  token: string;
}

/**
 * Composición de un conjunto como matriz de puntos: cada parte ocupa los puntos que le tocan de 54, y
 * debajo va su cifra con guía punteada. Dice la mezcla sin dibujar un pastel ni una barra.
 */
export function Mix({ parts }: { parts: MixPart[] }) {
  const N = 54;
  const sum = parts.reduce((t, x) => t + x.value, 0);
  // Reparto por mayor resto, con un punto garantizado para toda parte que no sea cero: 1 de 286 no
  // debe desaparecer.
  const raw = parts.map((x) => (sum ? (x.value / sum) * N : 0));
  const dots = raw.map((r, i) => (parts[i]!.value ? Math.max(1, Math.floor(r)) : 0));
  for (let guard = 0; sum && guard < N * 2; guard++) {
    const total = dots.reduce((t, x) => t + x, 0);
    if (total === N) break;
    const pick = (cmp: (i: number, j: number) => boolean) => dots.reduce((best, _, i) => (parts[i]!.value && (best < 0 || cmp(i, best)) ? i : best), -1);
    if (total < N) dots[pick((i, j) => raw[i]! - dots[i]! > raw[j]! - dots[j]!)]!++;
    else dots[pick((i, j) => dots[i]! > 1 && (dots[j]! <= 1 || raw[i]! - dots[i]! < raw[j]! - dots[j]!))]!--;
  }
  const cells: string[] = [];
  dots.forEach((n, i) => {
    for (let k = 0; k < n; k++) cells.push(parts[i]!.token);
  });
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-[repeat(18,minmax(0,1fr))] gap-[5px]" aria-hidden>
        {Array.from({ length: N }, (_, i) => {
          const token = cells[i];
          return <span key={i} className="aspect-square rounded-[2px]" style={{ background: token ? hsl(token) : hsl('--foreground', 0.1) }} />;
        })}
      </div>
      <ul className="grid gap-[7px]">
        {parts.map((x) => (
          <li key={x.label} className={cn('flex items-baseline gap-2 text-[12.5px]', x.value === 0 && 'text-faint')}>
            <span className="size-[7px] shrink-0 self-center rounded-[2px]" style={{ background: hsl(x.token), opacity: x.value ? 1 : 0.4 }} />
            <span className="truncate">{x.label}</span>
            <span className="zeus-leader" aria-hidden />
            <span className="font-semibold tabular-nums">{x.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Matriz de puntos para una proporción entre dos partes: cuántos de cada 36 son A. Se lee la mezcla
 * sin dibujar una barra.
 */
export function Waffle({ a, b }: { a: { label: string; value: number; token: string }; b: { label: string; value: number; token: string } }) {
  const N = 36;
  const sum = a.value + b.value;
  // Si hay algo de A o de B, se le garantiza al menos un punto: un 1 de 286 no debe desaparecer.
  let na = sum ? Math.round((a.value / sum) * N) : 0;
  if (a.value && na === 0) na = 1;
  if (b.value && na === N) na = N - 1;
  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-[repeat(18,minmax(0,1fr))] gap-[5px]" aria-hidden>
        {Array.from({ length: N }, (_, i) => {
          const on = sum > 0;
          const token = i < na ? a.token : b.token;
          return (
            <span
              key={i}
              className="aspect-square rounded-full"
              style={{ background: on ? hsl(token) : hsl('--foreground', 0.1) }}
            />
          );
        })}
      </div>
      <div className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <b className="font-semibold tabular-nums" style={{ color: hsl(a.token) }}>{a.value}</b>
          <span className="truncate text-muted-foreground">{a.label}</span>
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-muted-foreground">{b.label}</span>
          <b className="font-semibold tabular-nums" style={{ color: hsl(b.token) }}>{b.value}</b>
        </span>
      </div>
    </div>
  );
}

/** Conexiones de una entrada como puntitos: 7 puntos = "muchas", sin escribir otra cifra suelta. */
export function Pips({ n, max = 7, token = '--orange' }: { n: number; max?: number; token?: string }) {
  return (
    <span className="flex shrink-0 items-center gap-[3px]" aria-label={`${n} conexiones`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className="size-[5px] rounded-full" style={{ background: i < n ? hsl(token) : hsl('--foreground', 0.14) }} />
      ))}
    </span>
  );
}

/** Línea de tiempo con riel punteado y un nodo por evento; el primero late. */
export function Timeline({ children, className }: { children: ReactNode; className?: string }) {
  return <ol className={cn('zeus-timeline grid content-start', className)}>{children}</ol>;
}

export function TimelineItem({ token = '--orange', live, children }: { token?: string; live?: boolean; children: ReactNode }) {
  return (
    <li className="zeus-tick relative grid gap-0.5 pb-3 pl-5 last:pb-0">
      <span className={cn('absolute left-[2px] top-[5px] size-[7px] rounded-full', live && 'zeus-beat')} style={{ background: hsl(token) }} />
      {children}
    </li>
  );
}
