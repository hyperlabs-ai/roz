import { useMemo, useState } from 'react';
import { ChevronRight, CircleAlert, Radio } from 'lucide-react';
import { EmptyState, MatrixLoader } from '@/components/bits';
import { GithubAvatar, IntegrationIcon, type IntegrationName } from '@/components/brand';
import { PulseDot } from '@/components/pulse/pulse-ui';
import { DeadEventsDialog } from '@/components/queue/DeadEvents';
import { inflightPhrase } from '@/components/queue/QueueRow';
import { Badge } from '@/components/ui/badge';
import type { PulseFeedItem, PulseFeedKind, PulsePerson } from '@/lib/api';
import { useQueueLive } from '@/queue/QueueContext';
import { cn } from '@/lib/utils';

/**
 * Lo que manda el backend en el feed del Pulso. `deploy` / `infra`, `provider` y `tone` existen en
 * `src/types/roz-v2.ts` pero aún no en el espejo `lib/api.ts` (archivo compartido): se ensancha aquí.
 */
export type HistoryKind = PulseFeedKind | 'deploy' | 'infra';
export type HistoryItem = Omit<PulseFeedItem, 'kind'> & {
  kind: HistoryKind;
  provider?: string | null;
  tone?: 'ok' | 'bad' | 'pending' | null;
};

const KIND: Record<HistoryKind, { source: IntegrationName; label: string }> = {
  commit: { source: 'github', label: 'Commit' },
  branch: { source: 'github', label: 'Rama' },
  pr_opened: { source: 'github', label: 'PR abierta' },
  pr_merged: { source: 'github', label: 'PR integrada' },
  issue_created: { source: 'linear', label: 'Issue nuevo' },
  issue_closed: { source: 'linear', label: 'Issue cerrado' },
  issue_assigned: { source: 'linear', label: 'Asignación' },
  plan: { source: 'claude', label: 'Agente' },
  meeting: { source: 'granola', label: 'Junta' },
  deploy: { source: 'vercel', label: 'Deploy' },
  infra: { source: 'vercel', label: 'Servicio' },
};

const PROVIDERS = new Set<string>(['vercel', 'railway', 'supabase']);

type FilterKey = 'all' | 'commits' | 'issues' | 'prs' | 'plans' | 'meetings' | 'infra';
const FILTERS: { key: FilterKey; label: string; kinds?: HistoryKind[] }[] = [
  { key: 'all', label: 'Todo' },
  { key: 'commits', label: 'Commits', kinds: ['commit', 'branch'] },
  { key: 'issues', label: 'Issues', kinds: ['issue_created', 'issue_closed', 'issue_assigned'] },
  { key: 'prs', label: 'PRs', kinds: ['pr_opened', 'pr_merged'] },
  { key: 'plans', label: 'Planes', kinds: ['plan'] },
  { key: 'meetings', label: 'Juntas', kinds: ['meeting'] },
  { key: 'infra', label: 'Infra', kinds: ['deploy', 'infra'] },
];

const TONE_DOT: Record<string, string> = { ok: 'bg-green', bad: 'bg-red', pending: 'bg-yellow' };

/** Día (YYYY-MM-DD) en la zona del equipo. */
const teamDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

