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
    <div className="mt-3">
      <div className="group/sec flex items-center gap-1 px-2">
        <button
          type="button"
          onClick={toggle}
          className="flex flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] font-medium text-chat-sidebar-muted transition-colors hover:bg-chat-sidebar-hover hover:text-chat-sidebar-foreground"
        >
          <ChevronDown className={cn('size-3.5 transition-transform duration-200', collapsed && '-rotate-90')} />
          {title}
        </button>
        {action}
      </div>
      {!collapsed && <div className="mt-0.5 space-y-px px-2">{children}</div>}
    </div>
  );
}

function Item({ conv, title, icon }: { conv: ChatConversation; title: string; icon: ReactNode }) {
  const muted = conv.membership?.notifyLevel === 'none';
  const bold = conv.unread > 0 && !muted;
  const count = muted ? 0 : conv.kind === 'dm' ? conv.unread : conv.mentions;
  return (
    <NavLink
      to={`/app/chat/${conv.id}`}
      className={({ isActive }) =>
        cn(
          'flex h-8 items-center gap-2 rounded-md px-2.5 text-[15px] transition-colors',
          isActive
            ? 'bg-primary text-primary-foreground'
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
        <span className="grid h-5 min-w-5 place-items-center rounded-full bg-destructive px-1.5 text-[11px] font-bold text-destructive-foreground">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </NavLink>
  );
}

/**
 * Lista de conversaciones, con los colores de roz (azul marino; el activo en el azul de marca).
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
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-chat-sidebar-border px-4">
        <span className="flex-1 truncate text-[17px] font-bold">Conversaciones</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn('flex items-center gap-1 text-[11px]', realtime === 'live' ? 'text-success' : 'text-chat-sidebar-muted')}>
              <Radio className="size-3.5" />
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
              className="grid size-8 place-items-center rounded-md bg-chat-sidebar-hover text-chat-sidebar-foreground transition-colors hover:bg-primary hover:text-primary-foreground"
            >
              <PenSquare className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Nuevo mensaje</TooltipContent>
        </Tooltip>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-4 [scrollbar-color:hsl(var(--chat-sidebar-border))_transparent]">
        {!ready ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-6 animate-pulse rounded-md bg-chat-sidebar-hover" />
            ))}
          </div>
        ) : error && !conversations.length ? (
          <p className="p-4 text-sm text-chat-sidebar-muted">No se pudo cargar el chat: {error}</p>
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
                className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-[15px] text-chat-sidebar-muted transition-colors hover:bg-chat-sidebar-hover hover:text-chat-sidebar-foreground"
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
                        <span className="grid size-5 shrink-0 place-items-center rounded bg-chat-sidebar-hover text-[10px] font-bold">
                          <Users className="size-3" />
                        </span>
                      ) : (
                        <UserAvatar url={single?.avatarUrl ?? null} name={single?.name ?? '?'} className="size-5 shrink-0 rounded" />
                      )
                    }
                  />
                );
              })}
              <button
                type="button"
                onClick={onNewDm}
                className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-[15px] text-chat-sidebar-muted transition-colors hover:bg-chat-sidebar-hover hover:text-chat-sidebar-foreground"
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
