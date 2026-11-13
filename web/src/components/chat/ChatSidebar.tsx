import { useMemo, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronDown, Compass, Hash, Lock, PenSquare, Plus, Radio, Users } from 'lucide-react';
import { useChat } from '@/chat/ChatContext';
import { UserAvatar } from '@/components/bits';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { conversationTitle, type ChatConversation } from '@/lib/chat';
import { cn } from '@/lib/utils';

function useCollapsed(key: string): [boolean, () => void] {
  const storageKey = `roz-chat-collapsed:${key}`;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((v) => {
      try {
        localStorage.setItem(storageKey, v ? '0' : '1');
      } catch {
        /* sin storage */
      }
      return !v;
    });
  return [collapsed, toggle];
}

function Section({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  const [collapsed, toggle] = useCollapsed(id);
  return (
    <div className="mt-4">
      {/* Encabezado de sección como `.aside .sec` del mock: `label-caps`, tenue. */}
      <div className="group/sec flex items-center gap-1 px-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1 label-caps text-chat-sidebar-muted transition-colors hover:bg-chat-sidebar-hover hover:text-chat-sidebar-foreground"
        >
          <ChevronDown className={cn('size-3 transition-transform duration-200', collapsed && '-rotate-90')} />
          {title}
        </button>
        {action}
      </div>
      {!collapsed && <div className="mt-1 space-y-px px-2">{children}</div>}
    </div>
  );
}

function Item({ conv, title, icon }: { conv: ChatConversation; title: string; icon: ReactNode }) {
  const muted = conv.membership?.notifyLevel === 'none';
  const bold = conv.unread > 0 && !muted;
  const count = muted ? 0 : conv.kind === 'dm' ? conv.unread : conv.mentions;
  return (
    <NavLink
      to={`/chat/${conv.id}`}
      className={({ isActive }) =>
        cn(
          'group flex h-8 items-center gap-2 rounded-md px-2.5 text-[14px] transition-colors',
          isActive
            ? 'bg-primary font-semibold text-primary-foreground'
            : cn(
                'hover:bg-chat-sidebar-hover',
                bold ? 'font-semibold text-chat-sidebar-foreground' : 'text-chat-sidebar-muted',
                muted && 'opacity-60',
              ),
        )
      }
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {count > 0 && (
        // Contador mono como `.tab .count` del mock, pero en naranja: pide atención.
        <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-orange px-1.5 text-[10.5px] font-semibold text-primary-foreground group-[.active]:bg-primary-foreground group-[.active]:text-orange tabular-nums">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </NavLink>
  );
}

/**
 * Lista de conversaciones con la identidad roz v2: tinta cálida (tokens `chat-sidebar`, oscuros en
 * ambos modos) y el activo en el naranja de marca.
 * Canales por nombre; MDs por actividad reciente. Un MD cerrado no aparece hasta que llegue algo.
 */
export function ChatSidebar({
  onCreateChannel,
  onBrowse,
  onNewDm,
}: {
  onCreateChannel: () => void;
  onBrowse: () => void;
  onNewDm: () => void;
}) {
  const { conversations, nameOf, devOf, me, realtime, ready, error } = useChat();

  const channels = useMemo(
    () =>
      conversations
        .filter((c) => c.kind === 'channel' && c.membership)
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || (a.name ?? '').localeCompare(b.name ?? '')),
    [conversations],
  );
  const dms = useMemo(
    () =>
      conversations
        .filter((c) => c.kind === 'dm' && c.membership && (!c.membership.hidden || c.unread > 0))
        .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt)),
    [conversations],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-chat-sidebar text-chat-sidebar-foreground">
      <div className="flex h-16 shrink-0 items-center gap-2 border-b border-chat-sidebar-border px-4">
        <div className="grid min-w-0 flex-1 gap-1">
          <span className="eyebrow text-[10px] text-chat-sidebar-muted">Chat del equipo</span>
          <span className="truncate text-[17px] font-semibold leading-none tracking-[-0.03em]">Conversaciones</span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                'flex items-center gap-1.5 label-caps',
                realtime === 'live' ? 'text-green' : 'text-chat-sidebar-muted',
              )}
            >
              {realtime === 'live' ? (
                <span className="relative grid size-2 place-items-center">
                  <span className="absolute inset-0 animate-ping rounded-full bg-green opacity-60" />
                  <span className="size-2 rounded-full bg-green" />
                </span>
              ) : (
                <Radio className="size-3.5" />
              )}
              <span className="hidden lg:inline">{realtime === 'live' ? 'En vivo' : realtime === 'connecting' ? 'Conectando' : 'Sin conexión'}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {realtime === 'live'
              ? 'Los mensajes llegan al instante.'
              : 'Sin conexión en vivo: los mensajes se actualizan cada pocos segundos.'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onNewDm}
              aria-label="Nuevo mensaje"
              className="grid size-8 place-items-center rounded-btn bg-primary text-primary-foreground transition-colors hover:bg-primary/85"
            >
              <PenSquare className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Nuevo mensaje</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {!ready ? (
          <div className="space-y-5 px-4 pt-5" aria-label="Cargando conversaciones">
            {[4, 3].map((rows, s) => (
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
        ) : error && !conversations.length ? (
          <div className="m-3 grid gap-1.5 rounded-md border-l-[3px] border-l-red bg-chat-sidebar-hover p-3">
            <span className="label-caps text-red">Sin conexión al chat</span>
            <p className="text-[13px] text-chat-sidebar-muted">{error}</p>
          </div>
        ) : (
          <>
            <Section
              id="channels"
              title="Canales"
              action={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="Agregar canal"
                      className="grid size-6 place-items-center rounded-md text-chat-sidebar-muted opacity-0 transition-opacity hover:bg-chat-sidebar-hover hover:text-chat-sidebar-foreground group-hover/sec:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      <Plus className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={onCreateChannel}><Plus /> Crear un canal</DropdownMenuItem>
                    <DropdownMenuItem onSelect={onBrowse}><Compass /> Explorar canales</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            >
              {channels.map((c) => (
                <Item
                  key={c.id}
                  conv={c}
                  title={c.name ?? 'canal'}
                  icon={c.isPrivate ? <Lock className="size-4 shrink-0 opacity-80" /> : <Hash className="size-4 shrink-0 opacity-80" />}
                />
              ))}
              <button
                type="button"
                onClick={onBrowse}
                className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-[14px] text-chat-sidebar-muted transition-colors hover:bg-chat-sidebar-hover hover:text-chat-sidebar-foreground"
              >
                <span className="grid size-4 place-items-center rounded bg-chat-sidebar-hover"><Plus className="size-3" /></span>
                Agregar canales
              </button>
            </Section>

            <Section
              id="dms"
              title="Mensajes directos"
              action={
                <button
                  type="button"
                  onClick={onNewDm}
                  aria-label="Nuevo mensaje directo"
                  className="grid size-6 place-items-center rounded-md text-chat-sidebar-muted opacity-0 transition-opacity hover:bg-chat-sidebar-hover hover:text-chat-sidebar-foreground group-hover/sec:opacity-100 [@media(hover:none)]:opacity-100"
                >
                  <Plus className="size-4" />
                </button>
              }
            >
              {dms.map((c) => {
                const others = c.memberIds.filter((id) => id !== me);
                const single = others.length <= 1 ? devOf(others[0] ?? me ?? '') : undefined;
                return (
                  <Item
                    key={c.id}
                    conv={c}
                    title={conversationTitle(c, nameOf, me)}
                    icon={
                      others.length > 1 ? (
                        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-chat-sidebar-hover text-[10px] font-bold">
                          <Users className="size-3" />
                        </span>
                      ) : (
                        <UserAvatar url={single?.avatarUrl ?? null} email={single?.email} id={single?.id} name={single?.name ?? '?'} className="size-5 shrink-0 rounded-full" />
                      )
                    }
                  />
                );
              })}
              <button
                type="button"
                onClick={onNewDm}
                className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-[14px] text-chat-sidebar-muted transition-colors hover:bg-chat-sidebar-hover hover:text-chat-sidebar-foreground"
              >
                <span className="grid size-4 place-items-center rounded bg-chat-sidebar-hover"><Plus className="size-3" /></span>
                Nuevo mensaje
              </button>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
