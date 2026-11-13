import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronDown, Hash, Megaphone, MessagesSquare, Mic, Radio, Volume2 } from 'lucide-react';
import { useDiscord } from '@/discord/DiscordContext';
import { discordUrl, isAnnouncement, isForum, isVoice } from '@/discord/model';
import { splitChannelName } from '@/discord/channelName';
import type { DiscordChannelView, DiscordThreadView } from '@/lib/api';
import { IntegrationIcon } from '@/components/brand';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ConnectionPill } from './DiscordStatus';

const COLLAPSE_KEY = 'roz-discord-collapsed:';

/** Alto común de las dos barras del chat (servidor y canal): quedan alineadas en una sola línea. */
export const CHAT_BAR = 'h-14';

function useCollapsed(id: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY + id) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((v) => {
      try {
        localStorage.setItem(COLLAPSE_KEY + id, v ? '0' : '1');
      } catch {
        /* sin storage */
      }
      return !v;
    });
  return [collapsed, toggle];
}

/** Ícono por tipo de canal, como en Discord. */
export function ChannelIcon({ type, className }: { type: number; className?: string }) {
  const cls = cn('size-4 shrink-0 opacity-80', className);
  if (isAnnouncement(type)) return <Megaphone className={cls} />;
  if (isForum(type)) return <MessagesSquare className={cls} />;
  if (type === 13) return <Radio className={cls} />;
  if (isVoice(type)) return <Volume2 className={cls} />;
  return <Hash className={cls} />;
}

/**
 * UN solo glifo por canal: el emoji con el que el servidor adorna el nombre ("💻│dev") o, si no
 * trae, el ícono del tipo. Antes se pintaban los dos ("# 💻 dev"). Voz y anuncios conservan su
 * ícono de tipo porque dice algo que el emoji no (no se abre / solo anuncios).
 */
export function ChannelGlyph({
  name,
  type,
  thread = false,
  className,
}: {
  name: string;
  type: number;
  thread?: boolean;
  /** Tamaño del ícono (`size-4` por defecto); el emoji se escala al mismo alto. */
  className?: string;
}) {
  const { glyph } = splitChannelName(name);
  const typed = isVoice(type) || isAnnouncement(type);
  if (glyph && !typed) {
    return (
      <span aria-hidden className={cn('grid size-4 shrink-0 place-items-center text-[13px] leading-none', className)}>
        {glyph}
      </span>
    );
  }
  return thread ? <MessagesSquare className={cn('size-4 shrink-0 opacity-80', className)} /> : <ChannelIcon type={type} className={className} />;
}

/** Nombre visible del canal (sin el adorno del emoji, que ya va como glifo). */
export function channelLabel(name: string): string {
  return splitChannelName(name).label;
}

const ROW = 'group flex h-8 items-center gap-2 rounded-md px-2.5 text-[14px] transition-colors';
// Activo en naranja suave (pedido de diseño); sobre la tinta del aside se lee como selección de roz.
const ACTIVE = 'bg-orange-soft font-semibold text-orange-ink';

function Count({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-orange px-1.5 text-[10.5px] font-semibold text-primary-foreground tabular-nums">
      {n > 99 ? '99+' : n}
    </span>
  );
}

function ThreadRow({ t }: { t: DiscordThreadView }) {
  const { unread } = useDiscord();
  const u = unread(t.id);
  return (
    <NavLink
      to={`/chat/${t.id}`}
      className={({ isActive }) =>
        cn(
          'relative ml-[1.15rem] flex h-7 items-center gap-2 rounded-md pl-4 pr-2 text-[13px] transition-colors',
          isActive
            ? ACTIVE
            : cn('hover:bg-chat-sidebar-hover', u.unread ? 'font-semibold text-chat-sidebar-foreground' : 'text-chat-sidebar-muted'),
        )
      }
    >
      {/* Conector del hilo a su canal, como en Discord. */}
      <span aria-hidden className="absolute -top-1 left-0 h-[calc(50%+4px)] w-3 rounded-bl-md border-b border-l border-chat-sidebar-border" />
      <span className="min-w-0 flex-1 truncate">{channelLabel(t.name)}</span>
      <Count n={u.mentions} />
    </NavLink>
  );
}

