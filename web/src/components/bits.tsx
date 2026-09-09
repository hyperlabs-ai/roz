import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { compact, initials } from '@/lib/format';
import { STATE_LABEL, stateBadgeVariant, PRIO_DOT, DEV_PRESENCE } from '@/lib/labels';

// ---- Señales de carga y de cambio ----
// `useApi` siempre expuso `refetching`, pero solo Tareas lo consumía, así que en las otras doce
// secciones TODA revalidación era invisible: clic → toast → la pantalla igual un par de segundos →
// los datos cambian de golpe. Estas piezas son la señal que faltaba.

/**
 * Botón "Actualizar" estándar: gira mientras revalida y no admite un segundo clic.
 *
 * Al terminar, el icono se convierte en un check por un momento (recetas `09-icon-swap` +
 * `10-success-check`). Sin eso, "traer cambios" cuando no hay cambios era indistinguible de no
 * haber hecho clic: la flecha dejaba de girar y no pasaba nada más. El check responde "sí, fui, y
 * ya está al día".
 */
export function RefreshButton({
  onClick,
  busy,
  title = 'Traer cambios',
  className,
}: {
  onClick: () => void;
  busy?: boolean;
  title?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  const wasBusy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    // Solo en el flanco de bajada: `busy` arranca en false y sin esta guarda el check se vería al
    // montar la página, antes de que nadie haya pedido nada.
    if (wasBusy.current && !busy) {
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1_400);
    }
    wasBusy.current = !!busy;
  }, [busy]);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn('size-8 text-muted-foreground', done && 'text-success', className)}
      onClick={onClick}
      disabled={busy}
      title={title}
      aria-label="Actualizar"
    >
      <IconSwap
        state={done ? 'done' : 'idle'}
        icons={{
          idle: <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />,
          done: <SuccessCheck className="size-3.5" />,
        }}
      />
    </Button>
  );
}

/** Barra fina indeterminada: "esto que estás viendo se está actualizando". */
export function RefetchBar({ active, className }: { active: boolean; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'h-0.5 overflow-hidden rounded-full transition-opacity duration-200',
        active ? 'shimmer bg-muted opacity-100' : 'opacity-0',
        className,
      )}
    />
  );
}

/**
 * Envuelve un bloque cuyos datos van a cambiar por un filtro o un período: barra arriba y contenido
 * viejo atenuado. Es lo que arregla "leo los KPIs del filtro anterior sin saberlo".
 */
export function Revalidating({ active, children, className }: { active: boolean; children: ReactNode; className?: string }) {
  return (
    // El envoltorio es SOLO el ancla de la barra (`relative`, sin clases propias). `className` va al
    // div que contiene a los hijos, porque ahí es donde el llamador espera su layout: si las clases
    // se quedan en el envoltorio, un `grid` deja de aplicar a las tarjetas (se apilan en vertical) y
    // un `space-y-*` deja de separar los skeletons (se ven como un bloque sólido).
    <div className="relative">
      <RefetchBar active={active} className="absolute inset-x-0 -top-1" />
      <div className={cn('transition-opacity duration-200', active && 'pointer-events-none opacity-55', className)}>
        {children}
      </div>
    </div>
  );
}

/**
 * Resalta una entidad recién creada y la trae a la vista. Sin esto, en las páginas largas (Infra,
 * Developers) y en las listas ordenadas por métrica, lo que acabas de crear nace con cero commits
 * y aterriza fuera de pantalla: el toast dice "creado" y no ves nada.
 */
export function Fresh({ fresh, children, className }: { fresh: boolean; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  useEffect(() => {
    if (!fresh || scrolled.current) return;
    scrolled.current = true; // una sola vez: re-centrar en cada render sería marear al usuario
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [fresh]);
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-xl transition-[box-shadow] duration-1000 ease-spring',
        fresh && 'ring-2 ring-primary/60',
        className,
      )}
    >
      {children}
    </div>
  );
}

// ---- Micro-interacciones (transitions.dev) ----
// Las recetas viven en `styles.css` bajo clases `t-*`; esto son los envoltorios mínimos para
// usarlas desde JSX sin repetir el markup que cada una necesita.

/**
 * Varios iconos en la misma celda (receta `09-icon-swap`): el que sale colapsa y se desenfoca en
 * vez de desaparecer, lo que lee como "se convirtió en" y no como "otro icono apareció".
 *
 * Todos viven siempre en el DOM — es lo que permite que la transición ocurra. Acepta N estados y no
 * dos, porque el selector de tema tiene tres (claro / oscuro / sistema).
 */
