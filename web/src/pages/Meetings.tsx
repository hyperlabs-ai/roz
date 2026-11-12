// Juntas (roz v2): de una junta (pegada, subida o traída de Granola) a tareas: issues en Linear con
// ROZ_LINEAR_SOT encendido, tareas nativas de roz con el flag apagado.
//
// roz lee la junta y propone tareas y compromisos con su cita literal (verificada contra el texto),
// los clasifica con Jev, busca duplicados en el espejo y propone responsable con la política. Aquí
// una persona decide: aceptar (crea el issue o comenta el duplicado en Linear) o descartar. Las
// decisiones de la junta van directo al brain y solo se muestran.
//
// Composición del mock (`#producto → Juntas`): la lista de juntas a la izquierda (con la BANDEJA
// arriba: lo pendiente de todas) y, a la derecha, la bandeja o el detalle de una junta en `?m=<id>`
// (transcripción con las citas resaltadas + sus candidatas).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Inbox, CalendarDays, RotateCcw, Trash2, Loader2, Users } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { EmptyState, ErrorCard, RefreshButton } from '@/components/bits';
import { Eyebrow, IntegrationIcon, CapsLabel } from '@/components/brand';
import { V2OffState, isSotOff, useRozV2 } from '@/components/pulse/roz-v2';
import { ManualSessionDialog } from '@/components/meetings/ManualSessionDialog';
import { AcceptDialog } from '@/components/meetings/AcceptDialog';
import { CandidateCard, DiscardDialog } from '@/components/meetings/CandidateCard';
import { TranscriptView } from '@/components/meetings/TranscriptView';
import {
  FORMAT_LABEL, MeetingStatusBadge, MiniAvatar, SourceBadge, candidateTones, toneAt,
} from '@/components/meetings/meeting-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useApi } from '@/lib/useApi';
import { useAction } from '@/lib/useAction';
import { usePoll } from '@/lib/usePoll';
import { invalidate } from '@/lib/store';
import { toast } from '@/lib/toast';
import {
  apiGet, rozV2Api,
  type AcceptCandidateRequest, type AcceptCandidateResponse, type InboxCandidate, type InboxResponse, type MeetingCandidate,
  type MeetingDetailResponse, type MeetingSummary, type MeetingsResponse, type TicketFilterOptions,
} from '@/lib/api';
import { relative, shortDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ProjectIcon } from '@/components/avatars';
import { BalancedGrid } from '@/components/grid';

const NO_PROJECT = '__none__';

/** Candidatas que se pueden aceptar sin revisar: sin duplicado, con responsable y con proyecto. */
function isRiskZero(c: InboxCandidate): boolean {
  return c.status === 'pendiente' && c.kind !== 'decision' && !c.duplicate && !!c.proposedDev && !!c.meeting.projectId;
}

/** Aviso de lo que pasó al aceptar (incluye lo que Linear no pudo mapear). */
function acceptedNote(r: AcceptCandidateResponse): { title: string; description?: string } {
  const where = r.issue
    ? r.issue.linearIssueId ? `Issue ${r.issue.identifier} creado en Linear` : `Tarea ${r.issue.identifier} creada en roz`
    : r.comment ? `Comentado en ${r.comment.identifier}` : 'Aceptada';
  return { title: where, description: r.warnings.length ? r.warnings.join(' · ') : undefined };
}

