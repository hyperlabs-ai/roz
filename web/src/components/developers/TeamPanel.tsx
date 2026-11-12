import { useMemo, type ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { Columns, StackedBar } from '@/components/charts';
import { CapsLabel, SectionHeader } from '@/components/brand';
import { SizeDistLegend, sizeDistSegments } from '@/components/CommitSizeDist';
import { compact } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { DeveloperListItem, SizeBucket } from '@/lib/api';

/**
 * Resumen del equipo, al lado del podio. Un solo panel compuesto en vez de cuatro tarjetas con un
 * número arriba y un hueco debajo: la franja de cifras da los totales, las columnas dicen cómo se
 * reparte entre personas la MISMA métrica que ordena el podio (el podio muestra a tres, esto a
 * todos), y el pie resume el tamaño de commit del equipo. Las columnas se quedan el alto que sobre
 * (`fill`), así el panel siempre termina donde termina el podio.
 */
export function TeamPanel({
  devs, inactiveCount, periodLabel, metricKey, metricLabel, metricValue, onPick,
}: {
  /** Solo personas activas. */
  devs: DeveloperListItem[];
  inactiveCount: number;
  periodLabel: string;
  metricKey: 'hyper' | 'commits' | 'lines';
  metricLabel: string;
  metricValue: (d: DeveloperListItem) => number;
  onPick: (devId: string) => void;
}) {
  const n = devs.length;
  const totals = useMemo(() => devs.reduce(
    (s, d) => ({ commits: s.commits + d.commits, closed: s.closed + d.ticketsResolved, open: s.open + d.openTickets }),
    { commits: 0, closed: 0, open: 0 },
  ), [devs]);

  const ranked = useMemo(() => [...devs].sort((a, b) => metricValue(b) - metricValue(a)), [devs, metricValue]);
  const metricTotal = ranked.reduce((s, d) => s + metricValue(d), 0);
  const leader = ranked[0] && metricValue(ranked[0]) > 0 ? ranked[0] : null;
  const contributing = ranked.filter((d) => metricValue(d) > 0).length;
  const base = metricKey === 'hyper' ? '--hyper' : '--chart-1';

  // Tamaño de commit del equipo: suma por franja de lo que ya trae cada persona.
  const teamDist = useMemo(() => {
    const acc = new Map<SizeBucket['key'], SizeBucket>();
    for (const d of devs) for (const b of d.sizeDist) {
      const cur = acc.get(b.key);
      if (cur) { cur.commits += b.commits; cur.lines += b.lines; } else acc.set(b.key, { ...b });
    }
    return [...acc.values()];
  }, [devs]);
  const hasDist = teamDist.some((b) => b.lines > 0);

  const closeRate = totals.closed + totals.open > 0 ? Math.round((totals.closed / (totals.closed + totals.open)) * 100) : null;
  const per = (v: number) => (n ? compact(Math.round(v / n)) : '0');

  return (
    <Card className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
      <SectionHeader
        size="sm"
        eyebrow={`Equipo · ${periodLabel}`}
        eyebrowColor="ink"
        title={`Reparto de ${metricLabel}`}
        actions={leader && metricTotal > 0 ? (
          <span className="text-right text-[11px] leading-tight text-muted-foreground">
            <span className="block text-base font-semibold tabular-nums tracking-[-0.03em] text-foreground">
              {Math.round((metricValue(leader) / metricTotal) * 100)}%
            </span>
            lo aporta {leader.name}
          </span>
        ) : undefined}
      />

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-4 lg:grid-cols-2 2xl:grid-cols-4">
        <Stat label="Activos" value={n} sub={inactiveCount ? `${inactiveCount} inactivo${inactiveCount === 1 ? '' : 's'}` : `${contributing} con actividad`} />
        <Stat label="Commits" value={compact(totals.commits)} sub={`${per(totals.commits)} por persona`} />
        <Stat label="Cerradas" value={totals.closed} sub={closeRate == null ? 'sin tareas' : `${closeRate}% del total`} dot="bg-green" />
        <Stat label="Abiertas" value={totals.open} sub={`${per(totals.open)} por persona`} dot="bg-orange" />
      </div>

      <Columns
        fill
        height={120}
        topN={8}
        data={ranked.map((d) => ({
          label: d.name,
          value: metricValue(d),
          avatarUrl: d.avatarUrl,
          avatarSeed: d.id,
          color: `hsl(var(${base}) / ${d.id === leader?.id ? 1 : 0.45})`,
        }))}
        onPick={(c) => { const hit = ranked.find((d) => d.name === c.label); if (hit) onPick(hit.id); }}
      />

      {hasDist && (
        <div className="border-t pt-3.5">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <CapsLabel>Tamaño de commit del equipo</CapsLabel>
            <span className="text-[11px] text-faint">% de líneas</span>
          </div>
          <StackedBar height={8} data={sizeDistSegments(teamDist)} />
          <SizeDistLegend dist={teamDist} className="mt-2" />
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value, sub, dot }: { label: string; value: ReactNode; sub: string; dot?: string }) {
  return (
    <div className="min-w-0 bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        {dot && <span className={cn('size-1.5 shrink-0 rounded-[2px]', dot)} />}
        <CapsLabel className="truncate">{label}</CapsLabel>
      </div>
      <div className="mt-1 text-xl font-semibold leading-none tracking-[-0.04em] tabular-nums">{value}</div>
      <div className="mt-1 truncate text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}
