import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from '@/lib/toast';
import {
  ArrowLeft, Bell, BellOff, BellRing, Check, Hash, Loader2, Lock, LogOut, MoreVertical, Pencil, Trash2, Users,
} from 'lucide-react';
import { useChat } from '@/chat/ChatContext';
import { useConversationMessages } from '@/chat/useMessages';
import { AvatarStack, UserAvatar } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { ChannelDialog, MembersDialog } from './dialogs';
import { chatApi, conversationTitle, type ChatConversation, type NotifyLevel } from '@/lib/chat';
import { cn } from '@/lib/utils';

const LEVELS: { value: NotifyLevel; label: string; hint: string; icon: typeof Bell }[] = [
  { value: 'all', label: 'Todos los mensajes', hint: 'Push con cada mensaje nuevo', icon: BellRing },
  { value: 'mentions', label: 'Solo menciones', hint: 'Push si te mencionan o usan @canal', icon: Bell },
  { value: 'none', label: 'Silenciado', hint: 'Sin push ni contadores', icon: BellOff },
];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ConversationView({
  conversation: conv,
  onOpenThread,
  onBack,
}: {
  conversation: ChatConversation;
  onOpenThread: (rootId: string) => void;
  /** Móvil: volver a la lista de conversaciones. */
  onBack?: () => void;
}) {
  const chat = useChat();
  const { me, nameOf, devOf, markRead, upsertConversation, removeConversation } = chat;
  const navigate = useNavigate();
  const { messages, hasMore, loading, loadingOlder, loadOlder, send, discard } = useConversationMessages(conv.id);
  const [editOpen, setEditOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [confirm, setConfirm] = useState<'leave' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const [joining, setJoining] = useState(false);

  const isChannel = conv.kind === 'channel';
  const isMember = !!conv.membership;
  const isOwner = !!me && conv.ownerIds.includes(me);
  const title = conversationTitle(conv, nameOf, me);

  // Marca de lectura al ABRIR: fija mientras se ve, para que "Nuevos" no se mueva al marcar leído.
  const [readMark, setReadMark] = useState<string | null>(conv.membership?.lastReadAt ?? null);
  const openedId = useRef(conv.id);
  useEffect(() => {
    if (openedId.current === conv.id) return;
    openedId.current = conv.id;
    setReadMark(conv.membership?.lastReadAt ?? null);
  }, [conv.id, conv.membership?.lastReadAt]);

  // Marcar leído al abrir, al volver a la pestaña y cuando llega algo mientras se está mirando.
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRead = useCallback(() => {
    if (!isMember) return;
    if (readTimer.current) clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) markRead(conv.id);
    }, 600);
  }, [conv.id, isMember, markRead]);

  const lastMessageId = messages[messages.length - 1]?.id;
  useEffect(() => {
    scheduleRead();
  }, [scheduleRead, lastMessageId]);

  useEffect(() => {
    if (conv.unread > 0 || conv.mentions > 0) scheduleRead();
  }, [conv.unread, conv.mentions, scheduleRead]);

  useEffect(() => {
    const onFocus = () => scheduleRead();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      if (readTimer.current) clearTimeout(readTimer.current);
    };
  }, [scheduleRead]);

  async function setLevel(level: NotifyLevel) {
    if (!conv.membership) return;
    try {
      const { membership } = await chatApi.updateMembership(conv.id, { notifyLevel: level });
      upsertConversation({ ...conv, membership });
    } catch (e) {
      toast.error('No se pudo cambiar el aviso', { description: errText(e) });
    }
  }

  async function join() {
    setJoining(true);
    try {
      const { conversation } = await chatApi.join(conv.id);
      upsertConversation(conversation);
    } catch (e) {
      toast.error('No se pudo unir al canal', { description: errText(e) });
    } finally {
      setJoining(false);
    }
  }

  async function leaveOrClose() {
    setBusy(true);
    try {
      if (isChannel) await chatApi.leave(conv.id);
      else await chatApi.updateMembership(conv.id, { hidden: true });
      removeConversation(conv.id);
      navigate('/app/chat');
    } catch (e) {
      toast.error(isChannel ? 'No se pudo salir del canal' : 'No se pudo cerrar la conversación', { description: errText(e) });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function destroy() {
    setBusy(true);
    try {
      await chatApi.deleteConversation(conv.id);
      removeConversation(conv.id);
      navigate('/app/chat');
      toast.success(`Se eliminó #${conv.name}`);
    } catch (e) {
      toast.error('No se pudo eliminar el canal', { description: errText(e) });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  const others = conv.memberIds.filter((id) => id !== me);
  const dmPeer = !isChannel && others.length <= 1 ? devOf(others[0] ?? me ?? '') : undefined;
  const people = conv.memberIds
    .map((id) => devOf(id))
    .filter((d): d is NonNullable<typeof d> => !!d)
    .map((d) => ({ name: d.name, avatarUrl: d.avatarUrl, id: d.id, email: d.email }));
  const level = LEVELS.find((l) => l.value === conv.membership?.notifyLevel) ?? LEVELS[1]!;

  const empty = (
    // Inicio de la conversación: panel gris del mock (`.pc`) con eyebrow, título apretado y lede.
    <div className="px-4 pb-4 pt-8 md:px-5">
      <div className="grid max-w-2xl gap-4 rounded-xl bg-panel p-5 sm:p-6">
        {isChannel ? (
          <>
            <div className="flex items-center gap-3">
              <span className="grid size-11 place-items-center rounded-[10px] bg-orange text-primary-foreground">
                {conv.isPrivate ? <Lock className="size-5" /> : <Hash className="size-5" />}
              </span>
              <span className="eyebrow">{conv.isPrivate ? 'Canal privado' : 'Canal público'} · inicio</span>
            </div>
            <div className="grid gap-2">
              <h2 className="text-[22px] leading-tight tracking-[-0.03em] sm:text-[26px]">Este es el inicio de #{conv.name}</h2>
              <p className="max-w-[58ch] text-sm text-muted-foreground sm:text-[15px]">
                {conv.description || conv.topic || 'Aquí empieza la conversación. Menciona a alguien con @ o convierte un mensaje en tarea.'}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="neutral" className="bg-card">@ mencionar</Badge>
              <Badge variant="neutral" className="bg-card">@tarea citar</Badge>
              <Badge variant="warn" dot>/ticket crea un ticket</Badge>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              {others.length > 1 ? (
                <AvatarStack people={people.filter((p) => p.name !== nameOf(me ?? ''))} size="size-11" max={4} />
              ) : (
                <UserAvatar url={dmPeer?.avatarUrl ?? null} email={dmPeer?.email} id={dmPeer?.id} name={dmPeer?.name ?? '?'} className="size-11 rounded-full" />
              )}
              <span className="eyebrow" style={{ '--sq': 'var(--yellow)' } as CSSProperties}>
                {others.length === 0 ? 'Tus notas' : others.length > 1 ? 'Mensaje grupal' : 'Mensaje directo'}
              </span>
            </div>
            <div className="grid gap-2">
              <h2 className="text-[22px] leading-tight tracking-[-0.03em] sm:text-[26px]">{title}</h2>
              <p className="max-w-[58ch] text-sm text-muted-foreground sm:text-[15px]">
                {others.length === 0
                  ? 'Tu espacio personal: notas, borradores, recordatorios.'
                  : 'Esta conversación es solo entre ustedes. Lo que se acuerde aquí puede volverse tarea desde el menú de cada mensaje.'}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Encabezado */}
      <div className="flex h-16 shrink-0 items-center gap-2 border-b bg-card px-3 md:px-5">
        {onBack && (
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Volver a las conversaciones" className="md:hidden">
            <ArrowLeft />
          </Button>
        )}
        <div className="grid min-w-0 flex-1 gap-1">
          <span
            className="eyebrow hidden px-1 text-[10px] sm:inline-flex"
            style={{ '--sq': isChannel ? 'var(--orange)' : 'var(--yellow)' } as CSSProperties}
          >
            {isChannel ? (conv.isPrivate ? 'Canal privado' : 'Canal') : others.length > 1 ? 'Mensaje grupal' : 'Mensaje directo'}
            {conv.topic && <span className="normal-case tracking-normal text-faint">· {conv.topic}</span>}
          </span>
          <button
            type="button"
            onClick={() => (isChannel && isMember ? setEditOpen(true) : setMembersOpen(true))}
            className="flex max-w-full items-center gap-1.5 rounded-md px-1 text-left transition-colors hover:bg-panel"
          >
            {isChannel ? (
              conv.isPrivate ? <Lock className="size-4 shrink-0 text-faint" /> : <Hash className="size-[18px] shrink-0 text-faint" />
            ) : others.length <= 1 ? (
              <UserAvatar url={dmPeer?.avatarUrl ?? null} email={dmPeer?.email} id={dmPeer?.id} name={dmPeer?.name ?? '?'} className="size-6 rounded-full" />
            ) : (
              <Users className="size-4 shrink-0 text-faint" />
            )}
            <span className="truncate text-[18px] font-semibold leading-tight tracking-[-0.03em]">{title}</span>
          </button>
          {conv.topic && <p className="truncate px-1 text-xs text-muted-foreground sm:hidden">{conv.topic}</p>}
        </div>

        <button
          type="button"
          onClick={() => setMembersOpen(true)}
          className="hidden items-center gap-1.5 rounded-btn bg-panel px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-toggle-off/70 sm:flex"
          aria-label="Ver miembros"
        >
          <AvatarStack people={people} size="size-5" max={3} />
          <span className="pr-0.5 text-[11px] font-semibold tabular-nums">{conv.memberIds.length}</span>
        </button>

        {isMember && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Avisos: ${level.label}`} className={cn(level.value === 'none' && 'text-muted-foreground')}>
                <level.icon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Notificaciones de esta conversación</DropdownMenuLabel>
              {LEVELS.filter((l) => isChannel || l.value !== 'mentions').map((l) => (
                <DropdownMenuItem key={l.value} onSelect={() => void setLevel(l.value)} className="items-start">
                  <l.icon className="mt-0.5" />
                  <span className="flex-1">
                    <span className="block">{isChannel || l.value !== 'all' ? l.label : 'Cada mensaje'}</span>
                    <span className="block text-xs text-muted-foreground">{l.hint}</span>
                  </span>
                  {conv.membership?.notifyLevel === l.value && <Check className="mt-0.5" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {isMember && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Opciones de la conversación">
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {isChannel && (
                <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                  <Pencil /> Editar canal
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setMembersOpen(true)}>
                <Users /> Miembros
              </DropdownMenuItem>
              {(!isChannel || !conv.isDefault) && <DropdownMenuSeparator />}
              {!isChannel && (
                <DropdownMenuItem onSelect={() => setConfirm('leave')}>
                  <LogOut /> Cerrar conversación
                </DropdownMenuItem>
              )}
              {isChannel && !conv.isDefault && (
                <DropdownMenuItem onSelect={() => setConfirm('leave')}>
                  <LogOut /> Salir del canal
                </DropdownMenuItem>
              )}
              {isChannel && isOwner && !conv.isDefault && (
                <DropdownMenuItem onSelect={() => setConfirm('delete')} className="text-destructive focus:text-destructive">
                  <Trash2 /> Eliminar canal
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <MessageList
        conversationId={conv.id}
        messages={messages}
        hasMore={hasMore}
        loading={loading}
        loadingOlder={loadingOlder}
        onLoadOlder={() => void loadOlder()}
        lastReadAt={readMark}
        onOpenThread={onOpenThread}
        onRetry={(m) => {
          discard(m.clientNonce!);
          void send(m.body, m.attachments, m.statusTasks);
        }}
        onDiscard={(m) => discard(m.clientNonce!)}
        empty={empty}
      />

      {isMember ? (
        <Composer
          conversationId={conv.id}
          draftKey={`conv:${conv.id}`}
          memberIds={conv.memberIds}
          placeholder={isChannel ? `Escribe en #${conv.name}` : `Escribe a ${title}`}
          onSend={(body, attachments, statusTasks) => void send(body, attachments, statusTasks)}
          autoFocus={!onBack}
        />
      ) : (
        <div className="m-3 flex flex-col items-center gap-3 rounded-xl bg-panel p-5 text-center md:m-5 sm:flex-row sm:justify-between sm:text-left">
          <div className="grid gap-1">
            <span className="label-caps">Solo lectura</span>
            <p className="text-sm">
              Estás viendo <span className="font-semibold">#{conv.name}</span>. Únete para escribir y recibir avisos.
            </p>
          </div>
          <Button onClick={() => void join()} disabled={joining}>
            {joining && <Loader2 className="animate-spin" />} Unirme al canal
          </Button>
        </div>
      )}

      {isChannel && <ChannelDialog open={editOpen} onOpenChange={setEditOpen} conversation={conv} />}
      <MembersDialog open={membersOpen} onOpenChange={setMembersOpen} conversation={conv} />

      <AlertDialog open={confirm !== null} onOpenChange={(v) => !v && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'delete' ? `¿Eliminar #${conv.name}?` : isChannel ? `¿Salir de #${conv.name}?` : '¿Cerrar esta conversación?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'delete'
                ? 'Se borran para todos los mensajes, hilos y archivos del canal. Las tareas creadas desde él se conservan. No se puede deshacer.'
                : isChannel
                  ? conv.isPrivate
                    ? 'Es privado: para volver, alguien de adentro tendrá que invitarte.'
                    : 'Puedes volver a unirte cuando quieras desde "Explorar canales".'
                  : 'Se oculta de tu lista hasta que llegue un mensaje nuevo. No se borra nada.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void (confirm === 'delete' ? destroy() : leaveOrClose());
              }}
              className={cn(confirm === 'delete' && 'bg-destructive text-destructive-foreground hover:bg-destructive/90')}
            >
              {busy && <Loader2 className="animate-spin" />}
              {confirm === 'delete' ? 'Eliminar' : isChannel ? 'Salir' : 'Cerrar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