export default function Meetings() {
  const v2 = useRozV2();
  const [params, setParams] = useSearchParams();
  const meetingId = params.get('m');
  const setParam = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: false });
  };

  const filters = useApi<TicketFilterOptions>(() => apiGet('/tickets/filters'), [], { key: '/tickets/filters', ttl: 600_000 });
  const meetings = useApi<MeetingsResponse>(() => rozV2Api.meetings({ limit: 60 }), [], { key: '/meetings', ttl: 20_000 });
  const inbox = useApi<InboxResponse>(() => rozV2Api.inbox(), [], { key: '/meetings/inbox', ttl: 20_000 });

  // Mientras roz lee alguna junta, se sondea: las candidatas aparecen solas.
  const reading = (meetings.data?.meetings ?? []).some((m) => m.status === 'pendiente' || m.status === 'extrayendo');
  usePoll(() => { meetings.reload(); inbox.reload(); }, useReadingCadence(reading, 6_000), { onFocus: 'always' });

  const [creating, setCreating] = useState(false);
  const flow = useCandidateFlow();
  // Lote de "Aceptar riesgo 0": todas las de la bandeja, o solo las de la junta abierta.
  const [bulkList, setBulkList] = useState<InboxCandidate[] | null>(null);
  const bulk = useAction();

  const off = isSotOff(meetings.error) || isSotOff(inbox.error);
  const projects = filters.data?.allProjects ?? [];
  const pendingCount = inbox.data?.candidates.length ?? 0;
  const riskZero = (inbox.data?.candidates ?? []).filter(isRiskZero);

  async function acceptBulk() {
    const list = bulkList ?? [];
    let ok = 0;
    await bulk.run('bulk', async () => {
      for (const c of list) {
        try {
          await rozV2Api.acceptCandidate(c.id, {});
          ok++;
        } catch {
          /* se cuenta abajo; la candidata queda pendiente */
        }
      }
    }, { success: false });
    invalidate('/meetings');
    setBulkList(null);
    if (ok === list.length) toast.success(`${ok} tarea${ok === 1 ? '' : 's'} creada${ok === 1 ? '' : 's'} en ${v2.linearSourceOfTruth ? 'Linear' : 'roz'}`);
    else toast.error(`Se aceptaron ${ok} de ${list.length}`, { description: 'Las demás siguen en la bandeja.' });
  }

  const granola = meetings.data?.granolaEnabled;

  return (
    <Layout
      title="Juntas"
      eyebrow="Entrada · bandeja"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {meetings.data && (
            granola ? (
              <Badge variant="ok" dot title="Granola por API: las juntas llegan solas">
                <IntegrationIcon name="granola" size="xs" title="" />Granola conectado
              </Badge>
            ) : (
              <Badge variant="neutral" title="Sin GRANOLA_API_KEY el sondeo de Granola está apagado">
                <IntegrationIcon name="granola" size="xs" title="" />Granola por API apagado
              </Badge>
            )
          )}
          <RefreshButton busy={meetings.refetching || inbox.refetching} onClick={() => { meetings.reload(); inbox.reload(); }} />
          <Button variant="dark" onClick={() => setCreating(true)} disabled={off}><Plus /> Sesión manual</Button>
        </div>
      }
    >
      {off ? (
        <V2OffState what="Las juntas" />
      ) : (
        // Dos paneles del MISMO alto: en escritorio ocupan el alto visible (topbar + márgenes del
        // shell = 8rem) y cada uno desplaza su contenido por dentro, así empiezan y terminan en la
        // misma línea con 0 o con 60 juntas. En móvil se apilan con su alto natural.
        <div className="grid gap-3.5 lg:h-[calc(100dvh-8rem)] lg:min-h-[32rem] lg:grid-cols-[288px_minmax(0,1fr)]">
          <MeetingRail
            data={meetings}
            pendingCount={pendingCount}
            selected={meetingId}
            onInbox={() => setParam({ m: null, c: null, tab: null })}
            onOpen={(id) => setParam({ m: id, c: null, tab: null })}
          />
          <Card className="flex min-h-[22rem] min-w-0 flex-col overflow-hidden lg:min-h-0">
            {meetingId ? (
              <MeetingDetailView
                key={meetingId}
                id={meetingId}
                projects={projects}
                flow={flow}
                riskZero={riskZero.filter((c) => c.meeting.id === meetingId)}
                onBulk={setBulkList}
                activeCandidate={params.get('c')}
                onPickCandidate={(id) => setParam({ c: id })}
                onBack={() => setParam({ m: null, c: null })}
              />
            ) : (
              <InboxView data={inbox} flow={flow} riskZero={riskZero} onBulk={setBulkList} onCreate={() => setCreating(true)} />
            )}
          </Card>
        </div>
      )}

      <ManualSessionDialog
        open={creating}
        onOpenChange={setCreating}
        projects={projects}
        onCreated={(m) => {
          invalidate('/meetings');
          setParam({ tab: null, c: null, m: m.id });
        }}
      />

      <AcceptDialog
        candidate={flow.editing}
        filters={filters.data ?? null}
        busy={flow.editing ? flow.action.busy(`accept:${flow.editing.id}`) : false}
        onCancel={() => flow.setEditing(null)}
        onConfirm={(body) => flow.editing && flow.accept(flow.editing, body)}
      />
      <DiscardDialog
        candidate={flow.discarding}
        busy={flow.discarding ? flow.action.busy(`discard:${flow.discarding.id}`) : false}
        onCancel={() => flow.setDiscarding(null)}
        onConfirm={(reason) => flow.discarding && flow.discard(flow.discarding, reason)}
      />

      <AlertDialog open={!!bulkList} onOpenChange={(v) => !v && !bulk.anyBusy && setBulkList(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <Eyebrow color="green">Riesgo 0</Eyebrow>
            <AlertDialogTitle>
              ¿Aceptar {bulkList?.length ?? 0} candidata{bulkList?.length === 1 ? '' : 's'} de riesgo 0?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Son las que no tienen duplicado en el espejo, ya tienen responsable propuesto y su junta tiene proyecto. Se crean
              en {v2.linearSourceOfTruth ? 'Linear' : 'roz'} tal como las propuso roz (título, responsable, prioridad y estimación).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-48 divide-y overflow-y-auto rounded-lg border bg-card text-[13px]">
            {(bulkList ?? []).map((c, i) => (
              <li key={c.id} className="flex items-center gap-2.5 px-3 py-2">
                <span aria-hidden className={cn('size-2 shrink-0 rounded-full', toneAt(i).dot)} />
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">→ {c.proposedDev?.name}</span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulk.anyBusy}>Cancelar</AlertDialogCancel>
            <AlertDialogAction disabled={bulk.anyBusy} onClick={(e) => { e.preventDefault(); void acceptBulk(); }}>
              {bulk.anyBusy ? <><Loader2 className="animate-spin" /> Creando…</> : `Crear en ${v2.linearSourceOfTruth ? 'Linear' : 'roz'}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}

// ---- Acciones sobre candidatas (compartidas por la bandeja y el detalle)

type Flow = ReturnType<typeof useCandidateFlow>;

function useCandidateFlow() {
  const action = useAction();
  const [editing, setEditing] = useState<MeetingCandidate | null>(null);
  const [discarding, setDiscarding] = useState<MeetingCandidate | null>(null);

  const accept = (c: MeetingCandidate, body: AcceptCandidateRequest) =>
    action.run(`accept:${c.id}`, () => rozV2Api.acceptCandidate(c.id, body), {
      error: 'No se pudo aceptar',
      onDone: (r) => {
        toast.success(acceptedNote(r).title, { description: acceptedNote(r).description });
        setEditing(null);
        invalidate('/meetings');
      },
    });
  const discard = (c: MeetingCandidate, reason: string | null) =>
    action.run(`discard:${c.id}`, () => rozV2Api.discardCandidate(c.id, reason), {
      success: 'Candidata descartada',
      error: 'No se pudo descartar',
      onDone: () => {
        setDiscarding(null);
        invalidate('/meetings');
      },
    });
  const busy = (c: MeetingCandidate) => action.busy(`accept:${c.id}`) || action.busy(`discard:${c.id}`);
  return { action, editing, setEditing, discarding, setDiscarding, accept, discard, busy };
}

// ---- Columna izquierda: bandeja + lista de juntas (`.mtg` del mock)

/** Alto común de la cabecera de los dos paneles: sus líneas inferiores quedan a la misma altura. */
const PANE_HEAD = 'flex min-h-[4.5rem] shrink-0 items-center gap-3 border-b px-4 py-3';

function MeetingRail({
  data,
  pendingCount,
  selected,
  onInbox,
  onOpen,
}: {
  data: { data: MeetingsResponse | null; loading: boolean; refetching: boolean; error: string | null };
  pendingCount: number;
  selected: string | null;
  onInbox: () => void;
  onOpen: (id: string) => void;
}) {
  const list = data.data?.meetings ?? [];
  const reading = list.filter((m) => m.status === 'pendiente' || m.status === 'extrayendo').length;
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <button
        type="button"
        onClick={onInbox}
        aria-current={!selected ? 'true' : undefined}
        className={cn(
          PANE_HEAD,
          'w-full text-left transition-colors duration-fast',
          !selected ? 'bg-orange-soft' : 'hover:bg-sidebar',
        )}
      >
        <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', !selected ? 'bg-orange text-white' : 'bg-panel text-muted-foreground')}>
          <Inbox className="size-4" />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <b className={cn('text-sm font-semibold leading-tight', !selected && 'text-orange-ink')}>Bandeja</b>
          <span className="truncate text-[11.5px] text-muted-foreground">
            {pendingCount > 0 ? `${pendingCount} por decidir` : 'Al día, nada por decidir'}
          </span>
        </span>
        {pendingCount > 0 && (
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-orange px-1.5 text-[11px] font-semibold tabular-nums text-white">
            {pendingCount}
          </span>
        )}
      </button>

      <div className="flex shrink-0 items-center justify-between border-b bg-sidebar px-4 py-2">
        <CapsLabel>Juntas{list.length ? ` · ${list.length}` : ''}</CapsLabel>
        {data.refetching ? (
          <Loader2 className="size-3 animate-spin text-faint" />
        ) : reading > 0 ? (
          <span className="flex items-center gap-1.5 text-[11px] text-purple-deep">
            <span className="size-1.5 animate-pulse rounded-full bg-purple-deep" />
            leyendo {reading}
          </span>
        ) : null}
      </div>

      {data.error ? (
        <div className="p-3"><ErrorCard message={data.error} /></div>
      ) : data.loading || !data.data ? (
        <div className="divide-y">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="grid gap-1.5 px-4 py-3">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          ))}
        </div>
      ) : !list.length ? (
        // Sin botón propio: crear vive en la barra superior y en el panel de la derecha.
        <div className="grid flex-1 place-items-center px-5 py-8">
          <div className="grid justify-items-center gap-2.5 text-center">
            <span className="grid size-10 place-items-center rounded-lg bg-panel text-muted-foreground">
              <CalendarDays className="size-[18px]" />
            </span>
            <p className="max-w-[14rem] text-[12.5px] leading-relaxed text-muted-foreground">
              Aún no hay juntas. Las que crees
              {data.data.granolaEnabled ? ' o lleguen de Granola' : ''} aparecerán aquí, la más reciente arriba.
            </p>
          </div>
        </div>
      ) : (
        <div className="scroll-thin max-h-[44dvh] min-h-0 divide-y overflow-y-auto lg:max-h-none lg:flex-1">
          {list.map((m) => <MeetingRow key={m.id} m={m} active={selected === m.id} onOpen={() => onOpen(m.id)} />)}
        </div>
      )}
    </Card>
  );
}

function MeetingRow({ m, active, onOpen }: { m: MeetingSummary; active: boolean; onOpen: () => void }) {
  const meta = [shortDate(m.heldAt), m.durationMin ? `${m.durationMin} min` : null, m.attendees.length ? `${m.attendees.length} asist.` : null]
    .filter(Boolean)
    .join(' · ');
  let status: ReactNode;
  let dot = 'bg-toggle-off';
  if (m.status === 'extrayendo' || m.status === 'pendiente') {
    dot = 'animate-pulse bg-purple-deep';
    status = <span className="text-purple-deep">{m.status === 'extrayendo' ? 'roz la está leyendo' : 'en espera de lectura'}</span>;
  } else if (m.status === 'error') {
    dot = 'bg-red';
    status = <span className="text-red">no se pudo leer</span>;
  } else if (!m.projectId) {
    dot = 'bg-red';
    status = <span className="text-red">elige un proyecto</span>;
  } else if (m.counts.pendientes > 0) {
    dot = 'bg-orange';
    status = <span className="text-orange-ink">{m.counts.pendientes} candidata{m.counts.pendientes === 1 ? '' : 's'} por revisar</span>;
  } else {
    dot = 'bg-green';
    const bits = [
      `${m.counts.aceptadas} aceptada${m.counts.aceptadas === 1 ? '' : 's'}`,
      m.counts.descartadas ? `${m.counts.descartadas} descartada${m.counts.descartadas === 1 ? '' : 's'}` : null,
      m.counts.decisiones ? `${m.counts.decisiones} decisi${m.counts.decisiones === 1 ? 'ón' : 'ones'}` : null,
    ].filter(Boolean);
    status = <span className="text-faint">{bits.join(' · ')}</span>;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'relative grid w-full gap-1 px-4 py-3 text-left text-[13px] transition-colors duration-fast',
        active ? 'bg-orange-soft' : 'hover:bg-sidebar',
      )}
    >
      {active && <span aria-hidden className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-orange" />}
      <span className="flex min-w-0 items-center justify-between gap-2">
        <b className={cn('truncate font-semibold', active && 'text-orange-ink')}>{m.title}</b>
        <SourceBadge source={m.source} />
      </span>
      <span className="flex min-w-0 items-center gap-1 text-[11.5px] text-muted-foreground">
        <span className="shrink-0">{meta}</span>
        {m.projectName && <>·<ProjectIcon id={m.projectId} size="xs" /><span className="truncate">{m.projectName}</span></>}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[11.5px]">
        <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', dot)} />
        <span className="truncate">{status}</span>
      </span>
    </button>
  );
}

// ---- Panel derecho: piezas comunes

/** Cabecera DENTRO del panel (eyebrow + título + acción), a la altura de la cabecera de la lista. */
function PaneHead({ eyebrow, title, meta, action }: { eyebrow: ReactNode; title: ReactNode; meta?: ReactNode; action?: ReactNode }) {
  return (
    <div className={cn(PANE_HEAD, 'flex-wrap justify-between')}>
      <div className="grid min-w-0 gap-1">
        <Eyebrow color="yellow">{eyebrow}</Eyebrow>
        <h2 className="truncate text-lg font-semibold leading-tight tracking-[-0.03em]">{title}</h2>
      </div>
      {(meta || action) && (
        <div className="flex flex-wrap items-center gap-2">
          {meta}
          {action}
        </div>
      )}
    </div>
  );
}

/** Cuerpo del panel: se queda el alto que sobra y desplaza por dentro, con barra discreta. */
function PaneBody({ children, dim, center, className }: { children: ReactNode; dim?: boolean; center?: boolean; className?: string }) {
  return (
    <div
      className={cn(
        'scroll-thin min-h-0 flex-1 overflow-y-auto p-4 transition-opacity duration-200',
        center && 'grid place-items-center',
        dim && 'pointer-events-none opacity-55',
        className,
      )}
    >
      {children}
    </div>
  );
}

// ---- Bandeja

function InboxView({
  data,
  flow,
  riskZero,
  onBulk,
  onCreate,
}: {
  data: { data: InboxResponse | null; loading: boolean; refetching: boolean; error: string | null };
  flow: Flow;
  riskZero: InboxCandidate[];
  onBulk: (list: InboxCandidate[]) => void;
  onCreate: () => void;
}) {
  // Agrupadas por junta: el contexto de dónde salió cada una importa al decidir.
  const groups = useMemo(() => {
    const m = new Map<string, { meeting: InboxCandidate['meeting']; items: InboxCandidate[] }>();
    for (const c of data.data?.candidates ?? []) {
      const g = m.get(c.meeting.id) ?? { meeting: c.meeting, items: [] };
      g.items.push(c);
      m.set(c.meeting.id, g);
    }
    return [...m.values()].sort((a, b) => b.meeting.heldAt.localeCompare(a.meeting.heldAt));
  }, [data.data]);
  const total = data.data?.candidates.length ?? 0;

  const head = (
    <PaneHead
      eyebrow="Bandeja"
      title="Candidatas por decidir"
      meta={total > 0 && (
        <span className="text-xs tabular-nums text-muted-foreground">
          {total} pendiente{total === 1 ? '' : 's'} · {groups.length} junta{groups.length === 1 ? '' : 's'}
        </span>
      )}
      action={riskZero.length > 0 && (
        <Button size="sm" variant="secondary" onClick={() => onBulk(riskZero)}>Aceptar riesgo 0 · {riskZero.length}</Button>
      )}
    />
  );

  if (data.error) return <>{head}<PaneBody><ErrorCard message={data.error} /></PaneBody></>;
  if (data.loading || !data.data) return <>{head}<PaneBody><CardsSkeleton /></PaneBody></>;
  if (!groups.length) {
    return (
      <>
        {head}
        <PaneBody center>
          <EmptyState icon={<Inbox />} action={<Button size="sm" variant="secondary" onClick={onCreate}><Plus /> Sesión manual</Button>}>
            La bandeja está al día. Cuando roz lea una junta, lo que proponga aparecerá aquí para que decidas.
          </EmptyState>
        </PaneBody>
      </>
    );
  }
  return (
    <>
      {head}
      <PaneBody dim={data.refetching} className="grid content-start gap-6">
        {groups.map((g) => (
          <section key={g.meeting.id} className="grid gap-2.5">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <h3 className="text-sm font-semibold tracking-[-0.01em]">{g.meeting.title}</h3>
              <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
                {shortDate(g.meeting.heldAt)} · {g.meeting.projectId && <ProjectIcon id={g.meeting.projectId} size="xs" />}{g.meeting.projectName ?? 'sin proyecto'}
              </span>
              <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
              <span className="text-[11px] tabular-nums text-faint">{g.items.length} pendiente{g.items.length === 1 ? '' : 's'}</span>
            </div>
            <BalancedGrid max={{ base: 1, xl: 2 }} className="gap-2.5">
              {g.items.map((c, i) => (
                <CandidateCard
                  key={c.id}
                  c={c}
                  tone={toneAt(i)}
                  busy={flow.busy(c)}
                  onAccept={() => void flow.accept(c, {})}
                  onEdit={() => flow.setEditing(c)}
                  onDiscard={() => flow.setDiscarding(c)}
                />
              ))}
            </BalancedGrid>
          </section>
        ))}
      </PaneBody>
    </>
  );
}

// ---- Detalle de una junta

function MeetingDetailView({
  id,
  projects,
  flow,
  riskZero,
  onBulk,
  activeCandidate,
  onPickCandidate,
  onBack,
}: {
  id: string;
  projects: { id: string; name: string }[];
  flow: Flow;
  riskZero: InboxCandidate[];
  onBulk: (list: InboxCandidate[]) => void;
  activeCandidate: string | null;
  onPickCandidate: (id: string) => void;
  onBack: () => void;
}) {
  const { data, loading, refetching, error, reload } = useApi<MeetingDetailResponse>(() => rozV2Api.meeting(id), [id], {
    key: '/meetings/detail',
    ttl: 15_000,
  });
  const action = useAction();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const reading = data?.meeting.status === 'pendiente' || data?.meeting.status === 'extrayendo';
  usePoll(reload, useReadingCadence(reading, 5_000), { onFocus: 'always' });
  const tones = useMemo(() => candidateTones(data?.candidates ?? []), [data]);

  if (error) return <PaneBody><ErrorCard message={error} /></PaneBody>;
  if (loading || !data) {
    return (
      <>
        <div className={PANE_HEAD}>
          <div className="grid gap-2"><Skeleton className="h-3 w-24" /><Skeleton className="h-5 w-64" /></div>
        </div>
        <PaneBody className="grid content-start gap-3.5 xl:grid-cols-2">
          <Skeleton className="h-96 rounded-lg" />
          <div className="grid content-start gap-2.5"><Skeleton className="h-28 rounded-lg" /><Skeleton className="h-28 rounded-lg" /><Skeleton className="h-28 rounded-lg" /></div>
        </PaneBody>
      </>
    );
  }

  const m = data.meeting;
  const pending = data.candidates.filter((c) => c.kind !== 'decision' && c.status === 'pendiente');
  const decided = data.candidates.filter((c) => c.kind !== 'decision' && c.status !== 'pendiente');
  const decisions = data.candidates.filter((c) => c.kind === 'decision');

  const setProject = (v: string) =>
    action.run('project', () => rozV2Api.setMeetingProject(m.id, v === NO_PROJECT ? null : v), {
      success: 'Proyecto actualizado',
      error: 'No se pudo cambiar el proyecto',
      onDone: () => invalidate('/meetings'),
    });
  const retry = () =>
    action.run('retry', () => rozV2Api.retryMeeting(m.id), {
      success: 'roz vuelve a leer la junta',
      error: 'No se pudo reintentar',
      onDone: () => invalidate('/meetings'),
    });
  const remove = () =>
    action.run('delete', () => rozV2Api.deleteMeeting(m.id), {
      success: 'Junta eliminada',
      error: 'No se pudo eliminar',
      onDone: () => {
        invalidate('/meetings');
        onBack();
      },
      onSettled: () => setConfirmDelete(false),
    });

  const candidateCard = (c: MeetingCandidate) => (
    <CandidateCard
      key={c.id}
      c={c}
      tone={tones.get(c.id)}
      hasProject={!!m.projectId}
      active={activeCandidate === c.id}
      busy={flow.busy(c)}
      onQuoteClick={() => onPickCandidate(c.id)}
      onAccept={() => void flow.accept(c, {})}
      onEdit={() => flow.setEditing(c)}
      onDiscard={() => flow.setDiscarding(c)}
    />
  );

  return (
    <>
      {/* Cabecera de la junta: fija arriba del panel */}
      <div className={cn(PANE_HEAD, 'flex-wrap justify-between')}>
        <div className="grid min-w-0 gap-1">
          <Eyebrow color="yellow">Junta {m.source === 'granola' ? 'de Granola' : 'manual'}</Eyebrow>
          <h2 className="truncate text-lg font-semibold leading-tight tracking-[-0.03em]">{m.title}</h2>
        </div>
        <div className="flex items-center gap-1.5">
          <SourceBadge source={m.source} />
          <MeetingStatusBadge status={m.status} />
          <Button size="icon-sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirmDelete(true)} aria-label="Eliminar junta" title="Eliminar junta">
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="grid shrink-0 gap-2.5 border-b bg-sidebar px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="size-3.5 text-faint" />
            {new Date(m.heldAt).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })}
            {m.durationMin ? ` · ${m.durationMin} min` : ''}
          </span>
          <span>{m.transcriptFormat === 'granola_api' ? 'Granola' : FORMAT_LABEL[m.transcriptFormat]}</span>
          {m.extractedAt && <span>leída {relative(m.extractedAt)}{m.extractionModel ? ` · ${m.extractionModel}` : ''}</span>}
          {m.attendees.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              <Users className="size-3.5 text-faint" />
              {m.attendees.map((a, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 rounded-full bg-card py-0.5 pl-1 pr-2.5 text-xs font-medium text-foreground" title={a.email ?? undefined}>
                  <MiniAvatar name={a.name} email={a.email} />
                  {a.name}
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CapsLabel>Proyecto</CapsLabel>
          <Select value={m.projectId ?? NO_PROJECT} onValueChange={(v) => void setProject(v)} disabled={action.busy('project')}>
            <SelectTrigger className={cn('h-8 w-auto min-w-[12rem] bg-card text-xs', !m.projectId && 'border-red')}><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value={NO_PROJECT}>Sin proyecto</SelectItem>
              {projects.map((p) => <SelectItem key={p.id} value={p.id}><span className="flex items-center gap-2"><ProjectIcon id={p.id} size="xs" className="size-4" />{p.name}</span></SelectItem>)}
            </SelectContent>
          </Select>
          {m.projectSource === 'dominio' && <span className="text-[11.5px] text-faint">resuelto por el correo del cliente</span>}
          {!m.projectId && <span className="text-[11.5px] text-red">elige un proyecto para aceptar candidatas</span>}
          {m.status === 'error' && (
            <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void retry()} disabled={action.busy('retry')}><RotateCcw /> Reintentar</Button>
          )}
        </div>
      </div>

      {m.status === 'error' && m.error && (
        <div className="shrink-0 border-b p-3"><ErrorCard message={`roz no pudo leer la junta: ${m.error}`} /></div>
      )}

      {/* Transcript | candidatas. En pantallas anchas cada mitad desplaza por su cuenta: se puede
          leer la transcripción sin perder de vista la candidata que se está decidiendo. */}
      <div
        className={cn(
          'scroll-thin min-h-0 flex-1 overflow-y-auto transition-opacity duration-200 xl:grid xl:grid-cols-2 xl:divide-x xl:overflow-hidden',
          refetching && 'pointer-events-none opacity-55',
        )}
      >
        <div className="scroll-thin grid min-w-0 content-start gap-2.5 border-b p-4 xl:min-h-0 xl:overflow-y-auto xl:border-b-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold tracking-[-0.01em]">Transcript</span>
            <span className="text-[11.5px] text-faint">resaltado = evidencia verificada</span>
          </div>
          <TranscriptView bare transcript={m.transcript} candidates={data.candidates} activeId={activeCandidate} onPick={onPickCandidate} />
        </div>

        <div className="scroll-thin grid min-w-0 content-start gap-2.5 p-4 xl:min-h-0 xl:overflow-y-auto">
          <div className="flex min-h-8 items-center justify-between gap-2">
            <span className="text-sm font-semibold tracking-[-0.01em]">
              Candidatas{pending.length ? <span className="ml-1.5 text-[11px] font-normal text-faint tabular-nums">{pending.length} por decidir</span> : null}
            </span>
            {riskZero.length > 0 && (
              <Button size="sm" variant="secondary" onClick={() => onBulk(riskZero)}>Aceptar riesgo 0 · {riskZero.length}</Button>
            )}
          </div>

          {reading && (
            <div className="grid gap-2">
              <div className="flex items-center gap-2 rounded-md bg-lavender px-2.5 py-1.5 text-xs text-purple-deep">
                <span className="size-2 shrink-0 animate-pulse rounded-full bg-purple-deep" />
                roz está leyendo la junta y verificando cada cita contra el texto…
              </div>
              <Skeleton className="h-24 rounded-lg" />
              <Skeleton className="h-24 rounded-lg" />
            </div>
          )}
          {!reading && m.status === 'lista' && !pending.length && !decided.length && !decisions.length && (
            <EmptyState icon={<Inbox />}>roz no encontró tareas, compromisos ni decisiones en esta junta.</EmptyState>
          )}

          {pending.map(candidateCard)}

          {decided.length > 0 && (
            <>
              <CapsLabel className="mt-2 px-0.5">Decididas · {decided.length}</CapsLabel>
              {decided.map(candidateCard)}
            </>
          )}

          {decisions.length > 0 && <CapsLabel className="mt-2 px-0.5">Decisiones en el brain · {decisions.length}</CapsLabel>}
          {decisions.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => onPickCandidate(d.id)}
              className={cn(
                'grid gap-1 rounded-lg border border-l-4 border-l-ink bg-sidebar p-3.5 text-left transition-shadow duration-fast hover:border-toggle-off hover:border-l-ink',
                activeCandidate === d.id && 'ring-2 ring-ink',
              )}
            >
              <span className="text-[13px] font-medium">«{d.title}»</span>
              <span className="line-clamp-2 text-[11.5px] italic text-muted-foreground">{d.quote}</span>
            </button>
          ))}
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={(v) => !action.busy('delete') && setConfirmDelete(v)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar «{m.title}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Se borran la junta y sus candidatas pendientes. Lo que ya se creó en Linear y las decisiones del brain se quedan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={action.busy('delete')}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={action.busy('delete')}
              onClick={(e) => { e.preventDefault(); void remove(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {action.busy('delete') ? <><Loader2 className="animate-spin" /> Eliminando…</> : 'Eliminar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CardsSkeleton() {
  return (
    <div className="grid gap-2.5 xl:grid-cols-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="grid gap-2.5 rounded-lg border border-l-4 border-l-toggle-off bg-card p-3.5">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-8 w-full" />
          <div className="flex gap-1.5"><Skeleton className="h-5 w-14 rounded-full" /><Skeleton className="h-5 w-16 rounded-full" /></div>
          <div className="flex gap-1.5"><Skeleton className="h-8 w-24" /><Skeleton className="h-8 w-20" /></div>
        </div>
      ))}
    </div>
  );
}

/**
 * Cadencia del sondeo mientras roz lee una junta. Rápida al principio (las candidatas aparecen
 * solas) y lenta si la lectura se alarga: una junta atascada en `pendiente` sondeaba cada 4-5 s
 * para siempre. Pasados 3 minutos baja a 30 s; al terminar la lectura, se apaga.
 */
function useReadingCadence(reading: boolean, fast: number): number | null {
  const since = useRef<number | null>(null);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!reading) {
      since.current = null;
      setSlow(false);
      return;
    }
    since.current = Date.now();
    const t = setTimeout(() => setSlow(true), 180_000);
    return () => clearTimeout(t);
  }, [reading]);
  if (!reading) return null;
  return slow ? 30_000 : fast;
}