export function IconSwap({
  state, icons, className,
}: {
  state: string;
  icons: Record<string, ReactNode>;
  className?: string;
}) {
  return (
    <span className={cn('t-icon-swap', className)}>
      {Object.entries(icons).map(([key, node]) => (
        <span key={key} className={cn('t-icon', key === state && 'is-on')}>{node}</span>
      ))}
    </span>
  );
}

/**
 * Check de confirmación (receta `10-success-check`): entra rotando y rebotando, y el trazo se
 * dibuja. Se usa donde una acción termina y no cambia nada visible en la pantalla — sin esto el
 * usuario no sabe si pasó algo.
 *
 * `hero` es la versión completa de la receta (40px de rebote, 80° de giro), para una confirmación
 * a pantalla completa. Por defecto va la compacta, que es la que cabe dentro de un botón.
 */
export function SuccessCheck({ hero = false, className }: { hero?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('t-check size-4', !hero && 't-check--inline', className)} fill="none" aria-hidden>
      <path
        className="t-check-path"
        d="M4 12.5 9.5 18 20 6.5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        // Normaliza el largo del trazo a 100 para que el `stroke-dasharray: 100` de la receta cubra
        // exactamente el path, sin tener que medirlo en unidades de usuario.
        pathLength={100}
      />
    </svg>
  );
}

/**
 * Colapsable que TWEENEA el alto (recetas `01-card-resize` / `21-accordion`).
 *
 * `grid-template-rows: 0fr → 1fr` es la única forma de animar "hasta el alto del contenido" sin
 * medirlo en JS ni fijar un `max-height` inventado que recorta cuando el contenido crece.
 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cn('t-collapse', className)} data-open={open ? 'true' : 'false'}>
      <div>{children}</div>
    </div>
  );
}

/**
 * Estado que se sostiene con shimmer (receta `28-thinking-states`).
 *
 * Para procesos largos del backend: mientras el texto respira, se lee "sigue trabajando"; si se
 * quedara quieto se leería "se colgó". `live=false` lo deja plano (proceso terminado).
 */
export function ThinkingText({ live, children, className }: { live: boolean; children: ReactNode; className?: string }) {
  return <span className={cn('t-think', live && 't-think-live', className)}>{children}</span>;
}

/** Matriz de puntos que barre (receta `31-matrix-loader`). Para "hay trabajo en curso" sin porcentaje. */
export function MatrixLoader({ className }: { className?: string }) {
  return (
    <span className={cn('t-matrix size-3', className)} aria-hidden>
      {Array.from({ length: 16 }, (_, i) => (
        // El desfase por índice es lo que produce el barrido diagonal en vez de un parpadeo al
        // unísono; va inline porque son 16 valores distintos y no justifican 16 clases.
        <span key={i} style={{ animationDelay: `${(i % 4) * 60 + Math.floor(i / 4) * 60}ms` }} />
      ))}
    </span>
  );
}

// ---- Barras y medidores ----

/**
 * Barra de progreso. `pct = null` = indeterminado (no se conoce el total).
 *
 * Antes había DOS: la de aquí animaba desde 0 al montar pero no sabía de indeterminado, y la de
 * `sync/SyncContext` sabía de indeterminado y de tono pero no animaba la entrada. Esta hace las
 * tres cosas.
 */
export function ProgressBar({
  pct, tone = 'primary', className, barClassName,
}: {
  pct: number | null;
  tone?: 'primary' | 'success' | 'warning' | 'destructive';
  className?: string;
  barClassName?: string;
}) {
  const [w, setW] = useState(0);
  useEffect(() => {
    if (pct == null) return;
    const r = requestAnimationFrame(() => setW(Math.max(0, Math.min(100, pct))));
    return () => cancelAnimationFrame(r);
  }, [pct]);
  const indeterminate = pct == null;
  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-muted', indeterminate && 'shimmer', className)}>
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-700 ease-spring',
          tone === 'success' && 'bg-success',
          tone === 'warning' && 'bg-warning',
          tone === 'destructive' && 'bg-destructive',
          tone === 'primary' && 'bg-primary',
          indeterminate && 'w-1/3 animate-pulse',
          barClassName,
        )}
        style={indeterminate ? undefined : { width: `${w}%` }}
      />
    </div>
  );
}

