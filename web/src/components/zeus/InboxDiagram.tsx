// Diagrama de la Bandeja: de dónde te llega el trabajo (Linear, el equipo y sus Claude, la bóveda),
// tu día en el centro y lo que tú esperas de otros. Mismo lenguaje que "Cómo trabaja tu Claude con
// zeus" (MCP) y "Cómo viaja un secreto" (Variables): tres nodos con cifras vivas y dos cables. Todo
// sale de la bandeja y de Linear; nada es ilustración salvo el dibujo.
import type { ReactNode } from 'react';
import { Bell, ChevronRight, Hourglass, Inbox, KeyRound, Mail, Reply, Send, Sun } from 'lucide-react';
import { IntegrationIcon } from '@/components/brand';
import { PersonAvatar } from '@/components/avatars';
import { RefreshButton } from '@/components/bits';
import { cn } from '@/lib/utils';
import type { ZeusLinearIssue, ZeusMessage, ZeusOrgMember, ZeusRequest } from '@/lib/zeus';
import { Pips } from './MapHud';
import { ago } from './zeus-ui';
import './vault.css';

/** Cifra en línea (a la derecha del título del nodo). */
function Stat({ value, label, accent }: { value: ReactNode; label: string; accent?: boolean }) {
  return (
    <div className="grid justify-items-end gap-0.5">
      <span className={cn('text-[20px] font-semibold leading-none tracking-[-0.04em] tabular-nums', accent && 'text-orange')}>{value}</span>
      <span className="label-caps whitespace-nowrap text-[9px]">{label}</span>
    </div>
  );
}

/**
 * Nodo compacto: título con sus cifras en la misma línea y, debajo, el detalle. Es la versión baja de
 * los nodos de MCP/Variables: aquí el diagrama es un resumen arriba de los paneles, no la pantalla.
 */
function Node({
  icon,
  title,
  role,
  core = false,
  stats,
  children,
  className,
}: {
  icon: ReactNode;
  title: ReactNode;
  role: string;
  core?: boolean;
  stats: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid min-w-0 content-start gap-2.5 rounded-lg border bg-card p-3', core && 'vault-core border-transparent', className)}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={cn('grid size-7 shrink-0 place-items-center rounded-md [&_svg]:size-3.5', core ? 'bg-orange text-white' : 'bg-panel text-foreground')}>{icon}</span>
        <span className="grid min-w-0 flex-1">
          <span className="truncate text-[13px] font-semibold leading-tight tracking-[-0.01em]">{title}</span>
          <span className={cn('label-caps truncate text-[9.5px]', core && 'text-orange')}>{role}</span>
        </span>
        <div className="flex shrink-0 items-start gap-3.5">{stats}</div>
      </div>
      {children}
    </div>
  );
}

function Wire({ label, icon }: { label: string; icon: ReactNode }) {
  return (
    <div className="flex min-w-[96px] flex-[0.45] flex-col items-center justify-center gap-2">
      <span className="label-caps inline-flex items-center gap-1 whitespace-nowrap rounded-full border bg-card px-2 py-0.5 text-[9px] text-foreground/85 [&_svg]:size-3 [&_svg]:text-orange">
        {icon}
        {label}
      </span>
      <div className="flex w-full items-center">
        <span className="vault-wire flex-1" />
        <ChevronRight className="-ml-1.5 size-4 shrink-0 text-foreground/60" />
      </div>
    </div>
  );
}

/** Una fuente: ícono, nombre, qué trae, pips y cifra. */
function Source({ icon, label, hint, n, token }: { icon: ReactNode; label: string; hint: string; n: number | null; token: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-[11.5px] leading-none">
      <span className="grid size-3.5 shrink-0 place-items-center [&_svg]:size-3.5" style={{ color: `hsl(var(${token}))` }}>{icon}</span>
      <span className="min-w-0 flex-1 truncate font-medium" data-tip={hint}>{label}</span>
      <Pips n={n ? Math.min(4, n) : 0} max={4} token={token} />
      <span className={cn('w-6 shrink-0 text-right font-mono tabular-nums', !n && 'text-faint')}>{n ?? '–'}</span>
    </div>
  );
}

const DAYS = 14;

/** Lo que te llegó por día en las últimas dos semanas (mensajes, encargos, planes y avisos). */
function Daily({ items, now }: { items: Array<{ createdAt: string }>; now: number }) {
  const today = new Date(new Date(now).toDateString()).getTime();
  const counts = Array.from({ length: DAYS }, () => 0);
  for (const it of items) {
    const d = Math.round((today - new Date(new Date(it.createdAt).toDateString()).getTime()) / 86_400_000);
    if (d >= 0 && d < DAYS) counts[DAYS - 1 - d]!++;
  }
  const max = Math.max(1, ...counts);
  return (
    <div className="grid gap-1.5">
      <div className="flex h-[26px] items-end gap-[3px]" aria-label="Lo que te llegó por día en las últimas dos semanas">
        {counts.map((n, i) => (
          <span
            key={i}
            data-tip={`${n} ${n === 1 ? 'cosa' : 'cosas'} · ${i === DAYS - 1 ? 'hoy' : `hace ${DAYS - 1 - i} d`}`}
            className={cn('flex-1 rounded-[2px]', n ? (i === DAYS - 1 ? 'bg-orange' : 'bg-foreground/45') : 'bg-toggle-off/60')}
            style={{ height: `${n ? Math.max(16, (n / max) * 100) : 8}%` }}
          />
        ))}
      </div>
      <div className="flex justify-between font-mono text-[9.5px] text-faint">
        <span>hace 2 sem</span>
        <span>hace 1 sem</span>
        <span>hoy</span>
      </div>
    </div>
  );
}

