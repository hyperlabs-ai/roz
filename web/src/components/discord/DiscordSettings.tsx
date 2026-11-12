import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Hash, Link2, Loader2, Megaphone, Search, TriangleAlert, Unlink, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { DISCORD_STATUS_KEY, discordStatusOrOff } from '@/discord/status';
import { isTextLike } from '@/discord/model';
import { discordApi, type DiscordChannelView, type DiscordProjectChannelView } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { invalidate } from '@/lib/store';
import { relative } from '@/lib/format';
import { CapsLabel, GithubAvatar, IntegrationIcon, ProjectIcon } from '@/components/brand';
import { EmptyState, ProgressBar } from '@/components/bits';
import { Segmented } from '@/components/pulse/roz-v2';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { startDiscordLink } from './DiscordStatus';

/** Desenlaces del callback de OAuth (contrato §B.9) → aviso. */
const OUTCOME: Record<string, { ok: boolean; text: string; description?: string }> = {
  ok: { ok: true, text: 'Cuenta de Discord ligada' },
  denied: { ok: false, text: 'No autorizaste el acceso a Discord' },
  state: { ok: false, text: 'La sesión de conexión expiró', description: 'Vuelve a intentarlo.' },
  taken: { ok: false, text: 'Esa cuenta de Discord ya está ligada a otra persona de roz' },
  not_member: {
    ok: false,
    text: 'Cuenta ligada, pero no está en el servidor',
    description: 'Entra al servidor de Discord con esa cuenta para ver los canales.',
  },
  error: { ok: false, text: 'No se pudo ligar la cuenta de Discord' },
};

const NONE = '__none__';
type Filter = 'all' | 'mapped' | 'dm';

/** Plantilla de la tabla proyecto → canal (encabezado y filas). */
const ROW = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 sm:grid-cols-[minmax(0,1fr)_16rem_1.25rem]';

/**
 * Proyecto → canal como TABLA compacta con buscador y filtro: con 30 proyectos, la lista de
 * tarjetas era una columna larguísima. Cada fila: proyecto a la izquierda, selector de canal a la
 * derecha (todos alineados en la misma columna).
 */
