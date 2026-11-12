import { useMemo, useState, type ReactNode } from 'react';
import { Bot } from 'lucide-react';
import { HeatCell } from '@/components/charts';
import { EmptyState } from '@/components/bits';
import { GithubAvatar, tokenColor } from '@/components/brand';
import { Segmented } from '@/components/pulse/roz-v2';
import { addDays } from '@/components/pulse/pulse-ui';
import type { PulseHeatCell, PulsePerson } from '@/lib/api';
import { cn } from '@/lib/utils';

const DAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const DAYS_LONG = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const LEVELS = 4;

type Mode = 'persona' | 'hora';

/** Hoy (YYYY-MM-DD) en la zona del equipo. */
const teamToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/**
 * Mapa de calor de la semana (`.heat` del mock). Dos lecturas de los mismos datos:
 *  · por persona: filas = personas, columnas = días; naranja por intensidad con la cifra dentro de
 *    la celda, una fila de "Agentes" en morado profundo (eventos de plan del feed) y el total del
 *    equipo por día al pie.
 *  · por hora: día × hora del equipo o de una persona.
 * Arriba, tres lecturas que el mapa solo no dice de un vistazo: día pico, hora pico y ritmo diario.
 * Rampa por opacidad sobre UN token (`HeatCell`): más oscuro = más. Los niveles se escalan contra el
 * máximo de lo que se ve.
 */
export function PulseHeatmap({
  cells,
  people,
  weekStart,
  agentDays,
  className,
}: {
  cells: PulseHeatCell[];
  people: PulsePerson[];
  weekStart: string;
  /** Eventos de agente por día de la semana (índice 0 = lunes). */
  agentDays?: number[];
  className?: string;
}) {
  const [mode, setMode] = useState<Mode>('persona');
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  // Solo personas con actividad en la semana: las demás serían filas vacías.
  const active = useMemo(() => {
    const ids = new Set(cells.map((c) => c.devId));
    return people.filter((p) => ids.has(p.devId));
  }, [cells, people]);

  const total = cells.reduce((a, c) => a + c.count, 0);
  const hasAgents = !!agentDays?.some((n) => n > 0);

  // Lecturas rápidas: día pico, hora pico y promedio por día transcurrido.
  const facts = useMemo(() => {
    const byDay = Array(7).fill(0) as number[];
    const byHour = Array(24).fill(0) as number[];
    for (const c of cells) {
      const i = days.indexOf(c.day);
      if (i >= 0) byDay[i]! += c.count;
      if (c.hour >= 0 && c.hour < 24) byHour[c.hour]! += c.count;
    }
    const peakDay = byDay.indexOf(Math.max(...byDay));
    const peakHour = byHour.indexOf(Math.max(...byHour));
    const today = teamToday();
    // Días que ya contaron: hasta hoy en la semana en curso, los siete en una semana pasada.
    const elapsed = today < days[0]! ? 0 : today > days[6]! ? 7 : days.indexOf(today) + 1;
    const workdays = Math.max(1, Math.min(elapsed, 5));
    return { byDay, peakDay, peakHour, byHourMax: byHour[peakHour] ?? 0, perDay: Math.round(total / workdays) };
  }, [cells, days, total]);

  const empty = !cells.length && !hasAgents;

  return (
    <div className={cn('flex min-h-0 flex-col gap-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <span className="text-[15px] font-semibold tracking-[-0.02em]">
            {mode === 'persona' ? 'Actividad por persona' : 'Actividad por hora'}
          </span>
          <span className="text-xs text-faint">
            <span className="font-semibold tabular-nums text-muted-foreground">{total}</span> eventos · commits + issues + PRs
          </span>
        </div>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'persona', label: 'Por persona' },
            { value: 'hora', label: 'Por hora' },
          ]}
        />
      </div>

      {empty ? (
        <div className="grid flex-1 place-items-center">
          <EmptyState>Sin actividad registrada en la semana.</EmptyState>
        </div>
      ) : (
        <>
          {total > 0 && (
            <div className="grid grid-cols-3 divide-x rounded-md bg-sidebar">
              <Fact
                label="Día pico"
                value={DAYS_LONG[facts.peakDay]!}
                sub={plural(facts.byDay[facts.peakDay] ?? 0, 'evento', 'eventos')}
              />
              <Fact label="Hora pico" value={hh(facts.peakHour)} sub={plural(facts.byHourMax, 'evento', 'eventos')} />
              <Fact label="Ritmo" value={String(facts.perDay)} sub="eventos por día hábil" />
            </div>
          )}
          {mode === 'persona' ? (
            <ByPerson cells={cells} people={active} days={days} agentDays={hasAgents ? agentDays : undefined} />
          ) : (
            <ByHour cells={cells} people={active} days={days} />
          )}
        </>
      )}
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="grid min-w-0 gap-1 px-3.5 py-2.5">
      <span className="label-caps truncate">{label}</span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <b className="text-[17px] font-semibold leading-none tabular-nums tracking-[-0.03em]">{value}</b>
        <span className="truncate text-[11.5px] text-muted-foreground">{sub}</span>
      </span>
    </div>
  );
}

