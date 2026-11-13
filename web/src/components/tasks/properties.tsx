// Propiedades de una tarea al estilo Linear: píldoras compactas con ícono que abren un menú con
// búsqueda y teclado (flechas, Enter, números 1-9). Las usan el modal de tareas (alta y detalle) y
// el formulario de /ticket, así que el lenguaje es el mismo en los tres.
//
// Sin dependencias nuevas (no hay cmdk): Popover de Radix + una lista propia. El contenido del menú
// solo se monta mientras está abierto, así que diez píldoras en un modal no pesan nada.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CalendarClock, CalendarDays, Check, Plus } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { TimeField } from '@/components/ui/date-field';
import { tokenColor } from '@/components/brand';
import { localDateStr } from '@/lib/calendar';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------------------------
// Estilos de disparador
// ---------------------------------------------------------------------------------------------

/** Píldora de la fila de propiedades (modal de alta, /ticket). */
export const PILL =
  'inline-flex h-7 max-w-[15rem] items-center gap-1.5 rounded-md border bg-card px-2 text-[12.5px] font-medium text-foreground transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 data-[state=open]:bg-panel [&_svg]:size-3.5 [&_svg]:shrink-0';
/** Valor de una fila del panel lateral (detalle): sin borde, ocupa el ancho. */
export const ROW =
  'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] text-foreground transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 data-[state=open]:bg-panel [&_svg]:size-3.5 [&_svg]:shrink-0';

/** Atajo de teclado pintado como tecla. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-grid h-[18px] min-w-[18px] place-items-center rounded-[4px] border bg-panel px-1 font-sans text-[10.5px] font-semibold leading-none text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

// ---------------------------------------------------------------------------------------------
// Íconos
// ---------------------------------------------------------------------------------------------

/**
 * Prioridad con los íconos de Linear: tres barras que se llenan (baja 1, media 2, alta 3), cuadro
 * naranja con "!" para urgente y tres guiones para "sin prioridad". Todo con clases de token.
 */