/*
 * Aquí vivía `Bar`, la barra proporcional horizontal. Se eliminó junto con las listas rankeadas:
 * la regla de forma de la app es que una comparación entre categorías se dibuja con COLUMNAS
 * verticales (`Columns` en charts.tsx). Dejar la primitiva era dejar la puerta abierta a que
 * volvieran; `ProgressBar` cubre el otro caso, que es progreso de UNA cosa, no comparación.
 */

/**
 * Medidor segmentado: N tramos, los primeros `value` llenos.
 *
 * Había tres versiones de esta idea (los dots del chip de skill, los cinco tramos del medidor de
 * skill y los seis de la cobertura). La opacidad creciente en los tramos llenos es lo que hace que
 * se lea como una escala y no como una barra troceada.
 */
export function SegmentMeter({
  value, max = 5, tone = 'primary', shape = 'bar', size, className,
}: {
  value: number;
  max?: number;
  tone?: 'primary' | 'success' | 'warning';
  /** `bar` = tramos que llenan el ancho; `dots` = puntos de tamaño fijo (listas densas). */
  shape?: 'bar' | 'dots';
  size?: string;
  className?: string;
}) {
  const lvl = Math.max(0, Math.min(max, value));
  const fill = tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : 'bg-primary';
  return (
    <div className={cn('flex', shape === 'dots' ? 'gap-0.5' : 'gap-1', className)}>
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <div
          key={n}
          className={cn(
            'rounded-full transition-colors duration-fast',
            n <= lvl ? fill : 'bg-muted',
            shape === 'dots' ? size ?? 'size-1.5' : cn('h-1.5 flex-1', size),
          )}
          style={n <= lvl ? { opacity: 0.45 + (n / max) * 0.55 } : undefined}
        />
      ))}
    </div>
  );
}

// ---- Avatares ----

/**
 * Avatar con indicador opcional de presencia (calendario conectado).
 *
 * El punto necesita un contenedor `relative`, pero varios llamadores le pasan a este componente
 * clases que asumen que el avatar ES el elemento (el `-space-x-1.5` de `AvatarStack`, los `ring-2`
 * de las tarjetas). Por eso solo se envuelve cuando de verdad hay algo que indicar: sin `presence`
 * el render queda idéntico al de siempre y ninguna vista existente se mueve.
 */
export function UserAvatar({
  url, name, className, title, presence, presenceTitle,
}: {
  url: string | null;
  name: string;
  className?: string;
  title?: string;
  presence?: 'busy' | 'free' | 'unknown';
  presenceTitle?: string;
}) {
  // Sin presencia: exactamente el render de siempre.
  if (!presence) {
    return (
      <Avatar className={className} title={title}>
        {url && <AvatarImage src={url} alt={name} />}
        <AvatarFallback>{initials(name)}</AvatarFallback>
      </Avatar>
    );
  }

  // Con presencia, `className` va SOLO al envoltorio y el avatar lo llena. Pasarlo a los dos
  // duplicaba el `ring-2` que mandan varias vistas (se veía un doble borde) y dejaba dos reglas de
  // tamaño peleando. El envoltorio lleva `rounded-full` para que ese anillo salga redondo.
  return (
    <span className={cn('relative inline-flex shrink-0 rounded-full', className)}>
      <Avatar className="size-full" title={title}>
        {url && <AvatarImage src={url} alt={name} />}
        <AvatarFallback>{initials(name)}</AvatarFallback>
      </Avatar>
      {/* `bottom-0 right-0`, no offsets negativos: el avatar es un círculo, y en la esquina de su
          caja el borde ya se curvó hacia dentro — un punto ahí flota separado, fuera del círculo.
          Pegado a la caja cae justo sobre el filo y se lee como insignia de estado. */}
      <span
        title={presenceTitle ?? DEV_PRESENCE[presence]?.label}
        className={cn(
          'absolute bottom-0 right-0 size-3 rounded-full ring-2 ring-background',
          DEV_PRESENCE[presence]?.dot ?? DEV_PRESENCE.unknown!.dot,
        )}
      />
    </span>
  );
}

/**
 * Avatares apilados de responsables (máx `max` visibles + "+N"). Vacío → no renderiza nada.
 *
 * `t-avatars` aplica la receta `11-avatar-group-hover`: el que apuntas sube y el vecino lo
 * acompaña una fracción (`--avatar-falloff`). Ese acompañamiento es lo que hace que la pila se
 * sienta como UN grupo y no como N botones pegados.
 */