function level(n: number, max: number) {
  return n <= 0 || max === 0 ? 0 : Math.max(1, Math.ceil((n / max) * LEVELS));
}

function Legend({ agents }: { agents?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
      {agents && (
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 rounded-[3px]" style={{ background: tokenColor('purple-deep') }} />
          agentes
        </span>
      )}
      <span className="inline-flex items-center gap-1.5">
        menos
        {[0.18, 0.45, 0.72, 1].map((a) => (
          <span key={a} className="size-3 rounded-[3px]" style={{ background: tokenColor('orange', a) }} />
        ))}
        más
      </span>
    </div>
  );
}

/** Cifra dentro de la celda: tinta normal en los niveles claros, clara sobre el color pleno. */
function CellCount({ n, lvl }: { n: number; lvl: number }) {
  if (n <= 0) return null;
  return (
    <span
      className={cn(
        'absolute inset-0 grid place-items-center text-[12px] font-semibold tabular-nums',
        lvl >= 3 ? 'text-primary-foreground' : 'text-foreground/80',
      )}
    >
      {n}
    </span>
  );
}

/** Personas × días, como el mock. Fin de semana solo si hubo actividad. */
function ByPerson({
  cells,
  people,
  days,
  agentDays,
}: {
  cells: PulseHeatCell[];
  people: PulsePerson[];
  days: string[];
  agentDays?: number[];
}) {
  const byDev = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const c of cells) {
      const i = days.indexOf(c.day);
      if (i < 0) continue;
      const row = m.get(c.devId) ?? Array(7).fill(0);
      row[i] += c.count;
      m.set(c.devId, row);
    }
    return m;
  }, [cells, days]);

  const weekend = [...byDev.values()].some((r) => r[5]! + r[6]! > 0) || (agentDays?.[5] ?? 0) + (agentDays?.[6] ?? 0) > 0;
  const cols = weekend ? 7 : 5;
  const max = Math.max(0, ...[...byDev.values()].flatMap((r) => r.slice(0, cols)));
  const agentMax = Math.max(0, ...(agentDays ?? []).slice(0, cols));
  const today = teamToday();
  const grand = [...byDev.values()].reduce((a, r) => a + r.slice(0, cols).reduce((x, n) => x + n, 0), 0);
  const dayTotals = Array.from({ length: cols }, (_, i) => [...byDev.values()].reduce((a, r) => a + (r[i] ?? 0), 0));

  const cell = 'h-full min-h-10 w-full rounded-md hover:scale-[1.04]';

  return (
    <>
      <div
        className="grid flex-1 content-center items-stretch gap-1.5"
        style={{
          gridTemplateColumns: `minmax(92px,168px) repeat(${cols}, minmax(0,1fr)) 3.5rem`,
          gridAutoRows: 'minmax(2.5rem, 3.25rem)',
        }}
      >
        {/* Encabezado: día + fecha; hoy resaltado */}
        <span className="!min-h-0" />
        {days.slice(0, cols).map((d, i) => {
          const isToday = d === today;
          return (
            <span
              key={d}
              className={cn(
                'flex flex-col items-center justify-end gap-0.5 pb-1 text-center leading-none',
                isToday ? 'text-orange-ink' : 'text-faint',
              )}
              title={d}
            >
              <span className="label-caps text-[10px] text-current">{DAYS[i]}</span>
              <span className={cn('text-[13px] tabular-nums', isToday ? 'font-semibold' : 'font-medium text-muted-foreground')}>
                {Number(d.slice(8))}
              </span>
            </span>
          );
        })}
        <span className="label-caps flex items-end justify-end pb-1 text-[10px]">Total</span>

        {people.map((p) => {
          const row = byDev.get(p.devId) ?? Array(7).fill(0);
          const sum = row.slice(0, cols).reduce((a: number, n: number) => a + n, 0);
          return (
            <Row
              key={p.devId}
              total={sum}
              share={grand ? Math.round((sum / grand) * 100) : null}
              label={
                <>
                  <GithubAvatar login={p.githubLogin} id={p.devId} url={p.avatarUrl} name={p.name} className="size-7" />
                  <span className="truncate text-[13px] font-medium">{p.name.split(' ')[0]}</span>
                </>
              }
            >
              {row.slice(0, cols).map((n: number, i: number) => {
                const lvl = level(n, max);
                return (
                  <HeatCell
                    key={i}
                    level={lvl}
                    levels={LEVELS}
                    colorVar="--orange"
                    size=""
                    className={cn(cell, days[i]! > today && 'opacity-50')}
                    title={`${p.name} · ${DAYS[i]} ${days[i]!.slice(5)}: ${plural(n, 'evento', 'eventos')}`}
                  >
                    <CellCount n={n} lvl={lvl} />
                  </HeatCell>
                );
              })}
            </Row>
          );
        })}

        {agentDays && (
          <Row
            total={agentDays.slice(0, cols).reduce((a, n) => a + n, 0)}
            share={null}
            label={
              <>
                <span className="grid size-7 place-items-center rounded-full bg-lavender text-purple-deep">
                  <Bot className="size-4" />
                </span>
                <span className="truncate text-[13px] font-medium">Agentes</span>
              </>
            }
          >
            {agentDays.slice(0, cols).map((n, i) => {
              const lvl = level(n, agentMax);
              return (
                <HeatCell
                  key={i}
                  level={lvl}
                  levels={LEVELS}
                  colorVar="--purple-deep"
                  size=""
                  className={cn(cell, days[i]! > today && 'opacity-50')}
                  title={`Agentes · ${DAYS[i]} ${days[i]!.slice(5)}: ${plural(n, 'evento', 'eventos')}`}
                >
                  <CellCount n={n} lvl={lvl} />
                </HeatCell>
              );
            })}
          </Row>
        )}
      </div>

      {/* Pie: total del equipo por día, alineado con las columnas, y la leyenda. */}
      <div className="grid gap-3 border-t pt-3">
        <div
          className="grid items-center gap-1.5"
          style={{ gridTemplateColumns: `minmax(92px,168px) repeat(${cols}, minmax(0,1fr)) 3.5rem` }}
        >
          <span className="label-caps">Equipo</span>
          {dayTotals.map((n, i) => (
            <span key={i} className={cn('text-center text-[13px] tabular-nums', n ? 'font-semibold' : 'text-faint')}>
              {n}
            </span>
          ))}
          <span className="text-right text-[14px] font-semibold tabular-nums">{grand}</span>
        </div>
        <Legend agents={!!agentDays} />
      </div>
    </>
  );
}