export interface InboxDiagramProps {
  loading: boolean;
  firstName: string;
  sentence: string;
  issues: ZeusLinearIssue[] | null;
  /** Encargos y planes abiertos que te mandaron + solicitudes por decidir. */
  zeusWork: number;
  unread: number;
  envs: number;
  /** Para el histograma: todo lo que te llegó (con fecha). */
  received: Array<{ createdAt: string }>;
  waiting: ZeusMessage[];
  mine: ZeusRequest[];
  people: Map<string, ZeusOrgMember>;
  refetching: boolean;
  onRefresh: () => void;
  className?: string;
}

const greeting = (h: number) => (h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches');

function longDate(d: Date): string {
  const s = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function InboxDiagram(p: InboxDiagramProps) {
  const now = Date.now();
  const today = new Date(now);
  const dash = (v: number | null | undefined): ReactNode => (p.loading || v == null ? '–' : v);
  const started = p.issues?.filter((i) => i.stateType === 'started').length ?? null;
  const backlog = p.issues?.filter((i) => i.stateType === 'backlog').length ?? null;
  const todo = p.issues ? p.issues.length - (started ?? 0) - (backlog ?? 0) : null;
  const waitingItems = [
    ...p.waiting.map((m) => ({ id: m.id, who: m.toName, devId: m.toDevId, what: m.subject ?? '(sin título)', at: m.createdAt })),
    ...p.mine.map((r) => ({ id: r.id, who: r.approverName ?? 'admin de zeus', devId: r.approverDevId, what: r.title, at: r.createdAt })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <section className={cn('zeus-stage relative overflow-hidden rounded-lg border bg-background text-foreground', p.className)} aria-label="Cómo te llega el trabajo">
      <div className="flex items-center justify-between gap-3 px-4 pt-2.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 className="label-caps text-foreground/85">Cómo te llega el trabajo</h2>
          <span className="text-[12px] text-muted-foreground">Linear, el equipo y sus Claude, y la bóveda te avisan aquí; lo que tú pides lo sigues a la derecha.</span>
        </div>
        <RefreshButton busy={p.refetching} onClick={p.onRefresh} />
      </div>

      <div className="scroll-none overflow-x-auto">
        <div className="flex min-w-[1000px] items-stretch gap-2 px-3 pb-3 pt-2.5">
          <Node
            className="flex-1 basis-[260px] lg:max-w-[350px]"
            icon={<Inbox />}
            title="Te llega"
            role="Fuentes"
            stats={
              <>
                <Stat value={dash(p.zeusWork)} label="Por responder" accent={p.zeusWork > 0} />
                <Stat value={dash(p.unread)} label="Sin leer" />
              </>
            }
          >
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <Source icon={<IntegrationIcon name="linear" size="xs" />} label="Linear" hint="tickets abiertos" n={p.issues?.length ?? null} token="--blue" />
              <Source icon={<Send />} label="Equipo" hint="encargos y planes" n={p.loading ? null : p.zeusWork} token="--purple" />
              <Source icon={<Mail />} label="Mensajes" hint="sin leer" n={p.loading ? null : p.unread} token="--yellow" />
              <Source icon={<KeyRound />} label="Variables" hint="entornos con cambios" n={p.loading ? null : p.envs} token="--green" />
            </div>
          </Node>

          <Wire label="zeus te avisa" icon={<Bell />} />

          <Node
            core
            className="flex-[1.25] basis-[320px] lg:max-w-[460px]"
            icon={<Sun />}
            title={`${greeting(today.getHours())}${p.firstName ? `, ${p.firstName}` : ''}`}
            role={longDate(today)}
            stats={
              <>
                <Stat value={dash(started)} label="En curso" accent={!!started} />
                <Stat value={dash(todo)} label="Por hacer" />
                <Stat value={dash(backlog)} label="Backlog" />
              </>
            }
          >
            <div className="grid gap-2">
              <p className="truncate text-[12px] text-muted-foreground" data-tip={p.sentence}>{p.loading ? 'Leyendo tu bandeja…' : p.sentence}</p>
              <Daily items={p.received} now={now} />
            </div>
          </Node>

          <Wire label="Tú respondes" icon={<Reply />} />

          <Node
            className="flex-1 basis-[260px] lg:max-w-[350px]"
            icon={<Hourglass />}
            title="Esperas de otros"
            role="En espera"
            stats={
              <>
                <Stat value={dash(p.waiting.length)} label="Encargos" />
                <Stat value={dash(p.mine.length)} label="Solicitudes" />
              </>
            }
          >
            {waitingItems.length ? (
              <div className="grid gap-1.5">
                {waitingItems.slice(0, 2).map((w) => {
                  const m = w.devId ? p.people.get(w.devId) : undefined;
                  return (
                    <div key={w.id} className="flex min-w-0 items-center gap-2 text-[11.5px] leading-none">
                      <PersonAvatar name={w.who} login={m?.githubLogin} email={m?.email} id={w.devId} className="size-4" />
                      <span className="w-[56px] shrink-0 truncate font-medium">{w.who.split(' ')[0]}</span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{w.what}</span>
                      <span className="shrink-0 font-mono text-[10px] text-faint">{ago(w.at, now)}</span>
                    </div>
                  );
                })}
                {waitingItems.length > 2 && <span className="text-[10.5px] text-faint">+{waitingItems.length - 2} más</span>}
              </div>
            ) : (
              <div className="grid gap-1.5" aria-hidden>
                {[88, 120].map((w, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="size-4 rounded-full border border-dashed border-toggle-off" />
                    <span className="h-2 rounded-full bg-panel" style={{ width: w }} />
                    <span className="ml-auto h-1.5 w-8 rounded-full border border-dashed border-toggle-off" />
                  </div>
                ))}
              </div>
            )}
          </Node>
        </div>
      </div>
    </section>
  );
}
