import { useState } from 'react';
import { ExternalLink, FileText, ListChecks, Loader2, Music } from 'lucide-react';
import { MediaGallery } from '@/components/chat/MediaGallery';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { attachmentKind, formatBytes } from '@/lib/chat-text';
import type { ChatAttachment as ChatAttachmentType } from '@/lib/chat';
import type { DiscordAttachment, DiscordEmbed, DiscordReaction, DiscordSticker, DiscordTaskRef } from '@/lib/api';
import { canonState, CLOSED_STATES, stateBadgeVariant } from '@/lib/labels';
import { Badge } from '@/components/ui/badge';
import { discordColor, emojiUrl, safeHttpUrl, stickerUrl } from '@/discord/model';
import { DiscordMarkdown, type OnTask } from './DiscordMarkdown';
import { cn } from '@/lib/utils';

// Piezas de un mensaje de Discord: adjuntos, embeds, stickers, reacciones (solo lectura) y fichas de
// tarea. Separadas del mensaje para que este se lea de un vistazo.

const toChat = (a: DiscordAttachment): ChatAttachmentType => ({
  id: a.id,
  name: a.filename,
  contentType: a.contentType,
  size: a.size,
  url: safeHttpUrl(a.url) ?? null,
});

/** Imagen/video con spoiler: borroso hasta que se pulsa (como en Discord). */
function SpoilerMedia({ items }: { items: ChatAttachmentType[] }) {
  const [shown, setShown] = useState(false);
  if (shown) return <MediaGallery items={items} />;
  return (
    <button
      type="button"
      onClick={() => setShown(true)}
      className="relative block overflow-hidden rounded-lg border"
      aria-label="Spoiler: pulsa para ver"
    >
      {items[0]?.url && attachmentKind(items[0]) === 'image' ? (
        <img src={items[0].url} alt="" className="max-h-60 max-w-[18rem] scale-110 object-cover blur-2xl" draggable={false} />
      ) : (
        <span className="block h-40 w-64 bg-panel" />
      )}
      <span className="absolute inset-0 grid place-items-center">
        <span className="rounded-btn bg-ink px-3 py-1.5 label-caps text-ink-foreground">
          Spoiler
        </span>
      </span>
    </button>
  );
}

export function DiscordAttachments({ items }: { items: DiscordAttachment[] }) {
  if (!items.length) return null;
  const pending = items.filter((a) => !a.url);
  const ready = items.filter((a) => a.url);
  const isMedia = (a: DiscordAttachment) => ['image', 'video'].includes(attachmentKind({ name: a.filename, contentType: a.contentType }));
  const media = ready.filter((a) => isMedia(a) && !a.spoiler).map(toChat);
  const spoilers = ready.filter((a) => isMedia(a) && a.spoiler).map(toChat);
  const audio = ready.filter((a) => a.contentType?.startsWith('audio/'));
  const files = ready.filter((a) => !isMedia(a) && !audio.includes(a));

  return (
    <div className="mt-1.5 space-y-1.5">
      {media.length > 0 && <MediaGallery items={media} />}
      {spoilers.length > 0 && <SpoilerMedia items={spoilers} />}
      {audio.map((a) => (
        <div key={a.id} className="flex w-full max-w-sm items-center gap-3 rounded-lg border bg-card px-3 py-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-panel text-muted-foreground">
            <Music className="size-[18px]" />
          </span>
          <div className="grid min-w-0 flex-1 gap-1">
            <span className="truncate text-sm font-medium">{a.filename}</span>
            <audio controls preload="none" src={safeHttpUrl(a.url)} className="h-8 w-full" />
          </div>
        </div>
      ))}
      {[...files, ...pending].map((a) => (
        <a
          key={a.id}
          href={safeHttpUrl(a.url)}
          target="_blank"
          rel="noreferrer noopener"
          className={cn(
            'flex w-full max-w-sm items-center gap-3 rounded-lg border bg-card px-3 py-2 transition-colors',
            a.url ? 'hover:bg-sidebar' : 'pointer-events-none opacity-70',
          )}
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-panel text-muted-foreground">
            {a.url ? <FileText className="size-[18px]" /> : <Loader2 className="size-[18px] animate-spin" />}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{a.filename}</span>
            <span className="block label-caps text-faint">
              {a.url ? formatBytes(a.size) || 'Archivo' : 'Enviando…'}
            </span>
          </span>
        </a>
      ))}
    </div>
  );
}