function dayLabel(day: string): string {
  const today = teamDay(new Date().toISOString());
  const yesterday = teamDay(new Date(Date.now() - 86_400_000).toISOString());
  if (day === today) return 'Hoy';
  if (day === yesterday) return 'Ayer';
  return new Date(`${day}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short' });
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Mexico_City' });

/**
 * Historial de eventos del Pulso (antes: el feed "En vivo" + la página de Actividad). Un panel de
 * altura completa: estado del pipeline arriba (lo que se procesa ahora y los eventos sin procesar,
 * con reintento), filtros por tipo —que envuelven a una segunda fila en vez de recortarse— y la
 * lista agrupada por día. El scroll es del panel y su barra queda pegada al borde derecho (la lista
 * no lleva padding lateral propio).
 */
export function PulseHistory({
  items,
  people,
  live,
  freshIds,
  className,
}: {
  items: HistoryItem[];
  people: PulsePerson[];
  live: boolean;
  freshIds: Set<string>;
  className?: string;
}) {
  const [filter, setFilter] = useState<FilterKey>('all');
  const byId = useMemo(() => new Map(people.map((p) => [p.devId, p])), [people]);

  const counts = useMemo(() => {
    const c = {} as Record<FilterKey, number>;
    for (const f of FILTERS) c[f.key] = f.kinds ? items.filter((it) => f.kinds!.includes(it.kind)).length : items.length;
    return c;
  }, [items]);

  const active = FILTERS.find((f) => f.key === filter)!;
  const shown = active.kinds ? items.filter((it) => active.kinds!.includes(it.kind)) : items;

  // Agrupado por día (ya viene del más nuevo al más viejo).
  const days = useMemo(() => {
    const out: { day: string; items: HistoryItem[] }[] = [];
    for (const it of shown) {
      const d = teamDay(it.at);
      const last = out[out.length - 1];
      if (last && last.day === d) last.items.push(it);
      else out.push({ day: d, items: [it] });
    }
    return out;
  }, [shown]);

  return (
    <section
      id="historial"
      aria-label="Historial de eventos"
      className={cn('flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card', className)}
    >
      {/* Cabecera */}
      <div className="flex items-center justify-between gap-3 px-5 pt-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-[15px] font-semibold tracking-[-0.02em]">Historial</span>
          <span className="truncate text-xs tabular-nums text-faint">
            {items.length} evento{items.length === 1 ? '' : 's'}
          </span>
        </div>
        {live ? (
          <Badge variant="ok" title="Se actualiza cada 20 s">
            <PulseDot className="size-[7px] bg-current" />
            en vivo
          </Badge>
        ) : (
          <Badge variant="neutral" dot>
            foto de la semana
          </Badge>
        )}
      </div>

      <PipelineStatus />

      {/* Filtros: envuelven; ninguno queda recortado ni escondido tras un scroll horizontal. */}
      <div className="flex shrink-0 flex-wrap gap-1.5 border-b px-5 pb-3.5 pt-3.5">
        {FILTERS.map((f) => {
          const on = filter === f.key;
          const n = counts[f.key];
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={on}
              className={cn(
                'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-colors',
                on ? 'bg-orange-soft text-orange-ink' : 'bg-panel text-muted-foreground hover:text-foreground',
                !on && n === 0 && 'opacity-50',
              )}
            >
              {f.label}
              <span className={cn('text-[11px] tabular-nums', on ? 'text-orange-ink/80' : 'text-faint')}>{n}</span>
            </button>
          );
        })}
      </div>

      {/* Lista */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {!items.length ? (
          <EmptyState icon={<Radio />}>
            {live ? 'Todavía no pasa nada esta semana. Commits, PRs, issues, agentes, juntas y deploys aparecen aquí.' : 'No hubo eventos esa semana.'}
          </EmptyState>
        ) : !shown.length ? (
          <EmptyState>Sin eventos de {active.label.toLowerCase()} en esta semana.</EmptyState>
        ) : (
          days.map((g) => (
            <div key={g.day}>
              <div className="sticky top-0 z-[1] flex items-center justify-between gap-2 border-b bg-card/95 px-5 py-2 backdrop-blur-sm">
                <span className="label-caps text-muted-foreground">{dayLabel(g.day)}</span>
                <span className="rounded-full bg-panel px-1.5 py-px text-[10.5px] font-semibold tabular-nums text-muted-foreground">
                  {g.items.length}
                </span>
              </div>
              <ol>
                {g.items.map((it) => (
                  <HistoryRow key={it.id} it={it} person={it.devId ? byId.get(it.devId) : undefined} fresh={freshIds.has(it.id)} />
                ))}
              </ol>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function HistoryRow({ it, person, fresh }: { it: HistoryItem; person?: PulsePerson; fresh: boolean }) {
  const k = KIND[it.kind] ?? KIND.commit;
  const infra = it.kind === 'deploy' || it.kind === 'infra';
  const source: IntegrationName = infra && it.provider && PROVIDERS.has(it.provider) ? (it.provider as IntegrationName) : k.source;
  return (
    <li
      className={cn(
        'grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-3 border-b border-border/60 px-5 py-3 transition-colors last:border-b-0 hover:bg-sidebar/60',
        fresh && 'animate-page bg-orange-soft/40',
      )}
    >
      <span className="relative mt-0.5">
        <IntegrationIcon name={source} size="sm" framed />
        {infra && it.tone ? (
          <span className={cn('absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-card', TONE_DOT[it.tone])} />
        ) : (
          person && (
            <GithubAvatar
              login={person.githubLogin}
              id={person.devId}
              url={person.avatarUrl}
              name={person.name}
              className="absolute -bottom-1.5 -right-1 size-4 ring-2 ring-card"
            />
          )
        )}
      </span>
      <div className="min-w-0">
        <div className="line-clamp-2 text-[13px] leading-snug">
          {it.url ? (
            <a href={it.url} target="_blank" rel="noreferrer noopener" className="hover:underline">
              {it.text}
            </a>
          ) : (
            it.text
          )}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          <span className={cn('label-caps text-[10px]', it.tone === 'bad' && 'text-red')}>{k.label}</span>
          {it.identifier && (
            <>
              <span className="text-[10px] text-faint">·</span>
              <span className="truncate font-mono text-[10.5px] text-faint">{it.identifier}</span>
            </>
          )}
        </div>
      </div>
      <span className="pt-0.5 text-[11px] tabular-nums text-faint" title={new Date(it.at).toLocaleString('es-MX')}>
        {clock(it.at)}
      </span>
    </li>
  );
}

/**
 * Estado del pipeline (lo que antes era la página de Actividad): lo que se procesa ahora o "al
 * día", y si hay eventos que agotaron sus reintentos, un aviso rojo que abre el detalle con
 * reintento. Lee del sondeo global (`useQueueLive`): no agrega peticiones.
 */
function PipelineStatus() {
  const { pulse, stale } = useQueueLive();
  const [open, setOpen] = useState(false);
  if (!pulse && !stale) return null;

  const dead = pulse?.counts.dead ?? 0;
  const active = pulse?.inflight[0] ?? null;
  const queued = (pulse?.counts.pending ?? 0) + (pulse?.counts.processing ?? 0);

  return (
    <div className="grid gap-2 px-5 pt-3.5">
      <div className="flex min-w-0 items-center gap-2.5 rounded-md bg-panel px-3 py-2 text-[12.5px] text-muted-foreground">
        {stale ? (
          <>
            <span className="size-2 shrink-0 rounded-full bg-toggle-off" />
            <span className="truncate">Sin contacto con el servidor</span>
          </>
        ) : active ? (
          <>
            <MatrixLoader className="size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 truncate text-foreground">{inflightPhrase(active)}</span>
            {queued > 1 && <span className="ml-auto shrink-0 tabular-nums text-faint">+{queued - 1} en cola</span>}
          </>
        ) : (
          <>
            <span className={cn('size-2 shrink-0 rounded-full', pulse?.health === 'delayed' ? 'bg-yellow' : 'bg-green')} />
            <span className="truncate font-medium text-foreground">
              {pulse?.health === 'delayed' ? 'El procesamiento va con retraso' : 'Pipeline al día'}
            </span>
            <span className="ml-auto shrink-0 tabular-nums text-faint" title="Eventos procesados en la última hora">
              {pulse?.counts.doneLastHour ?? 0} en la última hora
            </span>
          </>
        )}
      </div>
      {dead > 0 && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="group flex items-center gap-2.5 rounded-md bg-red-soft px-3 py-2 text-left text-[12.5px] font-medium text-red transition-opacity hover:opacity-90"
        >
          <CircleAlert className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            <b className="font-semibold tabular-nums">{dead}</b> evento{dead === 1 ? '' : 's'} sin procesar
          </span>
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[12px] font-semibold">
            Revisar
            <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </button>
      )}
      <DeadEventsDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
