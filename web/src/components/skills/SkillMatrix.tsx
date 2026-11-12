import { useState } from 'react';
import { GraduationCap } from 'lucide-react';
import { EmptyState } from '@/components/bits';
import { GithubAvatar } from '@/components/brand';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { EXPERT_LEVEL, HEALTH, LEVEL_LABEL, cellKey, cellStyle, type Dev, type Selection, type SkillRow } from './levels';

/**
 * Heatmap equipo × habilidad: skills en filas (nombre fijo a la izquierda), personas en columnas.
 * Click en el nombre de una skill o en un avatar la selecciona (el panel de la derecha muestra su
 * detalle) y atenúa el resto para que se lea solo esa fila o columna.
 */
export function SkillMatrix({
  devs,
  rows,
  levels,
  isAdmin,
  isBusy,
  onSet,
  selection,
  onSelect,
}: {
  devs: Dev[];
  rows: SkillRow[];
  levels: Map<string, number>;
  isAdmin: boolean;
  isBusy: (id: string) => boolean;
  onSet: (devId: string, skillId: string, level: number) => Promise<void>;
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  // Guía de fila/columna bajo el cursor: en una matriz de 20×8 es lo que deja leer de quién y de
  // qué es la celda sin recorrer con la vista hasta los encabezados.
  const [hover, setHover] = useState<{ devId: string | null; skillId: string | null } | null>(null);

  if (!devs.length || !rows.length) {
    return (
      <EmptyState icon={<GraduationCap />}>
        {!rows.length ? 'Todavía no hay skills. Crea la primera con "Nueva skill".' : 'No hay personas activas para mapear.'}
      </EmptyState>
    );
  }

  const toggle = (s: NonNullable<Selection>) =>
    onSelect(selection?.kind === s.kind && selection.id === s.id ? null : s);
  const inFocus = (devId: string, skillId: string) =>
    !selection || (selection.kind === 'skill' ? selection.id === skillId : selection.id === devId);

  return (
    // `onMouseLeave` en el contenedor y no en cada celda: al cruzar el hueco entre dos celdas la
    // guía de fila/columna no parpadea.
    <div className="scroll-thin overflow-x-auto pb-1" onMouseLeave={() => setHover(null)}>
      <table className="border-separate border-spacing-1 sm:border-spacing-1.5">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-card pb-2 pl-2 text-left align-bottom">
              <span className="label-caps text-faint">{rows.length} skills</span>
            </th>
            {devs.map((d) => {
              const active = selection?.kind === 'dev' && selection.id === d.id;
              const hovered = hover?.devId === d.id;
              return (
                <th key={d.id} className="px-0 pb-1.5 align-bottom font-normal">
                  <button
                    type="button"
                    onClick={() => toggle({ kind: 'dev', id: d.id })}
                    onMouseEnter={() => setHover({ devId: d.id, skillId: null })}
                    aria-pressed={active}
                    title={d.name}
                    className={cn(
                      'mx-auto grid w-7 justify-items-center gap-1 rounded-md py-1 transition-[background-color,opacity] duration-fast sm:w-10',
                      active ? 'bg-orange-soft' : hovered && 'bg-sidebar',
                      selection && !active && selection.kind === 'dev' && 'opacity-50',
                    )}
                  >
                    <GithubAvatar
                      url={d.avatarUrl}
                      id={d.id}
                      name={d.name}
                      className={cn('size-6 sm:size-7', active && 'ring-2 ring-orange ring-offset-1 ring-offset-card')}
                    />
                    <span
                      className={cn(
                        'hidden w-full truncate text-center text-[10px] leading-none sm:block',
                        active ? 'font-semibold text-orange-ink' : hovered ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {d.name.split(' ')[0]}
                    </span>
                  </button>
                </th>
              );
            })}
            <th className="pb-2 pl-1.5 text-right align-bottom sm:pl-2.5">
              <Tooltip>
                <TooltipTrigger asChild><span className="label-caps cursor-default text-faint">Exp.</span></TooltipTrigger>
                <TooltipContent>Personas expertas (nivel {EXPERT_LEVEL}+) que sostienen la skill</TooltipContent>
              </Tooltip>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const active = selection?.kind === 'skill' && selection.id === s.id;
            const hovered = hover?.skillId === s.id;
            const experts = devs.filter((d) => (levels.get(cellKey({ devId: d.id, skillId: s.id })) ?? 0) >= EXPERT_LEVEL).length;
            const health = HEALTH[experts >= 2 ? 'backed' : experts === 1 ? 'single' : 'none'];
            return (
              <tr key={s.id}>
                <td className="sticky left-0 z-10 bg-card p-0 pr-1.5 sm:pr-2.5">
                  <button
                    type="button"
                    onClick={() => toggle({ kind: 'skill', id: s.id })}
                    onMouseEnter={() => setHover({ devId: null, skillId: s.id })}
                    aria-pressed={active}
                    title={s.tag}
                    className={cn(
                      'block w-full min-w-[68px] max-w-[110px] truncate rounded-md px-2 py-1.5 text-left text-xs font-semibold transition-colors duration-fast sm:min-w-[120px] sm:max-w-[168px] sm:text-[13px]',
                      active ? 'bg-orange-soft text-orange-ink' : hovered ? 'bg-sidebar' : 'hover:bg-sidebar',
                    )}
                  >
                    {s.tag}
                  </button>
                </td>
                {devs.map((d) => {
                  const id = cellKey({ devId: d.id, skillId: s.id });
                  return (
                    <td key={d.id} className="p-0" onMouseEnter={() => setHover({ devId: d.id, skillId: s.id })}>
                      <SkillCell
                        devName={d.name}
                        devId={d.id}
                        skillTag={s.tag}
                        level={levels.get(id) ?? 0}
                        isAdmin={isAdmin}
                        busy={isBusy(id)}
                        dim={!inFocus(d.id, s.id)}
                        guide={!!hover && (hover.devId === d.id || hover.skillId === s.id)}
                        onFocus={() => onSelect({ kind: 'skill', id: s.id })}
                        onSet={(n) => onSet(d.id, s.id, n)}
                      />
                    </td>
                  );
                })}
                <td className="p-0 pl-1.5 sm:pl-2.5">
                  <span
                    className={cn(
                      'ml-auto flex w-fit items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums transition-opacity',
                      health.chip,
                      selection && !active && selection.kind === 'skill' && 'opacity-40',
                    )}
                    title={health.label}
                  >
                    <span className={cn('size-1.5 rounded-full', health.dot)} />
                    {experts}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Leyenda de la escala con el nombre de cada nivel (el número solo no dice qué significa). */
export function LevelLegend({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', className)}>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-5 rounded" style={cellStyle(0)} />
        <span className="text-[12px] text-faint">Sin nivel</span>
      </span>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className="inline-flex items-center gap-1.5">
          <span className="grid size-5 place-items-center rounded text-[10px] font-semibold tabular-nums" style={cellStyle(n)}>
            {n}
          </span>
          <span className={cn('text-[12px]', n >= 4 ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{LEVEL_LABEL[n]}</span>
        </span>
      ))}
    </div>
  );
}

function SkillCell({
  devId,
  devName,
  skillTag,
  level,
  isAdmin,
  busy,
  dim,
  guide,
  onFocus,
  onSet,
}: {
  devId: string;
  devName: string;
  skillTag: string;
  level: number;
  isAdmin: boolean;
  busy: boolean;
  dim: boolean;
  /** La celda está en la fila o columna bajo el cursor. */
  guide: boolean;
  onFocus: () => void;
  onSet: (level: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const cell = (
    <button
      type="button"
      onClick={onFocus}
      className={cn(
        'mx-auto flex size-7 items-center justify-center rounded-md text-xs font-semibold tabular-nums transition-[opacity,box-shadow] duration-fast sm:size-10 sm:text-[13px]',
        'hover:ring-2 hover:ring-ring hover:ring-offset-1 hover:ring-offset-card',
        // Celda vacía en la guía: un borde tenue marca la fila/columna sin pintar un bloque.
        guide && !level && 'ring-1 ring-inset ring-border',
        dim && 'opacity-30',
        busy && 'animate-pulse',
      )}
      style={cellStyle(level)}
      aria-label={`${devName} · ${skillTag}: ${LEVEL_LABEL[level] ?? level}`}
    >
      {level || ''}
    </button>
  );

  if (!isAdmin)
    return (
      <Tooltip>
        <TooltipTrigger asChild>{cell}</TooltipTrigger>
        <TooltipContent>{devName} · {skillTag}: {level ? `${level} · ${LEVEL_LABEL[level]}` : 'sin nivel'}</TooltipContent>
      </Tooltip>
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{cell}</PopoverTrigger>
      <PopoverContent className="w-auto p-3">
        <div className="mb-2.5 flex items-center gap-2 text-xs">
          <GithubAvatar id={devId} name={devName} className="size-5" />
          <span className="text-muted-foreground">{devName} · <span className="font-medium text-foreground">{skillTag}</span></span>
        </div>
        <div className="flex gap-1.5">
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              // El popover se cierra CUANDO TERMINA, no antes: cerrarlo primero dejaba al usuario
              // mirando la celda con el valor viejo y un toast que afirmaba el nuevo.
              onClick={() => { void onSet(n).finally(() => setOpen(false)); }}
              disabled={busy}
              title={n === 0 ? 'Quitar' : `${n} · ${LEVEL_LABEL[n]}`}
              className={cn(
                'flex size-9 items-center justify-center rounded-md text-sm font-semibold tabular-nums transition-all hover:ring-2 hover:ring-ring disabled:opacity-50',
                n === level && 'ring-2 ring-ring ring-offset-1 ring-offset-popover',
              )}
              style={n === 0 ? { backgroundColor: 'hsl(var(--panel))', color: 'hsl(var(--muted-foreground))' } : cellStyle(n)}
            >
              {n || '–'}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11.5px] text-muted-foreground">{level ? LEVEL_LABEL[level] : 'Sin nivel'}</p>
      </PopoverContent>
    </Popover>
  );
}
