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
import { CalendarDays, Check, ChevronUp, UserRound } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Badge } from '@/components/ui/badge';
import { UserAvatar, AvatarStack } from '@/components/bits';
import { ProjectIcon } from '@/components/avatars';
import { STATE_LABEL, stateBadgeVariant, PRIO_LABEL } from '@/lib/labels';
import { PriorityIcon, PropertyMenu, type PropOption } from '@/components/tasks/properties';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/utils';

export const NONE = '__none__'; // centinela: los Select de Radix no aceptan value=""

/**
 * Responsables de una tarea con el PRINCIPAL al frente.
 *
 * Vive junto a AssigneesCell porque es el mismo contrato que esa celda documenta y guarda: el
 * backend ya los devuelve asi (`orderedAssignees` en getTickets) y `updateTask` toma `[0]` como
 * primario. Lo consumen la tabla y el tablero, que necesitan saber quien encabeza la tarea para
 * pintarla y para agrupar por responsable.
 */
export function assigneesOf(t: {
  assignees?: { id: string; name: string; avatarUrl: string | null }[] | null;
  assignee?: { id: string; name: string; avatarUrl: string | null } | null;
}) {
  const list = t.assignees?.length ? t.assignees : t.assignee ? [t.assignee] : [];
  const primaryId = t.assignee?.id;
  if (!primaryId || list.length < 2) return list;
  const primary = list.filter((a) => a.id === primaryId);
  return primary.length ? [...primary, ...list.filter((a) => a.id !== primaryId)] : list;
}

// Disparador compartido: invisible en reposo, con fondo al hover. Sin esto cada celda tendría su
// propio borde y la tabla parecería una hoja de cálculo.
// En escritorio la celda llena su columna (`w-full`), y así toda la columna es clicable. En móvil
// no hay columnas: las celdas van en fila, y con `w-full` cada una se llevaba el ancho completo y
// `flex-wrap` las mandaba a líneas separadas — de ahí que se vieran apiladas una por línea.
const CELL_BASE = 'flex h-8 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors hover:bg-panel';
const TRIGGER_BASE = 'h-8 justify-start gap-1 rounded-md border-0 bg-transparent px-1.5 text-left shadow-none ring-offset-0 focus:ring-1 focus:ring-ring [&>svg]:hidden';

const cell = (compact?: boolean) => cn(CELL_BASE, compact ? 'w-auto' : 'w-full');
const trigger = (compact?: boolean) => cn(TRIGGER_BASE, compact ? 'w-auto' : 'w-full');

// ---- Ícono de estado (la firma visual, estilo Linear) ----
// Dibujados a mano, como los de Linear, en vez de aproximarlos con lucide: backlog punteado, por
// hacer vacío, en curso con media luna, revisión a tres cuartos, completada rellena con palomita y
// cancelada rellena con cruz. El color sale del token (currentColor); el trazo interior usa --card.
type StatusKind = 'backlog' | 'todo' | 'progress' | 'review' | 'done' | 'canceled';
const STATUS_ICON: Record<string, { kind: StatusKind; cls: string }> = {
  planificada: { kind: 'backlog', cls: 'text-faint' },
  pendiente: { kind: 'todo', cls: 'text-muted-foreground' },
  en_progreso: { kind: 'progress', cls: 'text-blue' },
  revision: { kind: 'review', cls: 'text-purple' },
  completada: { kind: 'done', cls: 'text-green' },
  cancelada: { kind: 'canceled', cls: 'text-faint' },
  // Heredados de Linear (work items que nunca se reconvirtieron)
  backlog: { kind: 'backlog', cls: 'text-faint' },
  triage: { kind: 'backlog', cls: 'text-faint' },
  unstarted: { kind: 'todo', cls: 'text-muted-foreground' },
  started: { kind: 'progress', cls: 'text-blue' },
  in_progress: { kind: 'progress', cls: 'text-blue' },
  review: { kind: 'review', cls: 'text-purple' },
  completed: { kind: 'done', cls: 'text-green' },
  done: { kind: 'done', cls: 'text-green' },
  canceled: { kind: 'canceled', cls: 'text-faint' },
};

