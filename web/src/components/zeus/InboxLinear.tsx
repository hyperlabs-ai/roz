// Bandeja · bloque de Linear: tus tickets activos como los ve Linear (lista densa con ícono de
// estado, prioridad, identificador y proyecto). Linear es la fuente de verdad: aquí solo se lee; para
// trabajar uno se abre en Linear o se le pide a Claude («implementa HYP-123»).
import { ArrowUpRight, GitBranch } from 'lucide-react';
import { IntegrationIcon } from '@/components/brand';
import { PriorityIcon } from '@/components/tasks/properties';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { ZeusLinearBoard, ZeusLinearIssue } from '@/lib/zeus';
import { CopyButton, ago, dateTime } from './zeus-ui';

const PRIORITY_VALUE = ['none', 'urgent', 'high', 'medium', 'low'] as const;

/** El círculo de estado de Linear: vacío por hacer, a medio llenar en curso, punteado en backlog. */
export function LinearStateIcon({ type, className }: { type: ZeusLinearIssue['stateType']; className?: string }) {
  const cls = cn('size-3.5 shrink-0', className);
  if (type === 'started') {
    return (
      <svg viewBox="0 0 14 14" className={cls} aria-hidden>
        <circle cx="7" cy="7" r="6" fill="none" strokeWidth="1.5" className="stroke-yellow" />
        <path d="M7 3 A4 4 0 0 1 7 11 Z" className="fill-yellow" />
      </svg>
    );
  }
  if (type === 'completed') {
    return (
      <svg viewBox="0 0 14 14" className={cls} aria-hidden>
        <circle cx="7" cy="7" r="6.5" className="fill-blue" />
        <path d="M4.3 7.2 6.2 9 9.8 5.2" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="stroke-card" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 14 14" className={cls} aria-hidden>
      <circle
        cx="7"
        cy="7"
        r="6"
        fill="none"
        strokeWidth="1.5"
        strokeDasharray={type === 'backlog' ? '2 2' : undefined}
        className={type === 'triage' ? 'stroke-orange' : 'stroke-faint'}
      />
    </svg>
  );
}

function LinearRow({ issue }: { issue: ZeusLinearIssue }) {
  return (
    <li className="group relative">
      <a
        href={issue.url}
        target="_blank"
        rel="noreferrer"
        className="grid min-w-0 grid-cols-[16px_16px_auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-md px-2.5 py-2 transition-colors hover:bg-panel/70 focus-visible:bg-panel focus-visible:outline-none"
      >
        <PriorityIcon value={PRIORITY_VALUE[issue.priority] ?? 'none'} className="size-3.5" />
        <LinearStateIcon type={issue.stateType} />
        <span className="font-mono text-[11.5px] text-faint">{issue.identifier}</span>
        <span className="truncate text-[13px] font-medium">{issue.title}</span>
        <span className="flex shrink-0 items-center gap-2 text-[11px] text-faint group-hover:invisible group-focus-within:invisible">
          {issue.project && <span className="hidden max-w-[140px] truncate rounded-full border px-2 py-px text-muted-foreground xl:inline">{issue.project}</span>}
          <span className="tabular-nums" data-tip={dateTime(issue.updatedAt)}>{ago(issue.updatedAt)}</span>
        </span>
        {(issue.labels.length > 0 || issue.dueDate || issue.cycle) && (
          <span className="col-start-4 col-end-6 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            {issue.labels.slice(0, 3).map((l) => (
              <span key={l} className="rounded-full bg-panel px-1.5 py-px">{l}</span>
            ))}
            {issue.cycle && <span className="text-faint">{issue.cycle}</span>}
            {issue.dueDate && <span className="text-faint">Vence {issue.dueDate}</span>}
          </span>
        )}
      </a>
      {/* Acciones al pasar el cursor: van encima de la fecha para no robarle espacio al título. */}
      <span className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        {issue.branchName && (
          <CopyButton text={issue.branchName} label="Copiar rama" className="h-6 gap-1 rounded-sm bg-card px-1.5 text-[11px] text-muted-foreground shadow-sm [&_svg]:size-3" />
        )}
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          className="grid size-6 place-items-center rounded-sm bg-card text-muted-foreground shadow-sm hover:text-foreground"
          aria-label={`Abrir ${issue.identifier} en Linear`}
          data-tip="Abrir en Linear"
        >
          <ArrowUpRight className="size-3.5" />
        </a>
      </span>
    </li>
  );
}

