// Página "MCP": cómo trabaja tu Claude con zeus, con datos reales (GET /zeus/mcp, src/zeus/mcp-status.ts).
// Mismo lenguaje que Env: arriba un diagrama vivo (quién pide → zeus → qué se movió), y abajo tres
// columnas que caben en el alto de la pantalla:
//   · conectar el tuyo, con pasos que se marcan solos según lo que zeus ya vio de ti, y tus tokens;
//   · el último trabajo, AGRUPADO (diez "consultó las variables" seguidos son una sola fila ×10) y
//     filtrable por parte de zeus;
//   · quién está conectado, lo pendiente del equipo y la salud (repos que piden atención, runners).
// Una lista vacía se rellena con siluetas punteadas, como el resto de zeus: nunca un hueco.
import { useMemo, useState, type ReactNode } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { ErrorCard } from '@/components/bits';
import { PersonAvatar } from '@/components/avatars';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { invalidate } from '@/lib/store';
import { useAction } from '@/lib/useAction';
import { useApi } from '@/lib/useApi';
import { usePoll } from '@/lib/usePoll';
import { cn } from '@/lib/utils';
import { zeusApi, type ZeusActivityEvent, type ZeusMcpConnection, type ZeusMcpPendingItem, type ZeusMcpStatus, type ZeusMe } from '@/lib/zeus';
import { GRAPH_KEY, NODES_KEY } from './hooks';
import { AREA_META, McpDiagram, areaOf, type WorkArea } from './McpDiagram';
import { McpTokenList, SETUP_COMMAND } from './McpTokens';
import { CmdLine, Step, StepNote, Steps, type StepState } from './zeus-steps';
import { CLI_INSTALL, MESSAGE_STATUS, OnlineDot, ago, dateTime, describeActivity, viaLabel } from './zeus-ui';
import './access.css';

export { SETUP_COMMAND, cliCommand, mcpCommand } from './McpTokens';

const MCP_KEY = '/zeus/mcp';

// ---------------------------------------------------------------- piezas

