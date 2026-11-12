import { useEffect, useState } from 'react';
import { Cpu, KeyRound, Loader2, Plus, ShieldOff, TriangleAlert } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EmptyState } from '@/components/bits';
import { CopyButton } from '@/components/plans/PlanActionDialog';
import { useApi } from '@/lib/useApi';
import { useAction } from '@/lib/useAction';
import { invalidate } from '@/lib/store';
import { DEFAULT_RUNNER_SCHEDULE, rozV2Api, type RunnerSchedule, type RunnerSummary, type RunnersResponse } from '@/lib/api';
import { relative } from '@/lib/format';
import { cn } from '@/lib/utils';

const DAY_SHORT = ['', 'L', 'M', 'X', 'J', 'V', 'S', 'D'];

export function scheduleText(s: RunnerSchedule): string {
  const days = [...s.days].sort((a, b) => a - b);
  const span = days.join(',') === '1,2,3,4,5' ? 'L–V' : days.join(',') === '1,2,3,4,5,6,7' ? 'Todos los días' : days.map((d) => DAY_SHORT[d]).join(' ');
  return `${span} · ${s.start}–${s.end}`;
}

/**
 * Configuración → roz-runner: el token con el que la PC de cada dev toma planes de su cola. El token
 * se ve UNA vez (roz guarda solo su hash); revocarlo corta ese equipo de inmediato.
 */
