import { useMemo, useState } from 'react';
import { Ticket as TicketIcon, CircleAlert, UserX, CircleDot, CircleCheck, GitPullRequest, GitMerge } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { MetricCard } from '@/components/MetricCard';
import { RankBars, Donut } from '@/components/charts';
import { UserAvatar, EmptyState } from '@/components/bits';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useApi } from '@/lib/useApi';
import { apiGet, type TicketsResponse, type TicketFilterOptions } from '@/lib/api';

const ALL = '__all__';

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

// Origen del ticket: cómo nació el trabajo (migración 0011).
const SOURCE_LABEL: Record<string, string> = { pr: 'Pull Request', commit: 'Commit', linear: 'Linear' };
const SOURCE_COLOR: Record<string, string> = {
  pr: 'hsl(var(--chart-1))', commit: 'hsl(var(--chart-4))', linear: 'hsl(var(--muted-foreground))',
};

/**
 * Reportes: capa de análisis sobre el trabajo del equipo (mismo `work_item` que Tareas).
 * La gestión (lista/edición) vive en Tareas; aquí solo métricas, distribución y atribución.
 * Los filtros acotan el reporte (afectan KPIs y gráficas vía el querystring del fetch).
 */
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
      title="Reportes"
      subtitle="Análisis y atribución del trabajo del equipo"
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

      {/* Filtros: acotan el reporte */}
      <div className="mb-4 flex flex-wrap gap-2">
        <FilterSelect value={projectId} onChange={setProjectId} placeholder="Proyecto" options={(filters.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} />
        <FilterSelect value={state} onChange={setState} placeholder="Estado" options={(filters.data?.states ?? []).map((s) => ({ value: s.value, label: s.label }))} />
        <FilterSelect value={assignee} onChange={setAssignee} placeholder="Responsable" options={(filters.data?.devs ?? []).map((d) => ({ value: d.id, label: d.name }))} />
        <FilterSelect value={priority} onChange={setPriority} placeholder="Prioridad" options={[
          { value: 'urgent', label: 'Urgente' }, { value: 'high', label: 'Alta' }, { value: 'medium', label: 'Media' }, { value: 'low', label: 'Baja' },
        ]} />
      </div>

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
    </Layout>
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
