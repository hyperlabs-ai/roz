import { useState } from 'react';
import { Play } from 'lucide-react';
import type { LinkPreview } from '@/lib/chat';
import { cn } from '@/lib/utils';

// Tarjetas de los links de un mensaje (las arma el backend: src/chat/unfurl.ts). Las imágenes son
// de terceros: se piden sin Referer y, si fallan, se ocultan en vez de dejar un ícono roto.

function SiteLine({ p }: { p: LinkPreview }) {
  const [iconOk, setIconOk] = useState(true);
  const site = p.siteName ?? p.provider;
  if (!site) return null;
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {p.icon && iconOk && (
        <img src={p.icon} alt="" referrerPolicy="no-referrer" onError={() => setIconOk(false)} className="size-3.5 rounded-sm" />
      )}
      <span className="truncate">{site}</span>
    </div>
  );
}

function Thumb({ src, className }: { src: string | null; className?: string }) {
  const [ok, setOk] = useState(true);
  if (!src || !ok) return null;
  return <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setOk(false)} className={className} />;
}

const PLAYER: Record<NonNullable<LinkPreview['embed']>['type'], (id: string) => string> = {
  youtube: (id) => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`,
  vimeo: (id) => `https://player.vimeo.com/video/${id}?autoplay=1&dnt=1`,
  tiktok: (id) => `https://www.tiktok.com/player/v1/${id}?autoplay=1&description=1&music_info=1`,
};

/** YouTube / Vimeo / TikTok: miniatura con ▶; el reproductor se carga solo al dar clic (no en cada
 *  render: cada iframe de video pesa varios MB). TikTok es vertical y no trae miniatura. */
function VideoCard({ p }: { p: LinkPreview & { embed: NonNullable<LinkPreview['embed']> } }) {
  const [playing, setPlaying] = useState(false);
  const vertical = p.embed.type === 'tiktok';
  const src = PLAYER[p.embed.type](p.embed.id);
  return (
    <div className={cn('w-full space-y-1.5 border-l-4 border-l-destructive/70 pl-3', vertical ? 'max-w-[18rem]' : 'max-w-md')}>
      <SiteLine p={p} />
      {p.title && (
        <a href={p.url} target="_blank" rel="noreferrer noopener" className="line-clamp-2 text-sm font-semibold text-primary hover:underline">
          {p.title}
        </a>
      )}
      {p.author && <div className="text-xs text-muted-foreground">{p.author}</div>}
      <div className={cn('relative overflow-hidden rounded-lg border bg-black', vertical ? 'aspect-[9/16]' : 'aspect-video')}>
        {playing ? (
          <iframe
            src={src}
            title={p.title ?? 'Video'}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            className="size-full border-0"
          />
        ) : (
          <button type="button" onClick={() => setPlaying(true)} className="group block size-full" aria-label={`Reproducir ${p.title ?? 'video'}`}>
            <Thumb src={p.image} className="size-full object-cover" />
            {!p.image && <span className="absolute inset-x-0 top-3 text-center text-xs font-medium text-white/70">{p.provider ?? 'Video'}</span>}
            <span className="absolute inset-0 grid place-items-center">
              <span className="grid size-14 place-items-center rounded-full bg-black/65 text-white transition-transform group-hover:scale-110">
                <Play className="size-6 translate-x-0.5 fill-current" />
              </span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

/** Post de X: autor y texto (no se incrusta el widget de X: carga scripts de terceros). */
function PostCard({ p }: { p: LinkPreview }) {
  return (
    <a
      href={p.url}
      target="_blank"
      rel="noreferrer noopener"
      className="block w-full max-w-md rounded-lg border bg-card px-3 py-2.5 shadow-sm transition-colors hover:bg-accent/50"
    >
      <SiteLine p={p} />
      {p.title && <div className="mt-1 text-sm font-semibold">{p.title}</div>}
      {p.description && <p className="mt-0.5 line-clamp-6 whitespace-pre-line text-sm">{p.description}</p>}
    </a>
  );
}

/** Cualquier otro sitio (y TikTok / Spotify, sin reproductor): sitio, título, descripción e imagen. */
function LinkCard({ p }: { p: LinkPreview }) {
  const big = p.kind === 'video';
  return (
    <div className={cn('w-full max-w-md border-l-4 border-l-primary/50 pl-3', big ? 'space-y-1.5' : 'flex gap-3')}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <SiteLine p={p} />
        {p.title && (
          <a href={p.url} target="_blank" rel="noreferrer noopener" className="line-clamp-2 text-sm font-semibold text-primary hover:underline">
            {p.title}
          </a>
        )}
        {p.description && <p className="line-clamp-2 text-sm text-muted-foreground">{p.description}</p>}
      </div>
      {big ? (
        <a href={p.url} target="_blank" rel="noreferrer noopener" className="block overflow-hidden rounded-lg border">
          <Thumb src={p.image} className="max-h-64 w-full object-cover" />
        </a>
      ) : (
        <Thumb src={p.image} className="size-16 shrink-0 rounded-md border object-cover sm:size-20" />
      )}
    </div>
  );
}

export function LinkPreviews({ previews }: { previews: LinkPreview[] | undefined }) {
  if (!previews?.length) return null;
  return (
    <div className="mt-1.5 space-y-2">
      {previews.map((p) =>
        p.embed ? (
          <VideoCard key={p.url} p={p as LinkPreview & { embed: NonNullable<LinkPreview['embed']> }} />
        ) : p.kind === 'post' ? (
          <PostCard key={p.url} p={p} />
        ) : (
          <LinkCard key={p.url} p={p} />
        ),
      )}
    </div>
  );
}
