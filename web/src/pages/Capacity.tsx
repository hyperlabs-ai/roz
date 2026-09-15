// Capacidad — quién es cada quien, en qué está puesto, y cuánto le queda.
//
// Sustituye a la tabla que vivía en un documento. La diferencia que importa: ahí "Proyecto /
// Enfoque" era texto suelto y el "Estado de Carga" se escribía a mano, así que envejecía en cuanto
// cambiaba cualquier otra celda. Aquí los proyectos son los de roz (con su repo cuando el proyecto
// tiene varios) y la carga SALE de las asignaciones — nadie la teclea.
//
// Cada celda guarda sola y el backend responde la tabla completa recalculada: subirle el % a una
// asignación repinta el estado de esa persona en la misma respuesta, sin una segunda petición.
import { useEffect, useMemo, useState } from 'react';
import { Users, AlertTriangle, RefreshCw, Clock, UserCheck } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorCard } from '@/components/bits';
import { CAPACITY_COLUMNS, type CapacityActions } from '@/components/capacity/cells';
import { useAuth } from '@/auth/AuthContext';
import { useApi } from '@/lib/useApi';
import { apiGet, apiSend, type CapacityResponse } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

export default function Capacity() {
  const { user } = useAuth();
  const canEdit = !!user; // control total para cualquier usuario autenticado (sin roles), como Developers
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const { data, loading, refetching, error, reload } = useApi<CapacityResponse>(
    () => apiGet('/capacity'),
    [],
    { key: '/capacity', ttl: 60_000 },
  );

  // Copia local, igual que la lista de tareas: cada mutación devuelve la tabla ya recalculada y se
  // sustituye entera, sin recargar.
  const [table, setTable] = useState<CapacityResponse | null>(null);
  useEffect(() => { if (data) setTable(data); }, [data]);

  /**
   * Toda mutación devuelve la tabla entera ya recalculada, así que se sustituye el estado con la
   * respuesta en vez de recargar. Es lo que hace que cambiar un % actualice el estado de carga de
   * esa fila al instante y sin un segundo viaje.
   */
  const send = async (fn: () => Promise<CapacityResponse>, fallback: string) => {
    try {
      setTable(await fn());
    } catch (e: any) {
      // Las reglas (tope de principales, dedicación) llegan como 400 con su mensaje: se enseña el
      // del servidor, que explica QUÉ hacer, no un "no se pudo" genérico.
      toast.error(fallback, { description: String(e?.message ?? e) });
    }
  };

  const actions: CapacityActions = useMemo(() => ({
    canEdit,
    patchDev: (devId, patch) =>
      send(() => apiSend<CapacityResponse>('PATCH', `/capacity/devs/${devId}`, patch), 'No se pudo guardar'),
    addAssignment: (devId, body) =>
      send(() => apiSend<CapacityResponse>('POST', `/capacity/devs/${devId}/assignments`, body), 'No se pudo añadir'),
    patchAssignment: (id, body) =>
      send(() => apiSend<CapacityResponse>('PATCH', `/capacity/assignments/${id}`, body), 'No se pudo guardar'),
    removeAssignment: (id) =>
      send(() => apiSend<CapacityResponse>('DELETE', `/capacity/assignments/${id}`), 'No se pudo quitar'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [canEdit]);

  const devs = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (table?.devs ?? [])
      .filter((d) => showInactive || d.active)
      .filter((d) => !needle
        || d.name.toLowerCase().includes(needle)
        || (d.profile ?? '').toLowerCase().includes(needle)
        || d.principal.some((a) => (a.projectName ?? '').toLowerCase().includes(needle))
        || d.secondary.some((a) => (a.projectName ?? '').toLowerCase().includes(needle)));
  }, [table, q, showInactive]);

  const projects = table?.projects ?? [];
  const totals = table?.totals;
  const inactive = (table?.devs ?? []).filter((d) => !d.active).length;

  return (
    <Layout
      title="Capacidad"
      subtitle="Quién es cada quien, en qué está, y cuánto le queda"
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-8 text-muted-foreground"
          onClick={reload}
          disabled={refetching}
          title="Traer cambios"
          aria-label="Actualizar"
        >
          <RefreshCw className={cn('size-3.5', refetching && 'animate-spin')} />
        </Button>
      }
    >
      {error && <ErrorCard message={error} className="mb-4" />}

      {totals && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile icon={<Users className="size-4" />} label="En el equipo" value={String(totals.people)} />
          <Tile
            icon={<Clock className="size-4" />}
            label="Horas por semana"
            value={`${totals.hoursUsed} / ${totals.hours}`}
            hint={totals.hours ? `${Math.round((totals.hoursUsed / totals.hours) * 100)}% comprometido` : undefined}
          />
          <Tile
            icon={<UserCheck className="size-4" />}
            label="Con holgura"
            value={String(totals.free)}
            tone={totals.free > 0 ? 'success' : undefined}
          />
          <Tile
            icon={<AlertTriangle className="size-4" />}
            label="Saturadas"
            value={String(totals.saturated)}
            tone={totals.saturated > 0 ? 'destructive' : undefined}
          />
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar persona o proyecto…"
          className="h-8 w-56 text-xs"
        />
        {inactive > 0 && (
          <button
            type="button"
            onClick={() => setShowInactive((v) => !v)}
            className={cn(
              'flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-[13px] font-medium transition-colors',
              showInactive ? 'border-primary/20 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent',
            )}
          >
            Inactivos ({inactive})
          </button>
        )}
        {!canEdit && (
          <span className="text-xs text-muted-foreground">Solo lectura — inicia sesión para editar</span>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : !devs.length ? (
        <Card>
          <EmptyState icon={<Users className="size-6" />}>
            {q ? 'Nadie coincide con la búsqueda.' : 'Todavía no hay gente en el equipo.'}
          </EmptyState>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          {/* Scroll horizontal propio: son seis columnas anchas y comprimirlas para que quepan
              dejaría los textos de enfoque en una palabra por renglón. */}
          <div className="scroll-thin max-h-[calc(100dvh-19rem)] overflow-auto">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10">
                <tr>
                  {CAPACITY_COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      className={cn(
                        'border-b bg-muted/80 px-3 py-2 align-bottom text-[11px] font-semibold uppercase leading-tight tracking-[0.06em] text-muted-foreground backdrop-blur',
                        col.width,
                      )}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {devs.map((dev) => (
                  <tr
                    key={dev.id}
                    className={cn(
                      'align-top transition-colors hover:bg-muted/40',
                      !dev.active && 'opacity-60',
                      dev.load.overAssigned && 'bg-destructive/[0.04]',
                    )}
                  >
                    {CAPACITY_COLUMNS.map((col) => (
                      <td key={col.key} className={cn('px-3 py-2.5', col.width)}>
                        {col.render(dev, projects, actions)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Layout>
  );
}

function Tile({ icon, label, value, hint, tone }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: 'success' | 'destructive';
}) {
  return (
    <div className="rounded-xl border bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="truncate text-[11px] font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className={cn(
        'mt-1 text-xl font-semibold tabular-nums',
        tone === 'success' && 'text-success',
        tone === 'destructive' && 'text-destructive',
      )}>
        {value}
      </p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
