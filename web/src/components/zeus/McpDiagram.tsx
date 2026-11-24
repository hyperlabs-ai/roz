// Diagrama del MCP: tu Claude (y tu terminal) hablan con zeus usando tu token, y zeus responde con el
// contexto del equipo, la bandeja y las variables. Mismo lenguaje que "Cómo viaja un secreto" en Variables:
// tres nodos con sus cifras vivas y dos cables. Todo sale de GET /zeus/mcp; nada es ilustración salvo
// el dibujo mismo.
import type { ReactNode } from 'react';
import { BookOpen, ChevronRight, Inbox, KeyRound, Laptop, Plug, Server, Terminal } from 'lucide-react';
import { RefreshButton } from '@/components/bits';
import { cn } from '@/lib/utils';
import type { ZeusMcpStatus } from '@/lib/zeus';
import { Pips } from './MapHud';
import { OnlineDot, ago } from './zeus-ui';
import './vault.css';

// ---------------------------------------------------------------- categorías de trabajo

export type WorkArea = 'contexto' | 'bandeja' | 'variables' | 'accesos';

/** A qué parte de zeus pertenece una acción registrada en la actividad. */
export function areaOf(action: string): WorkArea {
  const a = action.toLowerCase();
  if (/^env\.|vault|secret/.test(a)) return 'variables';
  if (/^(message|task|plan|request|resolve|mark_read|inbox)/.test(a)) return 'bandeja';
  if (/^(token|key|grant|org|runner)/.test(a)) return 'accesos';
  return 'contexto';
}

export const AREA_META: Record<WorkArea, { label: string; icon: typeof BookOpen; token: string; hint: string }> = {
  contexto: { label: 'Contexto', icon: BookOpen, token: '--blue', hint: 'índice, búsqueda, documentos' },
  bandeja: { label: 'Bandeja', icon: Inbox, token: '--purple', hint: 'mensajes, encargos, planes' },
  variables: { label: 'Variables', icon: KeyRound, token: '--orange', hint: 'pull, push, entornos' },
  accesos: { label: 'Accesos', icon: Plug, token: '--green', hint: 'tokens, llaves, runners' },
};

/** Nombre corto de la herramienta o comando detrás de una acción (lo que el dev reconoce). */
const TOOL_NAME: Array<[RegExp, string]> = [
  [/^index$/, 'zeus_context_index'],
  [/^search$/, 'zeus_search'],
  [/^get$/, 'zeus_get'],
  [/^write$/, 'zeus_write'],
  [/^message$/, 'zeus_send_message'],
  [/^task$/, 'zeus_send_message · encargo'],
  [/^plan\.share$/, 'zeus_share_plan'],
  [/^request$/, 'zeus_request'],
  [/^env\.pull$/, 'zeus env pull'],
  [/^env\.push$/, 'zeus env push'],
  [/^env\.create$/, 'zeus env init'],
  [/^env\.grant$/, 'zeus env grant'],
  [/^env\.rotate$/, 'zeus env rotate'],
  [/^env\.history$/, 'zeus env history'],
];
export const toolName = (action: string): string => TOOL_NAME.find(([re]) => re.test(action))?.[1] ?? action;

// ---------------------------------------------------------------- piezas

function Stat({ value, label, accent }: { value: ReactNode; label: string; accent?: boolean }) {
  return (
    <div className="grid gap-1 bg-card px-3 py-2.5">
      <span className={cn('text-[24px] font-semibold leading-none tracking-[-0.04em] tabular-nums', accent && 'text-orange')}>{value}</span>
      <span className="label-caps truncate text-[9.5px]">{label}</span>
    </div>
  );
}

