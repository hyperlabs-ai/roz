import { useEffect, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, Download, ImageOff, X } from 'lucide-react';
import { attachmentKind, downloadUrl, formatBytes, type ChatAttachment } from '@/lib/chat';
import { cn } from '@/lib/utils';

/**
 * Visor a pantalla completa de las imágenes y videos de un mensaje (lightbox). Al dar clic en la
 * galería se abre aquí, sin salir de roz. Flechas / teclado (← →) / swipe en móvil para recorrer,
 * Esc para cerrar y Descargar con el nombre original.
 */
export function MediaViewer({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: ChatAttachment[];
  /** null = cerrado. */
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const open = index !== null && items.length > 0;
  const i = Math.min(Math.max(index ?? 0, 0), Math.max(items.length - 1, 0));
  const current = items[i];
  const many = items.length > 1;
  const touchX = useRef<number | null>(null);
  const [broken, setBroken] = useState<Set<string>>(() => new Set());

  const go = (delta: number) => {
    if (!many) return;
    onIndex((i + delta + items.length) % items.length);
  };

  // Al cambiar de elemento, el video anterior se desmonta (key) y deja de sonar.
  useEffect(() => {
    if (!open) setBroken(new Set());
  }, [open]);

  if (!current) return null;
  const kind = attachmentKind(current);
  const isBroken = broken.has(current.id) || !current.url;
  const markBroken = () => setBroken((s) => new Set(s).add(current.id));

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="t-overlay fixed inset-0 z-50 bg-black/90" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col text-white outline-none"
          onKeyDown={(e) => {
            // Con el foco en el video, las flechas adelantan / regresan el video, no cambian de archivo.
            if ((e.target as HTMLElement).tagName === 'VIDEO') return;
            if (e.key === 'ArrowLeft') go(-1);
            else if (e.key === 'ArrowRight') go(1);
          }}
          onTouchStart={(e) => (touchX.current = e.touches[0]?.clientX ?? null)}
          onTouchEnd={(e) => {
            const start = touchX.current;
            const end = e.changedTouches[0]?.clientX;
            touchX.current = null;
            if (start == null || end == null || Math.abs(end - start) < 50) return;
            go(end < start ? 1 : -1);
          }}
        >
          <DialogPrimitive.Title className="sr-only">{current.name}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {many ? `Archivo ${i + 1} de ${items.length}` : 'Vista previa del archivo'}
          </DialogPrimitive.Description>

          {/* Barra superior: nombre, contador, descargar, cerrar. */}
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{current.name}</div>
              <div className="text-xs text-white/60">
                {[many ? `${i + 1} / ${items.length}` : null, formatBytes(current.size) || null].filter(Boolean).join(' · ')}
              </div>
            </div>
            {current.url && (
              <a
                href={downloadUrl(current.url, current.name)}
                className="grid size-9 place-items-center rounded-full bg-white/10 hover:bg-white/20"
                aria-label="Descargar"
                title="Descargar"
              >
                <Download className="size-4" />
              </a>
            )}
            <DialogPrimitive.Close
              className="grid size-9 place-items-center rounded-full bg-white/10 hover:bg-white/20"
              aria-label="Cerrar"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>

          {/* Escenario: clic en el fondo cierra; en el medio, no. */}
          <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-2 sm:px-16" onClick={onClose}>
            {isBroken ? (
              <div className="flex flex-col items-center gap-3 text-center text-sm text-white/70" onClick={(e) => e.stopPropagation()}>
                <ImageOff className="size-10" />
                <p>Este archivo no se puede mostrar en este navegador.</p>
                {current.url && (
                  <a href={downloadUrl(current.url, current.name)} className="rounded-md bg-white/15 px-3 py-1.5 font-medium text-white hover:bg-white/25">
                    Descargar
                  </a>
                )}
              </div>
            ) : kind === 'video' ? (
              <video
                key={current.id}
                src={current.url!}
                controls
                autoPlay
                playsInline
                onError={markBroken}
                onClick={(e) => e.stopPropagation()}
                className="max-h-full max-w-full rounded-md bg-black"
              />
            ) : (
              <img
                key={current.id}
                src={current.url!}
                alt={current.name}
                onError={markBroken}
                onClick={(e) => e.stopPropagation()}
                className="max-h-full max-w-full select-none rounded-md object-contain"
                draggable={false}
              />
            )}

            {many && (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    go(-1);
                  }}
                  className="absolute left-2 top-1/2 hidden size-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 hover:bg-white/20 sm:grid"
                  aria-label="Anterior"
                >
                  <ChevronLeft className="size-6" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    go(1);
                  }}
                  className="absolute right-2 top-1/2 hidden size-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 hover:bg-white/20 sm:grid"
                  aria-label="Siguiente"
                >
                  <ChevronRight className="size-6" />
                </button>
              </>
            )}
          </div>

          {/* Tira de miniaturas: salta directo a cualquiera. */}
          {many && (
            <div className="flex justify-center gap-1.5 overflow-x-auto px-4 pb-4">
              {items.map((a, n) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onIndex(n)}
                  className={cn(
                    'relative size-12 shrink-0 overflow-hidden rounded-md border-2 bg-white/10',
                    n === i ? 'border-white' : 'border-transparent opacity-60 hover:opacity-100',
                  )}
                  aria-label={`Ver ${a.name}`}
                >
                  {attachmentKind(a) === 'video' ? (
                    <video src={a.url ? `${a.url}#t=0.1` : undefined} preload="metadata" muted playsInline className="size-full object-cover" />
                  ) : (
                    <img src={a.url ?? undefined} alt="" loading="lazy" className="size-full object-cover" />
                  )}
                </button>
              ))}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
