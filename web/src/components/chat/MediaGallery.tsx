import { useState } from 'react';
import { ImageOff, Play } from 'lucide-react';
import { attachmentKind, galleryLayout, type ChatAttachment } from '@/lib/chat';
import { cn } from '@/lib/utils';
import { MediaViewer } from './MediaViewer';

function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Un cuadro de la galería. Si el navegador no puede mostrarlo (HEIC, MOV con HEVC en Windows),
 *  queda un cuadro con el nombre: al abrirlo, el visor ofrece descargarlo. */
function Tile({
  a,
  single,
  extra,
  onOpen,
  className,
}: {
  a: ChatAttachment;
  single: boolean;
  extra?: number;
  onOpen: () => void;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const [secs, setSecs] = useState(0);
  const video = attachmentKind(a) === 'video';
  const media = single ? 'max-h-80 w-auto max-w-full' : 'size-full object-cover';

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn('group relative block overflow-hidden bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}
      aria-label={`Ver ${a.name}`}
    >
      {broken ? (
        <span className={cn('flex flex-col items-center justify-center gap-1 p-3 text-xs text-muted-foreground', single ? 'h-40 w-56' : 'size-full')}>
          <ImageOff className="size-6" />
          <span className="max-w-full truncate">{a.name}</span>
        </span>
      ) : video ? (
        <>
          {/* `#t=0.1`: sin esto Safari / iOS muestran un cuadro negro en vez del primer frame. */}
          <video
            src={`${a.url}#t=0.1`}
            preload="metadata"
            muted
            playsInline
            onLoadedMetadata={(e) => setSecs(e.currentTarget.duration)}
            onError={() => setBroken(true)}
            className={cn(media, 'pointer-events-none', single && 'min-h-32 min-w-48 bg-black')}
          />
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid size-11 place-items-center rounded-full bg-black/55 text-white transition-transform group-hover:scale-110">
              <Play className="size-5 translate-x-px fill-current" />
            </span>
          </span>
          {secs > 0 && (
            <span className="absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white">{duration(secs)}</span>
          )}
        </>
      ) : (
        <img src={a.url!} alt={a.name} loading="lazy" onError={() => setBroken(true)} className={cn(media, 'transition-opacity group-hover:opacity-90')} />
      )}
      {!!extra && (
        <span className="absolute inset-0 grid place-items-center bg-black/55 text-2xl font-semibold text-white">+{extra}</span>
      )}
    </button>
  );
}

/**
 * Imágenes y videos de un mensaje como mini galería (estilo WhatsApp). Un clic abre el visor en
 * ese elemento; nunca navega a la URL del archivo.
 */
export function MediaGallery({ items }: { items: ChatAttachment[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!items.length) return null;
  const { shape, visible, extra } = galleryLayout(items.length);
  const shown = items.slice(0, visible);

  return (
    <>
      {shape === 'single' ? (
        <Tile a={shown[0]!} single onOpen={() => setOpen(0)} className="inline-block rounded-lg border" />
      ) : (
        <div
          className={cn(
            'grid w-[min(22rem,100%)] gap-0.5 overflow-hidden rounded-lg border',
            shape === 'pair' ? 'aspect-[2/1] grid-cols-2' : 'aspect-square grid-cols-2 grid-rows-2',
          )}
        >
          {shown.map((a, n) => (
            <Tile
              key={a.id}
              a={a}
              single={false}
              onOpen={() => setOpen(n)}
              extra={n === visible - 1 ? extra : 0}
              className={cn(shape === 'trio' && n === 0 && 'row-span-2')}
            />
          ))}
        </div>
      )}
      <MediaViewer items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </>
  );
}