function Node({
  icon,
  title,
  role,
  note,
  core = false,
  stats,
  children,
  className,
}: {
  icon: ReactNode;
  title: ReactNode;
  role: string;
  note: ReactNode;
  core?: boolean;
  stats: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card', core && 'vault-core border-transparent', className)}>
      <div className="flex items-center gap-2.5 px-3 pb-2.5 pt-3">
        <span className={cn('grid size-8 shrink-0 place-items-center rounded-md [&_svg]:size-4', core ? 'bg-orange text-white' : 'bg-panel text-foreground')}>{icon}</span>
        <span className="grid min-w-0">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[13.5px] font-semibold leading-tight tracking-[-0.01em]">{title}</span>
          <span className={cn('label-caps truncate text-[10px]', core && 'text-orange')}>{role}</span>
        </span>
      </div>
      <div className="mx-3 flex-1 rounded-md border border-dashed border-border bg-background/60 p-2.5">{children}</div>
      <div className="flex min-w-0 items-center gap-1.5 px-3 py-2.5 text-[11.5px] leading-tight text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">{note}</div>
      <div className="grid auto-cols-fr grid-flow-col gap-px border-t bg-border">{stats}</div>
    </div>
  );
}

function Wire({ label, icon, command }: { label: string; icon: ReactNode; command: string }) {
  return (
    <div className="flex min-w-[150px] flex-1 flex-col items-center justify-center gap-2.5">
      <span className="label-caps inline-flex items-center gap-1 whitespace-nowrap rounded-full border bg-card px-2 py-1 text-[9.5px] text-foreground/85 [&_svg]:size-3 [&_svg]:text-orange">
        {icon}
        {label}
      </span>
      <div className="flex w-full items-center">
        <span className="vault-wire flex-1" />
        <ChevronRight className="-ml-1.5 size-4 shrink-0 text-foreground/60" />
      </div>
      <code className="whitespace-nowrap font-mono text-[10.5px] text-faint">{command}</code>
    </div>
  );
}