export function RunnersCard() {
  const { data, loading, error, reload } = useApi<RunnersResponse>(() => rozV2Api.runners(), [], { key: '/runners', ttl: 30_000 });
  const action = useAction();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<RunnerSummary | null>(null);

  const runners = (data?.runners ?? []).slice().sort((a, b) => Number(!!a.revokedAt) - Number(!!b.revokedAt) || b.createdAt.localeCompare(a.createdAt));

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2"><Cpu className="size-4" /> roz-runner en tus equipos</CardTitle>
          <CardDescription className="mt-1.5">
            El runner corre en tu PC: toma los planes de tu cola, los planea e implementa con Claude Code en un worktree aparte y
            abre la PR. Nada corre en la nube.
          </CardDescription>
        </div>
        <Button size="sm" className="shrink-0" onClick={() => setCreating(true)}><Plus /> Nuevo token</Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading && !data ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : error ? (
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>No se pudieron cargar tus runners.</span>
            <Button variant="secondary" size="sm" onClick={reload}>Reintentar</Button>
          </div>
        ) : !runners.length ? (
          <div className="rounded-lg border">
            <EmptyState icon={<KeyRound />}>Aún no conectas ningún equipo. Crea un token y pégalo en roz-runner.</EmptyState>
          </div>
        ) : (
          runners.map((r) => (
            <div key={r.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card p-3', r.revokedAt && 'opacity-60')}>
              <span
                className={cn('size-2 shrink-0 rounded-full', r.revokedAt ? 'bg-toggle-off' : r.online ? 'bg-green' : 'bg-toggle-off')}
                title={r.revokedAt ? 'Revocado' : r.online ? 'En línea' : 'Fuera de línea'}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span className="truncate">{r.name}</span>
                  <code className="shrink-0 rounded-sm bg-panel px-1.5 font-mono text-[11px] text-faint">{r.tokenPrefix}…</code>
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {r.revokedAt
                    ? `Revocado ${relative(r.revokedAt)}`
                    : [
                        r.lastSeenAt ? `visto ${relative(r.lastSeenAt)}` : 'nunca se ha conectado',
                        scheduleText(r.schedule),
                        `máx. ${r.maxConcurrent} a la vez`,
                        r.running ? `${r.running} corriendo` : null,
                        r.platform,
                        r.version ? `v${r.version}` : null,
                      ].filter(Boolean).join(' · ')}
                </div>
              </div>
              {!r.revokedAt && (
                <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => setRevoking(r)}>
                  <ShieldOff /> Revocar
                </Button>
              )}
            </div>
          ))
        )}
      </CardContent>

      <CreateRunnerDialog open={creating} onOpenChange={setCreating} />

      <AlertDialog open={!!revoking} onOpenChange={(v) => !v && !action.anyBusy && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Revocar «{revoking?.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Ese equipo deja de tomar planes de inmediato. Lo que tenga corriendo regresa a la cola en el siguiente latido.
              Para volver a conectarlo necesitas un token nuevo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={action.anyBusy}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={action.anyBusy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                const r = revoking;
                if (!r) return;
                void action.run(`revoke:${r.id}`, () => rozV2Api.revokeRunner(r.id), {
                  success: 'Token revocado',
                  error: 'No se pudo revocar',
                  onDone: () => invalidate('/runners'),
                  onSettled: () => setRevoking(null),
                });
              }}
            >
              {action.anyBusy ? <><Loader2 className="animate-spin" /> Revocando…</> : 'Revocar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function CreateRunnerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const action = useAction();
  const [name, setName] = useState('');
  const [max, setMax] = useState('1');
  const [days, setDays] = useState<number[]>(DEFAULT_RUNNER_SCHEDULE.days);
  const [start, setStart] = useState(DEFAULT_RUNNER_SCHEDULE.start);
  const [end, setEnd] = useState(DEFAULT_RUNNER_SCHEDULE.end);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setMax('1');
    setDays(DEFAULT_RUNNER_SCHEDULE.days);
    setStart(DEFAULT_RUNNER_SCHEDULE.start);
    setEnd(DEFAULT_RUNNER_SCHEDULE.end);
    setToken(null);
  }, [open]);

  const maxNum = Number(max);
  const valid = name.trim().length > 0 && Number.isInteger(maxNum) && maxNum >= 1 && maxNum <= 8 && days.length > 0 && start < end;
  const busy = action.busy('create');

  function submit() {
    if (!valid) return;
    void action.run(
      'create',
      () =>
        rozV2Api.createRunner({
          name: name.trim(),
          maxConcurrent: maxNum,
          schedule: { tz: DEFAULT_RUNNER_SCHEDULE.tz, days: [...days].sort((a, b) => a - b), start, end },
        }),
      {
        success: false,
        error: 'No se pudo crear el token',
        onDone: (r) => {
          setToken(r.token);
          invalidate('/runners');
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-lg">
        {token ? (
          <>
            <DialogHeader eyebrow="Agentes · roz-runner">
              <DialogTitle>Token de «{name.trim()}»</DialogTitle>
              <DialogDescription>Cópialo ahora: roz solo guarda su huella y no podrá mostrártelo otra vez.</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 rounded-lg border bg-sidebar px-3 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-xs">{token}</code>
              <CopyButton value={token} />
            </div>
            <div className="space-y-1.5 text-sm text-muted-foreground">
              <p>En esa PC, corre <code className="rounded-sm bg-panel px-1 font-mono text-xs">roz-runner login</code> y pega:</p>
              <ul className="list-inside list-disc text-xs">
                <li>URL de roz: <code className="font-mono">{window.location.origin}</code></li>
                <li>Token: el de arriba</li>
              </ul>
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-yellow bg-yellow-soft px-3 py-2 text-xs text-yellow-ink">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 " />
              Quien tenga este token puede tomar planes de tu cola. No lo compartas; si se filtra, revócalo aquí.
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Ya lo copié</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader eyebrow="Agentes · roz-runner">
              <DialogTitle>Conectar un equipo</DialogTitle>
              <DialogDescription>Un token por PC. Puedes ajustar horario y máximo después desde el runner.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                <div className="space-y-1.5">
                  <Label htmlFor="rn-name">Nombre del equipo</Label>
                  <Input id="rn-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="laptop-ana" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rn-max">Máx. a la vez</Label>
                  <Input id="rn-max" type="number" min={1} max={8} value={max} onChange={(e) => setMax(e.target.value)} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Horario de trabajo (hora de CDMX)</Label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={days.includes(d)}
                      onClick={() => setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))}
                      className={cn(
                        'grid size-8 place-items-center rounded-full border text-xs font-medium transition-colors',
                        days.includes(d) ? 'border-orange bg-orange-soft text-orange-ink' : 'bg-card text-muted-foreground hover:bg-sidebar',
                      )}
                    >
                      {DAY_SHORT[d]}
                    </button>
                  ))}
                  <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="ml-2 h-8 w-28" aria-label="Desde" />
                  <span className="text-xs text-muted-foreground">a</span>
                  <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="h-8 w-28" aria-label="Hasta" />
                </div>
                <p className="text-xs text-muted-foreground">Fuera de horario el runner no toma planes nuevos.</p>
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
              <Button onClick={submit} disabled={!valid || busy}>{busy ? 'Creando…' : 'Crear token'}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
