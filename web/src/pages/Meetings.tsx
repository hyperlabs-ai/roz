// Juntas: el REGISTRO de las juntas del equipo. Subir una es lo único manual (pegar lo que copia
// Granola, notas o un transcript: título, fecha y asistentes se autollenan); después se buscan aquí
// o Claude las trae por el MCP de zeus (zeus_meetings / zeus_meeting).
//
// Composición: la lista con buscador y filtros a la izquierda y, a la derecha, la junta abierta en
// `?m=<id>` con su transcript completo (las palabras buscadas, resaltadas).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, Loader2, Pencil, Plus, Search, Trash2, Users, X } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { EmptyState, ErrorCard, RefreshButton } from '@/components/bits';
import { CapsLabel, Eyebrow, IntegrationIcon } from '@/components/brand';
import { MeetingDialog } from '@/components/meetings/MeetingDialog';
import { AttendeeChip, HighlightedText, SourceBadge, searchTerms } from '@/components/meetings/meeting-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useApi } from '@/lib/useApi';
import { useAction } from '@/lib/useAction';
import { invalidate } from '@/lib/store';
import {
  apiGet, rozV2Api,
  type MeetingDetailResponse, type MeetingSummary, type MeetingsResponse, type TicketFilterOptions,
} from '@/lib/api';
import { compact, shortDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ProjectIcon } from '@/components/avatars';

const ALL = '__all__';

/** Alto común de la cabecera de los dos paneles: sus líneas inferiores quedan a la misma altura. */
const PANE_HEAD = 'flex min-h-[4.5rem] shrink-0 items-center gap-3 border-b px-4 py-3';

