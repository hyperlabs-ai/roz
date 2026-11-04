import { memo, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertCircle, FileText, ListPlus, Loader2, MessageSquareReply, MoreHorizontal, Pencil, RotateCw, Trash2, X,
} from 'lucide-react';
import { useChat } from '@/chat/ChatContext';
import { useMessageActions } from '@/chat/useMessages';
import { AvatarStack, UserAvatar } from '@/components/bits';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MessageBody } from './MessageBody';
import { MessageTasks, StatusBlock, TaskCreatedNotice, useTaskBridge } from './TaskChip';
import {
  decodeMentions, encodeMentions, formatBytes, mentionsMe, timeLabel, type ChatAttachment, type ChatMessage,
} from '@/lib/chat';
import { relative } from '@/lib/format';
import { cn } from '@/lib/utils';

function Attachments({ items }: { items: ChatAttachment[] }) {
  if (!items.length) return null;
  const images = items.filter((a) => a.contentType?.startsWith('image/') && a.url);
  const files = items.filter((a) => !images.includes(a));
  return (
    <div className="mt-1.5 space-y-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((a) => (
            <a key={a.id} href={a.url!} target="_blank" rel="noreferrer noopener" className="block overflow-hidden rounded-lg border bg-muted">
              <img src={a.url!} alt={a.name} loading="lazy" className="max-h-60 max-w-[min(20rem,100%)] object-cover" />
            </a>
          ))}
        </div>
      )}
      {files.map((a) => (
        <a
          key={a.id}
          href={a.url ?? undefined}
          target="_blank"
          rel="noreferrer noopener"
          className="flex w-full max-w-sm items-center gap-3 rounded-lg border bg-card px-3 py-2 shadow-sm transition-colors hover:bg-accent"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <FileText className="size-5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{a.name}</span>
            <span className="block text-xs text-muted-foreground">{formatBytes(a.size) || 'Archivo'}</span>
          </span>
        </a>
      ))}
    </div>
  );
}

function EditBox({ message, onDone }: { message: ChatMessage; onDone: () => void }) {
  const { nameOf, devs } = useChat();
  const { edit } = useMessageActions();
  const [text, setText] = useState(() => decodeMentions(message.body, nameOf));
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);

  async function save() {
    const body = encodeMentions(text.trim(), devs);
    if (body === message.body) return onDone();
    if (!body && !message.attachments.length) {
      toast.error('El mensaje no puede quedar vacío', { description: 'Si ya no sirve, elimínalo.' });
      return;
    }
    setBusy(true);
    try {
      await edit(message.id, body);
      onDone();
    } catch (e) {
      toast.error('No se pudo editar', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 rounded-lg border bg-background p-2 focus-within:ring-1 focus-within:ring-ring">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onDone();
          }
        }}
        rows={1}
        className="w-full resize-none bg-transparent text-sm outline-none"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-muted-foreground">Esc para cancelar · Enter para guardar</span>
        <Button size="sm" variant="ghost" onClick={onDone} disabled={busy}>Cancelar</Button>
        <Button size="sm" onClick={() => void save()} disabled={busy}>
          {busy && <Loader2 className="animate-spin" />} Guardar
        </Button>
      </div>
    </div>
  );
}

