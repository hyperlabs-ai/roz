import { useMemo, useState } from 'react';
import { Ticket as TicketIcon, CircleAlert, UserX, ExternalLink, CircleDot, CircleCheck, GitPullRequest, GitCommit, GitMerge } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { MetricCard } from '@/components/MetricCard';
import { RankBars, Donut } from '@/components/charts';
import { UserAvatar, EmptyState } from '@/components/bits';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useApi } from '@/lib/useApi';
import { apiGet, type TicketsResponse, type TicketFilterOptions, type Ticket, type TicketPerson } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const ALL = '__all__';

const PRIO: Record<string, { label: string; cls: string }> = {
  urgent: { label: 'Urgente', cls: 'bg-destructive' },
  high: { label: 'Alta', cls: 'bg-warning' },
  medium: { label: 'Media', cls: 'bg-chart-1' },
  low: { label: 'Baja', cls: 'bg-muted-foreground' },
};

// Colores de la dona de prioridad (semánticos) + etiqueta en español.
const PRIO_COLOR: Record<string, string> = {
  urgent: 'hsl(var(--destructive))', high: 'hsl(var(--warning))', medium: 'hsl(var(--chart-1))', low: 'hsl(var(--muted-foreground))',
};
const PRIO_ES: Record<string, string> = { urgent: 'Urgente', high: 'Alta', medium: 'Media', low: 'Baja', 'sin prioridad': 'Sin prioridad' };

// Color de barra por estado: verde si terminado, azul si en curso, gris si pendiente.
function STATE_COLOR(label: string): string {
  const l = label.toLowerCase();
  if (/(done|complet|hecho|cerrad)/.test(l)) return 'hsl(var(--success))';
  if (/(progress|curso|review|revis|sprint)/.test(l)) return 'hsl(var(--chart-1))';
  return 'hsl(var(--muted-foreground))';
}

function stateVariant(state: string): 'success' | 'default' | 'secondary' {
  if (['completed', 'done'].includes(state)) return 'success';
  if (['started', 'in_progress'].includes(state)) return 'default';
  return 'secondary';
}

// Origen del ticket: cómo nació el trabajo (migración 0011).
const SOURCE_LABEL: Record<string, string> = { pr: 'Pull Request', commit: 'Commit', linear: 'Linear' };
const SOURCE_COLOR: Record<string, string> = {
  pr: 'hsl(var(--chart-1))', commit: 'hsl(var(--chart-4))', linear: 'hsl(var(--muted-foreground))',
};

// Anillo del avatar según el veredicto de review.
function reviewRing(state: string | null | undefined): string {
  if (state === 'approved') return 'ring-success';
  if (state === 'changes_requested') return 'ring-warning';
  return 'ring-border';
}

/** Avatares apilados de revisores, con tooltip de nombre + veredicto. */
function ReviewerStack({ reviewers }: { reviewers: TicketPerson[] }) {
  if (!reviewers.length) return null;
  return (
    <div className="flex -space-x-1.5">
      {reviewers.slice(0, 4).map((r, i) => (
        <UserAvatar
          key={r.login ?? r.name ?? i}
          url={r.avatarUrl}
          name={r.name}
          className={cn('size-5 ring-2', reviewRing(r.reviewState))}
          title={`${r.name}${r.reviewState ? ` · ${r.reviewState}` : ''}`}
        />
      ))}
      {reviewers.length > 4 && <span className="pl-2.5 text-xs text-muted-foreground">+{reviewers.length - 4}</span>}
    </div>
  );
}

/** Celda "Código": link al PR (o commit/Linear) + revisores. El diferenciador vs. Linear. */
function CodeCell({ t }: { t: Ticket }) {
  return (
    <div className="flex items-center gap-2">
      {t.pr ? (
        <a
          href={t.pr.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 font-mono text-xs text-chart-1 hover:underline"
          title={`${t.pr.repo} · PR #${t.pr.number}`}
        >
          <GitPullRequest className="size-3.5" /> #{t.pr.number}
        </a>
      ) : t.source === 'commit' ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><GitCommit className="size-3.5" /> commit</span>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      )}
      <ReviewerStack reviewers={t.reviewers} />
    </div>
  );
}

