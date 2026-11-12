import { useMemo, type ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AreaTrend, Columns } from '@/components/charts';
import { CapsLabel } from '@/components/brand';
import { EmptyState } from '@/components/bits';
import { parseDate, shortDate } from '@/lib/format';

const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

/**
 * Ritmo de commits del período: la serie diaria con sus lecturas (días activos, día pico, promedio
 * y racha) y, al lado, en qué días de la semana cae el trabajo.
 *
 * La cabecera del perfil solo traía una sparkline de 52px sin ejes: se veía la forma pero no cuánto
 * ni cuándo. Las dos tarjetas salen de la misma serie que ya manda el backend (`commitTrend`).
 */
export function CommitRhythm({ trend }: { trend: { date: string; commits: number }[] }) {
  const stats = useMemo(() => {
    const total = trend.reduce((s, d) => s + d.commits, 0);
    const activeDays = trend.filter((d) => d.commits > 0);
    const peak = activeDays.reduce<{ date: string; commits: number } | null>((best, d) => (!best || d.commits > best.commits ? d : best), null);
    // Racha más larga de días seguidos con al menos un commit.
    let streak = 0, run = 0;
    for (const d of trend) { run = d.commits > 0 ? run + 1 : 0; if (run > streak) streak = run; }
    const byWeekday = WEEKDAYS.map((label) => ({ label, value: 0 }));
    for (const d of trend) byWeekday[(parseDate(d.date).getDay() + 6) % 7]!.value += d.commits;
    const topDay = byWeekday.reduce((a, b) => (b.value > a.value ? b : a), byWeekday[0]!);
    const weekend = byWeekday[5]!.value + byWeekday[6]!.value;
    return { total, activeDays: activeDays.length, peak, streak, byWeekday, topDay, weekend };
  }, [trend]);

  const empty = stats.total === 0;

  return (
    <div className="grid gap-3.5 xl:grid-cols-[1.5fr_1fr]">
      <Card className="flex min-w-0 flex-col">
        <CardHeader>
          <CardTitle>Ritmo de commits</CardTitle>
          <CardDescription>Commits por día en el período.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-4">
          {empty ? <EmptyState>Sin commits en este período</EmptyState> : (
            <>
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-4">
                <Reading label="Días activos" value={stats.activeDays} sub={`de ${trend.length}`} />
                <Reading label="Por día activo" value={(stats.total / Math.max(1, stats.activeDays)).toFixed(1)} sub="commits" />
                <Reading label="Día pico" value={stats.peak?.commits ?? 0} sub={stats.peak ? shortDate(stats.peak.date) : ''} />
                <Reading label="Racha más larga" value={stats.streak} sub={stats.streak === 1 ? 'día seguido' : 'días seguidos'} />
              </div>
              <AreaTrend
                fill
                height={170}
                data={trend}
                series={[{ key: 'commits', name: 'Commits', color: 'hsl(var(--chart-1))' }]}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card className="flex min-w-0 flex-col">
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div className="grid gap-1.5">
            <CardTitle>Días de la semana</CardTitle>
            <CardDescription>En qué días cae su trabajo.</CardDescription>
          </div>
          {!empty && (
            <span className="shrink-0 text-right text-[11px] leading-tight text-muted-foreground">
              <span className="block text-base font-semibold tabular-nums tracking-[-0.03em] text-foreground">
                {Math.round((stats.weekend / stats.total) * 100)}%
              </span>
              en fin de semana
            </span>
          )}
        </CardHeader>
        <CardContent className="flex flex-1 flex-col">
          {empty ? <EmptyState>Sin commits en este período</EmptyState> : (
            <Columns
              fill
              height={170}
              sort={false}
              hideZeros={false}
              valueFormat={(n) => String(n)}
              data={stats.byWeekday.map((d) => ({
                ...d,
                color: `hsl(var(--chart-1) / ${d.label === stats.topDay.label ? 1 : 0.45})`,
              }))}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Reading({ label, value, sub }: { label: string; value: ReactNode; sub: string }) {
  return (
    <div className="min-w-0 bg-card px-3 py-2.5">
      <CapsLabel className="block truncate">{label}</CapsLabel>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-xl font-semibold leading-none tracking-[-0.04em] tabular-nums">{value}</span>
        <span className="truncate text-[11px] text-muted-foreground">{sub}</span>
      </div>
    </div>
  );
}
