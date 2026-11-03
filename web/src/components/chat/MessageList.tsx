import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, Loader2 } from 'lucide-react';
import { useChat } from '@/chat/ChatContext';
import { MessageItem } from './MessageItem';
import { continuesGroup, dayLabel, startsDay, type ChatMessage } from '@/lib/chat';
import { cn } from '@/lib/utils';

function DayDivider({ iso }: { iso: string }) {
  return (
    <div className="sticky top-0 z-[5] flex items-center gap-3 px-4 py-2 md:px-5">
      <div className="h-px flex-1 bg-border" />
      <span className="rounded-full border bg-background px-3 py-0.5 text-xs font-medium text-muted-foreground shadow-sm">
        {dayLabel(iso)}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function NewDivider() {
  return (
    <div className="flex items-center gap-3 px-4 py-1 md:px-5" aria-label="Mensajes nuevos">
      <div className="h-px flex-1 bg-destructive/60" />
      <span className="text-[11px] font-semibold uppercase tracking-wide text-destructive">Nuevos</span>
    </div>
  );
}

/** Distancia al fondo bajo la cual se considera que la persona está "al día" (sigue el chat). */
const STICK_PX = 120;

/**
 * Lista de mensajes del canal: separadores de día, agrupado estilo Slack, marca de "Nuevos" desde
 * la última lectura, carga de anteriores al llegar arriba (sin saltos de scroll) y seguimiento del
 * fondo solo si la persona ya estaba abajo — si está leyendo historial, no se la arrastra.
 */
export function MessageList({
  conversationId,
  messages,
  hasMore,
  loading,
  loadingOlder,
  onLoadOlder,
  lastReadAt,
  onOpenThread,
  onRetry,
  onDiscard,
  empty,
}: {
  conversationId: string;
  messages: ChatMessage[];
  hasMore: boolean;
  loading: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  /** Marca de lectura al ABRIR la conversación (fija mientras se ve: si no, "Nuevos" se movería). */
  lastReadAt: string | null;
  onOpenThread: (rootId: string) => void;
  onRetry: (m: ChatMessage) => void;
  onDiscard: (m: ChatMessage) => void;
  empty: ReactNode;
}) {
  const { me } = useChat();
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const firstId = useRef<string | null>(null);
  const lastId = useRef<string | null>(null);
  const prevHeight = useRef(0);
  const initialized = useRef<string | null>(null);

  // Al abrir una conversación: al fondo, sin animación.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || loading) return;
    if (initialized.current !== conversationId) {
      initialized.current = conversationId;
      el.scrollTop = el.scrollHeight;
      atBottom.current = true;
      firstId.current = messages[0]?.id ?? null;
      lastId.current = messages[messages.length - 1]?.id ?? null;
      prevHeight.current = el.scrollHeight;
      return;
    }
    const first = messages[0]?.id ?? null;
    const last = messages[messages.length - 1];
    // Se cargaron anteriores (cambió el primero): se compensa el alto nuevo para no saltar.
    if (first !== firstId.current && lastId.current === (last?.id ?? null)) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (last && last.id !== lastId.current) {
      // Mensaje nuevo al final: se sigue si la persona estaba abajo o si lo mandó ella.
      if (atBottom.current || last.authorDevId === me) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      else setShowJump(true);
    } else if (atBottom.current) {
      // Algo creció (imagen que cargó, ficha de tarea): seguir pegado al fondo.
      el.scrollTop = el.scrollHeight;
    }
    firstId.current = first;
    lastId.current = last?.id ?? null;
    prevHeight.current = el.scrollHeight;
  }, [messages, loading, conversationId, me]);

  // Las imágenes cambian el alto después de pintar: mantener el fondo si se estaba ahí.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const inner = el.firstElementChild;
    if (!inner) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
      prevHeight.current = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [conversationId]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distance < STICK_PX;
    if (atBottom.current) setShowJump(false);
    if (el.scrollTop < 300 && hasMore && !loadingOlder) onLoadOlder();
  }

  // Dónde va la marca de "Nuevos": primer mensaje de otra persona posterior a la última lectura.
  const firstUnread = lastReadAt
    ? messages.find((m) => m.kind === 'user' && m.authorDevId !== me && !m.pending && m.createdAt > lastReadAt)?.id
    : undefined;

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="scroll-thin h-full overflow-y-auto overscroll-contain">
        <div className="flex min-h-full flex-col justify-end pb-2">
          {loading ? (
            <div className="flex flex-1 items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : (
            <>
              {hasMore ? (
                <div className="flex justify-center py-3 text-muted-foreground">
                  {loadingOlder ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <button type="button" onClick={onLoadOlder} className="text-xs hover:text-foreground hover:underline">
                      Cargar mensajes anteriores
                    </button>
                  )}
                </div>
              ) : (
                empty
              )}
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const newDay = startsDay(prev, m);
                const isFirstUnread = m.id === firstUnread;
                return (
                  <Fragment key={m.clientNonce ?? m.id}>
                    {newDay && <DayDivider iso={m.createdAt} />}
                    {isFirstUnread && <NewDivider />}
                    <MessageItem
                      message={m}
                      grouped={!newDay && !isFirstUnread && continuesGroup(prev, m)}
                      onOpenThread={onOpenThread}
                      onRetry={onRetry}
                      onDiscard={onDiscard}
                    />
                  </Fragment>
                );
              })}
            </>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
          setShowJump(false);
        }}
        className={cn(
          'absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg transition-all duration-200 ease-spring',
          showJump ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
        )}
      >
        <ArrowDown className="size-3.5" /> Mensajes nuevos
      </button>
    </div>
  );
}