function EmbedMedia({ e }: { e: DiscordEmbed }) {
  if (e.video && e.type === 'gifv') {
    return <video src={safeHttpUrl(e.video.url)} autoPlay loop muted playsInline className="max-h-72 max-w-full rounded-lg border" />;
  }
  const img = e.image ?? e.thumbnail;
  if (!img) return null;
  return (
    <a href={safeHttpUrl(e.url) ?? safeHttpUrl(img.url)} target="_blank" rel="noopener noreferrer" className="block w-fit">
      <img src={safeHttpUrl(img.url)} alt={e.title ?? ''} loading="lazy" className="max-h-72 max-w-full rounded-lg border object-contain" />
    </a>
  );
}

/** Embed de Discord (link, video, rich): tarjeta panel con el filo del color que manda Discord. */
export function DiscordEmbeds({ items, onTask }: { items: DiscordEmbed[]; onTask?: OnTask }) {
  if (!items.length) return null;
  return (
    <div className="mt-1.5 grid gap-1.5">
      {items.map((e, i) => {
        // Imagen o GIF suelto (Tenor, Giphy, un .png pegado): solo el medio, sin tarjeta.
        if ((e.type === 'image' || e.type === 'gifv') && !e.title && !e.description) return <EmbedMedia key={i} e={e} />;
        const color = discordColor(e.color);
        const thumbSide = !!e.thumbnail && !e.image && e.type !== 'video';
        return (
          <div
            key={i}
            className={cn('grid max-w-[32rem] gap-1.5 rounded-md border border-l-4 bg-panel/60 p-3', !color && 'border-l-toggle-off')}
            // Filo con el color del embed: es un dato de Discord, no un color de la marca.
            style={color ? { borderLeftColor: color } : undefined}
          >
            <div className="flex gap-3">
              <div className="grid min-w-0 flex-1 content-start gap-1">
                {e.provider?.name && <span className="text-[11px] text-faint">{e.provider.name}</span>}
                {e.author && (
                  <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
                    {e.author.iconUrl && <img src={safeHttpUrl(e.author.iconUrl)} alt="" className="size-5 rounded-full" />}
                    {e.author.url ? (
                      <a href={safeHttpUrl(e.author.url)} target="_blank" rel="noopener noreferrer" className="hover:underline">
                        {e.author.name}
                      </a>
                    ) : (
                      e.author.name
                    )}
                  </span>
                )}
                {e.title &&
                  (e.url ? (
                    <a href={safeHttpUrl(e.url)} target="_blank" rel="noopener noreferrer" className="text-[14px] font-semibold text-blue-ink hover:underline">
                      {e.title}
                    </a>
                  ) : (
                    <span className="text-[14px] font-semibold">{e.title}</span>
                  ))}
                {e.description && <DiscordMarkdown content={e.description} onTask={onTask} className="text-[13.5px] text-muted-foreground" />}
                {e.fields.length > 0 && (
                  <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {e.fields.map((f, n) => (
                      <div key={n} className={cn('min-w-0', !f.inline && 'sm:col-span-3')}>
                        <div className="text-[12.5px] font-semibold">{f.name}</div>
                        <DiscordMarkdown content={f.value} className="text-[13px]" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {thumbSide && e.thumbnail && (
                <img src={safeHttpUrl(e.thumbnail.url)} alt="" loading="lazy" className="size-20 shrink-0 rounded-md object-cover" />
              )}
            </div>
            {(e.image || (e.thumbnail && !thumbSide)) && <EmbedMedia e={e} />}
            {(e.footer || e.timestamp) && (
              <div className="flex items-center gap-1.5 text-[11px] text-faint">
                {e.footer?.iconUrl && <img src={safeHttpUrl(e.footer.iconUrl)} alt="" className="size-4 rounded-full" />}
                {e.footer?.text}
                {e.footer && e.timestamp && ' · '}
                {e.timestamp && new Date(e.timestamp).toLocaleString('es-MX')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function DiscordStickers({ items }: { items: DiscordSticker[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {items.map((s) => {
        const url = stickerUrl(s.id, s.formatType);
        return url ? (
          <img key={s.id} src={url} alt={s.name} title={s.name} loading="lazy" className="size-40 object-contain" draggable={false} />
        ) : (
          <span key={s.id} className="rounded-md bg-panel px-2 py-1 text-[11px] text-muted-foreground tabular-nums">
            Sticker · {s.name}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Reacciones de SOLO LECTURA (contrato §B.7): emoji + conteo, y "tuya" si tu cuenta ligada está en
 * la lista. roz no pone reacciones: el bot no puede reaccionar como tú.
 */
export function DiscordReactions({ items, me }: { items: DiscordReaction[]; me: string | null }) {
  if (!items.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {items.map((r, i) => {
        const mine = !!me && r.userIds.includes(me);
        const label = r.emoji.id ? `:${r.emoji.name ?? 'emoji'}:` : r.emoji.name ?? '';
        return (
          <Tooltip key={`${r.emoji.id ?? r.emoji.name}-${i}`}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  'inline-flex h-6 cursor-default items-center gap-1 rounded-md border px-1.5 text-[12px] font-medium tabular-nums',
                  mine ? 'border-orange/60 bg-orange-soft text-orange-ink' : 'bg-card text-muted-foreground',
                )}
              >
                {r.emoji.id ? (
                  <img src={emojiUrl(r.emoji.id, r.emoji.animated, 32)} alt={label} className="size-4 object-contain" draggable={false} />
                ) : (
                  <span className="text-[14px] leading-none">{r.emoji.name}</span>
                )}
                {r.count}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {label} · {r.count === 1 ? '1 reacción' : `${r.count} reacciones`}
              {mine ? ' (una es tuya)' : ''}. Se ponen desde Discord.
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** Fichas de las tareas del mensaje: citadas en el texto o creadas desde él (contrato §B.11). */
export function DiscordTaskCards({ tasks, onTask }: { tasks: DiscordTaskRef[]; onTask: OnTask }) {
  if (!tasks.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {tasks.map((t) => {
        const state = t.status ? canonState(t.status) : null;
        const variant = state ? stateBadgeVariant(state) : 'secondary';
        const closed = !!state && CLOSED_STATES.includes(state);
        return (
          <button
            key={t.identifier}
            type="button"
            onClick={() => onTask(t)}
            title={`Abrir ${t.identifier}`}
            className={cn(
              'group/card grid w-full max-w-[19rem] gap-1 rounded-md border border-l-[3px] bg-card px-3 py-2 text-left transition-[background-color,box-shadow] hover:bg-sidebar hover:shadow-md',
              variant === 'success' ? 'border-l-green' : variant === 'info' ? 'border-l-blue' : 'border-l-yellow',
            )}
          >
            <span className="flex items-center gap-2">
              <ListChecks className="size-3.5 text-yellow-ink" />
              <span className="font-mono text-[11px] font-medium text-faint group-hover/card:text-foreground">{t.identifier}</span>
              {t.status && (
                <Badge variant={variant} dot className="px-2 py-px text-[10.5px]">
                  {t.status}
                </Badge>
              )}
              {!t.workItemId && t.url && <ExternalLink className="ml-auto size-3 text-faint" />}
            </span>
            <span className={cn('text-[13px] font-medium leading-snug', closed && 'font-normal text-muted-foreground line-through')}>
              {t.name ?? 'Tarea'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

