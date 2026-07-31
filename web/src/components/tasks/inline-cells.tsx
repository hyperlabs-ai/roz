// Celdas editables en la propia fila, al estilo de la tabla de tareas de Ops: el valor se ve como
// texto hasta que lo tocas, y el control aparece donde estaba. Sin modo "editando" explícito ni
// botón de guardar — cada cambio dispara su PATCH.
//
// RENDIMIENTO — por qué el control NO está siempre montado:
// cada Select/Popover de Radix trae su contexto, sus refs y sus listeners. Con 300 tareas en
// pantalla y 6 controles por fila eso son ~1800 componentes vivos, y expandir un grupo grande
// congelaba la vista varios segundos. Aquí la celda en reposo es un `<button>` y nada más; el
// control de Radix se monta en el primer clic, ya abierto (`defaultOpen`), y se desmonta al
// cerrarse. Para quien la usa el gesto es el mismo — un clic y el desplegable está abierto.
import { useState, type ReactNode } from 'react';
import { CalendarDays, Check, Circle, CircleCheck, CircleDashed, CircleDot, CircleDotDashed, CircleSlash } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Badge } from '@/components/ui/badge';
import { UserAvatar, AvatarStack } from '@/components/bits';
import { STATE_LABEL, stateBadgeVariant, PRIO_LABEL, PRIO_DOT } from '@/lib/labels';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/utils';

export const NONE = '__none__'; // centinela: los Select de Radix no aceptan value=""

// Disparador compartido: invisible en reposo, con fondo al hover. Sin esto cada celda tendría su
// propio borde y la tabla parecería una hoja de cálculo.
// En escritorio la celda llena su columna (`w-full`), y así toda la columna es clicable. En móvil
// no hay columnas: las celdas van en fila, y con `w-full` cada una se llevaba el ancho completo y
// `flex-wrap` las mandaba a líneas separadas — de ahí que se vieran apiladas una por línea.
const CELL_BASE = 'flex h-8 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors hover:bg-accent';
const TRIGGER_BASE = 'h-8 justify-start gap-1 rounded-md border-0 bg-transparent px-1.5 text-left shadow-none ring-offset-0 focus:ring-1 focus:ring-ring [&>svg]:hidden';

const cell = (compact?: boolean) => cn(CELL_BASE, compact ? 'w-auto' : 'w-full');
const trigger = (compact?: boolean) => cn(TRIGGER_BASE, compact ? 'w-auto' : 'w-full');

// ---- Ícono de estado (la firma visual, estilo Linear) ----
const STATUS_ICON: Record<string, { Icon: typeof Circle; cls: string }> = {
  planificada: { Icon: CircleDashed, cls: 'text-muted-foreground' },
  pendiente: { Icon: Circle, cls: 'text-muted-foreground' },
  en_progreso: { Icon: CircleDot, cls: 'text-chart-1' },
  revision: { Icon: CircleDotDashed, cls: 'text-warning' },
  completada: { Icon: CircleCheck, cls: 'text-success' },
  cancelada: { Icon: CircleSlash, cls: 'text-muted-foreground' },
  // Heredados de Linear (work items que nunca se reconvirtieron)
  backlog: { Icon: CircleDashed, cls: 'text-muted-foreground' },
  triage: { Icon: CircleDashed, cls: 'text-muted-foreground' },
  unstarted: { Icon: Circle, cls: 'text-muted-foreground' },
  started: { Icon: CircleDot, cls: 'text-chart-1' },
  in_progress: { Icon: CircleDot, cls: 'text-chart-1' },
  review: { Icon: CircleDotDashed, cls: 'text-warning' },
  completed: { Icon: CircleCheck, cls: 'text-success' },
  done: { Icon: CircleCheck, cls: 'text-success' },
  canceled: { Icon: CircleSlash, cls: 'text-muted-foreground' },
};

export function StatusIcon({ state, className }: { state: string; className?: string }) {
  const s = STATUS_ICON[state] ?? { Icon: Circle, cls: 'text-muted-foreground' };
  return <s.Icon className={cn('size-[18px] shrink-0', s.cls, className)} />;
}

// ---- Casilla de selección ----
export function RowCheck({ checked, onChange, label }: { checked: boolean; onChange: (e: React.MouseEvent) => void; label: string }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={() => {}}
      onClick={onChange}
      className="size-4 cursor-pointer rounded border-border accent-primary"
    />
  );
}

/**
 * Envoltura que difiere el montaje del control pesado. En reposo pinta `display` dentro de un
 * botón; al activarse llama a `render` y deja que ese control se muestre ya abierto.
 */
function Deferred({ display, render, ariaLabel, className, compact }: {
  display: ReactNode;
  render: (close: () => void) => ReactNode;
  ariaLabel: string;
  className?: string;
  compact?: boolean;
}) {
  const [active, setActive] = useState(false);
  if (active) return <>{render(() => setActive(false))}</>;
  return (
    <button type="button" onClick={() => setActive(true)} className={cn(cell(compact), className)} aria-label={ariaLabel}>
      {display}
    </button>
  );
}

