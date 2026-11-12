import * as React from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { fieldSkin } from './input';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Ícono, avatar o punto de color delante del texto (en la lista Y en el disparador). */
  icon?: React.ReactNode;
  /** Segunda línea gris en la lista (cliente del proyecto, correo…). */
  hint?: string;
  /** Texto extra por el que también se encuentra. */
  keywords?: string;
  disabled?: boolean;
}

export interface ComboboxProps {
  value: string | null;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  invalid?: boolean;
  size?: 'sm' | 'md';
  id?: string;
  /** Clases del disparador. */
  className?: string;
  /** Clases de la lista; por defecto mide lo que el disparador (mínimo 220px). */
  contentClassName?: string;
  /** Sustituye el disparador entero (p. ej. un botón "+ Añadir"). Debe aceptar `ref` y props. */
  trigger?: React.ReactElement;
  /** La búsqueda aparece a partir de este número de opciones (por defecto 7). */
  searchFrom?: number;
  align?: 'start' | 'center' | 'end';
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Selector con búsqueda para listas largas (proyectos, personas, repos). Popover de Radix + una
 * lista con teclado (↑/↓, Enter, Esc); sin dependencia nueva. Para listas cortas y fijas sigue
 * siendo mejor `Select`.
 */
export function Combobox({
  value, onChange, options, placeholder = 'Elegir…', searchPlaceholder = 'Buscar…', emptyText = 'Sin resultados',
  disabled, invalid, size = 'md', id, className, contentClassName, trigger, searchFrom = 7, align = 'start',
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value) ?? null;
  const searchable = options.length >= searchFrom;

  const shown = React.useMemo(() => {
    const n = norm(q.trim());
    if (!n) return options;
    return options.filter((o) => norm(`${o.label} ${o.hint ?? ''} ${o.keywords ?? ''}`).includes(n));
  }, [options, q]);

  // Al abrir: búsqueda limpia y el cursor sobre la opción elegida.
  const onOpenChange = (next: boolean) => {
    if (disabled) return;
    if (next) {
      setQ('');
      const i = options.findIndex((o) => o.value === value);
      setActive(i < 0 ? 0 : i);
    }
    setOpen(next);
  };
  React.useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (o: ComboboxOption) => {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(shown.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = shown[active]; if (o) pick(o); }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild disabled={disabled}>
        {trigger ?? (
          <button
            type="button"
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-invalid={invalid || undefined}
            disabled={disabled}
            className={cn(
              fieldSkin,
              'flex w-full min-w-0 items-center gap-2 px-3 text-left data-[state=open]:border-ring data-[state=open]:ring-[3px] data-[state=open]:ring-ring/15',
              size === 'sm' ? 'h-8 text-[13px]' : 'h-9',
              className,
            )}
          >
            {selected?.icon && <span className="flex shrink-0 items-center">{selected.icon}</span>}
            <span className={cn('min-w-0 flex-1 truncate', !selected && 'text-faint')}>{selected?.label ?? placeholder}</span>
            <ChevronDown className={cn('size-4 shrink-0 opacity-50 transition-transform duration-150', open && 'rotate-180')} />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={4}
        onKeyDown={onKey}
        className={cn('w-[var(--radix-popover-trigger-width)] min-w-[220px] overflow-hidden p-0', contentClassName)}
      >
        {searchable && (
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-3.5 shrink-0 text-faint" />
            <input
              autoFocus
              value={q}
              onChange={(e) => { setQ(e.target.value); setActive(0); }}
              placeholder={searchPlaceholder}
              className="h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
            />
          </div>
        )}
        <div
          ref={listRef}
          role="listbox"
          tabIndex={searchable ? -1 : 0}
          className="scroll-thin max-h-64 overflow-y-auto p-1 outline-none"
        >
          {shown.length === 0 && <p className="px-2 py-5 text-center text-[12.5px] text-faint">{emptyText}</p>}
          {shown.map((o, i) => {
            const isSel = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={isSel}
                data-idx={i}
                disabled={o.disabled}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] outline-none transition-colors disabled:pointer-events-none disabled:opacity-45',
                  i === active && 'bg-panel',
                  isSel && 'font-medium',
                )}
              >
                {o.icon && <span className="flex shrink-0 items-center">{o.icon}</span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{o.label}</span>
                  {o.hint && <span className="block truncate text-[11.5px] font-normal text-faint">{o.hint}</span>}
                </span>
                {isSel && <Check className="size-3.5 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