export const MessageItem = memo(function MessageItem({
  message: m,
  grouped,
  inThread = false,
  isRoot = false,
  onOpenThread,
  onRetry,
  onDiscard,
}: {
  message: ChatMessage;
  /** Continúa el grupo del mensaje anterior: sin avatar ni nombre. */
  grouped: boolean;
  /** Se pinta dentro del panel de hilo (sin resumen de hilo ni "responder"). */
  inThread?: boolean;
  /** Es el mensaje raíz del hilo abierto. */
  isRoot?: boolean;
  onOpenThread?: (rootId: string) => void;
  onRetry?: (m: ChatMessage) => void;
  onDiscard?: (m: ChatMessage) => void;
}) {
  const { me, devOf } = useChat();
  const { remove } = useMessageActions();
  const { createFrom } = useTaskBridge();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (m.kind === 'system') {
    return (
      <div className="px-4 py-1 md:px-5">
        <TaskCreatedNotice message={m} />
      </div>
    );
  }

  const author = m.authorDevId ? devOf(m.authorDevId) : undefined;
  const authorName = author?.name ?? 'Alguien';
  const mine = !!me && m.authorDevId === me;
  const deleted = !!m.deletedAt;
  const local = m.pending || m.failed;
  const highlight = !mine && !deleted && mentionsMe(m, me);
  const canReply = !inThread && !local && !deleted;
  const canTask = !local && !deleted;
  const repliers = m.replyDevIds
    .map((id) => devOf(id))
    .filter((d): d is NonNullable<typeof d> => !!d)
    .map((d) => ({ name: d.name, avatarUrl: d.avatarUrl }));

  async function doDelete() {
    try {
      await remove(m);
    } catch (e) {
      toast.error('No se pudo eliminar', { description: e instanceof Error ? e.message : String(e) });
    }
  }

  const menuItems = (
    <>
      {canReply && onOpenThread && (
        <DropdownMenuItem onSelect={() => onOpenThread(m.id)}>
          <MessageSquareReply /> Responder en hilo
        </DropdownMenuItem>
      )}
      {canTask && (
        <DropdownMenuItem onSelect={() => createFrom(m)}>
          <ListPlus /> Crear tarea
        </DropdownMenuItem>
      )}
      {mine && !local && !deleted && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil /> Editar
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setConfirmDelete(true)} className="text-destructive focus:text-destructive">
            <Trash2 /> Eliminar
          </DropdownMenuItem>
        </>
      )}
    </>
  );

  return (
    <div
      data-message-id={m.id}
      className={cn(
        'group/msg relative flex gap-3 px-4 transition-colors md:px-5',
        grouped ? 'py-0.5' : 'pt-2 pb-0.5',
        highlight ? 'bg-warning/5 shadow-[inset_2px_0_0_hsl(var(--warning))]' : 'hover:bg-accent/50',
        isRoot && 'pb-2',
      )}
    >
      {/* Gutter: avatar en el primer mensaje del grupo; la hora al pasar el mouse en los demás. */}
      <div className="w-9 shrink-0">
        {grouped ? (
          <span className="block pt-1 text-right text-[10px] leading-5 text-muted-foreground opacity-0 group-hover/msg:opacity-100">
            {timeLabel(m.createdAt)}
          </span>
        ) : (
          <UserAvatar url={author?.avatarUrl ?? null} name={authorName} className="size-9 rounded-lg" />
        )}
      </div>

      <div className={cn('min-w-0 flex-1', local && m.pending && 'opacity-60')}>
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-semibold">{authorName}</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0 text-xs text-muted-foreground">{timeLabel(m.createdAt)}</span>
              </TooltipTrigger>
              <TooltipContent>{new Date(m.createdAt).toLocaleString('es-MX')}</TooltipContent>
            </Tooltip>
          </div>
        )}

        {deleted ? (
          <p className="text-sm italic text-muted-foreground">Este mensaje fue eliminado.</p>
        ) : editing ? (
          <EditBox message={m} onDone={() => setEditing(false)} />
        ) : (
          <>
            {m.body && (
              <div className="flex flex-wrap items-baseline gap-x-1.5">
                <MessageBody body={m.body} citedTasks={m.citedTasks} className="min-w-0" />
                {m.editedAt && <span className="text-[11px] text-muted-foreground">(editado)</span>}
              </div>
            )}
            {(m.meta as { type?: string } | null)?.type === 'status' && <StatusBlock message={m} />}
            <Attachments items={m.attachments} />
          </>
        )}

        {!deleted && <MessageTasks message={m} />}

        {m.failed && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-destructive">
            <AlertCircle className="size-3.5" /> No se envió.
            <button type="button" className="inline-flex items-center gap-1 font-medium hover:underline" onClick={() => onRetry?.(m)}>
              <RotateCw className="size-3" /> Reintentar
            </button>
            <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:underline" onClick={() => onDiscard?.(m)}>
              <X className="size-3" /> Descartar
            </button>
          </div>
        )}

        {!inThread && m.replyCount > 0 && onOpenThread && (
          <button
            type="button"
            onClick={() => onOpenThread(m.id)}
            className="-ml-1 mt-1 flex items-center gap-2 rounded-md px-1 py-0.5 text-xs transition-colors hover:bg-card hover:shadow-sm"
          >
            <AvatarStack people={repliers} size="size-5" max={3} />
            <span className="font-semibold text-primary">
              {m.replyCount === 1 ? '1 respuesta' : `${m.replyCount} respuestas`}
            </span>
            {m.lastReplyAt && <span className="text-muted-foreground">Última respuesta {relative(m.lastReplyAt)}</span>}
          </button>
        )}
      </div>

      {/* Acciones: barra flotante al pasar el mouse (desktop) y menú siempre a mano en táctil. */}
      {!local && !deleted && !editing && (
        <>
          <div className="absolute -top-3 right-3 z-10 hidden items-center rounded-lg border bg-popover p-0.5 shadow-md group-hover/msg:flex has-[[data-state=open]]:flex [@media(hover:none)]:!hidden">
            {canReply && onOpenThread && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => onOpenThread(m.id)} aria-label="Responder en hilo">
                    <MessageSquareReply />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Responder en hilo</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={() => createFrom(m)} aria-label="Crear tarea">
                  <ListPlus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Crear tarea</TooltipContent>
            </Tooltip>
            {mine && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Más acciones">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">{menuItems}</DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          <div className="absolute right-2 top-1 hidden [@media(hover:none)]:block">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" aria-label="Acciones del mensaje">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">{menuItems}</DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar este mensaje?</AlertDialogTitle>
            <AlertDialogDescription>
              Se borra para todos, junto con sus archivos. {m.replyCount > 0 && 'Las respuestas del hilo se conservan.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doDelete()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