function Row({ label, total, share, children }: { label: ReactNode; total: number; share: number | null; children: ReactNode }) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-2 pr-2">{label}</span>
      {children}
      <span className="flex flex-col items-end justify-center leading-tight">
        <span className={cn('text-[14px] font-semibold tabular-nums', total === 0 && 'font-normal text-faint')}>{total}</span>
        {share != null && total > 0 && <span className="text-[10.5px] tabular-nums text-faint">{share}%</span>}
      </span>
    </>
  );
}

/** Día × hora (zona del equipo), del equipo o de una persona. */
function ByHour({ cells, people, days }: { cells: PulseHeatCell[]; people: PulsePerson[]; days: string[] }) {
  const [who, setWho] = useState<string | null>(null);
  const grid = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cells) {
      if (who && c.devId !== who) continue;
      const k = `${c.day}|${c.hour}`;
      m.set(k, (m.get(k) ?? 0) + c.count);
    }
    return m;
  }, [cells, who]);
  const max = Math.max(0, ...grid.values());
  const today = teamToday();

  const chip = (on: boolean) =>
    cn(
      'flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors',
      on ? 'bg-orange-soft text-orange-ink' : 'bg-panel text-muted-foreground hover:text-foreground',
    );

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setWho(null)} className={chip(who === null)}>
          Equipo
        </button>
        {people.map((p) => (
          <button
            key={p.devId}
            type="button"
            onClick={() => setWho(who === p.devId ? null : p.devId)}
            title={p.name}
            className={cn(chip(who === p.devId), 'pl-1')}
          >
            <GithubAvatar login={p.githubLogin} id={p.devId} url={p.avatarUrl} name={p.name} className="size-6" />
            {p.name.split(' ')[0]}
          </button>
        ))}
      </div>

      <div className="scroll-none flex-1 overflow-x-auto">
        <div className="min-w-[520px]">
          <div className="mb-1.5 flex items-end gap-1 pl-12 text-[10.5px] tabular-nums text-faint">
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="flex-1 text-center">{h % 3 === 0 ? hh(h).slice(0, 2) : ''}</span>
            ))}
          </div>
          <div className="grid gap-1">
            {days.map((day, i) => {
              const isToday = day === today;
              return (
                <div key={day} className={cn('flex items-center gap-1', day > today && 'opacity-50')}>
                  <span
                    className={cn(
                      'flex w-11 shrink-0 items-baseline gap-1 text-[11px] tabular-nums',
                      isToday ? 'font-semibold text-orange-ink' : 'text-faint',
                    )}
                  >
                    {DAYS[i]}
                    <span className="text-[10px]">{Number(day.slice(8))}</span>
                  </span>
                  {Array.from({ length: 24 }, (_, h) => {
                    const n = grid.get(`${day}|${h}`) ?? 0;
                    return (
                      <HeatCell
                        key={h}
                        level={level(n, max)}
                        levels={LEVELS}
                        colorVar="--orange"
                        size="h-7 flex-1"
                        className="rounded-[5px] hover:scale-[1.15]"
                        title={`${DAYS[i]} ${day.slice(5)} · ${hh(h)}: ${plural(n, 'evento', 'eventos')}`}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="border-t pt-3">
        <Legend />
      </div>
    </>
  );
}
