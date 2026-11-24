// Sección "Bandeja": la ventana principal para saber en qué trabajar y qué está pendiente.
//
//   · Arriba, tu día de un vistazo (escenario): saludo, una frase con lo importante y las cifras de
//     cada bloque con su color.
//   · Izquierda, "Para trabajar": tus tickets activos de Linear (lista densa estilo Linear, con su
//     logo), los encargos y planes que te mandaron y las solicitudes que te toca decidir.
//   · Derecha, "Mensajes" (filas tipo bandeja de correo, en orden de llegada: leer no mueve nada) y
//     un bloque con "Variables" (avisos agrupados por entorno) y "En espera" (lo que tú mandaste).
//   · La pestaña "Historial" tiene TODO, leído o no, con filtros (InboxHistory.tsx).
// Cada bloque lleva su tono de la tabla de chips de DESIGN.md: trabajo naranja (marca), Linear con su
// logo, mensajes amarillo (lo humano), variables verde, planes lavanda (agentes).
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Check,
  CheckCheck,
  CornerDownRight,
  FileText,
  History,
  Inbox,
  KeySquare,
  Loader2,
  Mail,
  PencilLine,
  Plus,
  Reply,
  Search,
  Send,
  X,
} from 'lucide-react';
import { ErrorCard } from '@/components/bits';
import { PersonAvatar, RozBotAvatar } from '@/components/avatars';
import { Segmented } from '@/components/pulse/roz-v2';
import { fold } from '@/components/projects/project-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { R, to } from '@/lib/routes';
import { toast } from '@/lib/toast';
import { useAction } from '@/lib/useAction';
import { useApi } from '@/lib/useApi';
import { usePoll } from '@/lib/usePoll';
import { cn } from '@/lib/utils';
import { zeusApi, type ZeusInbox, type ZeusLinearBoard, type ZeusLinearIssue, type ZeusMe, type ZeusMessage, type ZeusOrgMember, type ZeusRequest } from '@/lib/zeus';
import { INBOX_KEY, useZeusOrg } from './hooks';
import { HistoryView } from './InboxHistory';
import { InboxDiagram } from './InboxDiagram';
import { LinearBlock } from './InboxLinear';
import { ComposeDialog, NewRequestDialog, PlanDialog, ResolveDialog, StatusDialog, refreshInbox, type StatusAction } from './InboxDialogs';
import { MESSAGE_KIND_LABEL, MESSAGE_STATUS, REQUEST_KIND_LABEL, REQUEST_STATUS, ago, dateTime, viaLabel } from './zeus-ui';
import { CmdLine } from './zeus-steps';
import './inbox.css';

type People = Map<string, ZeusOrgMember>;

const LINEAR_KEY = '/zeus/linear/board';

function Face({ devId, name, people, className = 'size-5' }: { devId: string | null; name: string; people: People; className?: string }) {
  const m = devId ? people.get(devId) : undefined;
  return <PersonAvatar name={name} login={m?.githubLogin} email={m?.email} id={devId} className={className} />;
}

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

/** Encabezado de un bloque: ícono con su tono, título, pista y acción. */
function BlockHead({ icon, title, hint, count, action }: { icon: ReactNode; title: string; hint?: string; count?: number | null; action?: ReactNode }) {
  return (
    <header className="flex shrink-0 items-center gap-2.5 px-1">
      {icon}
      <div className="grid min-w-0 flex-1">
        <h3 className="flex items-center gap-2 text-[13.5px] font-semibold leading-tight">
          {title}
          {count != null && count > 0 && <span className="rounded-full bg-panel px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground">{count}</span>}
        </h3>
        {hint && <span className="truncate text-[11.5px] text-muted-foreground">{hint}</span>}
      </div>
      {action}
    </header>
  );
}

/** Cajita del ícono de un bloque, con el par suave/tinta de su tono. */
const IconBox = ({ className, children }: { className: string; children: ReactNode }) => (
  <span className={cn('grid size-[26px] shrink-0 place-items-center rounded-md [&_svg]:size-3.5', className)}>{children}</span>
);

const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="rounded-md border border-dashed px-3 py-4 text-center text-[12.5px] leading-relaxed text-muted-foreground">{children}</p>
);

// ---------------------------------------------------------------- paneles (mismo marco que MCP)