function Section({ title, meta, children, className, bodyClassName }: { title: string; meta?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <Card className={cn('flex min-h-0 flex-col overflow-hidden', className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold tracking-[-0.01em]">{title}</h2>
        {meta}
      </div>
      <div className={cn('scroll-thin min-h-0 flex-1 overflow-y-auto', bodyClassName)}>{children}</div>
    </Card>
  );
}

/** Fila fantasma: misma altura y huesos que una real; rellena el espacio en vez de dejar hueco. */
function GhostRow({ wide = 96, avatar = true }: { wide?: number; avatar?: boolean }) {
  return (
    <li aria-hidden className="flex items-center gap-2.5 px-4 py-2.5">
      {avatar && <span className="size-7 shrink-0 rounded-full border border-dashed border-toggle-off" />}
      <span className="grid flex-1 gap-1.5">
        <span className="h-2 rounded-full bg-panel" style={{ width: wide }} />
        <span className="h-1.5 w-2/3 rounded-full border border-dashed border-toggle-off" />
      </span>
    </li>
  );
}

const PENDING_KIND: Record<ZeusMcpPendingItem['kind'], string> = { task: 'Encargo', plan: 'Plan', request: 'Solicitud', agent_plan: 'Planificador' };
const AGENT_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  en_cola: { label: 'En cola', variant: 'human' },
  planeando: { label: 'Planeando', variant: 'info' },
  implementando: { label: 'Implementando', variant: 'info' },
  esperando_aprobacion: { label: 'Por aprobar', variant: 'warn' },
};
function pendingStatus(it: ZeusMcpPendingItem): { label: string; variant: BadgeVariant } {
  if (it.kind === 'agent_plan') return AGENT_STATUS[it.status] ?? { label: it.status, variant: 'secondary' };
  if (it.kind === 'request') return { label: 'Por resolver', variant: 'human' };
  return MESSAGE_STATUS[it.status as keyof typeof MESSAGE_STATUS] ?? { label: it.status, variant: 'secondary' };
}

/** Verbos de las acciones del flujo de Claude que el catálogo general no conoce. */
const MCP_VERBS: Array<[RegExp, string]> = [
  [/^plan\.share$/, 'compartió el plan'],
  [/^task$/, 'dejó un encargo'],
  [/^(task|plan)\.accepted$/, 'aceptó'],
  [/^(task|plan)\.done$/, 'terminó'],
  [/^(task|plan)\.changes_requested$/, 'pidió ajustes a'],
  [/^(task|plan)\.declined$/, 'rechazó'],
  [/^env\.history$/, 'revisó el historial de'],
];

function describe(ev: ZeusActivityEvent) {
  const base = describeActivity(ev, null);
  const own = MCP_VERBS.find(([re]) => re.test(ev.action))?.[1];
  const d = ev.detail ?? {};
  const env = typeof d.env === 'string' ? d.env : null;
  const what = base.what ?? env ?? (typeof d.project === 'string' ? d.project : null);
  // Sin objeto, "pidió el índice de" quedaría colgando: el verbo se cierra solo.
  const verb = own ?? base.verb;
  return { ...base, verb: what ? verb : verb.replace(/ (de|a|en)$/, ''), what };
}

// ---------------------------------------------------------------- último trabajo, agrupado

interface WorkGroup {
  key: string;
  ev: ZeusActivityEvent;
  area: WorkArea;
  count: number;
  /** El más viejo del grupo (el más nuevo es `ev`). */
  oldestAt: string;
  /** Sobre qué se hizo (entornos, documentos), sin repetir, en orden de aparición. */
  targets: string[];
}

/** Ventana de una "sesión": la misma acción de la misma persona dentro de 2 h es una sola fila. */
const SESSION_MS = 2 * 3600_000;

/**
 * Agrupa por persona y acción dentro de una sesión, aunque cambie el objeto: "consultó variables" de
 * tres entornos en diez minutos es UNA fila con sus entornos y ×N, no diez filas casi iguales.
 */
function groupWork(events: ZeusActivityEvent[]): WorkGroup[] {
  const out: WorkGroup[] = [];
  const open = new Map<string, WorkGroup>();
  for (const ev of events) {
    const key = `${ev.devId ?? ev.actor}|${ev.action}`;
    const what = describe(ev).what;
    const g = open.get(key);
    if (g && new Date(g.oldestAt).getTime() - new Date(ev.at).getTime() < SESSION_MS) {
      g.count++;
      g.oldestAt = ev.at;
      if (what && !g.targets.includes(what)) g.targets.push(what);
      continue;
    }
    const next: WorkGroup = { key, ev, area: areaOf(ev.action), count: 1, oldestAt: ev.at, targets: what ? [what] : [] };
    open.set(key, next);
    out.push(next);
  }
  return out;
}

const dayLabel = (iso: string, now: number): string => {
  const d = new Date(iso);
  const diff = Math.round((new Date(new Date(now).toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (diff <= 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  return d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short' });
};

const VIA_VARIANT: Record<string, BadgeVariant> = { mcp: 'warn', cli: 'info', runner: 'llm', web: 'secondary' };

function WorkRow({ g, person, now }: { g: WorkGroup; person: ZeusMcpConnection | undefined; now: number }) {
  const d = describe(g.ev);
  const meta = AREA_META[g.area];
  const newest = ago(g.ev.at, now);
  const oldest = ago(g.oldestAt, now);
  return (
    <li className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-panel/60">
      <span className="relative shrink-0">
        {g.ev.devId ? (
          <PersonAvatar name={d.who} login={person?.githubLogin} email={person?.email} id={g.ev.devId} className="size-7" />
        ) : (
          <span className="grid size-7 place-items-center rounded-full bg-panel text-[10px] font-semibold text-muted-foreground">{d.who.slice(0, 1)}</span>
        )}
        <span
          className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full ring-2 ring-card [&_svg]:size-2.5"
          style={{ background: `hsl(var(${meta.token}))`, color: 'hsl(var(--card))' }}
          title={meta.label}
        >
          <meta.icon />
        </span>
      </span>
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="text-[12.5px] leading-snug">
          <span className="font-semibold">{d.who}</span> <span className="text-muted-foreground">{d.verb}</span>
          {g.targets.length === 1 && <> <span className="break-all font-mono text-[11.5px] font-medium">{g.targets[0]}</span></>}
        </span>
        {g.targets.length > 1 && (
          <span className="flex flex-wrap gap-1">
            {g.targets.slice(0, 4).map((t) => (
              <span key={t} className="rounded-[4px] bg-panel px-1.5 py-0.5 font-mono text-[10.5px] font-medium">{t}</span>
            ))}
            {g.targets.length > 4 && <span className="px-1 py-0.5 text-[10.5px] text-faint">+{g.targets.length - 4}</span>}
          </span>
        )}
        <span className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-faint">
          <Badge variant={VIA_VARIANT[g.ev.actor] ?? 'secondary'} className="px-1.5 py-0 text-[9.5px] font-semibold uppercase tracking-[0.04em]">
            {viaLabel(g.ev.actor).replace(/^(el|su|la) /, '')}
          </Badge>
          <span className="tabular-nums" title={dateTime(g.ev.at)}>{g.count > 1 && oldest !== newest ? `${newest} · desde ${oldest}` : newest}</span>
        </span>
      </span>
      {g.count > 1 && (
        <span className="shrink-0 rounded-full bg-panel px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums" title={`${g.count} veces seguidas`}>×{g.count}</span>
      )}
    </li>
  );
}

function WorkFeed({ data, now }: { data: ZeusMcpStatus | null; now: number }) {
  const [area, setArea] = useState<WorkArea | 'all'>('all');
  const people = useMemo(() => new Map((data?.connections ?? []).map((c) => [c.devId, c])), [data]);
  const events = useMemo(() => data?.recent ?? [], [data]);
  const counts = useMemo(() => {
    const m = new Map<WorkArea, number>();
    for (const e of events) m.set(areaOf(e.action), (m.get(areaOf(e.action)) ?? 0) + 1);
    return m;
  }, [events]);
  const groups = useMemo(() => groupWork(events.filter((e) => area === 'all' || areaOf(e.action) === area)), [events, area]);

  // Separadores por día.
  const rows: Array<{ day: string } | { g: WorkGroup }> = [];
  let lastDay = '';
  for (const g of groups) {
    const day = dayLabel(g.ev.at, now);
    if (day !== lastDay) rows.push({ day });
    lastDay = day;
    rows.push({ g });
  }

  return (
    <Section
      title="Último trabajo"
      meta={<span className="label-caps tabular-nums">{data ? `${events.length} eventos · ${groups.length} ${groups.length === 1 ? 'acción' : 'acciones'}` : '–'}</span>}
      bodyClassName="flex flex-col"
    >
      <div role="radiogroup" aria-label="Parte de zeus" className="flex shrink-0 flex-wrap items-center gap-1 border-b px-4 py-2">
        {(['all', 'contexto', 'bandeja', 'variables'] as const).map((k) => {
          const n = k === 'all' ? events.length : (counts.get(k) ?? 0);
          return (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={area === k}
              onClick={() => setArea(k)}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground',
                area === k ? 'bg-panel text-foreground' : 'hover:bg-panel/60',
              )}
            >
              {k !== 'all' && <span className="size-1.5 rounded-full" style={{ background: `hsl(var(${AREA_META[k].token}))` }} />}
              {k === 'all' ? 'Todo' : AREA_META[k].label}
              <span className="tabular-nums text-faint">{n}</span>
            </button>
          );
        })}
      </div>
      {!data ? (
        <ul className="divide-y divide-dashed">{[120, 160, 96, 140, 110].map((w, i) => <GhostRow key={i} wide={w} />)}</ul>
      ) : groups.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ul className="divide-y divide-dashed">{[120, 160, 96].map((w, i) => <GhostRow key={i} wide={w} />)}</ul>
          <p className="mt-auto border-t px-4 py-2.5 text-[12px] leading-snug text-muted-foreground">
            {area === 'all' ? 'Sin trabajo por MCP o CLI en los últimos 7 días. Cuando un Claude consulte zeus, aparece aquí.' : `Nada de ${AREA_META[area].label.toLowerCase()} en los últimos 7 días.`}
          </p>
        </div>
      ) : (
        <ol className="min-h-0 flex-1">
          {rows.map((r, i) =>
            'day' in r ? (
              <li key={`d${i}`} className="label-caps sticky top-0 z-10 bg-card px-4 pb-1 pt-3 text-faint">{r.day}</li>
            ) : (
              <WorkRow key={r.g.ev.id} g={r.g} person={r.g.ev.devId ? people.get(r.g.ev.devId) : undefined} now={now} />
            ),
          )}
          {/* Poco trabajo: siluetas hasta el pie, como el resto de zeus, en vez de un hueco. */}
          {Array.from({ length: Math.max(0, 9 - rows.length) }, (_, i) => (
            <GhostRow key={`g${i}`} wide={[140, 104, 168, 92, 128, 116, 150, 84, 132][i % 9]} />
          ))}
        </ol>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- página

const lastSeen = (c: ZeusMcpConnection): string | null => {
  const a = c.lastMcpAt;
  const b = c.lastCliAt;
  return !a ? b : !b ? a : a > b ? a : b;
};

export function AccessTab({ me }: { me: ZeusMe | null }) {
  const status = useApi<ZeusMcpStatus>(() => zeusApi.mcp(), [], { key: MCP_KEY, ttl: 20_000 });
  usePoll(status.reload, status.data ? 30_000 : null);
  const act = useAction();
  const [q, setQ] = useState('');
  const d = status.data;
  const now = d ? new Date(d.now).getTime() : Date.now();

  const sync = (repo: string) =>
    void act.run(`sync:${repo}`, () => zeusApi.syncSource(repo), {
      success: { title: 'Lectura en cola', description: 'zeus la atiende en su siguiente barrida.' },
      error: 'No se pudo pedir la lectura',
      onSettled: () => {
        invalidate(MCP_KEY);
        invalidate(GRAPH_KEY);
        invalidate(NODES_KEY);
      },
    });

  // Pasos para conectar el tuyo: se marcan solos con lo que zeus ya vio de ti.
  const mine = d?.connections.find((c) => c.devId === me?.devId) ?? null;
  const done = [!!mine && mine.tokens > 0, !!mine?.lastCliAt, !!mine?.lastMcpAt];
  const firstOpen = done.indexOf(false);
  const stepState = (i: number): StepState => (done[i] ? 'done' : i === firstOpen ? 'current' : 'todo');

  const connections = useMemo(
    () => [...(d?.connections ?? [])].sort((a, b) => (lastSeen(b) ?? '').localeCompare(lastSeen(a) ?? '') || b.events7d - a.events7d),
    [d],
  );
  const needle = q.trim().toLowerCase();
  const attention = (d?.sources.attention ?? []).filter((s) => !needle || `${s.repo} ${s.projectKey ?? ''}`.toLowerCase().includes(needle));
  const onlineRunners = d?.runners.filter((r) => r.online) ?? [];
  const pendingItems = d?.pending.items ?? [];

  return (
    <div className="flex flex-col gap-3 lg:h-[calc(100dvh-var(--shell-top,196px)-var(--shell-pad-b,0px))] lg:min-h-[600px]">
      {status.error && !d && <ErrorCard message="No se pudo leer el estado del MCP." className="shrink-0" />}

      <McpDiagram data={d ?? null} refetching={status.refetching} onRefresh={status.reload} className="shrink-0" />

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[296px_minmax(0,1fr)_320px] 2xl:grid-cols-[336px_minmax(0,1fr)_360px]">
        {/* Conecta tu Claude */}
        <Section title="Conecta tu Claude" meta={<span className="label-caps tabular-nums">{d ? `${done.filter(Boolean).length} de 3` : '– de 3'}</span>} bodyClassName="px-4 py-3.5">
          <Steps>
            <Step n={1} state={stepState(0)} title="Crea un token" stateLabel={done[0] && mine ? `Hecho · ${mine.tokens}` : undefined}>
              <StepNote>Te identifica ante zeus. Uno por equipo: así revocas uno sin tumbar los demás. Se crea abajo, en Tus tokens.</StepNote>
            </Step>
            <Step n={2} state={stepState(1)} title="Instala el CLI y entra" stateLabel={mine?.lastCliAt ? `Hecho · ${ago(mine.lastCliAt, now)}` : undefined}>
              <CmdLine wrap command={CLI_INSTALL} />
              <CmdLine wrap command="zeus login --url <zeus> --token <token>" />
            </Step>
            <Step n={3} state={stepState(2)} title="Conecta Claude Code" stateLabel={mine?.lastMcpAt ? `Hecho · ${ago(mine.lastMcpAt, now)}` : undefined} last>
              <CmdLine wrap command={SETUP_COMMAND} />
              <StepNote>Conecta el MCP y el protector de secretos. Las instrucciones llegan solas a Claude: no hay skill que instalar.</StepNote>
            </Step>
          </Steps>
          <div className="mt-4 border-t pt-3.5">
            <McpTokenList me={me} />
          </div>
          <p className="mt-3 rounded-md bg-panel px-3 py-2 text-[11.5px] leading-snug text-muted-foreground">
            <span className="font-medium text-foreground">El token no abre la bóveda.</span> Las variables se descifran con la llave de tu PC (
            <code className="font-mono text-[11px] text-foreground">zeus key init</code>, en Variables).
          </p>
        </Section>

        <WorkFeed data={d ?? null} now={now} />

        {/* Quién está, qué falta y la salud */}
        <div className="flex min-h-0 flex-col gap-3">
          <Section
            title="Conectados"
            className="max-h-[38%] shrink-0 max-lg:max-h-none"
            meta={<span className="label-caps tabular-nums">{d ? `${d.activity.activeDevs24h} hoy · ${connections.length} con token` : '–'}</span>}
          >
            <ul className="divide-y">
              {connections.map((c) => {
                const seen = lastSeen(c);
                const fresh = !!seen && now - new Date(seen).getTime() < 15 * 60_000;
                return (
                  <li key={c.devId} className="flex items-center gap-2.5 px-4 py-2.5">
                    <span className="relative shrink-0">
                      <PersonAvatar name={c.name} login={c.githubLogin} email={c.email} id={c.devId} className="size-7" />
                      <OnlineDot online={fresh || c.runnerOnline} className="absolute -bottom-0.5 -right-0.5 size-2 ring-2 ring-card" />
                    </span>
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate text-[12.5px] font-semibold">
                        {c.name}
                        {c.devId === me?.devId && <span className="font-normal text-muted-foreground"> (tú)</span>}
                      </span>
                      <span className="flex min-w-0 items-center gap-2 text-[10.5px] text-faint">
                        <span className="truncate">Claude {c.lastMcpAt ? ago(c.lastMcpAt, now) : 'sin usar'}</span>
                        <span className="truncate">CLI {c.lastCliAt ? ago(c.lastCliAt, now) : 'sin usar'}</span>
                      </span>
                    </span>
                    <span className="grid shrink-0 justify-items-end">
                      <span className="text-[13px] font-semibold tabular-nums">{c.events7d}</span>
                      <span className="text-[9.5px] text-faint">7 días</span>
                    </span>
                  </li>
                );
              })}
              {Array.from({ length: Math.max(0, 3 - connections.length) }, (_, i) => <GhostRow key={i} wide={80 + i * 24} />)}
            </ul>
          </Section>

          <Section title="Pendientes del equipo" className="min-h-[150px] flex-1" bodyClassName="flex flex-col" meta={<span className="label-caps tabular-nums">{d ? pendingItems.length : '–'}</span>}>
            {pendingItems.length > 0 ? (
              <ul className="divide-y">
                {pendingItems.map((it) => {
                  const st = pendingStatus(it);
                  return (
                    <li key={`${it.kind}:${it.id}`} className="grid gap-1 px-4 py-2.5">
                      <span className="flex items-center gap-1.5">
                        <Badge variant="neutral" className="px-1.5 py-0 text-[10px]">{PENDING_KIND[it.kind]}</Badge>
                        <Badge variant={st.variant} className="px-1.5 py-0 text-[10px]">{st.label}</Badge>
                        <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-faint" title={dateTime(it.at)}>{ago(it.at, now)}</span>
                      </span>
                      <span className="truncate text-[12.5px] font-medium" title={it.title}>{it.title}</span>
                      {(it.from || it.to) && <span className="truncate text-[11px] text-muted-foreground">{it.from ?? 'zeus'} → {it.to ?? 'quien lo tome'}</span>}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <ul className="min-h-0 flex-1 divide-y divide-dashed overflow-hidden">{[132, 96, 150, 110, 88, 124].map((w, i) => <GhostRow key={i} wide={w} avatar={false} />)}</ul>
                <p className="mt-auto border-t px-4 py-2.5 text-[12px] leading-snug text-muted-foreground">
                  Nada abierto. Aquí caen los encargos, planes y solicitudes del equipo mientras nadie los cierre.
                </p>
              </div>
            )}
          </Section>

          <Section
            title="Salud"
            className="max-h-[34%] shrink-0 max-lg:max-h-none"
            meta={<span className="label-caps tabular-nums">{d ? `${d.sources.docs} docs · ${d.sources.withDocs}/${d.sources.total} repos` : '–'}</span>}
          >
            <div className="grid grid-cols-3 gap-px border-b bg-border">
              {[
                { v: d?.sources.errored, l: 'Repos con error', warn: !!d?.sources.errored },
                { v: d?.sources.pending, l: 'Por leer', warn: false },
                { v: d ? `${onlineRunners.length}/${d.runners.length}` : undefined, l: 'Runners', warn: false },
              ].map((x) => (
                <div key={x.l} className="grid gap-1 bg-card px-3 py-2.5">
                  <span className={cn('text-[20px] font-semibold leading-none tracking-[-0.04em] tabular-nums', x.warn && 'text-red')}>{x.v ?? '–'}</span>
                  <span className="label-caps truncate text-[9.5px]">{x.l}</span>
                </div>
              ))}
            </div>
            {d && d.sources.attention.length > 4 && (
              <div className="px-4 pt-2.5">
                <Input
                  fieldSize="sm"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Buscar repo…"
                  aria-label="Buscar repo"
                  leading={<Search />}
                  trailing={
                    q ? (
                      <button type="button" onClick={() => setQ('')} aria-label="Limpiar" className="grid size-6 place-items-center text-faint hover:text-foreground">
                        <X className="size-3.5" />
                      </button>
                    ) : undefined
                  }
                />
              </div>
            )}
            <ul className="divide-y">
              {attention.map((s) => (
                <li key={s.repo} className="flex items-center gap-2.5 px-4 py-2">
                  <span className={cn('size-2 shrink-0 rounded-full', s.lastError ? 'bg-red' : 'bg-yellow')} />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate font-mono text-[12px] font-medium">{s.repo.replace(/^[^/]+\//, '')}</span>
                    <span className="truncate text-[10.5px] text-faint" title={s.lastError ?? undefined}>
                      {s.lastError ? 'No se pudo leer' : 'En cola para leer'}
                      {s.lastSyncedAt ? ` · leído ${ago(s.lastSyncedAt, now)}` : ''}
                    </span>
                  </span>
                  <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs text-muted-foreground" disabled={act.busy(`sync:${s.repo}`)} onClick={() => sync(s.repo)}>
                    {act.busy(`sync:${s.repo}`) && <Loader2 className="animate-spin" />}
                    Releer
                  </Button>
                </li>
              ))}
              {d && d.sources.attention.length === 0 && <li className="px-4 py-2.5 text-[12px] text-muted-foreground">Todos los repos se leen bien.</li>}
              {onlineRunners.map((r) => (
                <li key={r.id} className="flex items-center gap-2.5 px-4 py-2 text-[12px]">
                  <OnlineDot online />
                  <span className="truncate">
                    <span className="font-medium">{r.devName}</span> <span className="text-muted-foreground">· runner {r.name}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
