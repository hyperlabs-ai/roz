import * as React from 'react';
import { CalendarDays, Clock, X } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { fieldSkin } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { localDateStr, pad } from '@/lib/calendar';
import { cn } from '@/lib/utils';

/**
 * Campos de fecha y hora PROPIOS (ver DESIGN.md → "Sin controles nativos"). Reemplazan a
 * `<Input type="date|time|datetime-local">`, cuyo selector es el del navegador: distinto en cada
 * sistema, sin tema y sin el lenguaje de la app.
 *
 * El valor y el `onChange` son los del input que sustituyen, para que el cambio en cada sitio sea de
 * una línea: `value` es la misma cadena (`YYYY-MM-DD`, `HH:mm`, `YYYY-MM-DDTHH:mm`; vacío = sin
 * valor) y `onChange` recibe un objeto con `target.value`, así `onChange={(e) => set(e.target.value)}`
 * sigue funcionando tal cual. `onValueChange` da la cadena directa.
 */

/** Lo mínimo del evento de un input que usan los llamadores. */
export interface FieldChange { target: { value: string } }

interface FieldBaseProps {
  value: string;
  onChange?: (e: FieldChange) => void;
  onValueChange?: (v: string) => void;
  id?: string;
  /** `sm` = 32px para filas densas; `md` = 36px. */
  fieldSize?: 'sm' | 'md';
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Muestra la X para dejarlo vacío. Por defecto sí en fechas, no en horas. */
  clearable?: boolean;
  className?: string;
  /** Alias de `className` (lo usan los llamadores que venían de `<Input wrapperClassName>`). */
  wrapperClassName?: string;
  'aria-label'?: string;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const TIME_RE = /^(\d{1,2}):(\d{2})/;

/** `2026-11-12` → `12 nov 2026`. Sin `Date`: una fecha sin hora no debe moverse de día por la zona. */
function dateLabel(v: string): string | null {
  const m = DATE_RE.exec(v);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}
const toDate = (v: string) => (DATE_RE.test(v) ? new Date(`${v.slice(0, 10)}T12:00:00`) : undefined);
const timeOf = (v: string) => {
  const m = TIME_RE.exec(v);
  return m ? { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) } : null;
};

function useEmit(onChange?: (e: FieldChange) => void, onValueChange?: (v: string) => void) {
  return (v: string) => {
    onChange?.({ target: { value: v } });
    onValueChange?.(v);
  };
}

/** El disparador: un botón con la piel de campo, ícono a la izquierda y X opcional a la derecha. */
const FieldButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: React.ReactNode;
    label: string | null;
    placeholder: string;
    fieldSize: 'sm' | 'md';
    invalid?: boolean;
    onClear?: () => void;
  }
>(({ icon, label, placeholder, fieldSize, invalid, onClear, className, ...props }, ref) => (
  <span className={cn('relative inline-flex w-full min-w-0', className)}>
    <button
      ref={ref}
      type="button"
      aria-invalid={invalid || undefined}
      className={cn(
        fieldSkin,
        'flex w-full min-w-0 items-center gap-2 px-3 text-left tabular-nums data-[state=open]:border-ring data-[state=open]:ring-[3px] data-[state=open]:ring-ring/15 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-faint',
        fieldSize === 'sm' ? 'h-8 text-[13px]' : 'h-9',
        onClear && 'pr-8',
      )}
      {...props}
    >
      {icon}
      <span className={cn('min-w-0 flex-1 truncate', !label && 'text-faint')}>{label ?? placeholder}</span>
    </button>
    {onClear && (
      <button
        type="button"
        aria-label="Quitar"
        onClick={onClear}
        className="absolute inset-y-0 right-1 my-auto grid size-6 place-items-center rounded-sm text-faint transition-colors hover:bg-panel hover:text-foreground [&_svg]:size-3.5"
      >
        <X />
      </button>
    )}
  </span>
));
FieldButton.displayName = 'FieldButton';