// ---- Estado ----
export function StateCell({ value, options, onSave, compact }: {
  value: string; options: { value: string; label: string }[]; onSave: (v: string) => void; compact?: boolean;
}) {
  const badge = (
    <Badge variant={stateBadgeVariant(value)} className="px-2 py-0.5 text-xs font-medium">
      {STATE_LABEL[value] ?? value}
    </Badge>
  );
  return (
    <Deferred
      ariaLabel="Estado"
      display={badge}
      compact={compact}
      render={(close) => (
        <Select
          defaultOpen
          value={value}
          onValueChange={(v) => { close(); onSave(v); }}
          onOpenChange={(o) => { if (!o) close(); }}
        >
          <SelectTrigger className={trigger(compact)}>{badge}</SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                <span className="flex items-center gap-2">
                  <StatusIcon state={o.value} className="size-4" />
                  {o.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    />
  );
}

// ---- Select genérico diferido (prioridad, proyecto) ----
function DeferredSelect({ value, options, onSave, display, ariaLabel, contentClass, compact }: {
  value: string | null;
  options: { value: string; label: string }[];
  onSave: (v: string | null) => void;
  display: ReactNode;
  ariaLabel: string;
  contentClass?: string;
  compact?: boolean;
}) {
  return (
    <Deferred
      ariaLabel={ariaLabel}
      display={display}
      compact={compact}
      render={(close) => (
        <Select
          defaultOpen
          value={value ?? NONE}
          onValueChange={(v) => { close(); onSave(v === NONE ? null : v); }}
          onOpenChange={(o) => { if (!o) close(); }}
        >
          <SelectTrigger className={trigger(compact)}>{display}</SelectTrigger>
          <SelectContent className={contentClass}>
            <SelectItem value={NONE}>—</SelectItem>
            {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    />
  );
}

export function PriorityCell({ value, options, onSave, compact }: {
  value: string | null; options: { value: string; label: string }[]; onSave: (v: string | null) => void; compact?: boolean;
}) {
  return (
    <DeferredSelect
      value={value} options={options} onSave={onSave} ariaLabel="Prioridad" compact={compact}
      display={value ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn('size-2 shrink-0 rounded-full', PRIO_DOT[value] ?? 'bg-muted')} />
          <span className="truncate text-[13px]">{PRIO_LABEL[value] ?? value}</span>
        </span>
      ) : (
        <span className="text-[13px] text-muted-foreground/60">—</span>
      )}
    />
  );
}

export function ProjectCell({ value, options, onSave, compact }: {
  value: string | null; options: { value: string; label: string }[]; onSave: (v: string | null) => void; compact?: boolean;
}) {
  const name = options.find((o) => o.value === value)?.label;
  return (
    <DeferredSelect
      value={value} options={options} onSave={onSave} ariaLabel="Proyecto" contentClass="max-h-72" compact={compact}
      display={<span className={cn('truncate text-[13px]', !name && 'text-muted-foreground/60')}>{name ?? '—'}</span>}
    />
  );
}

// ---- Fecha ----
/** Calendario propio (react-day-picker), no el del navegador. Se guarda como YYYY-MM-DD leyendo
 *  los componentes LOCALES: toISOString() pasa a UTC y en México corre el día. */
export function DateCell({ value, overdue, onSave, compact }: {
  value: string | null; overdue?: boolean; onSave: (v: string | null) => void; compact?: boolean;
}) {
  const selected = value ? new Date(`${value.slice(0, 10)}T12:00:00`) : undefined;
  const display = (
    <>
      <CalendarDays className="size-3.5 shrink-0 opacity-60" />
      <span className="truncate">{value ? shortDate(value) : '—'}</span>
    </>
  );

  return (
    <Deferred
      ariaLabel="Fecha límite"
      className={cn('text-[13px]', overdue ? 'font-medium text-destructive' : 'text-muted-foreground')}
      display={display}
      compact={compact}
      render={(close) => {
        const pick = (d: Date | undefined) => {
          close();
          if (!d) return onSave(null);
          onSave(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
        };
        return (
          <Popover defaultOpen onOpenChange={(o) => { if (!o) close(); }}>
            <PopoverTrigger asChild>
              <button type="button" className={cn(cell(compact), 'text-[13px]', overdue ? 'font-medium text-destructive' : 'text-muted-foreground')}>
                {display}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar mode="single" selected={selected} onSelect={pick} defaultMonth={selected} />
              {value && (
                <div className="border-t p-2">
                  <button
                    type="button"
                    onClick={() => pick(undefined)}
                    className="w-full rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    Quitar fecha
                  </button>
                </div>
              )}
            </PopoverContent>
          </Popover>
        );
      }}
    />
  );
}

// ---- Responsables (multi) ----
export function AssigneesCell({ value, devs, onSave, compact }: {
  value: { id: string; name: string; avatarUrl: string | null }[];
  devs: { id: string; name: string; avatarUrl?: string | null }[];
  onSave: (ids: string[]) => void;
  compact?: boolean;
}) {
  const ids = value.map((v) => v.id);
  const display = value.length
    ? <AvatarStack people={value} max={3} size="size-6" />
    : <span className="text-[13px] text-muted-foreground/60">—</span>;

  return (
    <Deferred
      ariaLabel="Responsables"
      display={display}
      compact={compact}
      render={(close) => (
        <Popover defaultOpen onOpenChange={(o) => { if (!o) close(); }}>
          <PopoverTrigger asChild>
            <button type="button" className={cell(compact)}>{display}</button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-1" align="start">
            <div className="scroll-thin max-h-64 overflow-y-auto">
              {devs.map((d) => {
                const on = ids.includes(d.id);
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => onSave(on ? ids.filter((x) => x !== d.id) : [...ids, d.id])}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                  >
                    <UserAvatar url={d.avatarUrl ?? null} name={d.name} className="size-5" />
                    <span className="min-w-0 flex-1 truncate">{d.name}</span>
                    {on && <Check className="size-3.5 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}
    />
  );
}