function Section({ title, icon, meta, children, footer, className, bodyClassName }: {
  title: string;
  icon?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={cn('flex min-h-0 flex-col overflow-hidden', className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold tracking-[-0.01em]">{icon}{title}</h2>
        {meta}
      </div>
      <div className={cn('scroll-thin min-h-0 flex-1 overflow-y-auto', bodyClassName)}>{children}</div>
      {footer && <div className="shrink-0 border-t">{footer}</div>}
    </Card>
  );
}

/** Fila fantasma: misma altura y huesos que una real; rellena el espacio en vez de dejar hueco. */
function GhostRow({ wide = 96 }: { wide?: number }) {
  return (
    <li aria-hidden className="flex items-center gap-2.5 px-4 py-2.5">
      <span className="size-7 shrink-0 rounded-full border border-dashed border-toggle-off" />
      <span className="grid flex-1 gap-1.5">
        <span className="h-2 rounded-full bg-panel" style={{ width: wide }} />
        <span className="h-1.5 w-2/3 rounded-full border border-dashed border-toggle-off" />
      </span>
    </li>
  );
}

const GHOST_WIDTHS = [140, 104, 168, 92, 128, 116, 150, 84, 132];

/** Filtros de chips del encabezado de un panel (los de "Último trabajo"). */
function Chips<T extends string>({ value, onChange, options, label }: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; n: number; token?: string }>;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 flex-wrap items-center gap-1 border-b px-4 py-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground',
            value === o.value ? 'bg-panel text-foreground' : 'hover:bg-panel/60',
          )}
        >
          {o.token && <span className="size-1.5 rounded-full" style={{ background: `hsl(var(${o.token}))` }} />}
          {o.label}
          <span className="tabular-nums text-faint">{o.n}</span>
        </button>
      ))}
    </div>
  );
}

