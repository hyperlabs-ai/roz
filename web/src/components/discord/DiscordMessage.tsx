import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle, CornerUpLeft, ExternalLink, Link2, ListPlus, Loader2, MessagesSquare, MoreHorizontal, Pencil, Pin,
  Reply, RotateCw, Trash2, UserPlus, X,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { useDiscord } from '@/discord/DiscordContext';
import { decodeComposer, discordUrl, encodeComposer, isUserMessage, mentionsMe, type UiMessage } from '@/discord/model';
import { discordApi, type DiscordAuthorView, type DiscordMessageView } from '@/lib/api';
import { timeLabel } from '@/lib/chat-text';
import { relative } from '@/lib/format';
import { GithubAvatar, RozBotAvatar } from '@/components/brand';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DiscordInline, DiscordMarkdown, type OnTask } from './DiscordMarkdown';
import { DiscordAttachments, DiscordEmbeds, DiscordReactions, DiscordStickers, DiscordTaskCards } from './MessageParts';
import { cn } from '@/lib/utils';

export interface MessageHandlers {
  onReply: (m: DiscordMessageView) => void;
  onCreateIssue: (m: DiscordMessageView) => void;
  onTask: OnTask;
  onJump: (messageId: string) => void;
  onOpenThread: (threadId: string) => void;
  onRetry: (m: UiMessage) => void;
  onDiscard: (m: UiMessage) => void;
  /** Respuesta de la API (edición): mismo camino que el tiempo real. */
  onApplied: (m: DiscordMessageView) => void;
  onDeleted: (id: string) => void;
}

/** Etiqueta junto al nombre: mensajes de roz, de apps (webhooks ajenos) y de bots. */
function AuthorTag({ m }: { m: DiscordMessageView }) {
  if (m.fromRoz) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="rounded-[4px] bg-orange-soft px-1 py-px label-caps text-[9.5px] text-orange-ink">
            roz
          </span>
        </TooltipTrigger>
        <TooltipContent>Enviado desde roz. En Discord sale con su nombre y foto, con la etiqueta APP.</TooltipContent>
      </Tooltip>
    );
  }
  if (m.author.webhook || m.author.bot) {
    return (
      <span className="rounded-[4px] bg-blue-soft px-1 py-px label-caps text-[9.5px] text-blue-ink">
        {m.author.webhook ? 'App' : 'Bot'}
      </span>
    );
  }
  return null;
}

function Avatar({ a, className }: { a: DiscordAuthorView; className?: string }) {
  // Los avisos del propio bot de roz llevan a Roz-bot, no el ícono que tenga la app en Discord.
  if (a.rozBot) return <RozBotAvatar className={className} title={a.displayName} />;
  return <GithubAvatar url={a.avatarUrl} id={a.devId} name={a.displayName} color="chart-2" className={className} />;
}

/** Cita de una respuesta: línea curva + autor + extracto; al pulsarla salta al original. */
function ReplyQuote({ m, onJump }: { m: DiscordMessageView; onJump: (id: string) => void }) {
  const r = m.replyTo!;
  return (
    <div className="relative mb-0.5 flex min-w-0 items-center gap-1.5 pl-[3.25rem] text-[12.5px] text-muted-foreground md:pl-[3.5rem]">
      {/* Conector curvo como en Discord, con la hairline de roz. */}
      <span aria-hidden className="absolute left-[1.15rem] top-1/2 h-2.5 w-7 rounded-tl-md border-l-2 border-t-2 border-border md:left-[1.4rem]" />
      {r.deleted || !r.excerpt ? (
        <span className="italic text-faint">{r.deleted ? 'El mensaje original se eliminó.' : 'Mensaje original no disponible.'}</span>
      ) : (
        <button type="button" onClick={() => onJump(r.id)} className="flex min-w-0 items-center gap-1.5 hover:text-foreground">
          {r.author && <Avatar a={r.author} className="size-4" />}
          <span className="shrink-0 font-semibold text-foreground/80">{r.author?.displayName ?? 'Alguien'}</span>
          <DiscordInline text={r.excerpt} className="truncate" />
        </button>
      )}
    </div>
  );
}

