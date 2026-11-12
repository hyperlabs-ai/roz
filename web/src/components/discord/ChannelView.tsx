import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronRight, CloudOff, ExternalLink, Lock, MessagesSquare } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useDiscord } from '@/discord/DiscordContext';
import { plainText } from '@/discord/markdown';
import { discordUrl, isForum, type ChannelEntry, type UiMessage } from '@/discord/model';
import { useChannelMessages } from '@/discord/useChannelMessages';
import { ApiError, discordApi, type DiscordMessageView, type DiscordThreadView } from '@/lib/api';
import { relative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CHAT_BAR, ChannelGlyph, channelLabel } from './ChannelSidebar';
import { DiscordComposer, type ComposerSend } from './DiscordComposer';
import { DiscordInline, type OnTask } from './DiscordMarkdown';
import { DiscordMessageList } from './DiscordMessageList';
import type { MessageHandlers } from './DiscordMessage';
import { BridgeBanner, LimitsNote } from './DiscordStatus';
import { ChatState } from './ChatState';

/** Errores de envío del contrato (§B.4) en palabras de la persona. */
export function sendErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'DISCORD_CANNOT_SEND':
        return 'No tienes permiso para escribir en este canal.';
      case 'DISCORD_CHANNEL_UNSUPPORTED':
        return 'En este canal no se puede escribir desde roz.';
      case 'DISCORD_THREAD_LOCKED':
        return 'El hilo está archivado o cerrado.';
      case 'DISCORD_BOT_PERMISSIONS':
        return 'El bot de roz no tiene permiso para publicar en este canal (Manage Webhooks).';
      case 'DISCORD_UNAVAILABLE':
        return 'Discord no respondió. Reintenta en unos segundos.';
      case 'DISCORD_UPLOAD_TOO_LARGE':
        return e.message;
      default:
        if (e.status === 413) return 'Los adjuntos son demasiado grandes para Discord.';
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

