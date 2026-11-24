// Bandeja · Historial: todo lo recibido o enviado, leído o no, con filtros. Aquí se vuelve a abrir un
// mensaje viejo (la bandeja muestra lo reciente y lo pendiente; esto, todo).
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { ErrorCard } from '@/components/bits';
import { PersonAvatar, RozBotAvatar } from '@/components/avatars';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Segmented } from '@/components/pulse/roz-v2';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { zeusApi, type ZeusMessage, type ZeusMessageKind, type ZeusOrgMember } from '@/lib/zeus';
import { useZeusOrg, useZeusProjects } from './hooks';
import { prettyEnvText } from './vault-groups';
import { MESSAGE_KIND_LABEL, MESSAGE_STATUS, dateTime } from './zeus-ui';

const ALL = '__todos__';
const KIND_FILTERS: Array<{ value: ZeusMessageKind | typeof ALL; label: string }> = [
  { value: ALL, label: 'Todo' },
  { value: 'message', label: 'Mensajes' },
  { value: 'task', label: 'Encargos' },
  { value: 'plan', label: 'Planes' },
  { value: 'env_change', label: 'Variables' },
];

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Día legible para agrupar: "Hoy", "Ayer" o la fecha. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Hoy';
  if (d.toDateString() === y.toDateString()) return 'Ayer';
  const s = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