/** "Hoy", "Ayer" o la fecha: separadores por día, como en el resto de zeus. */
function dayOf(iso: string, now: number): string {
  const d = new Date(iso);
  const diff = Math.round((new Date(new Date(now).toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (diff <= 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  return d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short' });
}

type MessageFilter = 'all' | 'people' | 'zeus' | 'mcp';

// ---------------------------------------------------------------- tu día

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** La frase del día: lo que más importa primero, en lenguaje natural. */
function daySentence(s: { started: number; todo: number; backlog: number; zeus: number; unread: number; envs: number }): string {
  const parts: string[] = [];
  if (s.started) parts.push(`${plural(s.started, 'ticket', 'tickets')} en curso`);
  if (s.todo) parts.push(`${plural(s.todo, 'ticket', 'tickets')} por empezar`);
  if (s.backlog) parts.push(`${s.backlog} en backlog`);
  if (s.zeus) parts.push(`${plural(s.zeus, 'pendiente', 'pendientes')} del equipo esperando tu respuesta`);
  if (s.unread) parts.push(`${plural(s.unread, 'mensaje', 'mensajes')} sin leer`);
  if (s.envs) parts.push(`${plural(s.envs, 'cambio', 'cambios')} de variables`);
  if (!parts.length) return 'Todo al día: nada pendiente por ahora.';
  const last = parts.pop()!;
  return `Tienes ${parts.length ? `${parts.join(', ')} y ${last}` : last}.`;
}

// ---------------------------------------------------------------- tarjetas de trabajo de zeus

function RequestCard({
  request,
  mine,
  people,
  busy,
  onResolve,
  onCancel,
}: {
  request: ZeusRequest;
  mine?: boolean;
  people: People;
  busy: boolean;
  onResolve?: (decision: 'approved' | 'denied') => void;
  onCancel?: () => void;
}) {
  const st = REQUEST_STATUS[request.status] ?? { label: request.status, variant: 'secondary' as const };
  const pending = request.status === 'pending';
  return (
    <li className="grid min-w-0 gap-2 rounded-lg border bg-card p-3 transition-colors hover:border-foreground/20">
      <div className="flex items-center gap-1.5">
        <Badge variant="info">Solicitud · {REQUEST_KIND_LABEL[request.kind] ?? request.kind}</Badge>
        {(mine || !pending) && <Badge variant={st.variant} dot={pending}>{st.label}</Badge>}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-faint" data-tip={dateTime(request.createdAt)}>{ago(request.createdAt)}</span>
      </div>
      <p className="break-words text-[13.5px] font-semibold leading-snug">{request.title}</p>
      {request.detail && <p className="line-clamp-2 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted-foreground">{request.detail}</p>}
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

/** Un encargo o plan. El canto izquierdo dice qué es: plan = lavanda (agentes), encargo = amarillo. */
function WorkCard({
  message,
  sent,
  people,
  busy,
  onAct,
  onOpen,
}: {
  message: ZeusMessage;
  sent?: boolean;
  people: People;
  busy: boolean;
  onAct: (status: StatusAction) => void;
  onOpen: () => void;
}) {
  const st = message.status ? MESSAGE_STATUS[message.status] : null;
  const plan = message.kind === 'plan';
  return (
    <li className="relative grid min-w-0 gap-2 overflow-hidden rounded-lg border bg-card p-3 pl-4 transition-colors hover:border-foreground/20">
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', plan ? 'bg-purple-deep' : 'bg-yellow')} />
      <div className="flex items-center gap-1.5">
        <Badge variant={plan ? 'llm' : 'human'}>{plan ? <FileText className="size-3" /> : null}{MESSAGE_KIND_LABEL[message.kind]}</Badge>
        {st && <Badge variant={st.variant} dot={message.status === 'pending'}>{st.label}</Badge>}
        {message.projectKey && <span className="truncate font-mono text-[11px] text-faint">{message.projectKey}</span>}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-faint" data-tip={dateTime(message.createdAt)}>{ago(message.createdAt)}</span>
      </div>
      <button type="button" className="grid min-w-0 gap-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onOpen}>
        <span className="break-words text-[13.5px] font-semibold leading-snug">{message.subject ?? '(sin título)'}</span>
        <span className="line-clamp-2 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted-foreground">{message.body}</span>
      </button>
      {message.statusNote && (
        <p className="flex items-start gap-2 rounded-md bg-panel px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground">
          <CornerDownRight className="mt-0.5 size-3 shrink-0 text-faint" />
          <span className="min-w-0 whitespace-pre-wrap break-words">{message.statusNote}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {sent ? <Face devId={message.toDevId} name={message.toName} people={people} /> : <Face devId={message.fromDevId} name={message.fromName} people={people} />}
          <span className="truncate">
            {sent ? 'Para ' : 'De '}
            <span className="font-medium text-foreground">{sent ? message.toName : message.fromName}</span>
            {message.via !== 'web' && message.via !== 'system' && <> · por {viaLabel(message.via)}</>}
          </span>
        </span>
        {plan && <Button size="sm" variant="secondary" onClick={onOpen}><FileText /> Ver plan</Button>}
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

// ---------------------------------------------------------------- mensajes

/** Una fila de mensaje, como en un cliente de correo: quién, asunto, primera línea y cuándo. */
function MessageRow({
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
  const system = message.via === 'system' || !message.fromDevId;
  const who = sent ? `Para ${message.toName}` : !message.fromDevId ? 'zeus' : message.fromName;
  return (
    <li className={cn('group relative transition-colors hover:bg-panel/60', unread && 'bg-orange-soft/30')}>
      {unread && <span aria-hidden className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-orange" />}
      <button
        type="button"
        onClick={onOpen}
        className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 px-4 py-2.5 text-left focus-visible:bg-panel focus-visible:outline-none"
      >
        <span className="relative mt-0.5 block size-7">
          {sent ? (
            <Face devId={message.toDevId} name={message.toName} people={people} className="size-7" />
          ) : !message.fromDevId ? (
            <RozBotAvatar className="size-7" title="zeus" />
          ) : (
            <Face devId={message.fromDevId} name={message.fromName} people={people} className="size-7" />
          )}
          {/* Un aviso de zeus sobre algo de otra persona lleva la insignia de zeus encima de su cara. */}
          {system && message.fromDevId && !sent && <RozBotAvatar className="absolute -bottom-1 -right-1 size-4 rounded-full ring-2 ring-card" title="Aviso de zeus" />}
        </span>
        <span className="grid min-w-0 gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn('truncate text-[13px]', unread ? 'font-semibold' : 'font-medium')}>{who}</span>
            {message.projectKey && <span className="shrink-0 font-mono text-[10.5px] text-faint">{message.projectKey}</span>}
          </span>
          {message.subject && <span className={cn('truncate text-[13px] leading-snug', unread ? 'font-semibold' : 'text-foreground')}>{message.subject}</span>}
          <span className="line-clamp-1 break-words text-[12px] leading-relaxed text-muted-foreground">{message.body.replace(/\s+/g, ' ')}</span>
          {sent && <span className="text-[11px] text-faint">{message.readAt ? `Leído ${ago(message.readAt)}` : 'Sin leer todavía'}</span>}
        </span>
        <span className="flex flex-col items-end gap-1 pt-0.5">
          <span className="text-[11px] tabular-nums text-faint" data-tip={dateTime(message.createdAt)}>{ago(message.createdAt)}</span>
          {message.via !== 'web' && (
            <Badge variant={message.via === 'mcp' ? 'warn' : message.via === 'system' ? 'secondary' : 'info'} className="px-1.5 py-0 text-[9.5px] font-semibold uppercase tracking-[0.04em]">
              {message.via === 'system' ? 'zeus' : viaLabel(message.via).replace(/^(el|su|la) /, '')}
            </Badge>
          )}
        </span>
      </button>
      {(onRead || (onReply && !system)) && (
        <span className="absolute bottom-2 right-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {unread && onRead && (
            <Button variant="secondary" size="sm" className="h-6 gap-1 px-1.5 text-[11px] shadow-sm" onClick={onRead}><Check /> Leído</Button>
          )}
          {onReply && !system && (
            <Button variant="secondary" size="sm" className="h-6 gap-1 px-1.5 text-[11px] shadow-sm" onClick={onReply}><Reply /> Responder</Button>
          )}
        </span>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- variables

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

/** "HYPERHUB/api-hyperhub-production" del asunto del aviso. */
const envLabelOf = (subject: string | null) => /de (\S+\/\S+)$/.exec(subject ?? '')?.[1] ?? null;

interface EnvGroup {
  env: string;
  messages: ZeusMessage[];
  /** Nombre → qué le pasó (lo más reciente gana). */
  names: Map<string, string>;
  actors: Array<{ id: string | null; name: string }>;
  rotated: boolean;
  pull: string | null;
  at: string;
}

/** Junta los avisos por entorno: tres avisos de api-hyperhub-production son UNA fila. */
function groupEnvChanges(list: ZeusMessage[]): EnvGroup[] {
  const map = new Map<string, EnvGroup>();
  // De lo más viejo a lo más nuevo, para que el último cambio de un nombre sea el que quede.
  for (const m of [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const env = envLabelOf(m.subject) ?? m.subject ?? 'variables';
    const g: EnvGroup = map.get(env) ?? { env, messages: [], names: new Map(), actors: [], rotated: false, pull: null, at: m.createdAt };
    const parsed = parseEnvChange(m.body);
    g.messages.push(m);
    for (const grp of parsed.groups) for (const n of grp.names) g.names.set(n, grp.label);
    if (!g.actors.some((a) => a.id === m.fromDevId)) g.actors.push({ id: m.fromDevId, name: m.fromName });
    g.rotated ||= parsed.rotated;
    g.pull = parsed.pull ?? g.pull;
    g.at = m.createdAt;
    map.set(env, g);
  }
  return [...map.values()].sort((a, b) => b.at.localeCompare(a.at));
}

const ENV_NAME_TONE: Record<string, string> = { Nuevas: 'text-green', Cambiaron: 'text-foreground', 'Se quitaron': 'text-faint line-through' };
const MAX_NAMES = 8;

function EnvGroupRow({ group, unread, people, onRead }: { group: EnvGroup; unread: boolean; people: People; onRead: () => void }) {
  const [open, setOpen] = useState(false);
  const [project, env] = group.env.includes('/') ? group.env.split('/') : [null, group.env];
  const names = [...group.names.entries()];
  const shown = open ? names : names.slice(0, MAX_NAMES);
  return (
    <li className={cn('relative grid min-w-0 gap-2 rounded-md border px-3 py-2.5 transition-colors', unread ? 'border-green/40 bg-green-soft/30' : 'bg-card')}>
      <button
        type="button"
        aria-expanded={open}
        className="flex min-w-0 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          setOpen((v) => !v);
          if (unread) onRead();
        }}
      >
        <KeySquare className={cn('size-3.5 shrink-0', unread ? 'text-green' : 'text-faint')} />
        <span className="min-w-0 truncate font-mono text-[12px] font-semibold">{env}</span>
        {project && <span className="shrink-0 font-mono text-[10.5px] text-faint">{project}</span>}
        {group.rotated && <Badge variant="warn">Llave rotada</Badge>}
        {unread && <span className="size-1.5 shrink-0 rounded-full bg-green" aria-label="Nuevo" />}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-faint" data-tip={dateTime(group.at)}>{ago(group.at)}</span>
      </button>
      <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <span className="flex -space-x-1.5">
          {group.actors.slice(0, 3).map((a) => <Face key={a.id ?? a.name} devId={a.id} name={a.name} people={people} className="size-4 ring-2 ring-card" />)}
        </span>
        <span className="truncate">
          {group.actors.map((a) => a.name).join(', ')} · {plural(names.length, 'variable', 'variables')}
          {group.messages.length > 1 && ` en ${group.messages.length} cambios`}
        </span>
      </div>
      {shown.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {shown.map(([n, kind]) => (
            <span key={n} data-tip={kind} className={cn('rounded bg-panel px-1.5 py-0.5 font-mono text-[10.5px]', ENV_NAME_TONE[kind])}>
              {kind === 'Nuevas' && '+ '}
              {n}
            </span>
          ))}
          {!open && names.length > MAX_NAMES && (
            <button type="button" className="rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-panel" onClick={() => setOpen(true)}>
              +{names.length - MAX_NAMES}
            </button>
          )}
        </div>
      )}
      {open && group.pull && <CmdLine command={group.pull} />}
    </li>
  );
}

// ---------------------------------------------------------------- pestaña

const requestText = (r: ZeusRequest) => fold(`${r.title} ${r.detail} ${r.requesterName} ${r.approverName ?? ''} ${r.resourceTitle ?? ''} ${REQUEST_KIND_LABEL[r.kind] ?? ''}`);
const messageText = (m: ZeusMessage) => fold(`${m.subject ?? ''} ${m.body} ${m.fromName} ${m.toName} ${m.projectKey ?? ''}`);
const issueText = (i: ZeusLinearIssue) => fold(`${i.identifier} ${i.title} ${i.project ?? ''} ${i.team} ${i.state} ${i.labels.join(' ')}`);
const newest = (a: { createdAt: string }, b: { createdAt: string }) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

export function InboxTab({ me }: { me: ZeusMe | null }) {
  const inbox = useApi<ZeusInbox>(() => zeusApi.inbox(), [], { key: INBOX_KEY, ttl: 15_000 });
  usePoll(inbox.reload, inbox.data ? 30_000 : null);
  // Cada 30 s: zeus guarda tus tickets en memoria y el webhook de Linear borra esa copia en cuanto algo
  // cambia, así que preguntar seguido es barato y un cambio en Linear se ve en segundos.
  const linear = useApi<ZeusLinearBoard>(() => zeusApi.linearBoard(), [], { key: LINEAR_KEY, ttl: 25_000 });
  usePoll(linear.reload, linear.data ? 30_000 : null);
  const org = useZeusOrg();
  const act = useAction();
  const [view, setView] = useState<'bandeja' | 'historial'>('bandeja');
  const [msgFilter, setMsgFilter] = useState<MessageFilter>('all');
  const [q, setQ] = useState('');
  const [compose, setCompose] = useState<{ replyTo: ZeusMessage | null } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [resolving, setResolving] = useState<{ request: ZeusRequest; decision: 'approved' | 'denied' } | null>(null);
  const [statusTarget, setStatusTarget] = useState<{ message: ZeusMessage; status: StatusAction } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // Leídos en esta sesión: el punto se apaga al instante, sin esperar a que la bandeja revalide.
  const [readLocal, setReadLocal] = useState<Set<string>>(() => new Set());

  const data = inbox.data;
  const people = useMemo<People>(() => new Map((org.data?.members ?? []).map((m) => [m.devId, m])), [org.data]);
  const isUnread = (m: ZeusMessage) => !m.readAt && !readLocal.has(m.id) && m.toDevId === me?.devId;

  const markRead = (ids: string[]) => {
    const targets = ids.filter((id) => !readLocal.has(id));
    if (!targets.length) return;
    setReadLocal((prev) => new Set([...prev, ...targets]));
    void zeusApi
      .markRead(targets)
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

  const openMessage = (m: ZeusMessage) => {
    setOpenId(m.id);
    if (isUnread(m)) markRead([m.id]);
  };

  const needle = fold(q.trim());
  const lanes = useMemo(() => {
    const d = data ?? { messages: [], envChanges: [], sent: [], toResolve: [], mine: [], open: [], waiting: [] };
    const req = (r: ZeusRequest) => !needle || requestText(r).includes(needle);
    const msg = (m: ZeusMessage) => !needle || messageText(m).includes(needle);
    // Los encargos y planes abiertos viven en "Para trabajar"/"En espera"; no se repiten como mensajes.
    const work = new Set([...(d.open ?? []), ...(d.waiting ?? [])].map((m) => m.id));
    return {
      issues: needle ? (linear.data?.issues ?? []).filter((i) => issueText(i).includes(needle)) : null,
      open: (d.open ?? []).filter(msg).sort(newest),
      decide: d.toResolve.filter((r) => r.status === 'pending').filter(req).sort(newest),
      messages: d.messages.filter((m) => m.kind === 'message' && !work.has(m.id)).filter(msg).sort(newest),
      envs: (d.envChanges ?? []).filter(msg),
      waiting: (d.waiting ?? []).filter(msg).sort(newest),
      mine: d.mine.filter((r) => r.status === 'pending').filter(req).sort(newest),
      sent: d.sent.filter((m) => m.kind === 'message').filter(msg).sort(newest).slice(0, 8),
    };
  }, [data, linear.data, needle]);
  const envGroups = useMemo(() => groupEnvChanges(lanes.envs), [lanes.envs]);

  const loading = inbox.loading;
  const failed = !!inbox.error && !data;
  const unreadMessages = lanes.messages.filter(isUnread);
  const unreadEnvGroups = envGroups.filter((g) => g.messages.some(isUnread));
  const issues = linear.data?.status === 'ok' ? linear.data.issues : [];
  const started = issues.filter((i) => i.stateType === 'started').length;
  const zeusWork = lanes.open.length + lanes.decide.length;
  const waitingCount = lanes.waiting.length + lanes.mine.length;
  const firstName = me?.name.split(' ')[0] ?? '';
  const now = Date.now();
  const msgCounts = {
    all: lanes.messages.length,
    people: lanes.messages.filter((m) => m.via !== 'system' && m.fromDevId).length,
    zeus: lanes.messages.filter((m) => m.via === 'system' || !m.fromDevId).length,
    mcp: lanes.messages.filter((m) => m.via === 'mcp').length,
  };
  const shownMessages = lanes.messages.filter((m) =>
    msgFilter === 'all' ? true : msgFilter === 'people' ? m.via !== 'system' && !!m.fromDevId : msgFilter === 'zeus' ? m.via === 'system' || !m.fromDevId : m.via === 'mcp',
  );
  const messageRows: Array<{ day: string } | { m: ZeusMessage }> = [];
  {
    let last = '';
    for (const m of shownMessages) {
      const day = dayOf(m.createdAt, now);
      if (day !== last) messageRows.push({ day });
      last = day;
      messageRows.push({ m });
    }
  }

  return (
    <div className="flex flex-col gap-3 lg:h-[calc(100dvh-var(--shell-top,196px)-var(--shell-pad-b,0px))] lg:min-h-[760px]">
      <section className="flex shrink-0 flex-wrap items-center gap-2">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'bandeja', label: 'Bandeja', icon: <Inbox /> },
            { value: 'historial', label: 'Historial', icon: <History /> },
          ]}
        />
        {view === 'bandeja' && (
          <Input
            fieldSize="sm"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQ('')}
            placeholder="Filtrar tickets, mensajes y avisos…"
            aria-label="Filtrar la bandeja"
            leading={<Search />}
            trailing={
              q ? (
                <button type="button" onClick={() => setQ('')} aria-label="Limpiar búsqueda" className="grid size-6 place-items-center rounded-sm text-faint hover:text-foreground"><X className="size-3.5" /></button>
              ) : undefined
            }
            wrapperClassName="min-w-[220px] max-w-sm flex-1"
          />
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setCompose({ replyTo: null })}><Mail /> Nuevo mensaje</Button>
          <Button variant="brand" size="sm" onClick={() => setRequesting(true)}><Plus /> Nueva solicitud</Button>
        </div>
      </section>

      {inbox.error && <ErrorCard className="shrink-0" message={failed ? 'No se pudo cargar la bandeja.' : inbox.error} />}

      {view === 'historial' ? (
        <HistoryView people={people} onOpen={openMessage} />
      ) : (
        <>
          <InboxDiagram
            className="shrink-0"
            loading={loading}
            firstName={firstName}
            sentence={daySentence({ started, todo: issues.filter((i) => i.stateType === 'unstarted' || i.stateType === 'triage').length, backlog: issues.filter((i) => i.stateType === 'backlog').length, zeus: zeusWork, unread: unreadMessages.length, envs: unreadEnvGroups.length })}
            issues={linear.data?.status === 'ok' ? linear.data.issues : null}
            zeusWork={zeusWork}
            unread={unreadMessages.length}
            envs={unreadEnvGroups.length}
            received={[...(data?.messages ?? []), ...(data?.envChanges ?? []), ...(data?.open ?? [])]}
            waiting={data?.waiting ?? []}
            mine={(data?.mine ?? []).filter((r) => r.status === 'pending')}
            people={people}
            refetching={inbox.refetching || linear.refetching}
            onRefresh={() => {
              inbox.reload();
              linear.reload();
            }}
          />

          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_320px] lg:grid-rows-[minmax(0,1fr)] 2xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_360px]">
            {/* ---------------- Para trabajar */}
            <Section
              title="Para trabajar"
              meta={<span className="label-caps tabular-nums">{loading ? '–' : `${issues.length} en Linear · ${zeusWork} del equipo`}</span>}
              className="max-lg:max-h-[80dvh]"
              bodyClassName="grid content-start gap-5 p-3.5"
            >
              <LinearBlock board={linear.data ?? null} loading={linear.loading} filtered={lanes.issues} />
              <section className="grid gap-2">
                <BlockHead
                  icon={<IconBox className="bg-lavender text-purple-deep"><Send /></IconBox>}
                  title="Del equipo"
                  hint="Encargos, planes y solicitudes que te mandaron por zeus"
                  count={zeusWork}
                />
                {loading ? (
                  <Skeleton className="h-24 w-full rounded-lg" />
                ) : !zeusWork ? (
                  <Quiet>{needle ? 'Nada coincide con esa búsqueda.' : 'Nadie espera una respuesta tuya. Aquí caen los encargos y planes que te comparta el equipo o su Claude.'}</Quiet>
                ) : (
                  <ul className="grid gap-2">
                    {lanes.open.map((m) => (
                      <WorkCard
                        key={m.id}
                        message={m}
                        people={people}
                        busy={act.busy(`status:${m.id}`)}
                        onAct={(status) => setStatusTarget({ message: m, status })}
                        onOpen={() => openMessage(m)}
                      />
                    ))}
                    {lanes.decide.map((r) => (
                      <RequestCard key={r.id} request={r} people={people} busy={act.busy(`resolve:${r.id}`)} onResolve={(decision) => setResolving({ request: r, decision })} />
                    ))}
                  </ul>
                )}
              </section>
            </Section>

            {/* ---------------- Mensajes */}
            <Section
              title="Mensajes"
              meta={
                unreadMessages.length > 0 ? (
                  <Button variant="ghost" size="sm" className="-my-1 h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={() => markRead(unreadMessages.map((m) => m.id))}>
                    <CheckCheck /> {unreadMessages.length} sin leer
                  </Button>
                ) : (
                  <span className="label-caps tabular-nums">{loading ? '–' : `${lanes.messages.length} recientes`}</span>
                )
              }
              className="max-lg:max-h-[75dvh]"
              bodyClassName="flex flex-col"
              footer={
                <button
                  type="button"
                  onClick={() => setView('historial')}
                  className="flex h-9 w-full items-center justify-center gap-1.5 text-xs text-muted-foreground transition-colors hover:bg-panel/60 hover:text-foreground"
                >
                  <History className="size-3.5" /> Ver todo el historial
                </button>
              }
            >
              <Chips
                label="Tipo de mensaje"
                value={msgFilter}
                onChange={setMsgFilter}
                options={[
                  { value: 'all', label: 'Todo', n: msgCounts.all },
                  { value: 'people', label: 'Personas', n: msgCounts.people, token: '--yellow' },
                  { value: 'zeus', label: 'Avisos', n: msgCounts.zeus, token: '--purple' },
                  { value: 'mcp', label: 'Por MCP', n: msgCounts.mcp, token: '--orange' },
                ]}
              />
              {loading ? (
                <ul className="divide-y divide-dashed">{GHOST_WIDTHS.slice(0, 5).map((w, i) => <GhostRow key={i} wide={w} />)}</ul>
              ) : (
                <ol className="min-h-0 flex-1">
                  {messageRows.map((r, i) =>
                    'day' in r ? (
                      <li key={`d${i}`} className="label-caps sticky top-0 z-10 bg-card px-4 pb-1 pt-3 text-faint">{r.day}</li>
                    ) : (
                      <MessageRow
                        key={r.m.id}
                        message={r.m}
                        unread={isUnread(r.m)}
                        people={people}
                        onOpen={() => openMessage(r.m)}
                        onRead={() => markRead([r.m.id])}
                        onReply={() => setCompose({ replyTo: r.m })}
                      />
                    ),
                  )}
                  {!shownMessages.length && (
                    <li className="px-4 pb-1 pt-3 text-[12px] text-muted-foreground">
                      {needle ? 'Nada coincide con esa búsqueda.' : msgFilter === 'all' ? 'Sin mensajes recientes. Lo leído se queda aquí y siempre está en el historial.' : 'Nada de este tipo por ahora.'}
                    </li>
                  )}
                  {Array.from({ length: Math.max(0, 6 - messageRows.length) }, (_, i) => <GhostRow key={`g${i}`} wide={GHOST_WIDTHS[i % GHOST_WIDTHS.length]} />)}
                </ol>
              )}
            </Section>

            {/* ---------------- Variables + En espera */}
            <div className="grid min-h-0 gap-3 lg:grid-rows-[minmax(0,1.1fr)_minmax(0,1fr)]">
              <Section
                title="Variables"
                icon={<KeySquare className="size-4 text-green" />}
                meta={
                  unreadEnvGroups.length > 0 ? (
                    <Button variant="ghost" size="sm" className="-my-1 h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={() => markRead(lanes.envs.filter(isUnread).map((m) => m.id))}>
                      <CheckCheck /> {unreadEnvGroups.length} con cambios
                    </Button>
                  ) : (
                    <Link to={R.variables} className="label-caps hover:text-foreground">Ir a variables</Link>
                  )
                }
                className="max-lg:max-h-[60dvh]"
                bodyClassName="p-2"
              >
                {loading ? (
                  <div className="grid gap-1.5">{[0, 1].map((i) => <Skeleton key={i} className="h-16 w-full rounded-md" />)}</div>
                ) : envGroups.length === 0 ? (
                  <Quiet>{needle ? 'Nada coincide con esa búsqueda.' : 'Cuando alguien cambie variables de un entorno al que tienes acceso, aparece aquí con el comando para ponerte al día.'}</Quiet>
                ) : (
                  <ul className="grid gap-1.5">
                    {envGroups.map((g) => (
                      <EnvGroupRow key={g.env} group={g} unread={g.messages.some(isUnread)} people={people} onRead={() => markRead(g.messages.filter(isUnread).map((m) => m.id))} />
                    ))}
                  </ul>
                )}
              </Section>

              <Section
                title="En espera"
                icon={<Send className="size-4 text-purple-deep" />}
                meta={<span className="label-caps tabular-nums">{loading ? '–' : `${waitingCount} abiertas`}</span>}
                className="max-lg:max-h-[60dvh]"
                bodyClassName="p-2"
              >
                {loading ? (
                  <Skeleton className="h-16 w-full rounded-md" />
                ) : !lanes.waiting.length && !lanes.mine.length && !lanes.sent.length ? (
                  <Quiet>{needle ? 'Nada coincide con esa búsqueda.' : 'Aquí sigues los encargos, planes y solicitudes que mandaste: a quién le llegó y en qué quedó.'}</Quiet>
                ) : (
                  <div className="grid gap-3">
                    {(lanes.waiting.length > 0 || lanes.mine.length > 0) && (
                      <ul className="grid gap-2">
                        {lanes.waiting.map((m) => (
                          <WorkCard
                            key={m.id}
                            message={m}
                            sent
                            people={people}
                            busy={act.busy(`status:${m.id}`)}
                            onAct={(status) => setStatusTarget({ message: m, status })}
                            onOpen={() => openMessage(m)}
                          />
                        ))}
                        {lanes.mine.map((r) => (
                          <RequestCard
                            key={r.id}
                            request={r}
                            mine
                            people={people}
                            busy={act.busy(`cancel:${r.id}`)}
                            onCancel={() => void act.run(`cancel:${r.id}`, () => zeusApi.cancelRequest(r.id), { success: 'Solicitud cancelada', error: 'No se pudo cancelar', onSettled: refreshInbox })}
                          />
                        ))}
                      </ul>
                    )}
                    {lanes.sent.length > 0 && (
                      <div className="-mx-2 grid gap-1">
                        <h4 className="label-caps px-4 text-faint">Mensajes que enviaste</h4>
                        <ul className="divide-y divide-dashed">
                          {lanes.sent.map((m) => <MessageRow key={m.id} message={m} sent unread={false} people={people} onOpen={() => openMessage(m)} />)}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </Section>
            </div>
          </div>
        </>
      )}

      <ComposeDialog open={!!compose} me={me} replyTo={compose?.replyTo ?? null} onClose={() => setCompose(null)} />
      <NewRequestDialog
        open={requesting}
        onClose={() => setRequesting(false)}
        onCreated={(r) => toast.success(r.approverName ? `Solicitud enviada a ${r.approverName}` : 'Solicitud enviada', { description: r.routedBecause ?? undefined })}
      />
      <ResolveDialog target={resolving} onClose={() => setResolving(null)} />
      <StatusDialog target={statusTarget} onClose={() => setStatusTarget(null)} />
      <PlanDialog
        messageId={openId}
        onClose={() => setOpenId(null)}
        onReply={(m) => {
          setOpenId(null);
          setCompose({ replyTo: m });
        }}
      />
    </div>
  );
}
