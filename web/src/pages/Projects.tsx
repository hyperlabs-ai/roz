import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderGit2, ChevronRight } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { UserAvatar, EmptyState, LineDelta } from '@/components/bits';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/useApi';
import { apiGet, type ProjectListItem } from '@/lib/api';
import { compact } from '@/lib/format';
import { defaultPeriod } from '@/lib/period';

export default function Projects() {
  const [period, setPeriod] = useState(defaultPeriod());
  const nav = useNavigate();
  const { data, loading, error } = useApi<{ projects: ProjectListItem[] }>(() => apiGet('/projects', period.range), [period.range.from, period.range.to]);

  return (
    <Layout title="Proyectos" subtitle="Actividad de código por proyecto" actions={<PeriodPicker value={period} onChange={setPeriod} />}>
      {error && <Card><CardContent className="py-4 text-sm text-destructive">{error}</CardContent></Card>}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : !data?.projects.length ? (
        <Card><CardContent className="py-10"><EmptyState icon={<FolderGit2 className="size-6" />}>No hay proyectos con actividad en este período</EmptyState></CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.projects.map((p) => (
            <Card key={p.projectId} className="group cursor-pointer transition-shadow hover:shadow-md" onClick={() => nav(`/projects/${p.projectId}`)}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><FolderGit2 className="size-[18px]" /></div>
                    <div>
                      <div className="font-semibold">{p.name}</div>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <Badge variant={p.kind === 'client' ? 'default' : 'secondary'}>{p.kind === 'client' ? 'Cliente' : 'Interno'}</Badge>
                        <span className="text-xs text-muted-foreground">{p.repos.length} repo{p.repos.length !== 1 ? 's' : ''}</span>
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <Stat label="Commits" value={String(p.commits)} />
                  <Stat label="Tickets" value={String(p.ticketsResolved)} />
                  <Stat label="Líneas" value={compact(p.additions + p.deletions)} />
                </div>

                <div className="mt-3 flex items-center justify-between">
                  <LineDelta additions={p.additions} deletions={p.deletions} />
                  <div className="flex -space-x-2">
                    {p.contributors.slice(0, 4).map((c, i) => (
                      <div key={i} className="ring-2 ring-card rounded-full"><UserAvatar url={null} name={c} className="size-6" /></div>
                    ))}
                    {p.contributors.length > 4 && (
                      <div className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium ring-2 ring-card">+{p.contributors.length - 4}</div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </Layout>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 py-2">
      <div className="text-lg font-bold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}
