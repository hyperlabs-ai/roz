// Lista densa del equipo: una fila por persona, sin un solo input. Se lee de izquierda a derecha
// como una frase — quién es, en qué está puesto, cuánto se lleva eso y cómo queda — y un click en
// la fila abre el panel lateral donde se edita (`PersonSheet`).
import type { KeyboardEvent } from 'react';
import { ChevronRight, Wrench } from 'lucide-react';
import { ProgressBar } from '@/components/bits';
import { CapsLabel } from '@/components/brand';
import { PersonAvatar } from '@/components/avatars';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { CapacityDev } from '@/lib/api';
import { AssignmentChip, groupMeta, OverAssignedFlag, personLine, StatePill } from './cells';

/** Mismas pistas en cabecera, filas y esqueleto: así las columnas quedan alineadas. */
const ROW_GRID = 'lg:grid-cols-[minmax(220px,260px)_minmax(0,1fr)_180px_150px_16px]';

export function PeopleListHeader() {
  return (
    <div className={cn('hidden gap-5 border-b bg-sidebar px-4 py-2 lg:grid', ROW_GRID)}>
      <CapsLabel>Persona</CapsLabel>
      <CapsLabel>Asignaciones</CapsLabel>
      <CapsLabel>Carga</CapsLabel>
      <CapsLabel>Estado</CapsLabel>
      <span />
    </div>
  );
}

export function PersonRow({ dev, onOpen }: { dev: CapacityDev; onOpen: () => void }) {
  const g = groupMeta(dev);
  const assignments = [...dev.principal, ...dev.secondary];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={onKey}
      aria-label={`Editar la capacidad de ${dev.name}`}
      className={cn(
        'group grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 px-4 py-3 outline-none transition-colors hover:bg-sidebar focus-visible:bg-sidebar focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring lg:gap-5',
        ROW_GRID,
      )}
    >
      {/* Persona: avatar, nombre y "Rol · Dedicación · Horas" como texto. */}
      <div className={cn('flex min-w-0 items-center gap-3', !dev.active && 'opacity-60')}>
        <PersonAvatar url={dev.avatarUrl} id={dev.id} name={dev.name} presence={dev.active ? undefined : 'off'} className="size-9" />
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-semibold tracking-[-0.01em]">{dev.name}</p>
          <p className="truncate text-[12px] text-muted-foreground" title={dev.profile ?? undefined}>
            {personLine(dev)}
          </p>
        </div>
      </div>

      {/* Estado: en móvil va arriba a la derecha, junto a la persona. */}
      <div className="flex items-center justify-end gap-1.5 lg:order-4 lg:justify-start">
        <StatePill dev={dev} />
        <OverAssignedFlag dev={dev} />
      </div>

      {/* Asignaciones como chips (principales primero) + el trabajo continuo en una línea. */}
      <div className="col-span-2 min-w-0 lg:order-2 lg:col-span-1">
        {assignments.length ? (
          <div className="flex flex-wrap gap-1.5">
            {assignments.map((a) => <AssignmentChip key={a.id} a={a} className="max-w-[220px]" />)}
          </div>
        ) : (
          <span className="text-[12.5px] text-faint">Sin asignaciones</span>
        )}
        {dev.continuousWork && (
          <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground" title={dev.continuousWork}>
            <Wrench className="size-3 shrink-0 text-faint" />
            <span className="truncate">{dev.continuousWork.split('\n')[0]}</span>
          </p>
        )}
      </div>

      {/* Carga: % grande + horas, y la barra fina en el color de su estado. */}
      <div className="col-span-2 min-w-0 lg:order-3 lg:col-span-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[15px] font-semibold tracking-[-0.03em] tabular-nums">{dev.load.pct}%</span>
          <span className="text-[11.5px] tabular-nums text-muted-foreground">{dev.load.hoursUsed}/{dev.weeklyHours} h</span>
        </div>
        <ProgressBar pct={Math.min(100, dev.load.pct)} color={g.bar} className="mt-1.5" />
      </div>

      <ChevronRight className="hidden size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-foreground lg:order-5 lg:block" />
    </div>
  );
}

export function PersonRowSkeleton() {
  return (
    <div className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 px-4 py-3.5 lg:gap-5', ROW_GRID)} aria-hidden>
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-full" />
        <div className="grid gap-1.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-44" />
        </div>
      </div>
      <Skeleton className="h-5 w-24 rounded-full lg:order-4" />
      <div className="col-span-2 flex gap-1.5 lg:order-2 lg:col-span-1">
        <Skeleton className="h-6 w-32 rounded-md" />
        <Skeleton className="h-6 w-24 rounded-md" />
      </div>
      <div className="col-span-2 grid gap-2 lg:order-3 lg:col-span-1">
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-1.5 w-full rounded-full" />
      </div>
      <span className="hidden lg:order-5 lg:block" />
    </div>
  );
}