function EditBox({ m, onDone, onApplied }: { m: DiscordMessageView; onDone: () => void; onApplied: (m: DiscordMessageView) => void }) {
  const { members, channels, roles, emojis } = useDiscord();
  const decoded = useRef(
    decodeComposer(m.content, {
      user: (id) => members.get(id)?.displayName ?? m.mentions.find((u) => u.id === id)?.globalName ?? m.mentions.find((u) => u.id === id)?.username,
      channel: (id) => channels.get(id)?.name,
      role: (id) => roles.get(id)?.name,
    }),
  );
  const [text, setText] = useState(decoded.current.text);
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
    const content = encodeComposer(text.trim(), decoded.current.tokens, emojis);
    if (content === m.content) return onDone();
    if (!content && !m.attachments.length) {
      toast.error('El mensaje no puede quedar vacío', { description: 'Si ya no sirve, elimínalo.' });
      return;
    }
    setBusy(true);
    try {
      const { message } = await discordApi.edit(m.id, content);
      onApplied(message);
      onDone();
    } catch (e) {
      toast.error('No se pudo editar', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 rounded-md border bg-card p-2 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
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
        maxLength={2000}
        className="w-full resize-none bg-transparent text-sm outline-none"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <span className="mr-auto text-[10.5px] text-faint tabular-nums">Esc cancela · Enter guarda</span>
        <Button size="sm" variant="secondary" onClick={onDone} disabled={busy}>
          Cancelar
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={busy}>
          {busy && <Loader2 className="animate-spin" />} Guardar
        </Button>
      </div>
    </div>
  );
}

/** Mensajes de sistema de Discord (alguien se unió, fijó un mensaje, abrió un hilo…). */
function SystemLine({ m, h }: { m: DiscordMessageView; h: MessageHandlers }) {
  const who = <span className="font-medium text-foreground">{m.author.displayName}</span>;
  let icon = <MessagesSquare className="size-3.5" />;
  let body: ReactNode = m.content ? <DiscordInline text={m.content} /> : 'Mensaje del sistema de Discord.';
  switch (m.type) {
    case 6:
      icon = <Pin className="size-3.5" />;
      body = <>{who} fijó un mensaje en este canal.</>;
      break;
    case 7:
      icon = <UserPlus className="size-3.5 text-green" />;
      body = <>{who} se unió al servidor.</>;
      break;
    case 8:
      body = <>{who} mejoró el servidor con un boost.</>;
      break;
    case 18:
      body = (
        <>
          {who} inició un hilo:{' '}
          {m.thread ? (
            <button type="button" className="font-medium text-foreground hover:underline" onClick={() => h.onOpenThread(m.thread!.id)}>
              {m.thread.name}
            </button>
          ) : (
            <span className="font-medium">{m.content}</span>
          )}
        </>
      );
      break;
    case 21:
      // Mensaje inicial de un hilo: Discord lo muestra como "inicio del hilo".
      body = <>Inicio del hilo.</>;
      break;
    default:
      break;
  }
  return (
    <div className="flex items-center gap-3 px-4 py-1 text-[13px] text-muted-foreground md:px-5">
      <span className="grid w-9 shrink-0 place-items-center text-faint">{icon}</span>
      <span className="min-w-0">{body}</span>
      <span className="shrink-0 text-[10.5px] text-faint tabular-nums">{timeLabel(m.createdAt)}</span>
    </div>
  );
}

export const DiscordMessage = memo(function DiscordMessage({
  m,
  grouped,
  focused,
  handlers: h,
}: {
  m: UiMessage;
  grouped: boolean;
  /** Mensaje al que se saltó (cita, enlace): se resalta un momento. */
  focused: boolean;
  handlers: MessageHandlers;
}) {
  const { me, myDevId, guildId } = useDiscord();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!isUserMessage(m)) return <SystemLine m={m} h={h} />;

  const local = !!m.pending || !!m.failed;
  // Solo los mensajes propios salidos de roz se editan/borran desde roz (contrato §B.5).
  const mine = m.fromRoz && !!myDevId && m.author.devId === myDevId;
  const highlight = !mine && mentionsMe(m, me);
  const link = guildId ? discordUrl(guildId, m.channelId, m.id) : null;

  async function doDelete() {
    try {
      await discordApi.remove(m.id);
      h.onDeleted(m.id);
    } catch (e) {
      toast.error('No se pudo eliminar', { description: e instanceof Error ? e.message : String(e) });
    }
  }

  function copyLink() {
    const url = `${window.location.origin}/chat/${m.channelId}?m=${m.id}`;
    void navigator.clipboard?.writeText(url).then(
      () => toast.success('Enlace copiado'),
      () => toast.error('No se pudo copiar'),
    );
  }

  const menuItems = (
    <>
      <DropdownMenuItem onSelect={() => h.onReply(m)}>
        <Reply /> Responder
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => h.onCreateIssue(m)}>
        <ListPlus /> Crear issue
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={copyLink}>
        <Link2 /> Copiar enlace
      </DropdownMenuItem>
      {link && (
        <DropdownMenuItem asChild>
          <a href={link} target="_blank" rel="noopener noreferrer">
            <ExternalLink /> Abrir en Discord
          </a>
        </DropdownMenuItem>
      )}
      {mine && (
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
        'group/msg relative transition-colors duration-700',
        grouped ? 'py-0.5' : 'pb-0.5 pt-2',
        highlight ? 'bg-yellow-soft/60 shadow-[inset_3px_0_0_hsl(var(--yellow))]' : 'hover:bg-sidebar',
        focused && 'bg-orange-soft/70',
      )}
    >
      {m.replyTo && <ReplyQuote m={m} onJump={h.onJump} />}
      <div className="flex gap-3 px-4 md:px-5">
        <div className="w-9 shrink-0">
          {grouped ? (
            <span className="block pt-1 text-right text-[9.5px] leading-5 text-faint opacity-0 group-hover/msg:opacity-100 tabular-nums">
              {timeLabel(m.createdAt)}
            </span>
          ) : (
            <Avatar a={m.author} className="size-9" />
          )}
        </div>

        <div className={cn('min-w-0 flex-1', m.pending && 'opacity-60')}>
          {!grouped && (
            <div className="flex items-baseline gap-2">
              <span className="truncate text-sm font-semibold tracking-[-0.01em]" title={m.author.username}>
                {m.author.displayName}
              </span>
              <AuthorTag m={m} />
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="shrink-0 text-[10.5px] text-faint tabular-nums">{timeLabel(m.createdAt)}</span>
                </TooltipTrigger>
                <TooltipContent>{new Date(m.createdAt).toLocaleString('es-MX')}</TooltipContent>
              </Tooltip>
              {m.pinned && <Pin className="size-3 shrink-0 text-faint" aria-label="Fijado" />}
            </div>
          )}

          {editing ? (
            <EditBox m={m} onDone={() => setEditing(false)} onApplied={h.onApplied} />
          ) : (
            <>
              {m.content && (
                <div className="flex flex-wrap items-baseline gap-x-1.5">
                  <DiscordMarkdown content={m.content} mentions={m.mentions} tasks={m.tasks} onTask={h.onTask} />
                  {m.editedAt && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-[10px] text-faint tabular-nums">(editado)</span>
                      </TooltipTrigger>
                      <TooltipContent>Editado {new Date(m.editedAt).toLocaleString('es-MX')}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              )}
              <DiscordAttachments items={m.attachments} />
              <DiscordEmbeds items={m.embeds} onTask={h.onTask} />
              <DiscordStickers items={m.stickers} />
            </>
          )}

          <DiscordReactions items={m.reactions} me={me} />
          <DiscordTaskCards tasks={m.tasks.filter((t) => t.workItemId || t.name)} onTask={h.onTask} />

          {m.thread && (
            <button
              type="button"
              onClick={() => h.onOpenThread(m.thread!.id)}
              className="-ml-1 mt-1 flex max-w-full items-center gap-2 rounded-md border border-transparent px-1.5 py-1 text-xs transition-colors hover:border-border hover:bg-card"
            >
              <CornerUpLeft className="size-3.5 shrink-0 -scale-y-100 text-faint" />
              <span className="truncate font-semibold text-foreground">{m.thread.name}</span>
              <span className="shrink-0 label-caps text-orange-ink">
                {m.thread.messageCount == null
                  ? 'Ver hilo'
                  : m.thread.messageCount === 1
                    ? '1 mensaje'
                    : `${m.thread.messageCount} mensajes`}
              </span>
              {m.thread.lastMessageAt && <span className="shrink-0 text-faint">Último {relative(m.thread.lastMessageAt)}</span>}
            </button>
          )}

          {m.failed && (
            <div className="mt-1 flex w-fit flex-wrap items-center gap-2 rounded-md bg-red-soft px-2 py-1 text-xs text-red">
              <AlertCircle className="size-3.5" /> No se envió.
              <button type="button" className="inline-flex items-center gap-1 font-medium hover:underline" onClick={() => h.onRetry(m)}>
                <RotateCw className="size-3" /> Reintentar
              </button>
              <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:underline" onClick={() => h.onDiscard(m)}>
                <X className="size-3" /> Descartar
              </button>
            </div>
          )}
        </div>
      </div>

      {!local && !editing && (
        <>
          <div className="absolute -top-3 right-3 z-10 hidden items-center gap-px rounded-md border bg-card p-0.5 shadow-md group-hover/msg:flex has-[[data-state=open]]:flex [@media(hover:none)]:!hidden">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={() => h.onReply(m)} aria-label="Responder">
                  <Reply />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Responder</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={() => h.onCreateIssue(m)} aria-label="Crear issue">
                  <ListPlus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Crear issue</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Más acciones">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">{menuItems}</DropdownMenuContent>
            </DropdownMenu>
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
            <AlertDialogDescription>Se borra también en Discord, para todo el servidor.</AlertDialogDescription>
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