/** Lo que más pidieron los Claude y las terminales del equipo en la semana. */
function TopTools({ actions }: { actions: Array<{ action: string; count: number }> }) {
  const rows = actions.slice(0, 3);
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (!rows.length) {
    return (
      <div className="grid gap-1.5" aria-hidden>
        {[72, 96, 60].map((w, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="h-2 rounded-full bg-panel" style={{ width: w }} />
            <span className="ml-auto h-1.5 w-10 rounded-full border border-dashed border-toggle-off" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid gap-1.5">
      {rows.map((r) => (
        <div key={r.action} className="flex min-w-0 items-center gap-2 font-mono text-[11px] leading-none">
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={r.action}>{toolName(r.action)}</span>
          <Pips n={Math.max(1, Math.round((r.count / max) * 6))} max={6} token={AREA_META[areaOf(r.action)].token} />
          <span className="w-7 shrink-0 text-right tabular-nums text-foreground">{r.count}</span>
        </div>
      ))}
    </div>
  );
}

/** Eventos por hora en las últimas 24 h: cuándo trabajan los agentes del equipo. */
function Hourly({ hours }: { hours: number[] }) {
  const max = Math.max(1, ...hours);
  return (
    <div className="grid gap-1.5">
      <div className="flex h-[44px] items-end gap-[3px]" aria-label="Eventos por hora en las últimas 24 horas">
        {hours.map((n, i) => (
          <span
            key={i}
            title={`${n} evento${n === 1 ? '' : 's'} · hace ${23 - i} h`}
            className={cn('flex-1 rounded-[2px]', n ? (i === hours.length - 1 ? 'bg-orange' : 'bg-foreground/45') : 'bg-toggle-off/60')}
            style={{ height: `${n ? Math.max(14, (n / max) * 100) : 7}%` }}
          />
        ))}
      </div>
      <div className="flex justify-between font-mono text-[9.5px] text-faint">
        <span>hace 24 h</span>
        <span>hace 12 h</span>
        <span>ahora</span>
      </div>
    </div>
  );
}

/** Cuánto se movió cada parte de zeus en la semana (de las acciones más usadas). */
function Areas({ actions }: { actions: Array<{ action: string; count: number }> }) {
  const totals = new Map<WorkArea, number>();
  for (const a of actions) totals.set(areaOf(a.action), (totals.get(areaOf(a.action)) ?? 0) + a.count);
  const max = Math.max(1, ...totals.values());
  return (
    <div className="grid gap-1.5">
      {(['contexto', 'bandeja', 'variables'] as const).map((k) => {
        const m = AREA_META[k];
        const n = totals.get(k) ?? 0;
        return (
          <div key={k} className="flex min-w-0 items-center gap-2 text-[11.5px] leading-none">
            <m.icon className="size-3.5 shrink-0" style={{ color: `hsl(var(${m.token}))` }} />
            <span className="w-[68px] shrink-0 font-medium">{m.label}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint">{m.hint}</span>
            <Pips n={n ? Math.max(1, Math.round((n / max) * 6)) : 0} max={6} token={m.token} />
            <span className={cn('w-7 shrink-0 text-right font-mono tabular-nums', !n && 'text-faint')}>{n}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- diagrama

export function McpDiagram({
  data,
  refetching,
  onRefresh,
  className,
}: {
  data: ZeusMcpStatus | null;
  refetching: boolean;
  onRefresh: () => void;
  className?: string;
}) {
  const n = (v: number | undefined): ReactNode => (data ? (v ?? 0) : '–');
  const s = data?.server;
  const act = data?.activity;
  const pending = data ? data.pending.tasks + data.pending.plans + data.pending.requests + data.pending.queuedPlans : 0;
  const runnersOn = data?.runners.filter((r) => r.online).length ?? 0;
  const lastAt = data?.recent[0]?.at ?? null;

  return (
    <section className={cn('zeus-stage relative overflow-hidden rounded-lg border bg-background text-foreground', className)} aria-label="Cómo trabaja tu Claude con zeus">
      <div className="flex items-center justify-between gap-3 px-4 pt-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 className="label-caps text-foreground/85">Cómo trabaja tu Claude con zeus</h2>
          <span className="text-[12px] text-muted-foreground">Pregunta con tu token; zeus responde con el contexto, la bandeja y las variables del equipo.</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {lastAt && <span className="hidden text-[11.5px] text-muted-foreground sm:inline">Último movimiento {ago(lastAt)}</span>}
          <RefreshButton busy={refetching} onClick={onRefresh} />
        </div>
      </div>

      <div className="scroll-none overflow-x-auto">
        <div className="flex min-w-[1100px] items-stretch gap-3 px-4 pb-4 pt-3">
          <Node
            className="flex-1 basis-[250px] lg:max-w-[340px]"
            icon={<Laptop />}
            title="Claude y terminales"
            role="Piden"
            note={<><Terminal /> Lo que más pidieron esta semana</>}
            stats={
              <>
                <Stat value={n(act?.activeDevs24h)} label="Activos hoy" />
                <Stat value={n(act?.activeDevs7d)} label="Esta semana" />
              </>
            }
          >
            <TopTools actions={act?.topActions ?? []} />
          </Node>

          <Wire label="Tu token" icon={<KeyRound />} command="zeus setup" />

          <Node
            core
            className="flex-[1.25] basis-[300px] lg:max-w-[440px]"
            icon={<Server />}
            title={<>zeus {s ? <span className="font-mono text-[11.5px] font-medium text-muted-foreground">v{s.version}</span> : null}</>}
            role="Servidor MCP"
            note={
              s ? (
                <>
                  <OnlineDot online className="size-1.5" />
                  En línea · arrancó {ago(s.startedAt)} · {s.prompts.length} atajos en Claude
                </>
              ) : (
                'Leyendo el estado…'
              )
            }
            stats={
              <>
                <Stat value={n(act?.events24h)} label="Eventos 24 h" accent={!!act?.events24h} />
                <Stat value={n(s?.tools)} label="Herramientas" />
                <Stat value={n(act?.mcp24h)} label="Por MCP hoy" />
              </>
            }
          >
            <Hourly hours={act?.hourly ?? Array.from({ length: 24 }, () => 0)} />
          </Node>

          <Wire label="Responde" icon={<Plug />} command="/mcp__zeus__pendientes" />

          <Node
            className="flex-1 basis-[250px] lg:max-w-[340px]"
            icon={<Inbox />}
            title="El equipo"
            role="Recibe"
            note={<><Inbox /> Qué parte de zeus se movió</>}
            stats={
              <>
                <Stat value={n(pending)} label="Pendientes" accent={pending > 0} />
                <Stat value={data ? `${runnersOn}/${data.runners.length}` : '–'} label="Runners en línea" />
              </>
            }
          >
            <Areas actions={act?.topActions ?? []} />
          </Node>
        </div>
      </div>
    </section>
  );
}