function ThreadsPopover({ channel }: { channel: NonNullable<ChannelEntry['channel']> }) {
  const navigate = useNavigate();
  const [archived, setArchived] = useState<DiscordThreadView[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);

  async function loadArchived(before?: string) {
    setBusy(true);
    try {
      const r = await discordApi.archivedThreads(channel.id, { before });
      setArchived((prev) => [...(before ? prev ?? [] : []), ...r.threads]);
      setHasMore(r.hasMore);
    } catch (e) {
      toast.error('No se cargaron los hilos archivados', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const row = (t: DiscordThreadView) => (
    <button
      key={t.id}
      type="button"
      onClick={() => navigate(`/app/chat/${t.id}`)}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-sidebar"
    >
      <MessagesSquare className="size-4 shrink-0 text-faint" />
      <span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>
      {t.private && <Lock className="size-3 text-faint" />}
      <span className="shrink-0 text-[10px] text-faint tabular-nums">{t.lastMessageAt ? relative(t.lastMessageAt) : ''}</span>
    </button>
  );

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Hilos">
              <MessagesSquare />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Hilos</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-2">
        <div className="px-2 pb-1 pt-1 label-caps text-faint">Hilos activos</div>
        {channel.threads.length ? channel.threads.map(row) : <p className="px-2 py-1.5 text-sm text-muted-foreground">Ninguno.</p>}
        <div className="mt-2 border-t px-2 pb-1 pt-2 label-caps text-faint">Archivados</div>
        {archived === null ? (
          <button type="button" onClick={() => void loadArchived()} className="px-2 py-1.5 text-sm text-orange-ink hover:underline" disabled={busy}>
            {busy ? 'Cargando…' : 'Ver hilos archivados'}
          </button>
        ) : (
          <>
            {archived.length ? archived.map(row) : <p className="px-2 py-1.5 text-sm text-muted-foreground">Ninguno.</p>}
            {hasMore && (
              <button
                type="button"
                onClick={() => void loadArchived(archived[archived.length - 1]?.archivedAt ?? undefined)}
                className="px-2 py-1.5 text-sm text-orange-ink hover:underline"
                disabled={busy}
              >
                {busy ? 'Cargando…' : 'Más'}
              </button>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Header({ entry, onBack }: { entry: ChannelEntry; onBack?: () => void }) {
  const { channels, guildId } = useDiscord();
  const parent = entry.isThread && entry.parentId ? channels.get(entry.parentId) : null;
  const topic = entry.topic;
  return (
    // Encabezado del canal, a la misma altura (CHAT_BAR) que el del servidor en la barra de canales.
    // Una sola línea como en Discord: glifo + nombre │ tema, y las acciones a la derecha. Sin logo de
    // Discord aquí: el servidor ya se identifica en su barra (antes se repetía en ambas).
    <header className={cn(CHAT_BAR, 'flex shrink-0 items-center gap-2 border-b bg-card pl-2 pr-2 md:pl-5 md:pr-3')}>
      {onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Volver a los canales">
          <ArrowLeft />
        </Button>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {parent && (
          <>
            <Link
              to={`/app/chat/${parent.id}`}
              className="hidden min-w-0 max-w-[40%] shrink items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground sm:flex"
            >
              <ChannelGlyph name={parent.name} type={parent.type} />
              <span className="truncate text-[15px] font-medium">{channelLabel(parent.name)}</span>
            </Link>
            <ChevronRight className="hidden size-4 shrink-0 text-faint sm:block" />
          </>
        )}
        <ChannelGlyph name={entry.name} type={entry.type} thread={entry.isThread} className="text-muted-foreground" />
        <h2 className="shrink-0 truncate text-[16px] font-semibold tracking-[-0.02em] max-md:shrink">{channelLabel(entry.name)}</h2>
        {entry.thread?.private && <Lock className="size-3.5 shrink-0 text-faint" aria-label="Hilo privado" />}
        {topic && (
          <>
            <span aria-hidden className="mx-2 hidden h-5 w-px shrink-0 bg-border lg:block" />
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="hidden min-w-0 flex-1 truncate text-[13px] text-muted-foreground lg:block">
                  <DiscordInline text={topic} />
                </p>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm">{topic}</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {entry.channel && !isForum(entry.type) && <ThreadsPopover channel={entry.channel} />}
        <LimitsNote channelId={entry.id} compact />
        {guildId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="ghost" size="icon-sm">
                <a href={discordUrl(guildId, entry.id)} target="_blank" rel="noopener noreferrer" aria-label="Abrir en Discord">
                  <ExternalLink />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Abrir en Discord</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}

/** Foro o canal de medios: no se escribe en el foro raíz; se abren sus publicaciones (hilos). */
function ForumView({ entry }: { entry: ChannelEntry }) {
  const { guildId } = useDiscord();
  const navigate = useNavigate();
  const threads = entry.channel?.threads ?? [];
  // Lista (no rejilla de tarjetas): una fila por publicación, sin huecos con cualquier cantidad.
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-3xl gap-4 px-4 py-5 md:px-6">
        <div className="flex items-center justify-between gap-3">
          <span className="label-caps">
            {threads.length === 1 ? '1 publicación activa' : `${threads.length} publicaciones activas`}
          </span>
          {guildId && (
            <Button asChild variant="secondary" size="sm">
              <a href={discordUrl(guildId, entry.id)} target="_blank" rel="noopener noreferrer">
                Nueva publicación <ExternalLink />
              </a>
            </Button>
          )}
        </div>
        {threads.length === 0 ? (
          <div className="grid justify-items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
            <span className="grid size-10 place-items-center rounded-[10px] bg-panel text-muted-foreground">
              <MessagesSquare className="size-5" />
            </span>
            <p className="text-sm font-medium">Sin publicaciones activas</p>
            <p className="max-w-xs text-[13px] text-muted-foreground">Las publicaciones se crean en Discord; aquí se leen y se responden.</p>
          </div>
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border bg-card">
            {threads.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/app/chat/${t.id}`)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-sidebar"
                >
                  <MessagesSquare className="size-4 shrink-0 text-faint" />
                  <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold tracking-[-0.01em]">{t.name}</span>
                  {t.locked && <Lock className="size-3.5 shrink-0 text-faint" aria-label="Cerrado" />}
                  {t.messageCount != null && (
                    <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">{t.messageCount}</span>
                  )}
                  {t.lastMessageAt && (
                    <span className="hidden w-20 shrink-0 text-right text-[12px] text-faint tabular-nums sm:block">{relative(t.lastMessageAt)}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ChannelStart({ entry }: { entry: ChannelEntry }) {
  const label = channelLabel(entry.name);
  return (
    <div className="grid gap-2 px-4 pb-4 pt-8 md:px-5">
      <span className="grid size-12 place-items-center rounded-[12px] bg-panel text-muted-foreground">
        <ChannelGlyph name={entry.name} type={entry.type} thread={entry.isThread} className="size-6 text-[24px]" />
      </span>
      <h3 className="text-[22px] font-semibold leading-tight tracking-[-0.03em]">
        {entry.isThread ? label : `Este es el inicio de #${label}`}
      </h3>
      {entry.topic && <p className="text-sm text-muted-foreground">{entry.topic}</p>}
    </div>
  );
}

/**
 * Un canal o hilo de Discord abierto: encabezado (nombre, tema, ícono de Discord), banner del puente,
 * mensajes con tiempo real y compositor. Se monta con `key={channelId}`: cambiar de canal reinicia
 * todo el estado.
 */
export function ChannelView({
  entry,
  focusMessageId,
  onBack,
  onCreateIssue,
  onTask,
}: {
  entry: ChannelEntry;
  focusMessageId: string | null;
  onBack?: () => void;
  onCreateIssue: (m: DiscordMessageView, apply: (m: DiscordMessageView) => void, patch: (id: string, fn: (m: UiMessage) => UiMessage) => void) => void;
  onTask: OnTask;
}) {
  const navigate = useNavigate();
  const discord = useDiscord();
  const forum = isForum(entry.type);
  const [focus, setFocus] = useState<string | null>(focusMessageId);
  const messages = useChannelMessages(entry.id, forum ? null : focusMessageId);
  const [replyTo, setReplyTo] = useState<DiscordMessageView | null>(null);

  // Un enlace `?m=<id>` nuevo dentro del mismo canal (p. ej. "Copiar enlace" pegado aquí).
  useEffect(() => setFocus(focusMessageId), [focusMessageId]);

  useEffect(() => {
    discord.setActive(entry.id);
    return () => discord.setActive(null);
  }, [entry.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const abilities = entry.thread?.abilities ?? entry.channel?.abilities ?? null;
  const closed = !!entry.thread && (entry.thread.locked || entry.thread.archived);
  const blockedReason = closed
    ? entry.thread!.locked
      ? 'Este hilo está cerrado: solo se puede escribir desde Discord con permiso de moderación.'
      : 'Este hilo está archivado. Se reabre al escribir en él desde Discord.'
    : !entry.supported
      ? 'En este canal no se puede escribir desde roz.'
      : null;
  const canSend = !!abilities?.send && !closed && entry.supported;

  const { apply, patch, drop, retry, discard, jumpTo, send } = messages;

  const handlers = useMemo<MessageHandlers>(
    () => ({
      onReply: (m) => setReplyTo(m),
      onCreateIssue: (m) => onCreateIssue(m, apply, patch),
      onTask,
      onJump: (id) => {
        setFocus(null);
        requestAnimationFrame(() => setFocus(id));
        jumpTo(id);
      },
      onOpenThread: (id) => navigate(`/app/chat/${id}`),
      onRetry: (m) => {
        retry(m).catch((e) => toast.error('No se envió', { description: sendErrorText(e) }));
      },
      onDiscard: discard,
      onApplied: apply,
      onDeleted: (id) => drop([id]),
    }),
    [onCreateIssue, onTask, apply, patch, drop, retry, discard, jumpTo, navigate],
  );

  const onSend = useCallback(
    (p: ComposerSend) => {
      const reply = replyTo;
      setReplyTo(null);
      send({
        content: p.content,
        replyToId: p.replyToId,
        uploadIds: p.uploadIds,
        attachmentNames: p.attachmentNames,
        replyTo: reply
          ? { id: reply.id, author: reply.author, excerpt: plainText(reply.content).slice(0, 120) || null, deleted: false }
          : null,
      }).catch((e) => toast.error('No se envió el mensaje', { description: sendErrorText(e) }));
    },
    [replyTo, send],
  );

  const markSeen = useCallback((id: string) => discord.markSeen(entry.id, id), [discord.markSeen, entry.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const error = messages.error;
  const notFound = error instanceof ApiError && (error.status === 404 || error.status === 403);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <Header entry={entry} onBack={onBack} />
      <BridgeBanner />
      {forum ? (
        <ForumView entry={entry} />
      ) : notFound ? (
        <ChatState
          icon={<Lock />}
          color="red"
          eyebrow="Sin acceso"
          title="Este canal ya no está a tu alcance."
          lede="Se borró en Discord o tu cuenta ya no puede verlo."
        />
      ) : error && !messages.messages.length ? (
        <ChatState
          icon={<CloudOff />}
          color="red"
          eyebrow="Sin mensajes"
          title="No se cargaron los mensajes."
          lede={error instanceof Error ? error.message : undefined}
          action={
            <Button variant="secondary" size="sm" onClick={() => void messages.reload()}>
              Reintentar
            </Button>
          }
        />
      ) : (
        <>
          <DiscordMessageList
            channelId={entry.id}
            messages={messages.messages}
            hasMore={messages.hasMore}
            backfillComplete={messages.backfillComplete}
            loading={messages.loading}
            loadingOlder={messages.loadingOlder}
            onLoadOlder={() => void messages.loadOlder()}
            detached={messages.detached}
            missed={messages.missed}
            onJumpPresent={() => {
              setFocus(null);
              void messages.jumpToPresent();
            }}
            focusId={focus}
            onSeen={markSeen}
            handlers={handlers}
            empty={
              abilities && !abilities.readHistory ? (
                <p className="mx-4 my-3 flex items-center gap-2 rounded-md bg-panel px-3 py-2 text-sm text-muted-foreground md:mx-5">
                  <Lock className="size-4" /> No tienes permiso para ver el historial de este canal.
                </p>
              ) : (
                <ChannelStart entry={entry} />
              )
            }
          />
          <DiscordComposer
            key={entry.id}
            channelId={entry.id}
            channelName={entry.name}
            canSend={canSend}
            canAttach={!!abilities?.attach}
            blockedReason={blockedReason}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            onSend={onSend}
          />
        </>
      )}
    </div>
  );
}