/** Pie del popover de fecha: atajos a la izquierda, quitar a la derecha. */
function DateFooter({ onToday, onClear }: { onToday: () => void; onClear?: () => void }) {
  const link = 'rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-panel hover:text-foreground';
  return (
    <div className="flex items-center justify-between gap-2 border-t border-dashed px-2 py-1.5">
      <button type="button" className={link} onClick={onToday}>Hoy</button>
      {onClear && <button type="button" className={link} onClick={onClear}>Quitar</button>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Hora: dos carretes (horas y minutos)
// ---------------------------------------------------------------------------------------------

function Reel({ label, values, selected, onPick }: { label: string; values: number[]; selected: number | null; onPick: (n: number) => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  // Al abrir, el valor elegido queda a la vista (centrado), no perdido arriba de la lista.
  React.useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el && ref.current) ref.current.scrollTop = el.offsetTop - ref.current.clientHeight / 2 + el.clientHeight / 2;
  }, []);
  return (
    <div className="grid gap-1">
      <span className="label-caps px-1 text-center text-[10px]">{label}</span>
      <div ref={ref} role="listbox" aria-label={label} className="scroll-none relative grid h-[196px] w-14 content-start gap-0.5 overflow-y-auto rounded-md bg-panel/60 p-1">
        {values.map((n) => (
          <button
            key={n}
            type="button"
            role="option"
            aria-selected={n === selected}
            onClick={() => onPick(n)}
            className={cn(
              'h-7 shrink-0 rounded-sm text-[13px] tabular-nums transition-colors',
              n === selected ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground hover:bg-card hover:text-foreground',
            )}
          >
            {pad(n)}
          </button>
        ))}
      </div>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

/** Carretes de hora y minuto. Los minutos van de 5 en 5 (más el minuto actual si no es múltiplo). */
function TimeReels({ value, onPick }: { value: { h: number; m: number } | null; onPick: (h: number, m: number) => void }) {
  const minutes = React.useMemo(() => {
    const base = Array.from({ length: 12 }, (_, i) => i * 5);
    return value && value.m % 5 !== 0 ? [...base, value.m].sort((a, b) => a - b) : base;
  }, [value]);
  return (
    <div className="flex gap-2 p-3">
      <Reel label="Hora" values={HOURS} selected={value?.h ?? null} onPick={(h) => onPick(h, value?.m ?? 0)} />
      <Reel label="Min" values={minutes} selected={value?.m ?? null} onPick={(m) => onPick(value?.h ?? 9, m)} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Campos
// ---------------------------------------------------------------------------------------------

/** Fecha (`YYYY-MM-DD`). Elegir un día cierra el popover. */
export function DateField({
  value, onChange, onValueChange, id, fieldSize = 'md', placeholder = 'Sin fecha', disabled, invalid,
  clearable = true, className, wrapperClassName, ...aria
}: FieldBaseProps) {
  const [open, setOpen] = React.useState(false);
  const emit = useEmit(onChange, onValueChange);
  const selected = toDate(value);
  const pick = (v: string) => { emit(v); setOpen(false); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <FieldButton
          id={id}
          icon={<CalendarDays />}
          label={dateLabel(value)}
          placeholder={placeholder}
          fieldSize={fieldSize}
          invalid={invalid}
          disabled={disabled}
          aria-label={aria['aria-label']}
          onClear={clearable && value && !disabled ? () => emit('') : undefined}
          className={cn(className, wrapperClassName)}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar mode="single" selected={selected} defaultMonth={selected} onSelect={(d) => d && pick(localDateStr(d))} />
        <DateFooter onToday={() => pick(localDateStr(new Date()))} onClear={clearable && value ? () => pick('') : undefined} />
      </PopoverContent>
    </Popover>
  );
}

/** Hora (`HH:mm`). */
export function TimeField({
  value, onChange, onValueChange, id, fieldSize = 'md', placeholder = '--:--', disabled, invalid,
  clearable = false, className, wrapperClassName, ...aria
}: FieldBaseProps) {
  const emit = useEmit(onChange, onValueChange);
  const t = timeOf(value);
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <FieldButton
          id={id}
          icon={<Clock />}
          label={t ? `${pad(t.h)}:${pad(t.m)}` : null}
          placeholder={placeholder}
          fieldSize={fieldSize}
          invalid={invalid}
          disabled={disabled}
          aria-label={aria['aria-label']}
          onClear={clearable && value && !disabled ? () => emit('') : undefined}
          className={cn(className, wrapperClassName)}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <TimeReels value={t} onPick={(h, m) => emit(`${pad(h)}:${pad(m)}`)} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Fecha y hora (`YYYY-MM-DDTHH:mm`, el formato de `datetime-local`). Calendario y carretes lado a
 * lado; no se cierra al elegir porque casi siempre se tocan las dos mitades.
 */
export function DateTimeField({
  value, onChange, onValueChange, id, fieldSize = 'md', placeholder = 'Sin fecha', disabled, invalid,
  clearable = true, className, wrapperClassName, ...aria
}: FieldBaseProps) {
  const [open, setOpen] = React.useState(false);
  const emit = useEmit(onChange, onValueChange);
  const date = DATE_RE.test(value) ? value.slice(0, 10) : '';
  const t = timeOf(value.slice(11));
  const time = t ? `${pad(t.h)}:${pad(t.m)}` : '';
  const label = date ? `${dateLabel(date)} · ${time || '--:--'}` : null;
  const now = () => new Date();
  // Elegir solo una mitad completa la otra con algo sensato (hoy / la hora en punto que viene).
  const setDate = (d: string) => emit(`${d}T${time || `${pad(Math.min(23, now().getHours() + 1))}:00`}`);
  const setTime = (h: number, m: number) => emit(`${date || localDateStr(now())}T${pad(h)}:${pad(m)}`);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <FieldButton
          id={id}
          icon={<CalendarDays />}
          label={label}
          placeholder={placeholder}
          fieldSize={fieldSize}
          invalid={invalid}
          disabled={disabled}
          aria-label={aria['aria-label']}
          onClear={clearable && value && !disabled ? () => emit('') : undefined}
          className={cn(className, wrapperClassName)}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <div className="flex flex-col sm:flex-row">
          <Calendar mode="single" selected={toDate(date)} defaultMonth={toDate(date)} onSelect={(d) => d && setDate(localDateStr(d))} />
          <div className="border-t border-dashed sm:border-l sm:border-t-0">
            <TimeReels value={t} onPick={setTime} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-dashed px-2 py-1.5">
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-panel hover:text-foreground"
            onClick={() => { const n = now(); emit(`${localDateStr(n)}T${pad(n.getHours())}:${pad(n.getMinutes())}`); }}
          >
            Ahora
          </button>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[12px] font-semibold text-foreground transition-colors hover:bg-panel"
            onClick={() => setOpen(false)}
          >
            Listo
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
