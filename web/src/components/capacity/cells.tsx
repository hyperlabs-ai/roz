// Piezas compartidas de Capacidad: el estado de carga (píldora y grupo de filtro), el chip de una
// asignación y el resumen de la persona. Las usan la lista (`PeopleList`), la gráfica
// (`LoadChart`) y el panel lateral de edición (`PersonSheet`), así que la misma asignación se lee
// igual en las tres.
//
// Regla de la pantalla: aquí NO se edita nada. Toda edición vive en el panel lateral; la lista y
// la gráfica solo pintan lo que el backend ya calculó (`dev.load`).
import { AlertTriangle } from 'lucide-react';
import { ProjectIcon } from '@/components/avatars';
import type { BrandColor } from '@/components/brand';
import { COMMITMENT_SHORT, LOAD_STATE, ROLE_LABEL } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { CapacityAssignment, CapacityDev, LoadState } from '@/lib/api';

export interface CapacityActions {
  patchDev: (devId: string, patch: Record<string, unknown>) => Promise<void>;
  addAssignment: (devId: string, body: Record<string, unknown>) => Promise<void>;
  patchAssignment: (id: string, body: Record<string, unknown>) => Promise<void>;
  removeAssignment: (id: string) => Promise<void>;
  /** false = solo lectura. Las piezas se pintan igual, pero sin controles. */
  canEdit: boolean;
}

// ---------------------------------------------------------------- estado de carga

/**
 * Los cinco estados del backend se agrupan en tres para el filtro y la leyenda: lo que importa al
 * repartir trabajo es "le cabe más / está bien / no le cabe". Una persona con más principales de
 * las que permite su dedicación cuenta como saturada aunque su % no pase de 100 — es la misma
 * regla que usa `totals.saturated` en el backend.
 */
export type LoadGroup = 'holgura' | 'optima' | 'saturada';

/**
 * Color por GRUPO (no por los cinco estados): la gráfica, la leyenda y la píldora de la lista usan
 * los mismos tres colores, así que una columna azul en la gráfica es una píldora azul en la lista.
 * La etiqueta de la píldora sí dice el estado fino del backend ("Carga completa").
 */
export const LOAD_GROUPS: { value: LoadGroup; label: string; dot: string; pill: string; bar: BrandColor; states: LoadState[] }[] = [
  { value: 'holgura', label: 'Con holgura', dot: 'bg-blue', pill: 'bg-blue-soft text-blue-ink', bar: 'blue', states: ['libre', 'disponible'] },
  { value: 'optima', label: 'Óptima', dot: 'bg-orange', pill: 'bg-orange-soft text-orange-ink', bar: 'orange', states: ['optima', 'completa'] },
  { value: 'saturada', label: 'Saturada', dot: 'bg-red', pill: 'bg-red-soft text-red', bar: 'red', states: ['saturada'] },
];

export function loadGroup(dev: CapacityDev): LoadGroup {
  if (dev.load.overAssigned || dev.load.state === 'saturada') return 'saturada';
  if (dev.load.state === 'optima' || dev.load.state === 'completa') return 'optima';
  return 'holgura';
}

export function groupMeta(dev: CapacityDev) {
  const g = loadGroup(dev);
  return LOAD_GROUPS.find((x) => x.value === g) ?? LOAD_GROUPS[0];
}

/** Etiqueta fina del estado ("Carga completa"); con principales de más, "Sobreasignada". */
export function stateLabel(dev: CapacityDev): string {
  if (dev.load.overAssigned && dev.load.state !== 'saturada') return 'Sobreasignada';
  return (LOAD_STATE[dev.load.state] ?? LOAD_STATE.libre).label;
}

/** Píldora de estado (par suave/tinta de la tabla de chips), en el color de su grupo. */
export function StatePill({ dev, className }: { dev: CapacityDev; className?: string }) {
  const g = groupMeta(dev);
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium', g.pill, className)}>
      <span className={cn('size-1.5 rounded-full', g.dot)} />
      {stateLabel(dev)}
    </span>
  );
}

/** Aviso de "más principales de las que caben": el único estado que no sale del %. */
export function OverAssignedFlag({ dev }: { dev: CapacityDev }) {
  if (!dev.load.overAssigned) return null;
  return (
    <span
      title={`${dev.principal.length} principales y su dedicación admite ${dev.load.maxPrincipal}`}
      className="inline-flex items-center gap-1 rounded-full bg-red-soft px-1.5 py-0.5 text-[11px] font-medium text-red"
    >
      <AlertTriangle className="size-3" />
      {dev.principal.length}/{dev.load.maxPrincipal}
    </span>
  );
}

// ---------------------------------------------------------------- texto de la persona

/** "Developer · Full-time · 40 h" — rol y dedicación como texto, no como controles. */
export function personLine(dev: CapacityDev): string {
  return [ROLE_LABEL[dev.role] ?? dev.role, COMMITMENT_SHORT[dev.commitment], `${dev.weeklyHours} h`].join(' · ');
}

/** "32 de 40 h · 8 h libres" / "· 20% de más". */
export function hoursLine(dev: CapacityDev): string {
  const tail = dev.load.pct > 100
    ? ` · ${dev.load.pct - 100}% de más`
    : dev.load.hoursFree > 0 ? ` · ${dev.load.hoursFree} h libres` : '';
  return `${dev.load.hoursUsed} de ${dev.weeklyHours} h${tail}`;
}

// ---------------------------------------------------------------- chip de asignación

/**
 * Chip de una asignación: ícono Shapes del proyecto, nombre y su %. La principal va sobre tarjeta
 * con hairline; la secundaria, en gris y con el texto atenuado. La diferencia se lee sin leyenda
 * y sin una etiqueta extra por chip.
 */
export function AssignmentChip({ a, className }: { a: CapacityAssignment; className?: string }) {
  const principal = a.kind === 'principal';
  const name = a.projectName ?? 'Sin proyecto';
  return (
    <span
      title={[
        `${name}${a.repo ? ` · ${a.repo}` : ''}`,
        `${principal ? 'Principal' : 'Secundario'} · ${a.loadPct}% de su capacidad`,
        a.focus ?? '',
      ].filter(Boolean).join('\n')}
      className={cn(
        'inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md pl-1 pr-1.5 text-[12px]',
        principal ? 'border bg-card font-medium text-foreground' : 'bg-panel text-muted-foreground',
        className,
      )}
    >
      {a.projectId
        ? <ProjectIcon id={a.projectId} size="xs" />
        : <span aria-hidden className="size-3.5 shrink-0 rounded-[4px] border border-dashed border-faint" />}
      <span className={cn('min-w-0 truncate', !a.projectId && 'italic text-faint')}>{name}</span>
      <span className={cn('shrink-0 tabular-nums', principal ? 'text-orange-ink' : 'text-faint')}>{a.loadPct}%</span>
    </span>
  );
}
