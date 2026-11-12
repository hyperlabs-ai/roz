import { Link } from 'react-router-dom';
import { CircleCheck, GitCommitHorizontal, GitPullRequest, type LucideIcon } from 'lucide-react';
import { ProgressBar } from '@/components/bits';
import { GithubAvatar, ProjectIcon, tokenColor, type BrandColor } from '@/components/brand';
import { BalancedGrid } from '@/components/grid';
import { PERSON_STATE, PulseDot, Spark, personColor } from '@/components/pulse/pulse-ui';
import { PLAN_RUNNING, PLAN_STATUS_LABEL, type PersonState, type PulsePerson } from '@/lib/api';
import { compact, relative, shortDate } from '@/lib/format';
import { STATE_LABEL } from '@/lib/labels';
import { cn } from '@/lib/utils';

export { PERSON_STATE };

/** Color del texto de estado (par suave/tinta de DESIGN.md, solo la tinta). */
const STATE_INK: Record<PersonState, string> = {
  activo: 'text-green',
  ocupado: 'text-yellow-ink',
  inactivo: 'text-muted-foreground',
  fuera: 'text-faint',
};
const STATE_DOT: Record<PersonState, string> = {
  activo: 'bg-green',
  ocupado: 'bg-yellow',
  inactivo: 'bg-toggle-off',
  fuera: 'bg-toggle-off',
};
/** Píldora de estado de la cabecera: fondo suave + tinta, con su punto. */
const STATE_PILL: Record<PersonState, string> = {
  activo: 'bg-green-soft text-green',
  ocupado: 'bg-yellow-soft text-yellow-ink',
  inactivo: 'bg-panel text-muted-foreground',
  fuera: 'bg-panel text-faint',
};

/** ¿Tiene algo en las manos? (issue en curso o plan del agente). Quien no, va a la fila compacta. */
export const isWorking = (p: PulsePerson) => !!p.currentIssue || !!p.agentPlan;

/** "hace 7h" → "7h": junto a un reloj o a la palabra "visto" el "hace" sobra. */
const ago = (iso: string) => relative(iso).replace('hace ', '');

/**
 * Tarjeta de una persona con trabajo en curso. Cabecera con avatar, nombre, proyecto y la píldora
 * de estado; el bloque "ahora" con el borde de su color; la línea del agente; el ciclo con su barra
 * fina; y un pie con lo que produjo en la semana (tres cifras con etiqueta) junto a su tendencia
 * diaria.
 */
