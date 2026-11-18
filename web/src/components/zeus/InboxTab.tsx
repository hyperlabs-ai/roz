// Pestaña "Bandeja": un tablero de triage. Arriba, el recorrido de una solicitud dibujado (zeus la
// enruta sola: dueño del recurso → líder del proyecto → jefe directo → admin de zeus) con los
// contadores vivos; abajo, tres carriles a la vez: lo que espera tu decisión, lo que te escribieron y
// lo que tú pediste o enviaste. `routedBecause` dice por qué cayó con quien cayó: se muestra siempre.
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, CheckCheck, CornerDownRight, FileText, KeySquare, Loader2, Mail, PencilLine, Plus, Reply, Search, X } from 'lucide-react';
import { ErrorCard, RefreshButton } from '@/components/bits';
import { PersonAvatar, RozBotAvatar } from '@/components/avatars';
import { fold } from '@/components/projects/project-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { to } from '@/lib/routes';
import { toast } from '@/lib/toast';
import { useAction } from '@/lib/useAction';
import { useApi } from '@/lib/useApi';
import { usePoll } from '@/lib/usePoll';
import { cn } from '@/lib/utils';
import { zeusApi, type ZeusInbox, type ZeusMe, type ZeusMessage, type ZeusOrgMember, type ZeusRequest } from '@/lib/zeus';
import { INBOX_KEY, useZeusOrg } from './hooks';
import { CmdLine } from './zeus-steps';
import { ComposeDialog, NewRequestDialog, PlanDialog, ResolveDialog, StatusDialog, refreshInbox, type StatusAction } from './InboxDialogs';
import { RouteDiagram, routeStep, type RouteStep } from './RouteDiagram';
import { Figure, MESSAGE_KIND_LABEL, MESSAGE_STATUS, REQUEST_KIND_LABEL, REQUEST_STATUS, RailTitle, TONES, ago, dateTime, viaLabel, type Tone } from './zeus-ui';
import './inbox.css';

type People = Map<string, ZeusOrgMember>;

/** Enlace al nodo en el mapa. */
function RefLink({ nodeRef, title }: { nodeRef: string; title?: string | null }) {
  return (
    <Link
      to={to.nodo(nodeRef)}
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-panel px-2 py-0.5 text-[11.5px] font-medium text-foreground hover:bg-toggle-off/60"
    >
      <CornerDownRight className="size-3 shrink-0 text-faint" />
      <span className="truncate">{title ?? 'Ver en el mapa'}</span>
    </Link>
  );
}

function Face({ devId, name, people, className = 'size-5' }: { devId: string | null; name: string; people: People; className?: string }) {
  const m = devId ? people.get(devId) : undefined;
  return <PersonAvatar name={name} login={m?.githubLogin} email={m?.email} id={devId} className={className} />;
}

// ---------------------------------------------------------------- carril

function Lane({
  tone,
  title,
  hint,
  count,
  unit,
  action,
  children,
}: {
  tone: Tone;
  title: string;
  hint: string;
  count: number | null;
  unit: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden max-lg:max-h-[72dvh]">
      <header className="flex shrink-0 items-center gap-3 border-b px-3.5 py-3">
        <span className={cn('size-2 shrink-0 rounded-[2px]', tone.dot)} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h2 className="truncate text-sm font-semibold tracking-[-0.01em]">{title}</h2>
          <span className="truncate text-[11.5px] text-muted-foreground">{hint}</span>
        </div>
        {action}
        <div className="grid shrink-0 justify-items-end gap-0.5">
          <span className={cn('text-[22px] font-semibold leading-none tracking-[-0.03em] tabular-nums', !count && 'text-faint')}>{count ?? '—'}</span>
          <span className="label-caps text-[9.5px]">{unit}</span>
        </div>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
    </Card>
  );
}

const Bar = ({ className }: { className: string }) => <span className={cn('block h-2 rounded-full bg-panel', className)} />;