export function PriorityIcon({ value, className }: { value: string | null | undefined; className?: string }) {
  const cls = cn('size-4 shrink-0', className);
  if (value === 'urgent') {
    return (
      <svg viewBox="0 0 16 16" className={cls} aria-hidden>
        <rect x="1" y="1" width="14" height="14" rx="3.5" className="fill-orange" />
        <rect x="7" y="3.75" width="2" height="5.5" rx="1" className="fill-white" />
        <rect x="7" y="10.5" width="2" height="2" rx="1" className="fill-white" />
      </svg>
    );
  }
  const filled = value === 'high' ? 3 : value === 'medium' ? 2 : value === 'low' ? 1 : 0;
  if (!filled) {
    return (
      <svg viewBox="0 0 16 16" className={cls} aria-hidden>
        {[1.5, 6.5, 11.5].map((x) => <rect key={x} x={x} y="7.25" width="3" height="1.5" rx="0.75" className="fill-faint" />)}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className={cls} aria-hidden>
      {[
        { x: 1.5, h: 6 },
        { x: 6.5, h: 9 },
        { x: 11.5, h: 12 },
      ].map((b, i) => (
        <rect key={b.x} x={b.x} y={14 - b.h} width="3" height={b.h} rx="1" className={i < filled ? 'fill-foreground' : 'fill-toggle-off'} />
      ))}
    </svg>
  );
}

const LABEL_TONES = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'] as const;

/** Color estable de una etiqueta (mismo nombre → mismo punto en toda la app). */
export function labelTone(label: string): string {
  let h = 0;
  for (const ch of label.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return tokenColor(LABEL_TONES[h % LABEL_TONES.length]);
}

export function LabelDot({ label, className }: { label: string; className?: string }) {
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-full', className)} style={{ background: labelTone(label) }} />;
}

// ---------------------------------------------------------------------------------------------
// Menú de propiedad
// ---------------------------------------------------------------------------------------------

export interface PropOption {
  value: string;
  label: string;
  icon?: ReactNode;
  /** Texto atenuado a la derecha (p. ej. "≈ 4 h", "propuesta de roz"). */
  hint?: ReactNode;
  /** Texto extra para la búsqueda. */
  keywords?: string;
  /** Separador antes de esta opción (p. ej. entre "roz elige" y las personas). */
  divider?: boolean;
}

/**
 * Menú de una propiedad: buscador arriba, opciones con ícono y número, teclado completo.
 *
 *  · Flechas mueven, Enter elige, 1-9 eligen directo (con el buscador vacío), Esc cierra.
 *  · `multi`: no se cierra al elegir (armar un equipo o varias etiquetas son varios clics).
 *  · `onCreate`: si lo escrito no existe, ofrece "Crear «…»" (etiquetas).
 *  · `open`/`onOpenChange` opcionales: el modal los controla para abrir menús con atajos.
 */
export function PropertyMenu({
  title,
  shortcut,
  options,
  value,
  values,
  multi = false,
  onSelect,
  onCreate,
  children,
  triggerClassName,
  triggerLabel,
  align = 'start',
  disabled,
  open: openProp,
  onOpenChange,
  footer,
  width = 'w-64',
}: {
  /** "Cambiar estado…" — placeholder del buscador. */
  title: string;
  shortcut?: string;
  options: PropOption[];
  value?: string | null;
  values?: string[];
  multi?: boolean;
  onSelect: (value: string) => void;
  onCreate?: (query: string) => void;
  /** Contenido del disparador. */
  children: ReactNode;
  triggerClassName?: string;
  triggerLabel?: string;
  align?: 'start' | 'center' | 'end';
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  footer?: ReactNode;
  width?: string;
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = openProp ?? innerOpen;
  const setOpen = (o: boolean) => {
    if (openProp === undefined) setInnerOpen(o);
    onOpenChange?.(o);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={triggerClassName ?? PILL}
          aria-label={triggerLabel ?? title}
          title={shortcut ? `${triggerLabel ?? title} · tecla ${shortcut}` : triggerLabel ?? title}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className={cn('overflow-hidden p-0', width)} onOpenAutoFocus={(e) => e.preventDefault()}>
        {open && (
          <MenuBody
            title={title}
            shortcut={shortcut}
            options={options}
            selected={multi ? values ?? [] : value != null ? [value] : []}
            onPick={(v) => {
              onSelect(v);
              if (!multi) setOpen(false);
            }}
            onCreate={
              onCreate
                ? (q) => {
                    onCreate(q);
                    if (!multi) setOpen(false);
                  }
                : undefined
            }
            onClose={() => setOpen(false)}
          />
        )}
        {footer && <div className="border-t px-3 py-2 text-[11.5px] text-muted-foreground">{footer}</div>}
      </PopoverContent>
    </Popover>
  );
}

function MenuBody({
  title,
  shortcut,
  options,
  selected,
  onPick,
  onCreate,
  onClose,
}: {
  title: string;
  shortcut?: string;
  options: PropOption[];
  selected: string[];
  onPick: (v: string) => void;
  onCreate?: (q: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const needle = q.trim().toLowerCase();
  const filtered = useMemo(
    () => (needle ? options.filter((o) => `${o.label} ${o.keywords ?? ''}`.toLowerCase().includes(needle)) : options),
    [options, needle],
  );
  const canCreate = !!onCreate && !!needle && !options.some((o) => o.label.toLowerCase() === needle);
  const count = filtered.length + (canCreate ? 1 : 0);

  // Arranca sobre lo elegido (como Linear): Enter sin moverse no cambia nada.
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => selected.includes(o.value))));
  useEffect(() => setActive((a) => (needle ? 0 : Math.min(a, Math.max(0, count - 1)))), [needle, count]);
  useEffect(() => {
    // Foco al buscador al abrir (sin robar el scroll de la página).
    const t = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pickAt = (i: number) => {
    if (i < filtered.length) onPick(filtered[i].value);
    else if (canCreate) {
      onCreate!(q.trim());
      setQ('');
    }
  };

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (count ? (a + 1) % count : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (count ? (a - 1 + count) % count : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation(); // que no dispare el Ctrl+Enter del modal
      if (count) pickAt(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // Esc cierra el menú, no el modal
      onClose();
    } else if (!q && /^[1-9]$/.test(e.key) && Number(e.key) <= filtered.length) {
      e.preventDefault();
      pickAt(Number(e.key) - 1);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 border-b px-3">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder={`${title}…`}
          className="h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
          aria-label={title}
        />
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </div>
      <div ref={listRef} role="listbox" className="max-h-64 overflow-y-auto p-1">
        {filtered.map((o, i) => {
          const on = selected.includes(o.value);
          return (
            <div key={o.value}>
              {o.divider && i > 0 && <div className="mx-1 my-1 h-px bg-border" />}
              <button
                type="button"
                role="option"
                aria-selected={on}
                data-idx={i}
                onMouseMove={() => setActive(i)}
                onClick={() => pickAt(i)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                  i === active ? 'bg-panel text-foreground' : 'text-foreground/90',
                )}
              >
                {o.icon && <span className="grid size-4 shrink-0 place-items-center [&_svg]:size-4">{o.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint && <span className="shrink-0 text-[11.5px] text-faint">{o.hint}</span>}
                {on ? (
                  <Check className="size-3.5 shrink-0 text-orange" />
                ) : (
                  !needle && i < 9 && <span className="w-3.5 shrink-0 text-center text-[11px] tabular-nums text-faint">{i + 1}</span>
                )}
              </button>
            </div>
          );
        })}
        {canCreate && (
          <button
            type="button"
            data-idx={filtered.length}
            onMouseMove={() => setActive(filtered.length)}
            onClick={() => pickAt(filtered.length)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]',
              active === filtered.length && 'bg-panel',
            )}
          >
            <Plus className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">Crear «{q.trim()}»</span>
          </button>
        )}
        {count === 0 && <p className="px-2 py-3 text-center text-[12.5px] text-muted-foreground">Sin resultados</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------------------------

function addDaysStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}
function nextMonday(): string {
  const d = new Date();
  d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  return localDateStr(d);
}

/**
 * Fecha límite: atajos (hoy, mañana, próxima semana) + calendario. Guarda YYYY-MM-DD local.
 */
export function DueDateMenu({
  value,
  onChange,
  overdue,
  children,
  triggerClassName,
  open,
  onOpenChange,
  disabled,
  shortcut,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  overdue?: boolean;
  children?: ReactNode;
  triggerClassName?: string;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  disabled?: boolean;
  shortcut?: string;
}) {
  const [inner, setInner] = useState(false);
  const isOpen = open ?? inner;
  const setOpen = (o: boolean) => {
    if (open === undefined) setInner(o);
    onOpenChange?.(o);
  };
  const selected = value ? new Date(`${value.slice(0, 10)}T12:00:00`) : undefined;
  const pick = (v: string | null) => {
    onChange(v);
    setOpen(false);
  };
  const quick = [
    { label: 'Hoy', v: addDaysStr(0) },
    { label: 'Mañana', v: addDaysStr(1) },
    { label: 'Próx. lunes', v: nextMonday() },
    { label: 'En 2 semanas', v: addDaysStr(14) },
  ];
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button type="button" className={triggerClassName ?? PILL} title={shortcut ? `Fecha límite · tecla ${shortcut}` : 'Fecha límite'} aria-label="Fecha límite">
          {children ?? (
            <>
              <CalendarDays className={cn(overdue ? 'text-red' : 'text-muted-foreground')} />
              <span className={cn('truncate', !value && 'text-muted-foreground', overdue && 'text-red')}>{value ? shortDate(value) : 'Fecha límite'}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <div className="flex flex-wrap gap-1 border-b p-2">
          {quick.map((qk) => (
            <button
              key={qk.label}
              type="button"
              onClick={() => pick(qk.v)}
              className={cn(
                'rounded-md px-2 py-1 text-[12px] font-medium transition-colors hover:bg-panel',
                value?.slice(0, 10) === qk.v ? 'bg-orange-soft text-orange-ink' : 'text-muted-foreground',
              )}
            >
              {qk.label}
            </button>
          ))}
        </div>
        <Calendar mode="single" selected={selected} defaultMonth={selected} onSelect={(d) => pick(d ? localDateStr(d) : null)} />
        {value && (
          <div className="border-t p-1.5">
            <button type="button" onClick={() => pick(null)} className="w-full rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-panel hover:text-foreground">
              Quitar fecha
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Agenda en el calendario del equipo: día + hora de inicio y fin. Sin día, la tarea vive en el
 * backlog. Los cambios se aplican al pulsar "Agendar" (tres campos que viajan juntos).
 */
export function ScheduleMenu({
  date,
  start,
  end,
  onChange,
  children,
  triggerClassName,
  open,
  onOpenChange,
  disabled,
}: {
  date: string;
  start: string;
  end: string;
  onChange: (date: string, start: string, end: string) => void;
  children?: ReactNode;
  triggerClassName?: string;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  disabled?: boolean;
}) {
  const [inner, setInner] = useState(false);
  const isOpen = open ?? inner;
  const [d, setD] = useState(date);
  const [s, setS] = useState(start);
  const [e, setE] = useState(end);
  const setOpen = (o: boolean) => {
    if (o) {
      setD(date || localDateStr(new Date()));
      setS(start);
      setE(end);
    }
    if (open === undefined) setInner(o);
    onOpenChange?.(o);
  };
  // Si lo abren desde fuera (atajo, menú "Más"), también se precarga.
  useEffect(() => {
    if (open) {
      setD(date || localDateStr(new Date()));
      setS(start);
      setE(end);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const selected = d ? new Date(`${d}T12:00:00`) : undefined;
  const invalid = !!d && e <= s;
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button type="button" className={triggerClassName ?? PILL} aria-label="Agenda">
          {children ?? (
            <>
              <CalendarClock className="text-muted-foreground" />
              <span className={cn('truncate', !date && 'text-muted-foreground')}>{date ? `${shortDate(date)} · ${start}` : 'Agendar'}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar mode="single" selected={selected} defaultMonth={selected} onSelect={(x) => x && setD(localDateStr(x))} />
        <div className="grid grid-cols-2 gap-2 border-t px-3 py-2.5">
          <label className="grid gap-1">
            <span className="label-caps">Inicio</span>
            <TimeField fieldSize="sm" value={s} onChange={(ev) => setS(ev.target.value)} aria-label="Inicio" />
          </label>
          <label className="grid gap-1">
            <span className="label-caps">Fin</span>
            <TimeField fieldSize="sm" value={e} onChange={(ev) => setE(ev.target.value)} aria-label="Fin" />
          </label>
        </div>
        {invalid && <p className="px-3 pb-1 text-[11.5px] text-red">La hora de fin debe ser después del inicio.</p>}
        <div className="flex items-center justify-between gap-2 border-t bg-sidebar px-3 py-2">
          {date ? (
            <button
              type="button"
              onClick={() => { onChange('', start, end); setOpen(false); }}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Quitar de la agenda
            </button>
          ) : <span className="text-[11.5px] text-faint">Sin día, vive en el backlog</span>}
          <button
            type="button"
            disabled={!d || invalid}
            onClick={() => { onChange(d, s, e); setOpen(false); }}
            className="rounded-sm bg-ink px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-foreground transition-opacity disabled:opacity-40"
          >
            Agendar
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------------------------
// Panel lateral (detalle)
// ---------------------------------------------------------------------------------------------

/** Fila "Etiqueta · valor" del panel de propiedades del detalle. */
export function PropRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[88px_minmax(0,1fr)] items-center gap-1">
      <span className="truncate text-[12.5px] text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Bloque del panel lateral con su encabezado `label-caps`. */
export function SideSection({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('grid gap-1.5 border-t px-4 py-3.5 first:border-t-0', className)}>
      <div className="flex min-h-5 items-center justify-between gap-2">
        <span className="label-caps">{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Textarea que crece con el contenido (título y descripción sin borde)
// ---------------------------------------------------------------------------------------------

/** Ajusta la altura de un textarea a su contenido. */
export function useAutosize(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}