export function PersonCard({ p, spark, color }: { p: PulsePerson; spark?: number[]; color?: BrandColor }) {
  const st = PERSON_STATE[p.state];
  const c = color ?? personColor(p.devId);
  const main = p.projects[0];
  const more = p.projects.length - 1;

  return (
    <div className="hover-lift flex h-full min-w-0 flex-col gap-3.5 rounded-lg border bg-card p-4 hover:border-foreground/15">
      {/* Cabecera */}
      <div className="flex min-w-0 items-center gap-3">
        <GithubAvatar
          login={p.githubLogin}
          id={p.devId}
          url={p.avatarUrl}
          name={p.name}
          presence={st.presence}
          color={c}
          className="size-10"
        />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <Link to={`/app/developers/${p.devId}`} className="truncate text-[14.5px] font-semibold leading-tight tracking-[-0.01em] hover:underline">
            {p.name}
          </Link>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {main ? (
              <Link
                to={`/app/projects/${main.id}`}
                className="flex min-w-0 items-center gap-1.5 hover:text-foreground hover:underline"
                title={p.projects.map((x) => x.name).join(', ')}
              >
                <ProjectIcon id={main.id} size="xs" />
                <span className="truncate">{main.name}</span>
                {more > 0 && <span className="shrink-0 tabular-nums text-faint">+{more}</span>}
              </Link>
            ) : (
              <span className="text-faint">Sin proyecto</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={cn('inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium', STATE_PILL[p.state])}>
            <span className={cn('size-1.5 rounded-full', STATE_DOT[p.state])} />
            {st.label}
          </span>
          {p.lastActivityAt && (
            <span className="text-[11px] tabular-nums text-faint" title={`Última actividad: ${new Date(p.lastActivityAt).toLocaleString('es-MX')}`}>
              visto {ago(p.lastActivityAt)}
            </span>
          )}
        </div>
      </div>

      {/* Ahora: el issue en las manos */}
      {p.currentIssue && (
        <div className="grid gap-1 rounded-r-md border-l-[3px] bg-sidebar px-3 py-2.5" style={{ borderLeftColor: tokenColor(c) }}>
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-faint">
            <span className="shrink-0 font-mono">{p.currentIssue.identifier}</span>
            <span className="text-faint">·</span>
            <span className="truncate font-medium text-muted-foreground">
              {p.currentIssue.linearStateName ?? STATE_LABEL[p.currentIssue.status] ?? p.currentIssue.status}
            </span>
          </span>
          {p.currentIssue.url ? (
            <a
              href={p.currentIssue.url}
              target="_blank"
              rel="noreferrer noopener"
              className="line-clamp-2 text-[13.5px] font-semibold leading-snug hover:underline"
              title={p.currentIssue.name}
            >
              {p.currentIssue.name}
            </a>
          ) : (
            <b className="line-clamp-2 text-[13.5px] font-semibold leading-snug" title={p.currentIssue.name}>
              {p.currentIssue.name}
            </b>
          )}
        </div>
      )}

      {p.agentPlan && <AgentLine plan={p.agentPlan} />}

      {p.stateDetail && (
        <div className={cn('truncate text-xs', p.state === 'ocupado' ? 'text-yellow-ink' : 'text-muted-foreground')} title={p.stateDetail}>
          {p.stateDetail}
        </div>
      )}

      {p.cycle && (
        <div className="grid gap-1.5">
          <div
            className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
            title={`${p.cycle.name ?? `Ciclo ${p.cycle.number}`} · termina ${shortDate(p.cycle.endsAt)}`}
          >
            <span className="truncate">
              Ciclo {p.cycle.number} <span className="text-faint">· termina {shortDate(p.cycle.endsAt)}</span>
            </span>
            <span className="shrink-0 font-medium tabular-nums text-foreground">
              {p.cycle.issuesDone}/{p.cycle.issuesTotal}
            </span>
          </div>
          <ProgressBar pct={Math.round(p.cycle.progress * 100)} color={c} />
        </div>
      )}

      {/* Pie: producción de la semana + tendencia diaria */}
      <div className="mt-auto flex items-end justify-between gap-3 border-t pt-3">
        <WeekStats p={p} />
        {spark && spark.length > 1 && (
          <div className="grid shrink-0 justify-items-end gap-1" title="Actividad diaria de la semana">
            <Spark values={spark} color={c} width={72} height={24} />
            <span className="label-caps text-[9.5px]">7 días</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Commits · PRs integradas · issues cerrados de la semana: cifra grande con su etiqueta. */
export function WeekStats({ p, className }: { p: PulsePerson; className?: string }) {
  const title = [
    `${p.week.commits} commits`,
    p.week.lines ? `${compact(p.week.lines)} líneas` : null,
    `${p.week.prsOpened} PRs abiertas`,
    `${p.week.prsMerged} PRs integradas`,
    `${p.week.issuesClosed} issues cerrados`,
  ]
    .filter(Boolean)
    .join(' · ');
  const stat = (Icon: LucideIcon, n: number, label: string) => (
    <span className="grid gap-0.5">
      <span className={cn('inline-flex items-center gap-1 text-[15px] font-semibold leading-none tabular-nums tracking-[-0.02em]', n === 0 && 'font-medium text-faint')}>
        <Icon className={cn('size-3.5 shrink-0', n === 0 ? 'text-faint' : 'text-muted-foreground')} />
        {compact(n)}
      </span>
      <span className="label-caps text-[9.5px]">{label}</span>
    </span>
  );
  return (
    <span className={cn('flex min-w-0 items-end gap-4', className)} title={title}>
      {stat(GitCommitHorizontal, p.week.commits, 'Commits')}
      {stat(GitPullRequest, p.week.prsMerged, 'PRs')}
      {stat(CircleCheck, p.week.issuesClosed, 'Issues')}
    </span>
  );
}

/**
 * Personas sin nada en curso: no ocupan una tarjeta entera cada una. Van en una banda con su
 * encabezado y una rejilla balanceada de fichas compactas (avatar con presencia, nombre, estado y
 * última actividad, commits de la semana): sin huecos, sin píldoras sueltas.
 */
export function IdlePeople({ people, title = 'Sin trabajo en curso' }: { people: PulsePerson[]; title?: string }) {
  if (!people.length) return null;
  return (
    <div className="grid gap-3 rounded-lg border border-dashed bg-card/60 p-4">
      <div className="flex items-center gap-2">
        <span className="label-caps text-muted-foreground">{title}</span>
        <span className="rounded-full bg-panel px-1.5 py-px text-[10.5px] font-semibold tabular-nums text-muted-foreground">
          {people.length}
        </span>
      </div>
      <BalancedGrid max={{ base: 1, sm: 2, md: 3, xl: 5 }} className="gap-2">
        {people.map((p) => {
          const st = PERSON_STATE[p.state];
          const detail = p.stateDetail ?? (p.lastActivityAt ? `visto ${ago(p.lastActivityAt)}` : 'sin actividad');
          return (
            <Link
              key={p.devId}
              to={`/app/developers/${p.devId}`}
              title={[st.label, p.stateDetail, p.lastActivityAt ? `última actividad ${relative(p.lastActivityAt)}` : null].filter(Boolean).join(' · ')}
              className="flex h-full min-w-0 items-center gap-2.5 rounded-md bg-panel px-2.5 py-2 transition-colors hover:bg-sidebar"
            >
              <span className="relative shrink-0">
                <GithubAvatar login={p.githubLogin} id={p.devId} url={p.avatarUrl} name={p.name} className="size-8" />
                <span className={cn('absolute -bottom-px -right-px size-2.5 rounded-full ring-2 ring-panel', STATE_DOT[p.state])} />
              </span>
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-[13px] font-semibold leading-tight">{p.name.split(' ')[0]}</span>
                <span className="truncate text-[11.5px] leading-tight text-muted-foreground">
                  <span className={STATE_INK[p.state]}>{st.label}</span>
                  <span className="text-faint"> · {detail}</span>
                </span>
              </span>
              <span
                className={cn('inline-flex shrink-0 items-center gap-1 text-[12px] font-medium tabular-nums', p.week.commits ? 'text-muted-foreground' : 'text-faint')}
                title={`${p.week.commits} commits esta semana`}
              >
                <GitCommitHorizontal className="size-3.5" />
                {compact(p.week.commits)}
              </span>
            </Link>
          );
        })}
      </BalancedGrid>
    </div>
  );
}

/**
 * Línea del agente (`.agentline` del mock). Morado mientras trabaja (punto que late), amarillo
 * cuando espera a una persona, verde cuando ya entregó, gris en cola o cerrado.
 */
function AgentLine({ plan }: { plan: NonNullable<PulsePerson['agentPlan']> }) {
  const running = PLAN_RUNNING.includes(plan.status);
  const tone = running
    ? { box: 'bg-lavender text-purple-deep', dot: 'bg-purple-deep', still: false }
    : plan.status === 'esperando_aprobacion'
      ? { box: 'bg-yellow-soft text-yellow-ink', dot: 'bg-yellow', still: false }
      : plan.status === 'pr_abierto' || plan.status === 'hecho'
        ? { box: 'bg-green-soft text-green', dot: 'bg-green', still: true }
        : { box: 'bg-panel text-muted-foreground', dot: 'bg-toggle-off', still: true };
  const step = plan.progress?.step || plan.progress?.message;
  const pct = running && plan.progress?.pct != null ? `${Math.round(plan.progress.pct)}%` : null;
  const text =
    plan.status === 'esperando_aprobacion'
      ? 'Espera aprobación'
      : [PLAN_STATUS_LABEL[plan.status], step, pct].filter(Boolean).join(' · ');
  return (
    <Link
      to={`/app/plans?plan=${plan.id}`}
      className={cn('flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-opacity hover:opacity-80', tone.box)}
      title={[plan.identifier, text, plan.progress?.at ? `último avance ${relative(plan.progress.at)}` : null].filter(Boolean).join(' · ')}
    >
      <PulseDot className={tone.dot} still={tone.still} />
      <b className="shrink-0 font-mono text-[11px] font-semibold">{plan.identifier}</b>
      <span className="min-w-0 truncate">{text}</span>
    </Link>
  );
}