function Group({ type, label, issues }: { type: ZeusLinearIssue['stateType']; label: string; issues: ZeusLinearIssue[] }) {
  if (!issues.length) return null;
  return (
    <div className="grid gap-0.5">
      <h4 className="flex items-center gap-2 rounded-md bg-panel/60 px-2.5 py-1.5 text-[12px] font-semibold">
        <LinearStateIcon type={type} />
        {label}
        <span className="font-normal tabular-nums text-faint">{issues.length}</span>
      </h4>
      <ul className="grid">{issues.map((i) => <LinearRow key={i.id} issue={i} />)}</ul>
    </div>
  );
}

const NOTICE: Record<Exclude<ZeusLinearBoard['status'], 'ok'>, string> = {
  not_configured: 'zeus no tiene Linear conectado (falta LINEAR_API_KEY en el servidor).',
  no_user: 'Tu correo del equipo no coincide con ningún usuario de Linear: pide que te inviten con ese correo.',
  error: 'Linear no respondió.',
};

/** Bloque completo: encabezado con el logo y los grupos En curso / Por hacer. */
export function LinearBlock({ board, loading, filtered }: { board: ZeusLinearBoard | null; loading: boolean; filtered: ZeusLinearIssue[] | null }) {
  const issues = filtered ?? board?.issues ?? [];
  const started = issues.filter((i) => i.stateType === 'started');
  const todo = issues.filter((i) => i.stateType === 'unstarted' || i.stateType === 'triage');
  const backlog = issues.filter((i) => i.stateType === 'backlog');
  return (
    <section className="grid gap-2">
      <header className="flex items-center gap-2.5 px-1">
        <IntegrationIcon name="linear" size="sm" framed />
        <div className="grid min-w-0 flex-1">
          <h3 className="text-[13.5px] font-semibold leading-tight">Linear</h3>
          <span className="truncate text-[11.5px] text-muted-foreground">
            {board?.status === 'ok' ? `Asignado a ${board.user ?? 'ti'} · todo lo abierto` : 'Tus tickets activos'}
          </span>
        </div>
        {board?.status === 'ok' && (
          <span className="flex items-center gap-3 text-[11.5px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><LinearStateIcon type="started" className="size-3" />{started.length}</span>
            <span className="flex items-center gap-1.5"><LinearStateIcon type="unstarted" className="size-3" />{todo.length}</span>
            <span className="flex items-center gap-1.5"><LinearStateIcon type="backlog" className="size-3" />{backlog.length}</span>
          </span>
        )}
      </header>
      {loading && !board ? (
        <div className="grid gap-1.5 px-1">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-full rounded-md" />)}
        </div>
      ) : board && board.status !== 'ok' ? (
        <p className="rounded-md bg-panel/60 px-3 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
          {NOTICE[board.status]}
          {board.status === 'error' && board.error ? <span className="block text-[11.5px] text-faint">{board.error}</span> : null}
        </p>
      ) : !issues.length ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-[12.5px] text-muted-foreground">
          {filtered ? 'Ningún ticket coincide con esa búsqueda.' : 'Sin tickets activos en Linear. Cuando te asignen uno aparece aquí.'}
        </p>
      ) : (
        <div className="grid gap-2">
          <Group type="started" label="En curso" issues={started} />
          <Group type="unstarted" label="Por hacer" issues={todo} />
          <Group type="backlog" label="Backlog" issues={backlog} />
          <p className="flex items-center gap-1.5 px-2.5 text-[11.5px] text-faint">
            <GitBranch className="size-3" /> Para implementar uno, dile a Claude «implementa {issues[0]!.identifier}»: lo trae completo por zeus.
          </p>
        </div>
      )}
    </section>
  );
}