function ChannelRow({ c }: { c: DiscordChannelView }) {
  const { unread, guildId } = useDiscord();
  const u = unread(c.id);
  // Voz y escenarios: se ven como en Discord, pero no se abren (no hay voz en roz).
  if (isVoice(c.type)) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={guildId ? discordUrl(guildId, c.id) : undefined}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(ROW, 'text-chat-sidebar-muted opacity-60 hover:bg-chat-sidebar-hover hover:opacity-100')}
          >
            <ChannelIcon type={c.type} />
            <span className="min-w-0 flex-1 truncate">{channelLabel(c.name)}</span>
            <Mic className="size-3 opacity-70" />
          </a>
        </TooltipTrigger>
        <TooltipContent side="right">La voz no está disponible en roz · Abrir en Discord</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <>
      <NavLink
        to={`/chat/${c.id}`}
        className={({ isActive }) =>
          cn(
            ROW,
            isActive
              ? ACTIVE
              : cn('hover:bg-chat-sidebar-hover', u.unread ? 'font-semibold text-chat-sidebar-foreground' : 'text-chat-sidebar-muted'),
          )
        }
      >
        <ChannelGlyph name={c.name} type={c.type} />
        <span className="min-w-0 flex-1 truncate">{channelLabel(c.name)}</span>
        <Count n={u.mentions} />
      </NavLink>
      {c.threads.map((t) => (
        <ThreadRow key={t.id} t={t} />
      ))}
    </>
  );
}

function Category({ id, name, children }: { id: string; name: string; children: ReactNode }) {
  const [collapsed, toggle] = useCollapsed(id);
  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="mx-2 flex w-[calc(100%-1rem)] items-center gap-1.5 rounded-md px-2 py-1 label-caps text-chat-sidebar-muted transition-colors hover:bg-chat-sidebar-hover hover:text-chat-sidebar-foreground"
      >
        <ChevronDown className={cn('size-3 transition-transform duration-200', collapsed && '-rotate-90')} />
        {/* Sin el emoji de la categoría: el chevron ya es su ícono, y los canales traen el suyo. */}
        <span className="truncate">{channelLabel(name)}</span>
      </button>
      {!collapsed && <div className="mt-1 space-y-px px-2">{children}</div>}
    </div>
  );
}

/**
 * Barra de canales del servidor de Discord, con la tinta del aside de roz: categorías colapsables
 * en el orden y con los nombres de Discord, canales con su ícono por tipo, hilos activos bajo su
 * canal y el activo en naranja suave. Solo aparece lo que tu cuenta de Discord puede ver.
 */
export function ChannelSidebar() {
  const { status, tree, treeError, reloadTree } = useDiscord();
  const guild = status.guild;

  return (
    <div className="flex h-full min-h-0 flex-col bg-chat-sidebar text-chat-sidebar-foreground">
      {/* Encabezado del servidor: el ÚNICO lugar con su ícono y nombre. Mismo alto (CHAT_BAR) que el
          encabezado del canal, para que las dos barras queden en una sola línea como en Discord. */}
      <div className={cn(CHAT_BAR, 'flex shrink-0 items-center gap-2.5 border-b border-chat-sidebar-border px-3')}>
        {guild?.iconUrl ? (
          <img src={guild.iconUrl} alt="" className="size-7 shrink-0 rounded-[8px] object-cover" />
        ) : (
          <span className="grid size-7 shrink-0 place-items-center rounded-[8px] bg-card">
            <IntegrationIcon name="discord" size="xs" title="" />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.02em]" title={guild?.name ?? undefined}>
          {guild?.name ?? 'Servidor de Discord'}
        </span>
        <ConnectionPill />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {!tree && !treeError ? (
          <div className="space-y-5 px-4 pt-5" aria-label="Cargando canales">
            {[4, 3, 2].map((rows, s) => (
              <div key={s} className="space-y-2">
                <div className="h-2.5 w-20 rounded-sm bg-chat-sidebar-hover" />
                {Array.from({ length: rows }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="size-4 shrink-0 animate-pulse rounded bg-chat-sidebar-hover" />
                    <div className="h-3.5 animate-pulse rounded-sm bg-chat-sidebar-hover" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : treeError && !tree ? (
          <div className="m-3 grid gap-1.5 rounded-md border-l-[3px] border-l-red bg-chat-sidebar-hover p-3">
            <span className="label-caps text-red">No se cargaron los canales</span>
            <p className="text-[13px] text-chat-sidebar-muted">{treeError instanceof Error ? treeError.message : 'Error desconocido'}</p>
            <button type="button" onClick={reloadTree} className="w-fit label-caps text-chat-sidebar-foreground hover:underline">
              Reintentar
            </button>
          </div>
        ) : tree && !tree.uncategorized.length && !tree.categories.length ? (
          <p className="m-4 text-[13px] text-chat-sidebar-muted">
            Tu cuenta de Discord no puede ver ningún canal de este servidor. Pide acceso a quien administre el servidor.
          </p>
        ) : (
          tree && (
            <>
              {tree.uncategorized.length > 0 && (
                <div className="mt-3 space-y-px px-2">
                  {tree.uncategorized.map((c) => (
                    <ChannelRow key={c.id} c={c} />
                  ))}
                </div>
              )}
              {tree.categories.map((cat) => (
                <Category key={cat.id} id={cat.id} name={cat.name}>
                  {cat.channels.map((c) => (
                    <ChannelRow key={c.id} c={c} />
                  ))}
                </Category>
              ))}
            </>
          )
        )}
      </div>
    </div>
  );
}
