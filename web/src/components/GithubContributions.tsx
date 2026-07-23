import { useMemo } from 'react';
import { GitCommitHorizontal, Flame, Award, Zap, CalendarCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/bits';
import { useApi } from '@/lib/useApi';
import { apiGet, type GithubContributions as Data } from '@/lib/api';
import { cn } from '@/lib/utils';

// Verde de contribución por nivel. LIGHT: los verdes reconocibles de GitHub. DARK: rampa derivada
// del token --success (verde más mate/opaco, coherente con el tema), no los neón de GitHub.
const LEVEL_CLASS = [
  'bg-muted',
  'bg-[#9be9a8] dark:bg-success/25',
  'bg-[#40c463] dark:bg-success/45',
  'bg-[#30a14e] dark:bg-success/70',
  'bg-[#216e39] dark:bg-success',
] as const;

const CELL = 'aspect-square w-full rounded-[2px] ring-1 ring-inset ring-foreground/5';
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const WEEKDAYS = ['', 'Lun', '', 'Mié', '', 'Vie', '']; // GitHub solo etiqueta días alternos

function fmtDay(date: string) {
  const m = Number(date.slice(5, 7)) - 1;
  return `${Number(date.slice(8, 10))} ${MONTHS[m] ?? ''}`;
}

/** Cuadrícula de contribuciones traída directo del perfil de GitHub (últimos 12 meses). */
export function GithubContributions({ devId }: { devId: string }) {
  const { data, loading, error } = useApi<Data>(() => apiGet(`/developers/${devId}/contributions`), [devId]);

  // Etiqueta de mes por columna: se muestra solo cuando cambia respecto a la semana previa.
  const monthLabels = useMemo(() => {
    if (!data?.weeks) return [];
    let prev = -1;
    return data.weeks.map((w) => {
      const first = w.days[0];
      if (!first) return '';
      const m = Number(first.date.slice(5, 7)) - 1;
      if (m !== prev) {
        prev = m;
        return MONTHS[m] ?? '';
      }
      return '';
    });
  }, [data]);

  // Stats derivados de la misma cuadrícula (rachas, mejor día, días activos).
  const stats = useMemo(() => {
    if (!data?.linked) return null;
    const days = data.weeks.flatMap((w) => w.days); // ya vienen en orden cronológico
    let active = 0, best = 0, bestDate = '', longest = 0, run = 0;
    for (const d of days) {
      if (d.count > 0) { active++; run++; longest = Math.max(longest, run); } else run = 0;
      if (d.count > best) { best = d.count; bestDate = d.date; }
    }
    let current = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      if (days[i]!.count > 0) current++;
      else break;
    }
    return { active, best, bestDate, longest, current };
  }, [data]);

  const wideLayout = loading || data?.linked;
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-4">
      <Card className={cn('min-w-0', wideLayout ? 'lg:col-span-3' : 'lg:col-span-4')}>
        {/* En móvil el contador baja a su propia línea; lado a lado no cabe y se desborda. */}
        <CardHeader className="flex-col gap-1 space-y-0 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
          <CardTitle className="flex items-center gap-2">
            <GitCommitHorizontal className="size-4" /> Contribuciones en GitHub
          </CardTitle>
          {loading ? (
            <Skeleton className="h-4 w-32" />
          ) : data?.linked ? (
            <span className="whitespace-nowrap text-sm text-muted-foreground">
              <span className="font-semibold text-foreground tabular-nums">{data.totalContributions.toLocaleString('es-MX')}</span> en el último año
            </span>
          ) : null}
        </CardHeader>
        <CardContent>
          {error && <EmptyState>No se pudo cargar la actividad de GitHub</EmptyState>}
          {loading && <ContributionsSkeleton />}
          {!loading && data && !data.linked && (
            <EmptyState>{data.login ? `@${data.login} no tiene actividad pública` : 'Sin cuenta de GitHub vinculada'}</EmptyState>
          )}
          {!loading && data?.linked && (
            <div className="w-full">
              <div className="flex w-full gap-1.5">
                {/* Etiquetas de día (izquierda) — se estiran para alinear con las 7 filas.
                    En móvil se ocultan para darle todo el ancho a la cuadrícula. */}
                <div className="hidden shrink-0 flex-col gap-1 sm:flex">
                  <div className="h-4" />
                  <div className="flex flex-1 flex-col gap-[2px]">
                    {WEEKDAYS.map((d, i) => (
                      <div key={i} className="flex flex-1 items-center text-[10px] leading-none text-muted-foreground">{d}</div>
                    ))}
                  </div>
                </div>

                {/* Columna principal (meses + cuadrícula) ocupa todo el ancho */}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  {/* Etiquetas de mes con altura reservada (no se enciman con la cuadrícula); ocultas en móvil */}
                  <div className="hidden h-4 gap-[2px] sm:flex">
                    {monthLabels.map((label, i) => (
                      <div key={i} className="relative min-w-0 flex-1">
                        {label && <span className="absolute left-0 top-0 whitespace-nowrap text-[10px] leading-none text-muted-foreground">{label}</span>}
                      </div>
                    ))}
                  </div>

                  {/* Cuadrícula: una columna por semana, cuadritos que llenan el ancho */}
                  <div className="flex gap-[2px]">
                    {data.weeks.map((w, i) => {
                      // La primera semana puede ser parcial: se rellena arriba para alinear por día.
                      const pad = i === 0 && w.days.length > 0 ? (w.days[0]?.weekday ?? 0) : 0;
                      return (
                        <div key={i} className="flex min-w-0 flex-1 flex-col gap-[2px]">
                          {Array.from({ length: pad }).map((_, p) => <div key={`p${p}`} className="aspect-square w-full" />)}
                          {w.days.map((d) => (
                            <div
                              key={d.date}
                              className={cn(CELL, LEVEL_CLASS[d.level])}
                              title={`${d.count} ${d.count === 1 ? 'contribución' : 'contribuciones'} · ${d.date}`}
                            />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Leyenda */}
              <div className="mt-3 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                <span>Menos</span>
                {LEVEL_CLASS.map((c, i) => (
                  <div key={i} className={cn('size-3 rounded-[2px] ring-1 ring-inset ring-black/5 dark:ring-white/5', c)} />
                ))}
                <span>Más</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Card cuadrado a la derecha con stats de GitHub */}
      {loading ? (
        <Card className="min-w-0">
          <CardHeader><CardTitle>Resumen</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 lg:grid-cols-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2.5">
                <Skeleton className="size-9 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : data?.linked && stats ? (
        <Card className="min-w-0">
          <CardHeader><CardTitle>Resumen</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 lg:grid-cols-1">
            <Stat icon={Flame} label="Racha actual" value={`${stats.current} ${stats.current === 1 ? 'día' : 'días'}`} />
            <Stat icon={Award} label="Racha más larga" value={`${stats.longest} ${stats.longest === 1 ? 'día' : 'días'}`} />
            <Stat icon={Zap} label="Mejor día" value={String(stats.best)} sub={stats.bestDate ? fmtDay(stats.bestDate) : undefined} />
            <Stat icon={CalendarCheck} label="Días activos" value={String(stats.active)} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/** Skeleton de la cuadrícula: misma estructura (etiquetas de día + 52 columnas × 7 celdas) con un
 *  único barrido de luz sobre todo el bloque (una sola animación, no 364). */
function ContributionsSkeleton() {
  return (
    <div className="shimmer w-full rounded-md">
      <div className="flex w-full gap-1.5">
        {/* Etiquetas de día (izquierda); ocultas en móvil como en la cuadrícula real */}
        <div className="hidden shrink-0 flex-col gap-1 sm:flex">
          <div className="h-4" />
          <div className="flex flex-1 flex-col gap-[2px]">
            {WEEKDAYS.map((_, i) => (
              <div key={i} className="flex h-3 flex-1 items-center">
                {i % 2 === 1 && <div className="h-2.5 w-6 rounded bg-muted" />}
              </div>
            ))}
          </div>
        </div>
        {/* Cuadrícula */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="hidden h-4 sm:block" />
          <div className="flex gap-[2px]">
            {Array.from({ length: 52 }).map((_, i) => (
              <div key={i} className="flex min-w-0 flex-1 flex-col gap-[2px]">
                {Array.from({ length: 7 }).map((_, j) => (
                  <div key={j} className="aspect-square w-full rounded-[2px] bg-muted" />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, sub }: { icon: LucideIcon; label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-[18px]" />
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-lg font-bold leading-none tabular-nums">{value}</span>
          {sub && <span className="truncate text-[11px] text-muted-foreground">{sub}</span>}
        </div>
        <div className="mt-1 truncate text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}
