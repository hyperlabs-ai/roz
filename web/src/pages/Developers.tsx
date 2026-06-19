import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ChevronRight, GitCommitHorizontal, Code2, CircleCheck, CircleDot, FolderGit2 } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { UserAvatar, EmptyState, SkillChip } from '@/components/bits';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/useApi';
import { apiGet, type DeveloperListItem } from '@/lib/api';
import { compact } from '@/lib/format';
import { defaultPeriod } from '@/lib/period';
import { cn } from '@/lib/utils';

export default function Developers() {
  const [period, setPeriod] = useState(defaultPeriod());
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const { data, loading, error } = useApi<{ developers: DeveloperListItem[] }>(
    () => apiGet('/developers', period.range),
    [period.range.from, period.range.to],
  );

  const rows = useMemo(
    () => (data?.developers ?? []).filter((d) => d.name.toLowerCase().includes(q.toLowerCase()) || (d.githubLogin ?? '').toLowerCase().includes(q.toLowerCase())),
    [data, q],
  );

  return (
    <Layout title="Developers" subtitle="Quién contribuye y en qué" actions={<PeriodPicker value={period} onChange={setPeriod} />}>
      <div className="mb-4">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar developer…" className="pl-8" />
        </div>
      </div>

      {error && <Card className="p-4 text-sm text-destructive">{error}</Card>}

      <div className="space-y-3">
        {loading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        {!loading && rows.map((d) => <DevRow key={d.id} d={d} onClick={() => nav(`/developers/${d.id}`)} />)}
      </div>

      {!loading && !rows.length && <Card className="mt-2"><EmptyState>No hay developers que coincidan</EmptyState></Card>}
    </Layout>
  );
}

function DevRow({ d, onClick }: { d: DeveloperListItem; onClick: () => void }) {
  return (
    <Card className="group flex cursor-pointer flex-col gap-4 p-4 transition-shadow hover:shadow-md lg:flex-row lg:items-center" onClick={onClick}>
      {/* Identidad (izquierda) */}
      <div className="flex items-center gap-3 lg:w-56 lg:shrink-0">
        <UserAvatar url={d.avatarUrl} name={d.name} className="size-11 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{d.name}</div>
          {d.githubLogin && <div className="truncate text-xs text-muted-foreground">@{d.githubLogin}</div>}
        </div>
      </div>

      {/* Contribuciones destacadas (centro) */}
      <div className="grid grid-cols-3 gap-2 lg:w-80 lg:shrink-0 xl:gap-3">
        <BigStat icon={<GitCommitHorizontal className="size-3.5" />} label="Commits" value={String(d.commits)} accent />
        <BigStat icon={<Code2 className="size-3.5" />} label="Líneas" value={compact(d.linesChanged)} />
        <BigStat icon={<CircleCheck className="size-3.5" />} label="Resueltos" value={String(d.ticketsResolved)} />
      </div>

      {/* Skills + secundarios (derecha, ocupa el resto) */}
      <div className="min-w-0 flex-1">
        {d.topSkills.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {d.topSkills.slice(0, 5).map((s) => <SkillChip key={s.tag} tag={s.tag} level={s.level} />)}
          </div>
        )}
        <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1"><CircleDot className="size-3.5" /> {d.openTickets} abiertos</span>
          <span className="inline-flex items-center gap-1"><FolderGit2 className="size-3.5" /> {d.projects} proyectos</span>
        </div>
      </div>

      <ChevronRight className="hidden size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 lg:block" />
    </Card>
  );
}

function BigStat({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent?: boolean }) {
  return (
    <div className={cn('rounded-lg border p-2 text-center', accent ? 'border-primary/20 bg-primary/5' : 'bg-muted/40')}>
      <div className="flex items-center justify-center gap-1 text-muted-foreground">{icon}</div>
      <div className={cn('mt-0.5 text-xl font-bold tabular-nums leading-none', accent && 'text-primary')}>{value}</div>
      <div className="mt-1 text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}