function ProjectChannels() {
  const items = useApi(() => discordApi.projectChannels(), [], { key: '/discord/project-channels', ttl: 60_000 });
  const tree = useApi(() => discordApi.channels(), [], { key: '/discord/channels', ttl: 60_000 });
  const [local, setLocal] = useState<DiscordProjectChannelView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    if (items.data) setLocal(items.data.items);
  }, [items.data]);

  const options = useMemo(() => {
    if (!tree.data) return [] as { channel: DiscordChannelView; category: string | null }[];
    return [
      ...tree.data.uncategorized.map((channel) => ({ channel, category: null })),
      ...tree.data.categories.flatMap((cat) => cat.channels.map((channel) => ({ channel, category: cat.name }))),
    ].filter((o) => isTextLike(o.channel.type) && o.channel.supported);
  }, [tree.data]);

  const mapped = local?.filter((i) => i.channelId).length ?? 0;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (local ?? [])
      .filter((i) => (filter === 'mapped' ? !!i.channelId : filter === 'dm' ? !i.channelId : true))
      .filter((i) => !needle || i.projectName.toLowerCase().includes(needle) || (i.channelName ?? '').toLowerCase().includes(needle))
      .sort((a, b) => a.projectName.localeCompare(b.projectName));
  }, [local, q, filter]);

  async function change(projectId: string, value: string) {
    const channelId = value === NONE ? null : value;
    const prev = local;
    setLocal((l) =>
      l?.map((i) =>
        i.projectId === projectId
          ? { ...i, channelId, channelName: options.find((o) => o.channel.id === channelId)?.channel.name ?? null }
          : i,
      ) ?? l,
    );
    setBusy(projectId);
    try {
      const { item } = await discordApi.setProjectChannel(projectId, channelId);
      setLocal((l) => l?.map((i) => (i.projectId === projectId ? item : i)) ?? l);
      invalidate('/discord/project-channels');
      toast.success(channelId ? `Avisos de ${item.projectName} en #${item.channelName ?? 'canal'}` : `${item.projectName} sin canal`);
    } catch (e) {
      setLocal(prev);
      toast.error('No se pudo guardar el canal', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  const loading = (items.loading || tree.loading) && !local;
  const total = local?.length ?? 0;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-sidebar px-4 py-2.5 sm:px-5">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold tracking-[-0.01em]">
          <Megaphone className="size-4 text-faint" /> Canal de cada proyecto
        </span>
        {!loading && total > 0 && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            <ProgressBar pct={(mapped / total) * 100} color="blue" className="w-20" />
            {mapped}/{total} con canal
          </span>
        )}
      </div>
      <p className="border-b px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
        Al crear un ticket con <span className="font-mono text-foreground">/ticket</span>, roz menciona al responsable en el canal de su
        proyecto. Sin canal, le escribe por mensaje directo del bot.
      </p>

      {loading ? (
        <div className="divide-y">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={cn(ROW, 'px-4 py-2.5 sm:px-5')}>
              <div className="flex items-center gap-2"><Skeleton className="size-6 rounded-md" /><Skeleton className="h-3.5 w-36" /></div>
              <Skeleton className="h-8 w-44 sm:w-full" />
            </div>
          ))}
        </div>
      ) : items.error || tree.error ? (
        <div className="flex items-center justify-between gap-3 px-4 py-4 text-xs text-muted-foreground sm:px-5">
          <span>No se cargaron los proyectos o los canales.</span>
          <Button variant="secondary" size="sm" onClick={() => { items.reload(); tree.reload(); }}>Reintentar</Button>
        </div>
      ) : !total ? (
        <EmptyState icon={<Megaphone />}>No hay proyectos activos.</EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-2.5 sm:px-5">
            <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar proyecto o canal…" className="h-8 pl-8 pr-8" aria-label="Buscar proyecto o canal" />
              {q && (
                <button type="button" onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-foreground" aria-label="Limpiar búsqueda">
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <Segmented<Filter>
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'Todos', count: total },
                { value: 'mapped', label: 'Con canal', count: mapped },
                { value: 'dm', label: 'Por DM', count: total - mapped },
              ]}
            />
          </div>
          <div className={cn(ROW, 'hidden border-b px-4 py-2 sm:grid sm:px-5')}>
            <CapsLabel>Proyecto</CapsLabel>
            <CapsLabel>Canal de avisos</CapsLabel>
            <span />
          </div>
          {!shown.length ? (
            <EmptyState icon={<Search />}>Ningún proyecto coincide.</EmptyState>
          ) : (
            <div className="divide-y">
              {shown.map((i) => (
                <div key={i.projectId} className={cn(ROW, 'px-4 py-2 transition-colors hover:bg-sidebar sm:px-5')}>
                  <span className="flex min-w-0 items-center gap-2.5 text-[13.5px] font-medium">
                    <ProjectIcon id={i.projectId} size="sm" />
                    <span className="truncate">{i.projectName}</span>
                  </span>
                  <Select value={i.channelId ?? NONE} onValueChange={(v) => void change(i.projectId, v)} disabled={busy === i.projectId}>
                    <SelectTrigger className={cn('h-8 w-44 sm:w-full', !i.channelId && 'text-muted-foreground')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Sin canal (DM del bot)</SelectItem>
                      {/* Un mapeo a un canal que ya no veo (o borrado) se conserva visible. */}
                      {i.channelId && !options.some((o) => o.channel.id === i.channelId) && (
                        <SelectItem value={i.channelId}>#{i.channelName ?? 'canal sin acceso'}</SelectItem>
                      )}
                      {options.map((o) => (
                        <SelectItem key={o.channel.id} value={o.channel.id}>
                          <span className="inline-flex items-center gap-1.5">
                            <Hash className="size-3.5 opacity-70" />
                            {o.channel.name}
                            {o.category && <span className="label-caps text-faint">{o.category}</span>}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="hidden sm:block">
                    {busy === i.projectId && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** Estado de Discord compartido con la navegación de Configuración (misma caché, sin pedirlo dos veces). */
export function useDiscordStatus() {
  return useApi(() => discordStatusOrOff(), [], { key: DISCORD_STATUS_KEY, ttl: 60_000 });
}

/**
 * Configuración → Discord (solo con ROZ_DISCORD_CHAT): ligar/desligar la cuenta (OAuth2, scope
 * identify) y el mapeo proyecto ↔ canal para el aviso de /ticket. Con el flag apagado no pinta nada.
 * La cabecera de la sección la pone Configuración.
 */
export function DiscordSettings() {
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const status = useDiscordStatus();

  const outcome = params.get('discord');
  useEffect(() => {
    if (!outcome) return;
    const o = OUTCOME[outcome];
    if (o) (o.ok ? toast.success : toast.error)(o.text, o.description ? { description: o.description } : undefined);
    status.reload();
    invalidate('/discord/channels');
    params.delete('discord');
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  const data = status.data;
  if (status.loading && !data) {
    return (
      <div className="grid gap-3.5">
        <Skeleton className="h-[76px] w-full rounded-lg" />
        <Skeleton className="h-56 w-full rounded-lg" />
      </div>
    );
  }
  if (!data?.enabled) return null;

  const link = data.link;
  const notMember = data.unavailable === 'not_member';

  async function unlink() {
    setBusy(true);
    try {
      await discordApi.unlink();
      toast.success('Cuenta de Discord desligada');
      status.reload();
      invalidate('/discord/channels');
    } catch (e) {
      toast.error('No se pudo desligar', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3.5">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            {link ? (
              <GithubAvatar url={link.avatarUrl} name={link.globalName ?? link.username} color="chart-2" className="size-10" />
            ) : (
              <IntegrationIcon name="discord" size="md" framed />
            )}
            <div className="grid min-w-0 gap-0.5">
              <span className="flex items-center gap-2 truncate text-[13.5px] font-semibold">
                {link ? link.globalName ?? link.username : 'Cuenta sin ligar'}
                {link && (
                  <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold', notMember ? 'bg-yellow-soft text-yellow-ink' : 'bg-green-soft text-green')}>
                    <span className={cn('size-1.5 rounded-full', notMember ? 'bg-yellow' : 'bg-green')} />
                    {notMember ? 'Fuera del servidor' : 'Ligada'}
                  </span>
                )}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {link
                  ? `@${link.username} · ligada ${relative(link.linkedAt)}${data.guild ? ` · ${data.guild.name}` : ''}`
                  : 'Liga tu cuenta para ver en roz los canales del servidor que tienes permitidos.'}
              </span>
            </div>
          </div>
          <Button
            variant={link ? 'outline' : 'default'}
            size="sm"
            className="shrink-0"
            disabled={busy}
            onClick={() => (link ? void unlink() : void startDiscordLink(setBusy))}
          >
            {busy ? <Loader2 className="animate-spin" /> : link ? <Unlink /> : <Link2 />}
            {busy ? (link ? 'Desligando…' : 'Abriendo Discord…') : link ? 'Desligar' : 'Ligar cuenta'}
          </Button>
        </div>
        {notMember && (
          <div className="flex items-start gap-2 border-t border-yellow/40 bg-yellow-soft px-4 py-3 text-xs text-yellow-ink sm:px-5">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              <span className="font-semibold">Tu cuenta no está en {data.guild?.name ?? 'el servidor'}.</span> Entra al servidor con esa
              cuenta, o desliga y liga la correcta.
            </span>
          </div>
        )}
        {data.limits.length > 0 && (
          <ul className="grid gap-1.5 border-t bg-sidebar px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {data.limits.map((l) => (
              <li key={l} className="flex gap-2">
                <span className="mt-[6px] size-1 shrink-0 rounded-full bg-toggle-off" />
                {l}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {link && !data.unavailable ? (
        <ProjectChannels />
      ) : (
        <Card>
          <EmptyState icon={<Megaphone />}>
            Liga tu cuenta de Discord (y que esté en el servidor) para elegir el canal de avisos de cada proyecto.
          </EmptyState>
        </Card>
      )}
    </div>
  );
}
