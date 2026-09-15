// Tablero kanban de tareas: una columna por estado, y arrastrar una tarjeta cambia su estado.
//
// POR QUÉ EL ARRASTRE ES PROPIO Y NO UNA LIBRERÍA
// Lo que se pidió es el gesto de Trello, y ese gesto son tres detalles concretos: la tarjeta se
// inclina al levantarla, la columna a la que va a caer se enmarca, y el hueco se abre justo donde
// va a quedar. Con eventos de puntero los tres salen directos y sin dependencias; una librería
// genérica de drag&drop habría que pelearla para conseguir exactamente eso, y pesa más que este
// archivo.
//
// LÍMITE CONOCIDO — el orden DENTRO de una columna no se guarda.
// `roz.work_item` no tiene columna de posición (ver migraciones), así que no hay dónde escribirlo.
// El hueco te enseña dónde estás soltando, pero al caer la tarjeta se coloca donde la ponga el
// orden elegido arriba (Plan / Prioridad). Mover ENTRE columnas sí persiste: eso es un cambio de
// estado, y se guarda con el mismo PATCH optimista que usa la lista.
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, Copy, MoreHorizontal, Plus, SquarePen, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AvatarStack } from '@/components/bits';
import { StatusIcon, assigneesOf } from '@/components/tasks/inline-cells';
import { CLOSED_STATES, PRIO_DOT, PRIO_LABEL, STATE_LABEL, STATE_ORDER, canonState } from '@/lib/labels';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Ticket } from '@/lib/api';

const COL_W = 286;        // ancho de columna, del orden del de Trello (272px)
const DRAG_START = 5;     // px de margen para distinguir un clic de un arrastre
const HOLD_MS = 260;      // pulsación larga que inicia el arrastre en táctil
const EDGE = 76;          // franja donde el tablero empieza a auto-scrollear
const EDGE_MAX = 22;      // px por frame como mucho

/** Lo que el arrastre necesita saber entre frames. Vive en un ref: cambia 60 veces por segundo y
 *  pasarlo por estado repintaría el tablero entero en cada uno. */
interface Live {
  task: Ticket;
  from: string;
  pointerId: number;
  ox: number; oy: number;      // desfase del puntero dentro de la tarjeta
  w: number; h: number;        // tamaño de la tarjeta levantada (= tamaño del hueco)
  x: number; y: number;        // puntero
  startX: number; startY: number;
  active: boolean;             // ya se levantó (vs. solo el botón apretado)
  touch: boolean;              // dedo o lápiz (entra por pulsación larga); con ratón manda el umbral
  hold: number;                // temporizador de la pulsación larga
  over: string | null;         // columna bajo el puntero AHORA — es lo que manda al soltar
}

/** Lo que React sí necesita: dónde abrir el hueco. Cambia pocas veces por arrastre. */
interface Slot { id: string; over: string | null; index: number; w: number; h: number }

