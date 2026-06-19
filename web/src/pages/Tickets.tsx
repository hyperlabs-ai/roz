import { useMemo, useState } from 'react';
import { Ticket as TicketIcon, CircleAlert, UserX, ExternalLink, ListFilter } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { MetricCard } from '@/components/MetricCard';
import { RankBars } from '@/components/charts';
import { UserAvatar, EmptyState } from '@/components/bits';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useApi } from '@/lib/useApi';
import { apiGet, type TicketsResponse, type TicketFilterOptions, type Ticket } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const ALL = '__all__';

const PRIO: Record<string, { label: string; cls: string }> = {
  urgent: { label: 'Urgente', cls: 'bg-destructive' },
  high: { label: 'Alta', cls: 'bg-warning' },
  medium: { label: 'Media', cls: 'bg-chart-1' },
  low: { label: 'Baja', cls: 'bg-muted-foreground' },
};

function stateVariant(state: string): 'success' | 'default' | 'secondary' {
  if (['completed', 'done'].includes(state)) return 'success';
  if (['started', 'in_progress'].includes(state)) return 'default';
  return 'secondary';
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
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard label={scope === 'open' ? 'Tickets abiertos' : 'Tickets totales'} value={data.total} icon={TicketIcon} />
            <MetricCard label="Vencidos" value={data.overdue} icon={CircleAlert} />
            <MetricCard label="Sin asignar" value={data.unassigned} icon={UserX} />
            <MetricCard label="Estados activos" value={data.byState.length} icon={ListFilter} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader><CardTitle>Por estado</CardTitle></CardHeader>
              <CardContent><RankBars data={data.byState} height={150} /></CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Por prioridad</CardTitle></CardHeader>
              <CardContent><RankBars data={data.byPriority} color="hsl(var(--chart-5))" height={150} /></CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Por responsable</CardTitle></CardHeader>
              <CardContent><RankBars data={data.byAssignee} color="hsl(var(--chart-3))" height={150} /></CardContent>
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

      {/* Tabla */}
      <Card className="mt-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead>Ticket</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Proyecto</TableHead>
              <TableHead>Responsable</TableHead>
              <TableHead>Vence</TableHead>
              <TableHead className="w-8"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && Array.from({ length: 8 }).map((_, i) => (
              <TableRow key={i}><TableCell colSpan={7}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
            ))}
            {!loading && data?.tickets.map((t) => <TicketRow key={t.id} t={t} />)}
          </TableBody>
        </Table>
        {!loading && !data?.tickets.length && <EmptyState icon={<TicketIcon className="size-6" />}>No hay tickets con estos filtros</EmptyState>}
      </Card>
    </Layout>
  );
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