export function StatusIcon({ state, className }: { state: string; className?: string }) {
  const s = STATUS_ICON[state] ?? { kind: 'todo' as StatusKind, cls: 'text-muted-foreground' };
  const inner = { stroke: 'hsl(var(--card))', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return (
    <svg viewBox="0 0 14 14" fill="none" aria-hidden className={cn('size-[18px] shrink-0', s.cls, className)}>
      {s.kind === 'backlog' && <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1.6 2.02" strokeLinecap="round" />}
      {s.kind === 'todo' && <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.5" />}
      {(s.kind === 'progress' || s.kind === 'review') && (
        <>
          <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.5" />
          <path d={s.kind === 'progress' ? 'M7 3.6A3.4 3.4 0 0 1 7 10.4Z' : 'M7 3.6A3.4 3.4 0 1 1 3.6 7H7Z'} fill="currentColor" />
        </>
      )}
      {s.kind === 'done' && (
        <>
          <circle cx="7" cy="7" r="6.5" fill="currentColor" />
          <path d="M4.3 7.2 6.2 9.1 9.8 5.2" {...inner} />
        </>
      )}
      {s.kind === 'canceled' && (
        <>
          <circle cx="7" cy="7" r="6.5" fill="currentColor" />
          <path d="M4.9 4.9 9.1 9.1M9.1 4.9 4.9 9.1" {...inner} />
        </>
      )}
    </svg>
  );
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
      className="size-4 cursor-pointer rounded-sm border-border accent-orange"
    />
  );
}

/**
 * Envoltura que difiere el montaje del control pesado. En reposo pinta `display` dentro de un
 * botón; al activarse llama a `render` y deja que ese control se muestre ya abierto.
 */
function Deferred({ display, render, ariaLabel, className, compact, forceOpen, onForceClose }: {
  display: ReactNode;
  render: (close: () => void) => ReactNode;
  ariaLabel: string;
  className?: string;
  compact?: boolean;
  /** Abierto desde fuera (atajo de teclado sobre la fila). */
  forceOpen?: boolean;
  onForceClose?: () => void;
}) {
  const [active, setActive] = useState(false);
  if (active || forceOpen) return <>{render(() => { setActive(false); onForceClose?.(); })}</>;
  return (
    <button type="button" onClick={() => setActive(true)} className={cn(cell(compact), className)} aria-label={ariaLabel}>
      {display}
    </button>
  );
}

/** Disparador de solo ícono (estado, prioridad) de la fila estilo Linear. */
export const ICON_CELL =
  'grid size-6 shrink-0 place-items-center rounded-md transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-panel';
/** Disparador tipo chip (proyecto) de la fila. */
export const CHIP_CELL =
  'inline-flex h-6 max-w-[11rem] shrink-0 items-center gap-1.5 rounded-full border bg-card px-2 text-[12px] text-muted-foreground transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-panel';

/**
 * Celda con menú de propiedad (búsqueda + teclado, el mismo `PropertyMenu` del modal), montado solo
 * al abrirse: en reposo es un `<button>`. `forceOpen` lo abre desde un atajo (S / P sobre la fila).
 */
export function MenuCell({ title, shortcut, options, value, onSave, children, className = ICON_CELL, forceOpen, onForceClose, align }: {
  title: string;
  shortcut?: string;
  options: PropOption[];
  value: string | null;
  onSave: (v: string) => void;
  children: ReactNode;
  className?: string;
  forceOpen?: boolean;
  onForceClose?: () => void;
  align?: 'start' | 'center' | 'end';
}) {
  const [active, setActive] = useState(false);
  if (!active && !forceOpen) {
    return (
      <button type="button" onClick={() => setActive(true)} className={className} aria-label={title} title={shortcut ? `${title} · tecla ${shortcut}` : title}>
        {children}
      </button>
    );
  }
  return (
    <PropertyMenu
      title={title}
      shortcut={shortcut}
      options={options}
      value={value}
      onSelect={onSave}
      open
      onOpenChange={(o) => { if (!o) { setActive(false); onForceClose?.(); } }}
      triggerClassName={className}
      align={align}
    >
      {children}
    </PropertyMenu>
  );
}

/** Opciones de estado y prioridad con sus íconos, listas para `MenuCell` / `PropertyMenu`. */
export const NO_PRIORITY = '__none__';
export function statusMenuOptions(options: { value: string; label: string }[]): PropOption[] {
  return options.map((o) => ({ value: o.value, label: o.label, icon: <StatusIcon state={o.value} className="size-4" /> }));
}
export function priorityMenuOptions(options: { value: string; label: string }[]): PropOption[] {
  return [
    { value: NO_PRIORITY, label: 'Sin prioridad', icon: <PriorityIcon value={null} /> },
    ...options.map((o) => ({ value: o.value, label: o.label, icon: <PriorityIcon value={o.value} /> })),
  ];
}

// ---- Estado ----
export function StateCell({ value, options, onSave, compact }: {
  value: string; options: { value: string; label: string }[]; onSave: (v: string) => void; compact?: boolean;
}) {
  const badge = (
    <Badge variant={stateBadgeVariant(value)} dot className="px-2 py-0.5 text-[11.5px] font-medium">
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
function DeferredSelect({ value, options, onSave, display, ariaLabel, contentClass, compact, renderOption }: {
  value: string | null;
  options: { value: string; label: string }[];
  onSave: (v: string | null) => void;
  display: ReactNode;
  ariaLabel: string;
  contentClass?: string;
  compact?: boolean;
  /** Contenido de cada opción (por defecto, la etiqueta). */
  renderOption?: (o: { value: string; label: string }) => ReactNode;
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
            {options.map((o) => <SelectItem key={o.value} value={o.value}>{renderOption ? renderOption(o) : o.label}</SelectItem>)}
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
          <PriorityIcon value={value} className="size-3.5" />
          <span className="truncate text-[13px]">{PRIO_LABEL[value] ?? value}</span>
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground/60"><PriorityIcon value={null} className="size-3.5" />—</span>
      )}
      renderOption={(o) => (
        <span className="flex items-center gap-2"><PriorityIcon value={o.value} />{o.label}</span>
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
      display={
        <span className="flex min-w-0 items-center gap-1.5">
          {name && <ProjectIcon id={value} size="xs" className="size-4" />}
          <span className={cn('truncate text-[13px]', !name && 'text-muted-foreground/60')}>{name ?? '—'}</span>
        </span>
      }
      renderOption={(o) => (
        <span className="flex items-center gap-2"><ProjectIcon id={o.value} size="xs" className="size-4" />{o.label}</span>
      )}
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
      className={cn('text-[13px]', overdue ? 'font-medium text-red' : 'text-muted-foreground')}
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
              <button type="button" className={cn(cell(compact), 'text-[13px]', overdue ? 'font-medium text-red' : 'text-muted-foreground')}>
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
                    className="w-full rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-panel hover:text-foreground"
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
/**
 * Responsables de una tarea. `value` viene con el PRINCIPAL al frente (lo garantizan
 * `orderedAssignees` en el backend y `assigneesOf` en la lista): el primero es el responsable y el
 * resto es apoyo. La distinción se pinta — el principal a opacidad completa, el apoyo atenuado —
 * porque "quién la saca" y "quién ayuda" no son lo mismo al repartir trabajo.
 *
 * El orden también manda al guardar: updateTask toma `[0]` como primario, y este control preserva
 * la posición (quita por filtro, agrega al final), así que agregar apoyo nunca degrada al
 * responsable.
 */
export function AssigneesCell({ value, devs, onSave, compact, forceOpen, onForceClose, align = 'start' }: {
  value: { id: string; name: string; avatarUrl: string | null }[];
  devs: { id: string; name: string; avatarUrl?: string | null }[];
  onSave: (ids: string[]) => void;
  compact?: boolean;
  forceOpen?: boolean;
  onForceClose?: () => void;
  align?: 'start' | 'end';
}) {
  const ids = value.map((v) => v.id);
  const [primary, ...support] = value;
  const display = value.length
    ? (
        <span className="flex items-center gap-1">
          <UserAvatar
            url={primary.avatarUrl}
            id={primary.id}
            name={primary.name}
            className="size-6 ring-2 ring-background"
            title={`Responsable · ${primary.name}`}
          />
          {support.length > 0 && (
            <span className="opacity-55" title={`Apoyo · ${support.map((s) => s.name).join(', ')}`}>
              <AvatarStack people={support} max={2} size="size-5" />
            </span>
          )}
        </span>
      )
    : (
        // Sin responsable: el círculo punteado de Linear, no un guion.
        <span className="grid size-6 place-items-center rounded-full border border-dashed border-faint/70 text-faint" title="Sin responsable">
          <UserRound className="size-3" />
        </span>
      );

  return (
    <Deferred
      ariaLabel="Responsables"
      display={display}
      compact={compact}
      forceOpen={forceOpen}
      onForceClose={onForceClose}
      render={(close) => (
        <Popover defaultOpen onOpenChange={(o) => { if (!o) close(); }}>
          <PopoverTrigger asChild>
            <button type="button" className={cell(compact)}>{display}</button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-1" align={align}>
            <p className="px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">
              El primero es el responsable; los demás, apoyo.
            </p>
            <div className="scroll-thin max-h-64 overflow-y-auto">
              {devs.map((d) => {
                const at = ids.indexOf(d.id);
                const on = at >= 0;
                return (
                  // Fila, no botón: el apoyo lleva DENTRO su propia acción para ascender, y un
                  // botón dentro de otro no es HTML válido.
                  <div key={d.id} className="flex items-center rounded-md transition-colors hover:bg-panel">
                    <button
                      type="button"
                      onClick={() => onSave(on ? ids.filter((x) => x !== d.id) : [...ids, d.id])}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
                    >
                      <UserAvatar url={d.avatarUrl ?? null} id={d.id} name={d.name} className={cn('size-5 shrink-0', on && at > 0 && 'opacity-55')} />
                      <span className="min-w-0 flex-1 truncate">{d.name}</span>
                      {on && (
                        <span className="shrink-0 label-caps text-faint">
                          {at === 0 ? 'Responsable' : 'Apoyo'}
                        </span>
                      )}
                      {on && <Check className="size-3.5 shrink-0 text-orange" />}
                    </button>
                    {/* Ascender a responsable. Sin esto, cambiar quién saca la tarea obligaba a
                        quitar a todos y volver a agregarlos en el orden correcto. */}
                    {on && at > 0 && (
                      <button
                        type="button"
                        onClick={() => onSave([d.id, ...ids.filter((x) => x !== d.id)])}
                        className="mr-1 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                        title="Hacer responsable"
                        aria-label={`Hacer responsable a ${d.name}`}
                      >
                        <ChevronUp className="size-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}
    />
  );
}