export default function Tickets() {
  const [projectId, setProjectId] = useState(ALL);
  const [state, setState] = useState(ALL);
  const [assignee, setAssignee] = useState(ALL);
  const [priority, setPriority] = useState(ALL);
  const [scope, setScope] = useState<'open' | 'all'>('open');

  const filters = useApi<TicketFilterOptions>(() => apiGet('/tickets/filters'), []);
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (projectId !== ALL) p.set('projectId', projectId);
    if (state !== ALL) p.set('state', state);
    if (assignee !== ALL) p.set('assignee', assignee);
    if (priority !== ALL) p.set('priority', priority);
    p.set('scope', scope);
    return p.toString();
  }, [projectId, state, assignee, priority, scope]);

  const { data, loading, error } = useApi<TicketsResponse>(() => apiGet(`/tickets?${qs}`), [qs]);

  return (
    <Layout
      title="Tickets"
      subtitle="El trabajo del equipo en Linear"
      actions={
        <Select value={scope} onValueChange={(v) => setScope(v as 'open' | 'all')}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Abiertos</SelectItem>
            <SelectItem value="all">Todos</SelectItem>
          </SelectContent>
        </Select>
      }
    >
      {error && <Card><CardContent className="py-4 text-sm text-destructive">{error}</CardContent></Card>}

      {/* KPIs */}
      {loading || !data ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <MetricCard label="Total" value={data.summary.total} icon={TicketIcon} colorVar="--chart-1" className="col-span-2 lg:col-span-1" />
            <MetricCard label="En curso" value={data.summary.inProgress} icon={CircleDot} colorVar="--chart-2" />
            <MetricCard label="Completados" value={data.summary.completed} icon={CircleCheck} colorVar="--chart-3" />
            <MetricCard label="Vencidos" value={data.summary.overdue} icon={CircleAlert} colorVar="--destructive" />
            <MetricCard label="Sin asignar" value={data.summary.unassigned} icon={UserX} colorVar="--chart-5" />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
            <Card className="min-w-0">
              <CardHeader><CardTitle>Por proyecto</CardTitle></CardHeader>
              <CardContent><RankBars data={data.byProject} height={180} /></CardContent>
            </Card>
            <Card className="min-w-0">
              <CardHeader><CardTitle>Por estado</CardTitle></CardHeader>
              <CardContent><RankBars data={data.byState.map((s) => ({ ...s, color: STATE_COLOR(s.label) }))} height={180} /></CardContent>
            </Card>
            <Card className="min-w-0">
              <CardHeader><CardTitle>Por prioridad</CardTitle></CardHeader>
              <CardContent>
                <Donut data={data.byPriority.map((p) => ({ label: PRIO_ES[p.label] ?? p.label, value: p.value, color: PRIO_COLOR[p.label] ?? 'hsl(var(--muted-foreground))' }))} height={210} />
              </CardContent>
            </Card>
            <Card className="min-w-0">
              <CardHeader><CardTitle>Por origen</CardTitle></CardHeader>
              <CardContent>
                <Donut data={data.bySource.map((s) => ({ label: SOURCE_LABEL[s.label] ?? s.label, value: s.value, color: SOURCE_COLOR[s.label] ?? 'hsl(var(--muted-foreground))' }))} height={210} />
              </CardContent>
            </Card>
          </div>

          {/* Insight de atribución: lo que Linear no muestra. Solo si hay señal. */}
          {(data.attributionMismatch > 0 || data.withoutPr > 0) && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {data.attributionMismatch > 0 && (
                <Card className="border-warning/40">
                  <CardContent className="flex items-center gap-3 py-4">
                    <GitMerge className="size-5 shrink-0 text-warning" />
                    <p className="text-sm">
                      <span className="font-semibold">{data.attributionMismatch}</span> ticket{data.attributionMismatch === 1 ? '' : 's'} mergeado{data.attributionMismatch === 1 ? '' : 's'} por alguien <span className="font-medium">distinto al autor</span>.
                    </p>
                  </CardContent>
                </Card>
              )}
              {data.withoutPr > 0 && (
                <Card>
                  <CardContent className="flex items-center gap-3 py-4">
                    <GitPullRequest className="size-5 shrink-0 text-muted-foreground" />
                    <p className="text-sm">
                      <span className="font-semibold">{data.withoutPr}</span> ticket{data.withoutPr === 1 ? '' : 's'} cerrado{data.withoutPr === 1 ? '' : 's'} <span className="font-medium">sin PR vinculado</span>.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* Personas: responsables vs. revisores (atribución por PR) */}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Developers involucrados</CardTitle></CardHeader>
              <CardContent>
                {data.developers.length ? (
                  <div className="flex flex-wrap gap-2">
                    {data.developers.map((d) => (
                      <div key={d.name} className="flex items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-3">
                        <UserAvatar url={d.avatarUrl} name={d.name} className="size-6" />
                        <span className="text-sm">{d.name}</span>
                        <Badge variant="secondary">{d.count}</Badge>
                      </div>
                    ))}
                  </div>
                ) : <EmptyState>Sin responsables asignados</EmptyState>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Top revisores</CardTitle></CardHeader>
              <CardContent>
                {data.topReviewers.length ? (
                  <div className="flex flex-wrap gap-2">
                    {data.topReviewers.map((r) => (
                      <div key={r.name} className="flex items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-3">
                        <UserAvatar url={r.avatarUrl} name={r.name} className="size-6" />
                        <span className="text-sm">{r.name}</span>
                        <Badge variant="secondary">{r.count}</Badge>
                      </div>
                    ))}
                  </div>
                ) : <EmptyState>Aún sin reviews registradas</EmptyState>}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {/* Filtros */}
      <div className="mt-4 flex flex-wrap gap-2">
        <FilterSelect value={projectId} onChange={setProjectId} placeholder="Proyecto" options={(filters.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} />
        <FilterSelect value={state} onChange={setState} placeholder="Estado" options={(filters.data?.states ?? []).map((s) => ({ value: s.value, label: s.label }))} />
        <FilterSelect value={assignee} onChange={setAssignee} placeholder="Responsable" options={(filters.data?.devs ?? []).map((d) => ({ value: d.id, label: d.name }))} />
        <FilterSelect value={priority} onChange={setPriority} placeholder="Prioridad" options={[
          { value: 'urgent', label: 'Urgente' }, { value: 'high', label: 'Alta' }, { value: 'medium', label: 'Media' }, { value: 'low', label: 'Baja' },
        ]} />
      </div>

      {/* Desktop: tabla */}
      <Card className="mt-3 hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead>Ticket</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Proyecto</TableHead>
              <TableHead>Responsable</TableHead>
              <TableHead>Código</TableHead>
              <TableHead>Vence</TableHead>
              <TableHead className="w-8"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && Array.from({ length: 8 }).map((_, i) => (
              <TableRow key={i}><TableCell colSpan={8}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
            ))}
            {!loading && data?.tickets.map((t) => <TicketRow key={t.id} t={t} />)}
          </TableBody>
        </Table>
        {!loading && !data?.tickets.length && <EmptyState icon={<TicketIcon className="size-6" />}>No hay tickets con estos filtros</EmptyState>}
      </Card>

      {/* Móvil: tarjetas */}
      <div className="mt-3 space-y-2 md:hidden">
        {loading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
        {!loading && data?.tickets.map((t) => <TicketCardMobile key={t.id} t={t} />)}
        {!loading && !data?.tickets.length && <Card><EmptyState icon={<TicketIcon className="size-6" />}>No hay tickets con estos filtros</EmptyState></Card>}
      </div>
    </Layout>
  );
}

function TicketCardMobile({ t }: { t: Ticket }) {
  const prio = t.priority ? PRIO[t.priority] : null;
  const inner = (
    <Card className="p-3">
      <div className="flex items-start gap-2">
        <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', prio?.cls ?? 'bg-muted')} title={prio?.label ?? 'sin prioridad'} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-muted-foreground">{t.identifier}</span>
            <Badge variant={stateVariant(t.state)}>{t.stateName}</Badge>
          </div>
          <div className="mt-1 text-sm leading-snug">{t.title}</div>
          <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
            {t.projectName && <span className="truncate">{t.projectName}</span>}
            {t.assignee && (
              <span className="flex items-center gap-1">
                <UserAvatar url={t.assignee.avatarUrl} name={t.assignee.name} className="size-4" /> {t.assignee.name}
              </span>
            )}
            {t.dueDate && <span className={cn('ml-auto shrink-0', t.overdue && 'font-medium text-destructive')}>{shortDate(t.dueDate)}</span>}
          </div>
          {(t.pr || t.source === 'commit' || t.reviewers.length > 0) && (
            <div className="mt-2"><CodeCell t={t} /></div>
          )}
        </div>
      </div>
    </Card>
  );
  // Wrapper como div clickeable (no <a>) para no anidar anclas: CodeCell ya enlaza al PR.
  return t.url && t.url !== '#'
    ? <div role="link" tabIndex={0} className="block cursor-pointer" onClick={() => window.open(t.url!, '_blank', 'noopener')}>{inner}</div>
    : inner;
}

function TicketRow({ t }: { t: Ticket }) {
  const prio = t.priority ? PRIO[t.priority] : null;
  return (
    <TableRow>
      <TableCell>
        <span className={cn('block size-2 rounded-full', prio?.cls ?? 'bg-muted')} title={prio?.label ?? 'sin prioridad'} />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{t.identifier}</span>
          <span className="max-w-[28ch] truncate text-sm md:max-w-[44ch]">{t.title}</span>
          {t.labels.slice(0, 2).map((l) => <Badge key={l} variant="secondary" className="hidden lg:inline-flex">{l}</Badge>)}
        </div>
      </TableCell>
      <TableCell><Badge variant={stateVariant(t.state)}>{t.stateName}</Badge></TableCell>
      <TableCell className="text-sm text-muted-foreground">{t.projectName ?? '—'}</TableCell>
      <TableCell>
        {t.assignee ? (
          <div className="flex items-center gap-2">
            <UserAvatar url={t.assignee.avatarUrl} name={t.assignee.name} className="size-6" />
            <span className="hidden text-sm sm:inline">{t.assignee.name}</span>
          </div>
        ) : <span className="text-xs text-muted-foreground">Sin asignar</span>}
      </TableCell>
      <TableCell><CodeCell t={t} /></TableCell>
      <TableCell>
        {t.dueDate ? (
          <span className={cn('text-xs', t.overdue ? 'font-medium text-destructive' : 'text-muted-foreground')}>{shortDate(t.dueDate)}</span>
        ) : <span className="text-xs text-muted-foreground">—</span>}
      </TableCell>
      <TableCell>
        {t.url && t.url !== '#' && (
          <a href={t.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground"><ExternalLink className="size-4" /></a>
        )}
      </TableCell>
    </TableRow>
  );
}

function FilterSelect({ value, onChange, placeholder, options }: { value: string; onChange: (v: string) => void; placeholder: string; options: { value: string; label: string }[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-auto min-w-36"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{placeholder}: todos</SelectItem>
        {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