/** Carril vacío: una línea que dice qué llega ahí y la silueta punteada de las tarjetas que vendrán. */
function Ghosts({ shape, children }: { shape: 'request' | 'message'; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <p className="px-1.5 pb-1 pt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{children}</p>
      {[1, 0.7, 0.45, 0.25].map((opacity, i) => (
        <div key={i} aria-hidden className="zeus-ghost grid gap-2.5 p-3" style={{ opacity }}>
          <div className="flex items-center gap-2">
            {shape === 'message' && <span className="size-5 shrink-0 rounded-full bg-panel" />}
            <Bar className={shape === 'message' ? 'w-20' : 'h-[18px] w-16'} />
            <Bar className="ml-auto w-9" />
          </div>
          <Bar className="h-2.5 w-3/5" />
          <Bar className="w-11/12" />
          {shape === 'request' ? (
            <div className="flex gap-2 pt-0.5">
              <span className="block h-7 w-[86px] rounded-[4px] bg-panel" />
              <span className="block h-7 w-[86px] rounded-[4px] bg-panel" />
            </div>
          ) : (
            <Bar className="w-2/5" />
          )}
        </div>
      ))}
    </div>
  );
}

function LaneSkeleton() {
  return (
    <div className="grid gap-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="grid gap-2.5 rounded-md border p-3">
          <div className="flex items-center gap-2"><Skeleton className="h-[18px] w-16 rounded-full" /><Skeleton className="ml-auto h-2.5 w-9" /></div>
          <Skeleton className="h-3 w-3/5" />
          <Skeleton className="h-2.5 w-11/12" />
          <Skeleton className="h-2.5 w-2/5" />
        </div>
      ))}
    </div>
  );
}

function GroupLabel({ children, count }: { children: ReactNode; count: number }) {
  return (
    <h3 className="label-caps sticky -top-2 z-10 flex items-center justify-between gap-2 bg-card px-1.5 pb-1.5 pt-2.5 text-muted-foreground">
      {children}
      <span className="tabular-nums text-faint">{count}</span>
    </h3>
  );
}

const NoMatch = () => <p className="px-1.5 py-6 text-center text-[12.5px] text-muted-foreground">Nada coincide con esa búsqueda.</p>;

// ---------------------------------------------------------------- tarjetas

