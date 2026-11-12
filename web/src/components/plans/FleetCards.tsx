import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Cpu, Plus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { GithubAvatar, CapsLabel } from '@/components/brand';
import { ProgressBar } from '@/components/bits';
import { scheduleText } from '@/components/plans/RunnersCard';
import { BalancedGrid } from '@/components/grid';
import type { PlanDevRef, PlansResponse, RunnerSummary } from '@/lib/api';
import { relative } from '@/lib/format';

/**
 * Tarjetas de la flota (`.g3` de "Flota" en el mock): un runner por equipo con su dev, sistema,
 * horario y ocupación (trabajos corriendo / máximo), más una tarjeta oscura con el total de la flota.
 */
export function FleetCards({
  runners,
  loading,
  failed,
  people,
  counts,
}: {
  runners: RunnerSummary[];
  loading: boolean;
  failed: boolean;
  /** Dueños de planes por id: de ahí sale la foto de GitHub del dev del runner. */
  people: Map<string, PlanDevRef>;
  counts: PlansResponse['counts'] | null;
}) {
  if (loading) {
    return (
      <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[118px] rounded-lg" />)}
      </div>
    );
  }
  if (failed) {
    return <p className="text-xs text-muted-foreground">No se pudo cargar la flota de runners.</p>;
  }
  if (!runners.length) {
    return (
      <Card className="flex flex-wrap items-center gap-4 p-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-panel text-muted-foreground"><Cpu className="size-5" /></span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <b className="text-sm font-semibold">Ningún equipo conectado</b>
          <span className="text-xs text-muted-foreground">
            Sin un roz-runner en la PC de un dev, los planes de su cola se quedan esperando. Crea un token en Configuración.
          </span>
        </div>
        <Button asChild size="sm" variant="secondary"><Link to="/app/settings"><Plus /> Registrar runner</Link></Button>
      </Card>
    );
  }

  const live = runners.filter((r) => r.online);
  const capacity = live.reduce((n, r) => n + r.maxConcurrent, 0);
  const busy = live.reduce((n, r) => n + r.running, 0);
  const queued = counts?.en_cola ?? 0;
  const waiting = counts?.esperando_aprobacion ?? 0;

  return (
    <BalancedGrid max={{ base: 1, md: 2, xl: 3 }} className="stagger-children gap-3.5">
      {runners.map((r) => {
        const person = people.get(r.devId);
        const pct = r.maxConcurrent ? (r.running / r.maxConcurrent) * 100 : 0;
        const full = r.running >= r.maxConcurrent && r.running > 0;
        return (
          <Card key={r.id} className="grid content-start gap-2.5 p-4">
            <div className="flex items-center gap-2.5">
              <GithubAvatar
                login={person?.githubLogin}
                url={person?.avatarUrl}
                id={r.devId}
                name={r.devName}
                presence={r.online ? 'on' : 'off'}
                color="orange"
              />
              <div className="grid min-w-0 flex-1">
                <b className="truncate text-[13px] font-semibold">{r.devName} · {r.name}</b>
                <span className="truncate text-[11.5px] text-muted-foreground">
                  {[r.platform, scheduleText(r.schedule), `máx ${r.maxConcurrent}`].filter(Boolean).join(' · ')}
                </span>
              </div>
            </div>
            <ProgressBar pct={pct} color={full ? 'purple-deep' : 'orange'} />
            <span className="text-[11.5px] text-muted-foreground">
              {r.online
                ? `${r.running} de ${r.maxConcurrent} trabajo${r.maxConcurrent === 1 ? '' : 's'}${r.version ? ` · v${r.version}` : ''}`
                : `Fuera de línea · ${r.lastSeenAt ? `visto ${relative(r.lastSeenAt)}` : 'nunca se ha conectado'}`}
            </span>
          </Card>
        );
      })}

      <div className="grid content-start gap-2.5 rounded-lg bg-ink p-4 text-ink-foreground">
        <div className="flex items-center gap-2.5">
          <span className="grid size-[34px] shrink-0 place-items-center rounded-full bg-ink-foreground/15"><Cpu className="size-4" /></span>
          <div className="grid min-w-0">
            <b className="text-[13px] font-semibold">Flota completa</b>
            <span className="text-[11.5px] opacity-70">{live.length} de {runners.length} equipo{runners.length === 1 ? '' : 's'} en línea</span>
          </div>
        </div>
        <ProgressBar pct={capacity ? (busy / capacity) * 100 : 0} color="green" className="bg-ink-foreground/15" />
        <span className="text-[11.5px] opacity-70">
          {busy} de {capacity} lugares ocupados · {queued} en cola{waiting ? ` · ${waiting} esperando aprobación` : ''}
        </span>
      </div>
    </BalancedGrid>
  );
}

/** Encabezado de bloque interno (`.ct` + etiqueta `label-caps` a la derecha). */
export function BlockHead({ title, meta, children }: { title: string; meta?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-semibold tracking-[-0.01em]">{title}</span>
      <div className="flex flex-wrap items-center gap-2">
        {meta && <CapsLabel>{meta}</CapsLabel>}
        {children}
      </div>
    </div>
  );
}
