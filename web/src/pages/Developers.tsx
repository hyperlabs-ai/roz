import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ChevronRight } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { PeriodPicker } from '@/components/PeriodPicker';
import { UserAvatar, EmptyState } from '@/components/bits';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/lib/useApi';
import { apiGet, type DeveloperListItem } from '@/lib/api';
import { compact } from '@/lib/format';
import { defaultPeriod } from '@/lib/period';

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

      {/* Desktop: tabla */}
      <Card className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Developer</TableHead>
              <TableHead className="text-right">Commits</TableHead>
              <TableHead className="text-right">Líneas</TableHead>
              <TableHead className="text-right">Resueltos</TableHead>
              <TableHead className="text-right">Abiertos</TableHead>
              <TableHead className="text-right">Proyectos</TableHead>
              <TableHead>Skills top</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading &&
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={8}><Skeleton className="h-9 w-full" /></TableCell>
                </TableRow>
              ))}
            {!loading &&
              rows.map((d) => (
                <TableRow key={d.id} className="cursor-pointer" onClick={() => nav(`/developers/${d.id}`)}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <UserAvatar url={d.avatarUrl} name={d.name} className="size-8" />
                      <div>
                        <div className="font-medium">{d.name}</div>
                        {d.githubLogin && <div className="text-xs text-muted-foreground">@{d.githubLogin}</div>}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{d.commits}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{compact(d.linesChanged)}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.ticketsResolved}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.openTickets}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.projects}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {d.topSkills.slice(0, 3).map((s) => <Badge key={s.tag} variant="secondary">{s.tag}</Badge>)}
                    </div>
                  </TableCell>
                  <TableCell><ChevronRight className="size-4 text-muted-foreground" /></TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </Card>

      {/* Móvil: tarjetas apiladas */}
      <div className="space-y-2.5 md:hidden">
        {loading && Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}
        {!loading &&
          rows.map((d) => (
            <Card key={d.id} className="cursor-pointer p-4 active:bg-accent/50" onClick={() => nav(`/developers/${d.id}`)}>
              <div className="flex items-center gap-3">
                <UserAvatar url={d.avatarUrl} name={d.name} className="size-9" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{d.name}</div>
                  {d.githubLogin && <div className="truncate text-xs text-muted-foreground">@{d.githubLogin}</div>}
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                <MiniStat label="Commits" value={String(d.commits)} />
                <MiniStat label="Líneas" value={compact(d.linesChanged)} />
                <MiniStat label="Resueltos" value={String(d.ticketsResolved)} />
                <MiniStat label="Abiertos" value={String(d.openTickets)} />
              </div>
              {d.topSkills.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {d.topSkills.slice(0, 4).map((s) => <Badge key={s.tag} variant="secondary">{s.tag}</Badge>)}
                </div>
              )}
            </Card>
          ))}
      </div>

      {!loading && !rows.length && <Card className="mt-2"><EmptyState>No hay developers que coincidan</EmptyState></Card>}
    </Layout>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 py-1.5">
      <div className="text-sm font-bold tabular-nums">{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}