function RequestCard({
  request,
  mine,
  people,
  busy,
  onFocus,
  onResolve,
  onCancel,
}: {
  request: ZeusRequest;
  mine?: boolean;
  people: People;
  busy: boolean;
  onFocus: (r: ZeusRequest | null) => void;
  onResolve?: (decision: 'approved' | 'denied') => void;
  onCancel?: () => void;
}) {
  const st = REQUEST_STATUS[request.status] ?? { label: request.status, variant: 'secondary' as const };
  const pending = request.status === 'pending';
  return (
    <li
      className={cn(
        'zeus-lane-card grid min-w-0 gap-2 rounded-md border p-3 transition-colors hover:border-foreground/25 focus-within:border-foreground/25',
        pending ? 'bg-card' : 'bg-sidebar',
      )}
      onPointerEnter={() => onFocus(request)}
      onPointerLeave={() => onFocus(null)}
      onFocus={() => onFocus(request)}
      onBlur={() => onFocus(null)}
    >
      <div className="flex items-center gap-1.5">
        <Badge variant="neutral">{REQUEST_KIND_LABEL[request.kind] ?? request.kind}</Badge>
        {(mine || !pending) && <Badge variant={st.variant} dot={pending}>{st.label}</Badge>}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-faint" title={dateTime(request.createdAt)}>{ago(request.createdAt)}</span>
      </div>
      <p className="break-words text-[13.5px] font-semibold leading-snug">{request.title}</p>
      {request.detail && <p className="line-clamp-3 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted-foreground">{request.detail}</p>}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          {mine ? (
            request.approverDevId ? <Face devId={request.approverDevId} name={request.approverName ?? ''} people={people} /> : null
          ) : (
            <Face devId={request.requesterDevId} name={request.requesterName} people={people} />
          )}
          <span className="truncate">
            {mine ? 'Le tocó a ' : 'La pide '}
            <span className="font-medium text-foreground">{mine ? request.approverName ?? 'quien administre zeus' : request.requesterName}</span>
            {request.via !== 'web' && <> · por {viaLabel(request.via)}</>}
          </span>
        </span>
        {request.resourceRef && <RefLink nodeRef={request.resourceRef} title={request.resourceTitle} />}
      </div>
      {request.routedBecause && (
        <p className="flex items-start gap-2 rounded-md bg-panel px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground">
          <CornerDownRight className="mt-0.5 size-3 shrink-0 text-faint" />
          <span className="min-w-0 break-words">
            <span className="font-medium text-foreground">{mine ? 'Se envió ahí porque' : 'Te llegó porque'}</span> {request.routedBecause}
          </span>
        </p>
      )}
      {!pending && (request.resolutionNote || request.resolvedByName) && (
        <p className="break-words text-xs leading-relaxed text-muted-foreground">
          {request.resolvedByName && <><span className="font-medium text-foreground">{request.resolvedByName}</span>{request.resolvedAt && <> · {ago(request.resolvedAt)}</>}</>}
          {request.resolutionNote && <>{request.resolvedByName && ': '}{request.resolutionNote}</>}
        </p>
      )}
      {pending && (onResolve || onCancel) && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {onResolve && request.canResolve && (
            <>
              <Button size="sm" disabled={busy} onClick={() => onResolve('approved')}><Check /> Aprobar</Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => onResolve('denied')}><X /> Denegar</Button>
            </>
          )}
          {onResolve && !request.canResolve && <span className="text-xs text-faint">Solo su aprobador o un admin de zeus puede resolverla.</span>}
          {onCancel && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
              {busy && <Loader2 className="animate-spin" />}
              Cancelar solicitud
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function MessageCard({
  message,
  sent,
  unread,
  people,
  onOpen,
  onRead,
  onReply,
}: {
  message: ZeusMessage;
  sent?: boolean;
  unread: boolean;
  people: People;
  onOpen: () => void;
  onRead?: () => void;
  onReply?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (message.kind === 'env_change') return <EnvChangeCard message={message} unread={unread} people={people} onOpen={onOpen} onRead={onRead} />;
  const system = message.via === 'system' || !message.fromDevId;
  const long = message.body.length > 150 || message.body.includes('\n');
  return (
    <li className={cn('zeus-lane-card grid min-w-0 gap-2 rounded-md border p-3 transition-colors hover:border-foreground/25', unread ? 'border-orange/40 bg-orange-soft/40' : 'bg-card')}>
      <button
        type="button"
        className="grid min-w-0 gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={long ? open : undefined}
        onClick={() => {
          setOpen((v) => !v);
          onOpen();
        }}
      >
        <span className="flex min-w-0 items-center gap-2">
          {sent ? (
            <Face devId={message.toDevId} name={message.toName} people={people} />
          ) : system ? (
            <RozBotAvatar className="size-5 shrink-0" title="zeus" />
          ) : (
            <Face devId={message.fromDevId} name={message.fromName} people={people} />
          )}
          <span className={cn('min-w-0 truncate text-[13px]', unread ? 'font-semibold' : 'font-medium')}>{sent ? `Para ${message.toName}` : message.fromName}</span>
          {unread && <span className="size-2 shrink-0 rounded-full bg-orange" aria-label="Sin leer" />}
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-faint" title={dateTime(message.createdAt)}>
            {message.via !== 'web' && message.via !== 'system' && <>por {viaLabel(message.via)} · </>}
            {ago(message.createdAt)}
          </span>
        </span>
        {message.subject && <span className={cn('break-words text-[13.5px] leading-snug', unread ? 'font-semibold' : 'font-medium')}>{message.subject}</span>}
        <span className={cn('whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted-foreground', !open && 'line-clamp-2')}>{message.body}</span>
      </button>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        {message.ref && <RefLink nodeRef={message.ref} />}
        {sent && <span className="text-[11.5px] text-faint">{message.readAt ? `Leído ${ago(message.readAt)}` : 'Sin leer todavía'}</span>}
        <span className="ml-auto flex items-center gap-0.5">
          {unread && onRead && (
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs text-muted-foreground" onClick={onRead}><Check /> Leído</Button>
          )}
          {onReply && !system && (
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs text-muted-foreground" onClick={onReply}><Reply /> Responder</Button>
          )}
        </span>
      </div>
    </li>
  );
}

/**
 * Aviso de la bóveda: alguien cambió variables de un entorno al que tienes acceso. El cuerpo trae
 * solo NOMBRES por grupo ("Nuevas: …", "Cambiaron: …", "Se quitaron: …") y el comando para ponerse al día.
 */
export function parseEnvChange(body: string): { groups: Array<{ label: string; names: string[] }>; rotated: boolean; pull: string | null } {
  const groups: Array<{ label: string; names: string[] }> = [];
  for (const [label, prefix] of [['Nuevas', 'Nuevas:'], ['Cambiaron', 'Cambiaron:'], ['Se quitaron', 'Se quitaron:']] as const) {
    const line = body.split('\n').find((l) => l.startsWith(prefix));
    if (line) groups.push({ label, names: line.slice(prefix.length).split(',').map((n) => n.trim()).filter(Boolean) });
  }
  const pull = /zeus env pull \S+ \S+/.exec(body)?.[0] ?? null;
  return { groups, rotated: /rotó la llave/i.test(body), pull };
}

function EnvChangeCard({
  message,
  unread,
  people,
  onOpen,
  onRead,
}: {
  message: ZeusMessage;
  unread: boolean;
  people: People;
  onOpen: () => void;
  onRead?: () => void;
}) {
  const { groups, rotated, pull } = parseEnvChange(message.body);
  return (
    <li
      className={cn('zeus-lane-card grid min-w-0 gap-2 rounded-md border p-3 transition-colors hover:border-foreground/25', unread ? 'border-orange/40 bg-orange-soft/40' : 'bg-card')}
      onPointerEnter={() => unread && onOpen()}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Face devId={message.fromDevId} name={message.fromName} people={people} />
        <Badge variant="info"><KeySquare className="size-3" /> {MESSAGE_KIND_LABEL.env_change}</Badge>
        {message.projectKey && <span className="truncate text-[11px] text-faint">{message.projectKey}</span>}
        {unread && <span className="size-2 shrink-0 rounded-full bg-orange" aria-label="Sin leer" />}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-faint" title={dateTime(message.createdAt)}>{ago(message.createdAt)}</span>
      </div>
      <p className={cn('break-words text-[13.5px] leading-snug', unread ? 'font-semibold' : 'font-medium')}>{message.subject}</p>
      {rotated && <p className="text-[12px] leading-relaxed text-muted-foreground">Los valores no cambiaron. Vuelve a bajar para poder seguir subiendo cambios.</p>}
      {groups.length > 0 && (
        <dl className="grid gap-1 text-[12px]">
          {groups.map((g) => (
            <div key={g.label} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1">
              <dt className="shrink-0 text-muted-foreground">{g.label}</dt>
              {g.names.map((n) => (
                <dd key={n} className="rounded bg-panel px-1.5 py-0.5 font-mono text-[11px] text-foreground">{n}</dd>
              ))}
            </div>
          ))}
        </dl>
      )}
      {pull && <CmdLine command={pull} />}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-faint">Solo nombres: los valores nunca pasan por la bandeja.</span>
        {unread && onRead && (
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs text-muted-foreground" onClick={onRead}><Check /> Leído</Button>
        )}
      </div>
    </li>
  );
}

/** Un encargo o plan: lo que te mandaron (con qué hacer) o lo que mandaste (en qué va). */
function WorkCard({
  message,
  sent,
  people,
  busy,
  onAct,
  onOpenPlan,
}: {
  message: ZeusMessage;
  sent?: boolean;
  people: People;
  busy: boolean;
  onAct: (status: StatusAction) => void;
  onOpenPlan: () => void;
}) {
  const [open, setOpen] = useState(false);
  const st = message.status ? MESSAGE_STATUS[message.status] : null;
  const plan = message.kind === 'plan';
  return (
    <li className={cn('zeus-lane-card grid min-w-0 gap-2 rounded-md border p-3 transition-colors hover:border-foreground/25', message.status === 'pending' && !sent ? 'bg-card' : 'bg-sidebar')}>
      <div className="flex items-center gap-1.5">
        <Badge variant="neutral">{MESSAGE_KIND_LABEL[message.kind]}</Badge>
        {st && <Badge variant={st.variant} dot={message.status === 'pending'}>{st.label}</Badge>}
        {message.projectKey && <span className="truncate text-[11px] text-faint">{message.projectKey}</span>}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-faint" title={dateTime(message.createdAt)}>{ago(message.createdAt)}</span>
      </div>
      <p className="break-words text-[13.5px] font-semibold leading-snug">{message.subject ?? '(sin título)'}</p>
      <button
        type="button"
        className={cn('whitespace-pre-wrap break-words rounded-sm text-left text-[12.5px] leading-relaxed text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', !open && 'line-clamp-3')}
        onClick={() => (plan ? onOpenPlan() : setOpen((v) => !v))}
      >
        {message.body}
      </button>
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {sent ? <Face devId={message.toDevId} name={message.toName} people={people} /> : <Face devId={message.fromDevId} name={message.fromName} people={people} />}
        <span className="truncate">
          {sent ? 'Para ' : 'De '}
          <span className="font-medium text-foreground">{sent ? message.toName : message.fromName}</span>
          {message.via !== 'web' && message.via !== 'system' && <> · por {viaLabel(message.via)}</>}
        </span>
      </div>
      {message.statusNote && (
        <p className="flex items-start gap-2 rounded-md bg-panel px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground">
          <CornerDownRight className="mt-0.5 size-3 shrink-0 text-faint" />
          <span className="min-w-0 whitespace-pre-wrap break-words">{message.statusNote}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {plan && <Button size="sm" variant="secondary" onClick={onOpenPlan}><FileText /> Ver plan</Button>}
        {!sent && message.status === 'pending' && (
          <>
            <Button size="sm" disabled={busy} onClick={() => onAct('accepted')}><Check /> Aceptar</Button>
            {plan && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAct('changes_requested')}><PencilLine /> Ajustes</Button>}
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAct('declined')}><X /> Rechazar</Button>
          </>
        )}
        {!sent && message.status === 'accepted' && <Button size="sm" disabled={busy} onClick={() => onAct('done')}><CheckCheck /> Hecho</Button>}
        {sent && message.status && ['pending', 'accepted', 'changes_requested'].includes(message.status) && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAct('cancelled')}>Retirar</Button>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- pestaña

const requestText = (r: ZeusRequest) => fold(`${r.title} ${r.detail} ${r.requesterName} ${r.approverName ?? ''} ${r.resourceTitle ?? ''} ${REQUEST_KIND_LABEL[r.kind] ?? ''}`);
const messageText = (m: ZeusMessage) => fold(`${m.subject ?? ''} ${m.body} ${m.fromName} ${m.toName}`);
const newest = (a: { createdAt: string }, b: { createdAt: string }) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
const pendingFirst = (a: ZeusRequest, b: ZeusRequest) => Number(b.status === 'pending') - Number(a.status === 'pending') || newest(a, b);

export function InboxTab({ me }: { me: ZeusMe | null }) {
  const inbox = useApi<ZeusInbox>(() => zeusApi.inbox(), [], { key: INBOX_KEY, ttl: 15_000 });
  usePoll(inbox.reload, inbox.data ? 30_000 : null);
  const org = useZeusOrg();
  const act = useAction();
  const [q, setQ] = useState('');
  const [focus, setFocus] = useState<ZeusRequest | null>(null);
  const [compose, setCompose] = useState<{ replyTo: ZeusMessage | null } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [resolving, setResolving] = useState<{ request: ZeusRequest; decision: 'approved' | 'denied' } | null>(null);
  const [statusTarget, setStatusTarget] = useState<{ message: ZeusMessage; status: StatusAction } | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  // Leídos en esta sesión: el punto se apaga al instante, sin esperar a que la bandeja revalide.
  const [readLocal, setReadLocal] = useState<Set<string>>(() => new Set());

  const data = inbox.data;
  const people = useMemo<People>(() => new Map((org.data?.members ?? []).map((m) => [m.devId, m])), [org.data]);
  const isUnread = (m: ZeusMessage) => !m.readAt && !readLocal.has(m.id);

  // Los encargos y planes abiertos viven en su carril; no se repiten como mensajes.
  const openWork = data?.open ?? [];
  const waitingWork = data?.waiting ?? [];
  const workIds = useMemo(() => new Set([...openWork, ...waitingWork].map((m) => m.id)), [openWork, waitingWork]);
  const messages = (data?.messages ?? []).filter((m) => !workIds.has(m.id));
  const sent = (data?.sent ?? []).filter((m) => !workIds.has(m.id));
  const toResolve = data?.toResolve ?? [];
  const mine = data?.mine ?? [];
  const unread = messages.filter(isUnread).length;
  const pendingToResolve = toResolve.filter((r) => r.status === 'pending').length + openWork.length;
  // Lo que espero de otros: mis solicitudes abiertas y los encargos/planes que mandé y nadie ha cerrado.
  const pendingMine = mine.filter((r) => r.status === 'pending').length + waitingWork.length;

  const markRead = (ids: string[] | 'all') => {
    const targets = ids === 'all' ? messages.filter(isUnread).map((m) => m.id) : ids;
    if (!targets.length) return;
    setReadLocal((prev) => new Set([...prev, ...targets]));
    void zeusApi
      .markRead(ids)
      .then(refreshInbox)
      .catch(() => {
        // Si no se pudo, el punto vuelve: mejor un "sin leer" de más que perder un mensaje.
        setReadLocal((prev) => {
          const next = new Set(prev);
          targets.forEach((t) => next.delete(t));
          return next;
        });
      });
  };

  // Abiertas por escalón, para los contadores del diagrama. Una misma solicitud puede venir en las
  // dos listas (un admin que pide algo): se cuenta una vez.
  const counts = useMemo(() => {
    const out: Record<RouteStep, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    const seen = new Set<string>();
    for (const r of [...(data?.toResolve ?? []), ...(data?.mine ?? [])]) {
      if (r.status !== 'pending' || seen.has(r.id)) continue;
      seen.add(r.id);
      const step = routeStep(r.routedBecause);
      if (step) out[step]++;
    }
    return out;
  }, [data]);

  const needle = fold(q.trim());
  const lanes = useMemo(() => {
    const d = data ?? { messages: [], sent: [], toResolve: [], mine: [], open: [], waiting: [] };
    const req = (r: ZeusRequest) => !needle || requestText(r).includes(needle);
    const msg = (m: ZeusMessage) => !needle || messageText(m).includes(needle);
    const notWork = (m: ZeusMessage) => !workIds.has(m.id);
    return {
      toResolve: d.toResolve.filter(req).sort(pendingFirst),
      messages: d.messages.filter(notWork).filter(msg).sort(newest),
      mine: d.mine.filter(req).sort(pendingFirst),
      sent: d.sent.filter(notWork).filter(msg).sort(newest),
      open: (d.open ?? []).filter(msg).sort(newest),
      waiting: (d.waiting ?? []).filter(msg).sort(newest),
    };
  }, [data, needle, workIds]);
  // Sin leer primero. Va fuera del memo: "leído" cambia al instante con `readLocal`.
  const inboxList = [...lanes.messages].sort((a, b) => Number(isUnread(b)) - Number(isUnread(a)));
  const decide = lanes.toResolve.filter((r) => r.status === 'pending');
  const decided = lanes.toResolve.filter((r) => r.status !== 'pending');

  const loading = inbox.loading;
  const failed = !!inbox.error && !data;
  const focusMine = !!focus && focus.requesterDevId === me?.devId;

  return (
    <div className="flex flex-col gap-3 lg:h-[calc(100dvh-var(--shell-top,196px)-var(--shell-pad-b,0px))] lg:min-h-[660px]">
      <section className="zeus-stage grid shrink-0 gap-x-6 gap-y-4 rounded-lg border bg-background p-4 text-foreground lg:grid-cols-[minmax(0,1fr)_316px] xl:gap-x-8 2xl:grid-cols-[minmax(0,1fr)_376px]">
        <div className="grid min-w-0 content-start gap-3">
          <RailTitle meta={<span className="truncate text-[11.5px] text-faint">{focus ? focus.title : 'Pasa por una solicitud para ver hasta dónde llegó'}</span>}>
            Recorrido de una solicitud
          </RailTitle>
          <div className="scroll-none -mx-1 overflow-x-auto px-1 pt-2">
            <RouteDiagram focus={focus} mine={focusMine} counts={counts} />
          </div>
        </div>
        <div className="grid min-w-0 content-start gap-2.5">
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border">
            <Figure value={loading ? '—' : pendingToResolve} label="Por decidir" accent={pendingToResolve > 0} />
            <Figure value={loading ? '—' : unread} label="Sin leer" />
            <Figure value={loading ? '—' : pendingMine} label="En espera" />
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              fieldSize="sm"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQ('')}
              placeholder="Buscar en la bandeja…"
              aria-label="Buscar en la bandeja"
              leading={<Search />}
              trailing={
                q ? (
                  <button type="button" onClick={() => setQ('')} aria-label="Limpiar búsqueda" className="grid size-6 place-items-center rounded-sm text-faint hover:text-foreground"><X className="size-3.5" /></button>
                ) : undefined
              }
              wrapperClassName="min-w-0 flex-1"
            />
            <RefreshButton busy={inbox.refetching} onClick={inbox.reload} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" size="sm" onClick={() => setCompose({ replyTo: null })}><Mail /> Nuevo mensaje</Button>
            <Button variant="brand" size="sm" onClick={() => setRequesting(true)}><Plus /> Nueva solicitud</Button>
          </div>
        </div>
      </section>

      {inbox.error && <ErrorCard className="shrink-0" message={failed ? 'No se pudo cargar la bandeja.' : inbox.error} />}

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-3 lg:grid-rows-[minmax(0,1fr)]">
        <Lane tone={TONES.orange} title="Esperan tu decisión" hint="Encargos, planes y solicitudes que te tocan" count={loading ? null : pendingToResolve} unit="pendientes">
          {loading ? (
            <LaneSkeleton />
          ) : toResolve.length === 0 && openWork.length === 0 ? (
            <Ghosts shape="request">
              Aquí caen los encargos y planes que te manda el equipo (o su Claude) y las solicitudes de acceso que te toca decidir, con el motivo por el que te llegaron.
            </Ghosts>
          ) : lanes.toResolve.length === 0 && lanes.open.length === 0 ? (
            <NoMatch />
          ) : (
            <>
              {lanes.open.length > 0 && (
                <>
                  <GroupLabel count={lanes.open.length}>Encargos y planes</GroupLabel>
                  <ul className="grid gap-2">
                    {lanes.open.map((m) => (
                      <WorkCard
                        key={m.id}
                        message={m}
                        people={people}
                        busy={act.busy(`status:${m.id}`)}
                        onAct={(status) => setStatusTarget({ message: m, status })}
                        onOpenPlan={() => setPlanId(m.id)}
                      />
                    ))}
                  </ul>
                  {lanes.toResolve.length > 0 && <GroupLabel count={decide.length}>Solicitudes</GroupLabel>}
                </>
              )}
              {decide.length === 0 && lanes.open.length === 0 && <p className="px-1.5 pb-1 pt-1.5 text-[12.5px] text-muted-foreground">Nada pendiente: ya resolviste todo lo que te tocaba.</p>}
              <ul className="grid gap-2">
                {decide.map((r) => (
                  <RequestCard key={r.id} request={r} people={people} busy={act.busy(`resolve:${r.id}`)} onFocus={setFocus} onResolve={(decision) => setResolving({ request: r, decision })} />
                ))}
              </ul>
              {decided.length > 0 && (
                <>
                  <GroupLabel count={decided.length}>Ya resueltas</GroupLabel>
                  <ul className="grid gap-2">
                    {decided.map((r) => <RequestCard key={r.id} request={r} people={people} busy={false} onFocus={setFocus} />)}
                  </ul>
                </>
              )}
            </>
          )}
        </Lane>

        <Lane
          tone={TONES.blue}
          title="Mensajes"
          hint="Lo que te escribe el equipo, sus agentes y los avisos de variables"
          count={loading ? null : unread}
          unit="sin leer"
          action={
            unread > 0 ? (
              <Button variant="ghost" size="icon-sm" className="size-8 shrink-0 text-muted-foreground" onClick={() => markRead('all')} title="Marcar todo como leído" aria-label="Marcar todo como leído"><CheckCheck /></Button>
            ) : undefined
          }
        >
          {loading ? (
            <LaneSkeleton />
          ) : messages.length === 0 ? (
            <Ghosts shape="message">Aquí llega lo que te escriba alguien del equipo o su agente, y los avisos de zeus. Lo no leído va primero.</Ghosts>
          ) : inboxList.length === 0 ? (
            <NoMatch />
          ) : (
            <ul className="grid gap-2">
              {inboxList.map((m) => (
                <MessageCard
                  key={m.id}
                  message={m}
                  unread={isUnread(m)}
                  people={people}
                  onOpen={() => isUnread(m) && markRead([m.id])}
                  onRead={() => markRead([m.id])}
                  onReply={() => setCompose({ replyTo: m })}
                />
              ))}
            </ul>
          )}
        </Lane>

        <Lane tone={TONES.purple} title="Lo que pediste y enviaste" hint="Tus encargos, planes, solicitudes y mensajes" count={loading ? null : pendingMine} unit="abiertas">
          {loading ? (
            <LaneSkeleton />
          ) : mine.length === 0 && sent.length === 0 && waitingWork.length === 0 ? (
            <Ghosts shape="request">Aquí sigues lo que pediste y encargaste: a quién le llegó, por qué y en qué quedó. También los mensajes que enviaste.</Ghosts>
          ) : lanes.mine.length === 0 && lanes.sent.length === 0 && lanes.waiting.length === 0 ? (
            <NoMatch />
          ) : (
            <>
              {lanes.waiting.length > 0 && (
                <>
                  <GroupLabel count={lanes.waiting.length}>Encargos y planes que mandaste</GroupLabel>
                  <ul className="grid gap-2">
                    {lanes.waiting.map((m) => (
                      <WorkCard
                        key={m.id}
                        message={m}
                        sent
                        people={people}
                        busy={act.busy(`status:${m.id}`)}
                        onAct={(status) => setStatusTarget({ message: m, status })}
                        onOpenPlan={() => setPlanId(m.id)}
                      />
                    ))}
                  </ul>
                </>
              )}
              {lanes.mine.length > 0 && (
                <>
                  <GroupLabel count={lanes.mine.length}>Tus solicitudes</GroupLabel>
                  <ul className="grid gap-2">
                    {lanes.mine.map((r) => (
                      <RequestCard
                        key={r.id}
                        request={r}
                        mine
                        people={people}
                        busy={act.busy(`cancel:${r.id}`)}
                        onFocus={setFocus}
                        onCancel={() => void act.run(`cancel:${r.id}`, () => zeusApi.cancelRequest(r.id), { success: 'Solicitud cancelada', error: 'No se pudo cancelar', onSettled: refreshInbox })}
                      />
                    ))}
                  </ul>
                </>
              )}
              {lanes.sent.length > 0 && (
                <>
                  <GroupLabel count={lanes.sent.length}>Mensajes enviados</GroupLabel>
                  <ul className="grid gap-2">
                    {lanes.sent.map((m) => <MessageCard key={m.id} message={m} sent unread={false} people={people} onOpen={() => {}} />)}
                  </ul>
                </>
              )}
            </>
          )}
        </Lane>
      </div>

      <ComposeDialog open={!!compose} me={me} replyTo={compose?.replyTo ?? null} onClose={() => setCompose(null)} />
      <NewRequestDialog
        open={requesting}
        onClose={() => setRequesting(false)}
        onCreated={(r) => toast.success(r.approverName ? `Solicitud enviada a ${r.approverName}` : 'Solicitud enviada', { description: r.routedBecause ?? undefined })}
      />
      <ResolveDialog target={resolving} onClose={() => setResolving(null)} />
      <StatusDialog target={statusTarget} onClose={() => setStatusTarget(null)} />
      <PlanDialog messageId={planId} onClose={() => setPlanId(null)} />
    </div>
  );
}
