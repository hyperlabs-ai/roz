import { useMemo, type ReactNode } from 'react';
import { CircleCheck, MousePointerClick, ShieldAlert, X } from 'lucide-react';
import { SegmentMeter } from '@/components/bits';
import { CapsLabel, GithubAvatar } from '@/components/brand';
import { BalancedGrid } from '@/components/grid';
import { Columns } from '@/components/charts';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { SkillCatalogItem } from '@/lib/api';
import {
  EXPERT_LEVEL, HEALTH, LEVEL_LABEL, computeStats, type Dev, type DevStat, type Selection, type SkillHealth, type SkillRow,
  type SkillStat,
} from './levels';

/**
 * Panel vivo a la derecha del mapa: resumen del equipo, detalle de lo seleccionado (skill o
 * persona) y las skills que dependen de una sola persona. Todo sale de la matriz en memoria, así
 * que cambia en el mismo frame en que cambias un nivel.
 */
export function SkillInsights({
  devs,
  rows,
  levels,
  catalog,
  selection,
  onSelect,
}: {
  devs: Dev[];
  rows: SkillRow[];
  levels: Map<string, number>;
  catalog: SkillCatalogItem[];
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  const { skillStats, devStats } = useMemo(() => computeStats(devs, rows, levels), [devs, rows, levels]);
  const all = [...skillStats.values()];
  const count = (h: SkillHealth) => all.filter((s) => s.health === h).length;
  const risky = all
    .filter((s) => s.health !== 'backed')
    .sort((a, b) => (a.health === b.health ? b.holders.length - a.holders.length : a.health === 'none' ? -1 : 1));

  const selectedSkill = selection?.kind === 'skill' ? skillStats.get(selection.id) : undefined;
  const selectedDev = selection?.kind === 'dev' ? devStats.get(selection.id) : undefined;
  const overview = !selectedSkill && !selectedDev;

  return (
    // Columna flex que ocupa TODO el alto de la fila (la matriz suele ser más alta). El sobrante se
    // reparte entre la gráfica del equipo (`fill`) y la lista de riesgo, cuya lista tiene base 0:
    // no empuja el alto de la fila, solo toma el que hay y desplaza por dentro.
    <div className="flex min-h-0 flex-1 flex-col gap-3.5">
      <BalancedGrid max={{ base: 2, sm: 4 }} className="shrink-0 gap-2.5">
        <Kpi label="Skills" value={all.length} />
        <Kpi label="Respaldadas" value={count('backed')} dot={HEALTH.backed.dot} />
        <Kpi label="Punto único" value={count('single')} dot={HEALTH.single.dot} />
        <Kpi label="Sin experto" value={count('none')} dot={HEALTH.none.dot} />
      </BalancedGrid>

      <Card className={cn('flex min-w-0 flex-col p-4 sm:p-5', overview ? 'flex-[1_1_auto]' : 'shrink-0')}>
        {selectedSkill ? (
          <SkillDetail
            stat={selectedSkill}
            description={catalog.find((c) => c.skillId === selectedSkill.id)?.description ?? null}
            teamSize={devs.length}
            onSelect={onSelect}
          />
        ) : selectedDev ? (
          <DevDetail stat={selectedDev} onSelect={onSelect} />
        ) : (
          <TeamOverview devStats={[...devStats.values()]} onSelect={onSelect} />
        )}
      </Card>

      <Card className="flex min-h-0 min-w-0 flex-[1_1_auto] flex-col p-4 sm:p-5">
        <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-orange-ink" />
            <span className="text-sm font-semibold">Riesgo de punto único</span>
          </div>
          <span className="flex items-center gap-2">
            {risky.length > 0 && <span className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">{risky.length} de {all.length}</span>}
            <CapsLabel>Expertos = nivel {EXPERT_LEVEL}+</CapsLabel>
          </span>
        </div>
        {!risky.length ? (
          <div className="flex items-center gap-2 rounded-md bg-green-soft px-3 py-2.5 text-[13px] text-green">
            <CircleCheck className="size-4 shrink-0" /> Cada skill tiene al menos dos personas expertas.
          </div>
        ) : (
          <ul className="scroll-list grid max-h-72 content-start gap-0.5 [--edge:1.25rem] lg:max-h-none lg:min-h-[13.5rem] lg:flex-[1_1_0]">
            {risky.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelect({ kind: 'skill', id: s.id })}
                  className={cn(
                    'flex min-h-9 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-fast hover:bg-sidebar',
                    selection?.kind === 'skill' && selection.id === s.id && 'bg-orange-soft hover:bg-orange-soft',
                  )}
                >
                  <span className={cn('size-2 shrink-0 rounded-[2px]', HEALTH[s.health].dot)} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{s.tag}</span>
                  {s.experts[0] ? (
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <GithubAvatar url={s.experts[0].avatarUrl} id={s.experts[0].id} name={s.experts[0].name} className="size-5" />
                      <span className="max-w-[9rem] truncate">{s.experts[0].name}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-faint">{s.holders.length ? `${s.holders.length} aprendiendo` : 'nadie'}</span>
                  )}
                  <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', HEALTH[s.health].chip)}>{HEALTH[s.health].label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function SkillInsightsSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-3.5">
      <BalancedGrid max={{ base: 2, sm: 4 }} className="gap-2.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="grid gap-2 p-3.5"><Skeleton className="h-3 w-16" /><Skeleton className="h-6 w-8" /></Card>
        ))}
      </BalancedGrid>
      <Card className="grid gap-3 p-5"><Skeleton className="h-4 w-40" /><Skeleton className="h-40 w-full" /></Card>
      <Card className="grid flex-1 content-start gap-2 p-5"><Skeleton className="h-4 w-36" />{[0, 1, 2].map((i) => <Skeleton key={i} className="h-7 w-full" />)}</Card>
    </div>
  );
}

function Kpi({ label, value, dot }: { label: string; value: number; dot?: string }) {
  return (
    <Card className="grid h-full gap-1.5 p-3.5">
      <span className="flex items-center gap-1.5">
        {dot && <span className={cn('size-2 rounded-[2px]', dot)} />}
        <CapsLabel>{label}</CapsLabel>
      </span>
      <span className="text-2xl font-semibold leading-none tracking-[-0.03em] tabular-nums">{value}</span>
    </Card>
  );
}

function DetailHeader({ eyebrow, title, onClear, children }: { eyebrow: string; title: ReactNode; onClear?: () => void; children?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="grid min-w-0 gap-1.5">
        <CapsLabel>{eyebrow}</CapsLabel>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-lg font-semibold tracking-[-0.025em]">{title}</div>
        {children}
      </div>
      {onClear && (
        <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="Quitar selección">
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid gap-1 rounded-md bg-panel px-3 py-2">
      <CapsLabel className="text-[10px]">{label}</CapsLabel>
      <span className="text-base font-semibold leading-none tabular-nums">{value}</span>
    </div>
  );
}

/** Sin selección: cuántas skills domina cada persona (columnas verticales; click = seleccionar). */
function TeamOverview({ devStats, onSelect }: { devStats: DevStat[]; onSelect: (s: Selection) => void }) {
  const data = devStats.map((d) => ({
    label: d.dev.name,
    value: d.expertIn,
    avatarUrl: d.dev.avatarUrl,
    avatarSeed: d.dev.id,
    sub: `${d.skills.length} en total`,
  }));
  return (
    <>
      <DetailHeader eyebrow="Equipo" title="Skills dominadas por persona">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MousePointerClick className="size-3.5" /> Elige una skill o un avatar del mapa para ver su detalle.
        </span>
      </DetailHeader>
      <Columns
        data={data}
        height={180}
        fill
        hideZeros={false}
        color="hsl(var(--chart-1))"
        onPick={(d) => {
          const hit = devStats.find((x) => x.dev.name === d.label);
          if (hit) onSelect({ kind: 'dev', id: hit.dev.id });
        }}
      />
    </>
  );
}

function SkillDetail({
  stat,
  description,
  teamSize,
  onSelect,
}: {
  stat: SkillStat;
  description: string | null;
  teamSize: number;
  onSelect: (s: Selection) => void;
}) {
  const h = HEALTH[stat.health];
  // Distribución por nivel en orden de escala (sort=false: es ordinal).
  const dist = [1, 2, 3, 4, 5].map((n) => ({
    label: LEVEL_LABEL[n],
    value: stat.holders.filter((x) => x.level === n).length,
    color: n >= EXPERT_LEVEL ? 'hsl(var(--chart-1))' : 'hsl(var(--chart-1) / 0.45)',
  }));
  return (
    <>
      <DetailHeader
        eyebrow="Skill"
        title={<>
          <span className="truncate">{stat.tag}</span>
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-normal', h.chip)}>{h.label}</span>
        </>}
        onClear={() => onSelect(null)}
      >
        {description && <p className="line-clamp-2 text-xs text-muted-foreground">{description}</p>}
      </DetailHeader>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Cobertura" value={<>{stat.holders.length}<span className="text-xs font-medium text-faint">/{teamSize}</span></>} />
            <Stat label="Promedio" value={stat.avg || '—'} />
            <Stat label="Expertos" value={stat.experts.length} />
          </div>
          <Columns data={dist} height={120} sort={false} hideZeros={false} />
        </div>

        <div className="grid content-start gap-1">
          <CapsLabel className="mb-1">Quién la domina</CapsLabel>
          {!stat.holders.length ? (
            <p className="rounded-md bg-panel px-3 py-2.5 text-xs text-muted-foreground">Nadie tiene nivel en esta skill todavía.</p>
          ) : (
            stat.holders.map(({ dev, level }) => (
              <PersonRow key={dev.id} dev={dev} level={level} onClick={() => onSelect({ kind: 'dev', id: dev.id })} />
            ))
          )}
        </div>
      </div>
    </>
  );
}

function DevDetail({ stat, onSelect }: { stat: DevStat; onSelect: (s: Selection) => void }) {
  const sole = stat.skills.filter((s) => s.soleExpert);
  return (
    <>
      <DetailHeader
        eyebrow="Persona"
        title={<>
          <GithubAvatar url={stat.dev.avatarUrl} id={stat.dev.id} name={stat.dev.name} className="size-7" />
          <span className="truncate">{stat.dev.name}</span>
        </>}
        onClear={() => onSelect(null)}
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Skills" value={stat.skills.length} />
            <Stat label="Promedio" value={stat.avg || '—'} />
            <Stat label="Experto en" value={stat.expertIn} />
          </div>
          {sole.length > 0 && (
            <div className="rounded-md bg-orange-soft px-3 py-2.5 text-xs text-orange-ink">
              <p className="mb-1.5 font-semibold">Única persona experta en</p>
              <div className="flex flex-wrap gap-1.5">
                {sole.map((s) => (
                  <button
                    key={s.skill.id}
                    type="button"
                    onClick={() => onSelect({ kind: 'skill', id: s.skill.id })}
                    className="rounded-sm bg-card px-1.5 py-0.5 font-semibold text-foreground transition-colors hover:bg-sidebar"
                  >
                    {s.skill.tag}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="grid content-start gap-1">
          <CapsLabel className="mb-1">Sus skills</CapsLabel>
          {!stat.skills.length ? (
            <p className="rounded-md bg-panel px-3 py-2.5 text-xs text-muted-foreground">Sin niveles asignados todavía.</p>
          ) : (
            stat.skills.map((s) => (
              <button
                key={s.skill.id}
                type="button"
                onClick={() => onSelect({ kind: 'skill', id: s.skill.id })}
                className="flex items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{s.skill.tag}</span>
                <span className="w-[4.5rem] text-right text-[11.5px] text-muted-foreground">{LEVEL_LABEL[s.level]}</span>
                <SegmentMeter value={s.level} max={5} shape="dots" className="shrink-0" />
              </button>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function PersonRow({ dev, level, onClick }: { dev: Dev; level: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar">
      <GithubAvatar url={dev.avatarUrl} id={dev.id} name={dev.name} className="size-6" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{dev.name}</span>
      <span className="w-[4.5rem] text-right text-[11.5px] text-muted-foreground">{LEVEL_LABEL[level]}</span>
      <SegmentMeter value={level} max={5} shape="dots" className="shrink-0" />
    </button>
  );
}