/** Valor que se asienta tras `ms` sin cambios (la búsqueda no pega a la API por tecla). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function Meetings() {
  const [params, setParams] = useSearchParams();
  // `?m=` es el de la página; `?meeting=` lo mandan los avisos viejos.
  const meetingId = params.get('m') ?? params.get('meeting');
  const setParam = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    p.delete('meeting');
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  };

  const [q, setQ] = useState(params.get('q') ?? '');
  const [person, setPerson] = useState(params.get('persona') ?? '');
  const project = params.get('proyecto') ?? ALL;
  const dq = useDebounced(q.trim(), 300);
  const dPerson = useDebounced(person.trim(), 300);
  useEffect(() => {
    setParam({ q: dq || null, persona: dPerson || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq, dPerson]);

  const filters = useApi<TicketFilterOptions>(() => apiGet('/tickets/filters'), [], { key: '/tickets/filters', ttl: 600_000 });
  const query = { q: dq || undefined, attendee: dPerson || undefined, projectId: project === ALL ? undefined : project, limit: 100 };
  const meetings = useApi<MeetingsResponse>(() => rozV2Api.meetings(query), [dq, dPerson, project], {
    key: `/meetings?${dq}|${dPerson}|${project}`,
    ttl: 30_000,
  });
  const projects = filters.data?.allProjects ?? [];
  const terms = useMemo(() => searchTerms(dq), [dq]);
  const [creating, setCreating] = useState(false);
  const granola = meetings.data?.granolaEnabled;

  return (
    <Layout
      title="Juntas"
      eyebrow="Entrada · registro"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {granola && (
            <Badge variant="ok" dot title="Granola por API: las juntas llegan solas">
              <IntegrationIcon name="granola" size="xs" title="" />Granola conectado
            </Badge>
          )}
          <RefreshButton busy={meetings.refetching} onClick={() => meetings.reload()} />
          <Button variant="dark" onClick={() => setCreating(true)}><Plus /> Nueva junta</Button>
        </div>
      }
    >
      {/* Dos paneles del MISMO alto en escritorio; cada uno desplaza por dentro. En móvil se apilan. */}
      <div className="grid gap-3.5 lg:h-[calc(100dvh-8rem)] lg:min-h-[32rem] lg:grid-cols-[340px_minmax(0,1fr)]">
        <Card className="flex min-h-0 flex-col overflow-hidden">
          <div className="grid shrink-0 gap-2 border-b p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar en lo que se habló…"
                className="h-9 pl-8 pr-7 text-[13px]"
                aria-label="Buscar en las juntas"
              />
              {q && (
                <button
                  type="button"
                  onClick={() => setQ('')}
                  aria-label="Limpiar búsqueda"
                  className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-faint hover:bg-panel hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Select value={project} onValueChange={(v) => setParam({ proyecto: v === ALL ? null : v })}>
                <SelectTrigger className="h-8 text-xs" aria-label="Proyecto"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={ALL}>Todos los proyectos</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="flex items-center gap-2"><ProjectIcon id={p.id} size="xs" className="size-4" />{p.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={person}
                onChange={(e) => setPerson(e.target.value)}
                placeholder="Persona…"
                className="h-8 text-xs"
                aria-label="Filtrar por persona"
              />
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-between border-b bg-sidebar px-4 py-2">
            <CapsLabel>
              {dq || dPerson || project !== ALL ? 'Resultados' : 'Juntas'}
              {meetings.data ? ` · ${meetings.data.meetings.length}` : ''}
            </CapsLabel>
            {meetings.refetching && <Loader2 className="size-3 animate-spin text-faint" />}
          </div>

          <MeetingList
            data={meetings}
            filtered={!!(dq || dPerson || project !== ALL)}
            selected={meetingId}
            onOpen={(id) => setParam({ m: id })}
          />
        </Card>

        <Card className="flex min-h-[22rem] min-w-0 flex-col overflow-hidden lg:min-h-0">
          {meetingId ? (
            <MeetingDetailView key={meetingId} id={meetingId} projects={projects} terms={terms} onClosed={() => setParam({ m: null })} />
          ) : (
            <div className="grid flex-1 place-items-center p-6">
              <EmptyState icon={<CalendarDays />} action={<Button size="sm" variant="secondary" onClick={() => setCreating(true)}><Plus /> Nueva junta</Button>}>
                Elige una junta para leerla completa. Para recuperar un detalle desde Claude, pídeselo a zeus: busca en estas mismas juntas.
              </EmptyState>
            </div>
          )}
        </Card>
      </div>

      <MeetingDialog
        open={creating}
        onOpenChange={setCreating}
        projects={projects}
        onSaved={(m) => {
          invalidate('/meetings');
          setParam({ m: m.id });
        }}
      />
    </Layout>
  );
}

// ---- Lista

function MeetingList({
  data,
  filtered,
  selected,
  onOpen,
}: {
  data: { data: MeetingsResponse | null; loading: boolean; refetching: boolean; error: string | null };
  filtered: boolean;
  selected: string | null;
  onOpen: (id: string) => void;
}) {
  if (data.error) return <div className="p-3"><ErrorCard message={data.error} /></div>;
  if (data.loading || !data.data) {
    return (
      <div className="divide-y">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="grid gap-1.5 px-4 py-3">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  }
  const list = data.data.meetings;
  if (!list.length) {
    return (
      <div className="grid flex-1 place-items-center px-5 py-8">
        <p className="max-w-[16rem] text-center text-[12.5px] leading-relaxed text-muted-foreground">
          {filtered
            ? 'Nada coincide. Prueba con menos palabras o quita un filtro.'
            : `Aún no hay juntas. Las que subas${data.data.granolaEnabled ? ' o lleguen de Granola' : ''} aparecerán aquí, la más reciente arriba.`}
        </p>
      </div>
    );
  }
  return (
    <div className={cn('scroll-thin max-h-[44dvh] min-h-0 divide-y overflow-y-auto transition-opacity lg:max-h-none lg:flex-1', data.refetching && 'opacity-60')}>
      {list.map((m) => <MeetingRow key={m.id} m={m} active={selected === m.id} onOpen={() => onOpen(m.id)} />)}
    </div>
  );
}

function MeetingRow({ m, active, onOpen }: { m: MeetingSummary; active: boolean; onOpen: () => void }) {
  const people = m.attendees.slice(0, 3).map((a) => a.name.split(' ')[0]).join(', ');
  const more = m.attendees.length > 3 ? ` +${m.attendees.length - 3}` : '';
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
        <span className="shrink-0 text-[11px] tabular-nums text-faint">{shortDate(m.heldAt)}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1 text-[11.5px] text-muted-foreground">
        {m.projectName && <><ProjectIcon id={m.projectId} size="xs" /><span className="max-w-[45%] shrink-0 truncate">{m.projectName}</span>{people && '·'}</>}
        {people && <span className="truncate">{people}{more}</span>}
      </span>
      {m.snippet && <span className="line-clamp-2 text-[11.5px] leading-snug text-faint">{m.snippet}</span>}
    </button>
  );
}

// ---- Una junta

function MeetingDetailView({
  id,
  projects,
  terms,
  onClosed,
}: {
  id: string;
  projects: { id: string; name: string }[];
  terms: string[];
  onClosed: () => void;
}) {
  const { data, loading, refetching, error } = useApi<MeetingDetailResponse>(() => rozV2Api.meeting(id), [id], {
    key: `/meetings/detail/${id}`,
    ttl: 60_000,
  });
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (error) return <div className="p-4"><ErrorCard message={error} /></div>;
  if (loading || !data) {
    return (
      <>
        <div className={PANE_HEAD}>
          <div className="grid gap-2"><Skeleton className="h-3 w-24" /><Skeleton className="h-5 w-64" /></div>
        </div>
        <div className="grid gap-2 p-4">
          {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className={cn('h-3.5', i % 3 === 2 ? 'w-2/3' : 'w-full')} />)}
        </div>
      </>
    );
  }

  const m = data.meeting;
  const remove = () =>
    action.run('delete', () => rozV2Api.deleteMeeting(m.id), {
      success: 'Junta eliminada',
      error: 'No se pudo eliminar',
      onDone: () => {
        invalidate('/meetings');
        onClosed();
      },
      onSettled: () => setConfirmDelete(false),
    });

  const meta: ReactNode[] = [
    <span key="d" className="inline-flex items-center gap-1.5">
      <CalendarDays className="size-3.5 text-faint" />
      {new Date(m.heldAt).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })}
      {m.durationMin ? ` · ${m.durationMin} min` : ''}
    </span>,
    m.projectName ? (
      <span key="p" className="inline-flex items-center gap-1.5"><ProjectIcon id={m.projectId} size="xs" />{m.projectName}</span>
    ) : (
      <span key="p" className="text-faint">Sin proyecto</span>
    ),
    <span key="c" className="tabular-nums text-faint">{compact(m.transcript.length)} caracteres</span>,
    m.createdBy ? <span key="u" className="text-faint">subida por {m.createdBy.name}</span> : null,
  ];

  return (
    <>
      <div className={cn(PANE_HEAD, 'flex-wrap justify-between')}>
        <div className="grid min-w-0 gap-1">
          <Eyebrow color="yellow">Junta {m.source === 'granola' ? 'de Granola' : 'manual'}</Eyebrow>
          <h2 className="truncate text-lg font-semibold leading-tight tracking-[-0.03em]">{m.title}</h2>
        </div>
        <div className="flex items-center gap-1.5">
          <SourceBadge source={m.source} />
          <Button size="icon-sm" variant="ghost" className="text-muted-foreground" onClick={() => setEditing(true)} aria-label="Editar datos de la junta" title="Editar datos">
            <Pencil />
          </Button>
          <Button size="icon-sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirmDelete(true)} aria-label="Eliminar junta" title="Eliminar junta">
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="grid shrink-0 gap-2 border-b bg-sidebar px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">{meta}</div>
        {m.attendees.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Users className="size-3.5 text-faint" />
            {m.attendees.map((a, i) => <AttendeeChip key={i} a={a} className="bg-card" />)}
          </div>
        )}
      </div>

      <div className={cn('scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4 transition-opacity', refetching && 'opacity-60')}>
        <HighlightedText
          text={m.transcript}
          terms={terms}
          className="mx-auto max-w-[78ch] whitespace-pre-wrap break-words text-[13.5px] leading-[1.75] text-foreground"
        />
      </div>

      <MeetingDialog
        open={editing}
        onOpenChange={setEditing}
        projects={projects}
        meeting={m}
        onSaved={() => invalidate('/meetings')}
      />

      <AlertDialog open={confirmDelete} onOpenChange={(v) => !action.busy('delete') && setConfirmDelete(v)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar «{m.title}»?</AlertDialogTitle>
            <AlertDialogDescription>Se borra la junta con su texto. No se puede deshacer.</AlertDialogDescription>
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