export function AvatarStack({
  people, max = 3, size = 'size-5', className,
}: {
  people: { name: string; avatarUrl: string | null }[] | null | undefined;
  max?: number;
  size?: string;
  className?: string;
}) {
  // Tolera null/undefined a propósito: lo alimentan respuestas de la API desde muchas páginas, y
  // un campo ausente no debe tumbar el render entero (el ErrorBoundary es global).
  if (!people?.length) return null;
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <div className={cn('t-avatars flex -space-x-1.5', className)}>
      {shown.map((p, i) => (
        <UserAvatar key={i} url={p.avatarUrl} name={p.name} className={cn('t-avatar', size, 'ring-2 ring-background')} title={p.name} />
      ))}
      {extra > 0 && (
        <span className={cn('t-avatar grid place-items-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-background', size)} title={`+${extra} más`}>
          +{extra}
        </span>
      )}
    </div>
  );
}

// ---- Etiquetas y estados ----

export function StateBadge({ state }: { state: string }) {
  return <Badge variant={stateBadgeVariant(state)}>{STATE_LABEL[state] ?? state}</Badge>;
}

export function PriorityDot({ priority }: { priority: string | null }) {
  if (!priority) return <span className="size-2 rounded-full bg-muted" />;
  return <span className={cn('size-2 rounded-full', PRIO_DOT[priority] ?? 'bg-muted')} title={priority} />;
}

export function EmptyState({ icon, children, action }: { icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
      {icon && (
        <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">{icon}</div>
      )}
      <span className="max-w-xs text-sm text-muted-foreground">{children}</span>
      {action}
    </div>
  );
}

/**
 * Aviso de error consistente (reemplaza las "Card roja suelta" repetidas en cada página).
 *
 * Entra con el shake de la receta `12-error-state-shake`. La animación corre una vez al montar, que
 * es exactamente cuando aparece el error — no hace falta disparador. El shake por segmentos (largo,
 * corto, largo) se siente como un "no"; un seno uniforme se lee como decoración.
 */
export function ErrorCard({ message, className }: { message: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        't-shake flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive',
        className,
      )}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{message}</span>
    </div>
  );
}

// ---- Skills ----

/** Chip compacto de skill con dots de nivel (1–5). Para listas densas (tarjetas de dev). */
export function SkillChip({ tag, level }: { tag: string; level: number }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border bg-card px-2 py-1 text-xs" title={tag}>
      {/* Tope de ancho: sin él, un tag como "liderazgo-tecnico" hace el chip tan ancho que solo
          cabe uno por renglón, y tres skills se convierten en tres renglones. */}
      <span className="max-w-[8rem] truncate font-medium">{tag}</span>
      <SegmentMeter value={level} max={5} shape="dots" className="shrink-0" />
    </span>
  );
}

const LEVEL_LABEL = ['', 'Básico', 'Junior', 'Intermedio', 'Avanzado', 'Experto'];

/** Medidor de una skill: nombre + barra segmentada (1–5) + etiqueta de dominio. */
export function SkillMeter({ tag, level }: { tag: string; level: number }) {
  const lvl = Math.max(0, Math.min(5, level));
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-semibold">{tag}</span>
        <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{LEVEL_LABEL[lvl] ?? '—'}</span>
      </div>
      <SegmentMeter value={lvl} max={5} />
    </div>
  );
}

/** Grid de medidores de skills, ordenado por nivel desc. */
export function SkillMeters({ skills }: { skills: { tag: string; level: number }[] }) {
  if (!skills.length) return <EmptyState>Sin skills asignadas</EmptyState>;
  const sorted = [...skills].sort((a, b) => b.level - a.level);
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
      {sorted.map((s) => <SkillMeter key={s.tag} tag={s.tag} level={s.level} />)}
    </div>
  );
}

/** +/- líneas en verde/rojo, estilo diff. Compacta las cifras grandes como el resto de la app. */
export function LineDelta({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  if (additions == null && deletions == null) return <span className="text-muted-foreground">—</span>;
  return (
    // `compact()`: antes imprimía `+24571` mientras cada otra cifra de la app decía `24.6k`, y en
    // una fila de tabla eso desalinea la columna entera.
    <span className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums">
      <span className="text-success">+{compact(additions ?? 0)}</span>
      <span className="text-destructive">−{compact(deletions ?? 0)}</span>
    </span>
  );
}