export function HistoryView({ people, onOpen }: { people: Map<string, ZeusOrgMember>; onOpen: (m: ZeusMessage) => void }) {
  const org = useZeusOrg();
  const projects = useZeusProjects();
  const [box, setBox] = useState<'received' | 'sent'>('received');
  const [kind, setKind] = useState<string>(ALL);
  const [person, setPerson] = useState<string>(ALL);
  const [project, setProject] = useState<string>(ALL);
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  const [rows, setRows] = useState<ZeusMessage[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filters = useMemo(
    () => ({
      box,
      kind: kind === ALL ? undefined : (kind as ZeusMessageKind),
      with: person === ALL ? undefined : person,
      project: project === ALL ? undefined : project,
      q: q || undefined,
    }),
    [box, kind, person, project, q],
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    zeusApi
      .messageHistory({ ...filters, limit: 40 })
      .then((r) => {
        if (!live) return;
        setRows(r.messages);
        setNext(r.nextBefore);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'No se pudo cargar el historial'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [filters]);

  const loadMore = () => {
    if (!next) return;
    setMore(true);
    zeusApi
      .messageHistory({ ...filters, before: next, limit: 40 })
      .then((r) => {
        setRows((prev) => [...prev, ...r.messages]);
        setNext(r.nextBefore);
      })
      .catch(() => toast.error('No se pudo cargar más'))
      .finally(() => setMore(false));
  };

  const personOptions = useMemo<ComboboxOption[]>(
    () => [{ value: ALL, label: 'Todas las personas' }, ...(org.data?.members ?? []).map((m) => ({ value: m.devId, label: m.name }))],
    [org.data],
  );
  const projectOptions = useMemo<ComboboxOption[]>(
    () => [{ value: ALL, label: 'Todos los proyectos' }, ...projects.map((p) => ({ value: p.key ?? p.id, label: p.name, hint: p.key ?? undefined }))],
    [projects],
  );
  const filtering = !!q || kind !== ALL || person !== ALL || project !== ALL;

  // Agrupado por día: un historial largo se lee por fechas, no como una lista sin fin.
  const days = useMemo(() => {
    const out: Array<{ label: string; items: ZeusMessage[] }> = [];
    for (const m of rows) {
      const label = dayLabel(m.createdAt);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(m);
      else out.push({ label, items: [m] });
    }
    return out;
  }, [rows]);

  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
        <Segmented
          value={box}
          onChange={setBox}
          options={[
            { value: 'received', label: 'Recibidos' },
            { value: 'sent', label: 'Enviados' },
          ]}
        />
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className={cn('h-8 w-[132px] text-xs', kind !== ALL && 'bg-orange-soft text-orange-ink')} aria-label="Tipo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_FILTERS.filter((k) => box === 'received' || k.value !== 'env_change').map((k) => (
              <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Combobox size="sm" value={person} onChange={setPerson} options={personOptions} className="w-[180px]" searchPlaceholder="Buscar persona…" />
        <Combobox size="sm" value={project} onChange={setProject} options={projectOptions} className="w-[190px]" searchPlaceholder="Buscar proyecto…" />
        <Input
          fieldSize="sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setText('')}
          placeholder="Buscar en asunto y texto…"
          aria-label="Buscar en el historial"
          leading={<Search />}
          wrapperClassName="min-w-[200px] flex-1"
        />
        {filtering && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-muted-foreground"
            onClick={() => {
              setKind(ALL);
              setPerson(ALL);
              setProject(ALL);
              setText('');
            }}
          >
            Limpiar
          </Button>
        )}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <ErrorCard className="m-3" message={error} />
        ) : loading ? (
          <div className="grid gap-2 p-3">{Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-md" />)}</div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">
            {filtering ? 'Nada coincide con esos filtros.' : box === 'sent' ? 'Todavía no has mandado nada.' : 'Todavía no te ha llegado nada.'}
          </p>
        ) : (
          days.map((d) => (
            <section key={d.label}>
              <h3 className="label-caps sticky top-0 z-10 border-b bg-card/95 px-4 py-1.5 text-muted-foreground backdrop-blur">{d.label}</h3>
              <ul className="divide-y">
                {d.items.map((m) => {
                  const other = box === 'sent' ? { id: m.toDevId, name: m.toName } : { id: m.fromDevId, name: m.fromName };
                  const member = other.id ? people.get(other.id) : undefined;
                  const st = m.status ? MESSAGE_STATUS[m.status] : null;
                  const unread = box === 'received' && !m.readAt;
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(m)}
                        className={cn(
                          'relative grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-panel/60 focus-visible:bg-panel focus-visible:outline-none',
                          unread && 'bg-orange-soft/30',
                        )}
                      >
                        {unread && <span aria-hidden className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-orange" />}
                        {m.via === 'system' && !m.fromDevId ? (
                          <RozBotAvatar className="mt-0.5 size-7" title="zeus" />
                        ) : (
                          <PersonAvatar name={other.name} login={member?.githubLogin} email={member?.email} id={other.id} className="mt-0.5 size-7" />
                        )}
                        <span className="grid min-w-0 gap-0.5">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className={cn('truncate text-[13px]', unread ? 'font-semibold' : 'font-medium')}>
                              {box === 'sent' ? `Para ${other.name}` : m.fromDevId ? other.name : 'zeus'}
                            </span>
                            {m.kind !== 'message' && <Badge variant={m.kind === 'plan' ? 'llm' : m.kind === 'task' ? 'human' : 'ok'}>{MESSAGE_KIND_LABEL[m.kind]}</Badge>}
                            {st && <Badge variant={st.variant}>{st.label}</Badge>}
                            {m.projectKey && <span className="truncate text-[11px] text-faint">{m.projectKey}</span>}
                          </span>
                          {m.subject && <span className={cn('truncate text-[13px]', unread ? 'font-semibold' : 'text-foreground')}>{prettyEnvText(m.subject)}</span>}
                          <span className="truncate text-[12px] text-muted-foreground">{prettyEnvText(m.body.replace(/\s+/g, ' '))}</span>
                        </span>
                        <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-faint" data-tip={dateTime(m.createdAt)}>{timeOf(m.createdAt)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
        {next && !loading && (
          <div className="flex justify-center p-3">
            <Button variant="secondary" size="sm" disabled={more} onClick={loadMore}>{more && <Loader2 className="animate-spin" />} Cargar más</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