export function TaskBoard({
  tasks, onOpen, onToggleDone, onStatus, onDuplicate, onDelete, onCreate, onMoveAll,
}: {
  /** Ya filtradas y ORDENADAS por quien llama: el tablero solo las reparte en columnas. */
  tasks: Ticket[];
  onOpen: (t: Ticket) => void;
  onToggleDone: (t: Ticket) => void;
  onStatus: (t: Ticket, status: string) => void;
  onDuplicate: (t: Ticket) => void;
  onDelete: (t: Ticket) => void;
  onCreate: (status: string) => void;
  onMoveAll: (from: string, to: string) => void;
}) {
  const board = useRef<HTMLDivElement>(null);
  const live = useRef<Live | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  // Tras soltar, el navegador manda un `click` a la tarjeta que acabas de arrastrar; sin esto cada
  // arrastre terminaba abriendo el modal. Se guarda el INSTANTE del soltar y no un booleano con
  // temporizador: un setTimeout(0) es un macrotask y el navegador puede colar el `click` antes de
  // que corra, que es justo el caso que había que evitar.
  const droppedAt = useRef(0);

  const [down, setDown] = useState(false);   // botón apretado sobre una tarjeta (aún no es arrastre)
  const [slot, setSlot] = useState<Slot | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [landed, setLanded] = useState<string | null>(null);

  const byState = useMemo(() => {
    const m = new Map<string, Ticket[]>(STATE_ORDER.map((s) => [s, [] as Ticket[]]));
    for (const t of tasks) m.get(canonState(t.status))!.push(t);
    return m;
  }, [tasks]);

  // El anillo que marca la tarjeta recién movida se apaga solo: es un acuse de recibo, no un estado.
  useEffect(() => {
    if (!landed) return;
    const id = window.setTimeout(() => setLanded(null), 900);
    return () => window.clearTimeout(id);
  }, [landed]);

  /** Empieza el seguimiento. Todavía no es un arrastre: falta rebasar el umbral (ratón) o
   *  mantener apretado (táctil). */
  const grab = useCallback((e: React.PointerEvent<HTMLElement>, t: Ticket) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    live.current = {
      task: t, from: canonState(t.status), pointerId: e.pointerId,
      ox: e.clientX - r.left, oy: e.clientY - r.top,
      w: r.width, h: r.height,
      x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
      active: false, touch: e.pointerType !== 'mouse', hold: 0, over: canonState(t.status),
    };
    setDown(true);
  }, []);

  // Sincrono y antes del pintado: el rAF llega un frame tarde, y ese frame la tarjeta se veía en
  // la esquina superior izquierda antes de saltar bajo el puntero.
  useLayoutEffect(() => {
    const d = live.current;
    if (slot && d && overlay.current) {
      overlay.current.style.transform = `translate3d(${d.x - d.ox}px, ${d.y - d.oy}px, 0)`;
    }
  }, [slot]);

  const openCard = useCallback((t: Ticket) => {
    if (performance.now() - droppedAt.current < 250) return;
    onOpen(t);
  }, [onOpen]);

  // Todo el motor vive en un efecto para que las funciones se cierren sobre los props de ESTE
  // render: con useCallback y refs cruzados acaban leyendo valores viejos.
  useEffect(() => {
    if (!down) return;

    /** Columna bajo el puntero y posición de inserción dentro de ella. La tarjeta levantada no
     *  está en el DOM mientras se arrastra, así que no cuenta para el índice. */
    const locate = (x: number, y: number) => {
      const b = board.current;
      if (!b) return null;
      for (const el of b.querySelectorAll<HTMLElement>('[data-col]')) {
        const r = el.getBoundingClientRect();
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        // El índice se mide contra el DOM de AHORA, que ya incluye el hueco. Converge: el hueco
        // está siempre exactamente en la posición que se calculó, así que recalcular da lo mismo
        // y no oscila entre dos posiciones.
        const cards = el.querySelectorAll<HTMLElement>('[data-card]');
        let index = cards.length;
        for (let i = 0; i < cards.length; i++) {
          const cr = cards[i].getBoundingClientRect();
          if (y < cr.top + cr.height / 2) { index = i; break; }
        }
        return { over: el.dataset.col as string, index };
      }
      return null;
    };

    const creep = (d: number) => Math.min(EDGE_MAX, Math.max(2, d / 3));

    /** Arrastrar hasta el borde desplaza: si no, no puedes llevar una tarjeta a una columna que
     *  está fuera de pantalla ni al fondo de una lista larga. */
    const autoScroll = (x: number, y: number, over: string | null) => {
      const b = board.current;
      if (b) {
        const r = b.getBoundingClientRect();
        if (x < r.left + EDGE) b.scrollLeft -= creep(r.left + EDGE - x);
        else if (x > r.right - EDGE) b.scrollLeft += creep(x - (r.right - EDGE));
      }
      const sc = over ? b?.querySelector<HTMLElement>(`[data-col="${over}"] [data-scroller]`) : null;
      if (sc) {
        const r = sc.getBoundingClientRect();
        if (y < r.top + EDGE) sc.scrollTop -= creep(r.top + EDGE - y);
        else if (y > r.bottom - EDGE) sc.scrollTop += creep(y - (r.bottom - EDGE));
      }
    };

    const tick = () => {
      const d = live.current;
      if (!d?.active) { frame.current = 0; return; }
      // El overlay se posiciona escribiendo el transform a mano. Por estado serían 60 renders por
      // segundo del tablero completo.
      if (overlay.current) overlay.current.style.transform = `translate3d(${d.x - d.ox}px, ${d.y - d.oy}px, 0)`;
      const hit = locate(d.x, d.y);
      d.over = hit?.over ?? null;
      autoScroll(d.x, d.y, d.over);
      // Devolver `prev` tal cual cuando nada cambió evita el re-render: solo se repinta cuando el
      // hueco cambia de columna o de posición.
      setSlot((prev) => (
        !prev ? prev
          : prev.over === (hit?.over ?? null) && prev.index === (hit?.index ?? 0) ? prev
            : { ...prev, over: hit?.over ?? null, index: hit?.index ?? 0 }
      ));
      frame.current = requestAnimationFrame(tick);
    };

    const lift = () => {
      const d = live.current;
      if (!d || d.active) return;
      d.active = true;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'grabbing';
      const hit = locate(d.x, d.y);
      d.over = hit?.over ?? d.from;
      setSlot({ id: d.task.id, over: d.over, index: hit?.index ?? 0, w: d.w, h: d.h });
      if (!frame.current) frame.current = requestAnimationFrame(tick);
    };

    const end = (drop: boolean) => {
      const d = live.current;
      if (d?.hold) window.clearTimeout(d.hold);
      if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      live.current = null;
      setSlot(null);
      setDown(false);
      if (!d?.active) return;
      // El `click` que el navegador emite al soltar llega justo después: openCard lo descarta.
      droppedAt.current = performance.now();
      // Soltar en la MISMA columna no manda nada: sin posición que guardar, un PATCH con el estado
      // que la tarea ya tiene sería una petición que no cambia nada.
      if (drop && d.over && d.over !== d.from) {
        onStatus(d.task, d.over);
        setLanded(d.task.id);
      }
    };

    const move = (e: PointerEvent) => {
      const d = live.current;
      if (!d || e.pointerId !== d.pointerId) return;
      d.x = e.clientX; d.y = e.clientY;
      if (d.active) { e.preventDefault(); return; }
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) <= DRAG_START) return;
      // Con el ratón, moverse ES arrastrar. En táctil, moverse antes de que corra la pulsación
      // larga es hacer scroll — se suelta el gesto y la columna se desplaza como debe.
      if (e.pointerType === 'mouse') lift();
      else end(false);
    };

    const up = () => end(true);
    const cancel = () => end(false);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') end(false); };

    const d0 = live.current;
    // La pulsación larga es SOLO para dedo/lápiz. Con ratón manda el umbral de 5px: si el reloj
    // también corriera aquí, un clic lento (>260ms sin mover) levantaría la tarjeta, al soltar no
    // habría cambio de columna y el clic se descartaría — la tarea nunca abriría.
    if (d0?.touch && !d0.active) d0.hold = window.setTimeout(lift, HOLD_MS);
    // Si el efecto se re-montó a mitad de un arrastre (cambió `onStatus`), la limpieza anterior ya
    // canceló el rAF: sin esto la tarjeta se quedaría clavada siguiendo un puntero que no avanza.
    if (d0?.active && !frame.current) frame.current = requestAnimationFrame(tick);

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [down, onStatus]);

  const dragged = slot ? tasks.find((t) => t.id === slot.id) ?? null : null;

  return (
    <>
      <div
        ref={board}
        className="scroll-thin flex h-[calc(100dvh-13rem)] gap-3 overflow-x-auto overflow-y-hidden pb-2"
      >
        {STATE_ORDER.map((state) => (
          <BoardColumn
            key={state}
            state={state}
            tasks={byState.get(state) ?? []}
            collapsed={!!collapsed[state]}
            slot={slot}
            landed={landed}
            onCollapse={(v) => setCollapsed((c) => ({ ...c, [state]: v }))}
            onGrab={grab}
            onOpen={openCard}
            onToggleDone={onToggleDone}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
            onCreate={onCreate}
            onMoveAll={onMoveAll}
          />
        ))}
      </div>

      {/* La tarjeta levantada: fuera del flujo, siguiendo al puntero, inclinada. En un portal a
          <body> para que ninguna columna con overflow la recorte. */}
      {dragged && slot && createPortal(
        <div
          ref={overlay}
          className="pointer-events-none fixed left-0 top-0 z-[70] will-change-transform"
          style={{ width: slot.w }}
        >
          <div className="rotate-[4deg] scale-[1.03] opacity-95 shadow-2xl">
            <Card t={dragged} ghost />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ---------------------------------------------------------------------------- columna

function BoardColumn({
  state, tasks, collapsed, slot, landed, onCollapse, onGrab, onOpen,
  onToggleDone, onDuplicate, onDelete, onCreate, onMoveAll,
}: {
  state: string;
  tasks: Ticket[];
  collapsed: boolean;
  slot: Slot | null;
  landed: string | null;
  onCollapse: (v: boolean) => void;
  onGrab: (e: React.PointerEvent<HTMLElement>, t: Ticket) => void;
  onOpen: (t: Ticket) => void;
  onToggleDone: (t: Ticket) => void;
  onDuplicate: (t: Ticket) => void;
  onDelete: (t: Ticket) => void;
  onCreate: (status: string) => void;
  onMoveAll: (from: string, to: string) => void;
}) {
  const target = slot?.over === state;
  const label = STATE_LABEL[state] ?? state;

  if (collapsed) {
    return (
      <button
        type="button"
        data-col={state}
        onClick={() => onCollapse(false)}
        title={`Desplegar ${label}`}
        className={cn(
          'flex w-11 shrink-0 flex-col items-center gap-2 rounded-xl border bg-muted/40 py-3 transition-colors hover:bg-muted',
          target && 'border-primary bg-primary/10',
        )}
      >
        <StatusIcon state={state} className="size-4" />
        <span className="text-[11px] font-semibold tabular-nums text-muted-foreground">{tasks.length}</span>
        {/* Vertical, como las listas plegadas de Trello: el nombre se sigue leyendo sin ocupar ancho. */}
        <span className="mt-1 whitespace-nowrap text-[12px] font-medium text-muted-foreground [writing-mode:vertical-rl]">
          {label}
        </span>
      </button>
    );
  }

  // La tarjeta levantada sale de su columna mientras viaja: así el hueco es el único sitio donde
  // "está", y las demás se recolocan como en Trello.
  const list = slot ? tasks.filter((t) => t.id !== slot.id) : tasks;
  const gap = target && slot ? Math.min(slot.index, list.length) : -1;

  const cards: ReactNode[] = [];
  list.forEach((t, i) => {
    if (i === gap) cards.push(<Gap key="__gap" h={slot!.h} />);
    cards.push(
      <Card
        key={t.id}
        t={t}
        landed={landed === t.id}
        onGrab={onGrab}
        onOpen={onOpen}
        onToggleDone={onToggleDone}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
      />,
    );
  });
  if (gap >= list.length) cards.push(<Gap key="__gap" h={slot!.h} />);

  return (
    <section
      data-col={state}
      className={cn(
        'flex max-h-full shrink-0 flex-col rounded-xl border bg-muted/40 transition-colors duration-150',
        // El marco de la columna destino: el aviso de "aquí es donde va a caer".
        target && 'border-primary bg-primary/[0.06] shadow-[0_0_0_1px_hsl(var(--primary))]',
      )}
      style={{ width: COL_W }}
    >
      <header className="flex items-center gap-1.5 px-3 pb-1.5 pt-2.5">
        <StatusIcon state={state} className="size-4" />
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{label}</h3>
        <span className="rounded px-1 text-[12px] tabular-nums text-muted-foreground">{tasks.length}</span>
        <ColumnMenu
          state={state}
          count={tasks.length}
          onCreate={onCreate}
          onCollapse={() => onCollapse(true)}
          onMoveAll={onMoveAll}
        />
      </header>

      <div data-scroller className="scroll-thin min-h-[52px] flex-1 space-y-2 overflow-y-auto px-2 py-1">
        {cards}
        {!cards.length && (
          <p className="px-1 py-6 text-center text-[12px] text-muted-foreground/70">
            {target ? 'Suelta aquí' : 'Sin tareas'}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={() => onCreate(state)}
        className="m-2 mt-1 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Plus className="size-3.5" />
        Añade una tarjeta
      </button>
    </section>
  );
}

/** El hueco que se abre donde va a caer la tarjeta. Mismo alto que la que llevas en la mano. */
function Gap({ h }: { h: number }) {
  return <div style={{ height: h }} className="rounded-lg bg-foreground/[0.07] ring-1 ring-inset ring-border" />;
}

function ColumnMenu({ state, count, onCreate, onCollapse, onMoveAll }: {
  state: string;
  count: number;
  onCreate: (status: string) => void;
  onCollapse: () => void;
  onMoveAll: (from: string, to: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
          aria-label={`Acciones de ${STATE_LABEL[state] ?? state}`}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={() => onCreate(state)}><Plus className="size-3.5" /> Nueva tarea aquí</DropdownMenuItem>
        <DropdownMenuItem onClick={onCollapse}>Plegar columna</DropdownMenuItem>
        {count > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
              Mover las {count} a
            </DropdownMenuLabel>
            {STATE_ORDER.filter((s) => s !== state).map((s) => (
              <DropdownMenuItem key={s} onClick={() => onMoveAll(state, s)}>
                <StatusIcon state={s} className="size-3.5" />
                {STATE_LABEL[s]}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------- tarjeta

/** Una tarjeta. `ghost` es la copia que viaja con el puntero: misma pinta, sin nada interactivo.
 *
 *  Memoizada y con callbacks estables desde el tablero: durante un arrastre el hueco se mueve
 *  varias veces por segundo, y sin memo cada salto repintaría todas las tarjetas del tablero. */
const Card = memo(function Card({ t, ghost, landed, onGrab, onOpen, onToggleDone, onDuplicate, onDelete }: {
  t: Ticket;
  ghost?: boolean;
  landed?: boolean;
  onGrab?: (e: React.PointerEvent<HTMLElement>, t: Ticket) => void;
  onOpen?: (t: Ticket) => void;
  onToggleDone?: (t: Ticket) => void;
  onDuplicate?: (t: Ticket) => void;
  onDelete?: (t: Ticket) => void;
}) {
  const closed = CLOSED_STATES.includes(canonState(t.status));
  const people = assigneesOf(t);

  return (
    <div
      data-card={ghost ? undefined : ''}
      onPointerDown={ghost ? undefined : (e) => onGrab?.(e, t)}
      onClick={ghost ? undefined : () => onOpen?.(t)}
      // `pan-y`: en táctil el dedo sigue pudiendo desplazar la columna; el arrastre entra por
      // pulsación larga, que es justo cuando el dedo NO se ha movido.
      style={{ touchAction: 'pan-y' }}
      className={cn(
        'group/card relative rounded-lg border bg-card p-2.5 text-left shadow-sm',
        'transition-[background-color,box-shadow,border-color] duration-150',
        !ghost && 'cursor-grab select-none hover:border-foreground/15 hover:bg-accent hover:shadow-md active:cursor-grabbing',
        landed && 'ring-2 ring-primary/70',
      )}
    >
      {!!t.labels?.length && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {t.labels.slice(0, 3).map((l) => (
            <Badge key={l} variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">{l}</Badge>
          ))}
        </div>
      )}

      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleDone?.(t); }}
          onPointerDown={(e) => e.stopPropagation()}
          className="mt-[1px] shrink-0 rounded transition-transform hover:scale-110"
          aria-label={closed ? 'Reabrir' : 'Completar'}
          title={closed ? 'Reabrir' : 'Completar'}
          tabIndex={ghost ? -1 : 0}
        >
          <StatusIcon state={t.status} className="size-[15px]" />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpen?.(t); }}
          className={cn(
            'min-w-0 flex-1 pr-5 text-left text-[13px] leading-snug',
            closed && 'text-muted-foreground line-through',
          )}
          tabIndex={ghost ? -1 : 0}
        >
          {t.name}
        </button>
      </div>

      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="shrink-0 font-mono">{t.identifier}</span>
        {t.priority && (
          <span className="flex shrink-0 items-center gap-1" title={`Prioridad ${PRIO_LABEL[t.priority] ?? t.priority}`}>
            <span className={cn('size-1.5 rounded-full', PRIO_DOT[t.priority] ?? 'bg-muted')} />
            {PRIO_LABEL[t.priority] ?? t.priority}
          </span>
        )}
        {t.dueDate && (
          <span className={cn('flex shrink-0 items-center gap-1', t.overdue && 'font-medium text-destructive')}>
            <CalendarDays className="size-3" />
            {shortDate(t.dueDate)}
          </span>
        )}
        <span className="ml-auto shrink-0">
          {people.length > 0 && <AvatarStack people={people} max={3} size="size-5" />}
        </span>
      </div>

      {/* El lápiz de Trello: aparece al pasar el ratón, en la esquina. Abre el menú en vez de
          repetir lo que ya hace un clic en la tarjeta. */}
      {!ghost && <CardMenu t={t} onOpen={onOpen} onDuplicate={onDuplicate} onDelete={onDelete} />}
    </div>
  );
});

function CardMenu({ t, onOpen, onDuplicate, onDelete }: {
  t: Ticket;
  onOpen?: (t: Ticket) => void;
  onDuplicate?: (t: Ticket) => void;
  onDelete?: (t: Ticket) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-md bg-card/80 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/card:opacity-100 data-[state=open]:opacity-100"
          aria-label={`Acciones de ${t.identifier}`}
        >
          <SquarePen className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={() => onOpen?.(t)}>Abrir</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onDuplicate?.(t)}><Copy className="size-3.5" /> Duplicar</DropdownMenuItem>
        {t.pr && (
          <DropdownMenuItem onClick={() => window.open(t.pr!.url, '_blank')}>Ver PR #{t.pr.number}</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onDelete?.(t)} className="text-destructive focus:text-destructive">
          <Trash2 className="size-3.5" /> Eliminar
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
