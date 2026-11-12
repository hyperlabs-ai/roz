import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, History, Loader2 } from 'lucide-react';
import { useDiscord } from '@/discord/DiscordContext';
import { continuesGroup, isLocal, startsDay, type UiMessage } from '@/discord/model';
import { dayLabel } from '@/lib/chat-text';
import { cn } from '@/lib/utils';
import { DiscordMessage, type MessageHandlers } from './DiscordMessage';

/**
 * Separador de día como en Discord: línea fina con la fecha al centro, en la etiqueta de interfaz
 * (`label-caps`, Inter Tight). Fijo arriba al hacer scroll, sobre el fondo de la conversación para
 * que no se mezcle con los mensajes que pasan debajo.
 */
function DayDivider({ iso }: { iso: string }) {
  return (
    <div role="separator" aria-label={dayLabel(iso)} className="sticky top-0 z-[5] flex items-center gap-3 bg-background/90 px-4 pb-2 pt-3 backdrop-blur-sm md:px-5">
      <div className="h-px flex-1 bg-border" />
      <span className="label-caps text-[10.5px]">{dayLabel(iso)}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-1 flex-col justify-end gap-5 px-4 py-6 md:px-5" aria-label="Cargando mensajes">
      {[0.62, 0.4, 0.78, 0.5].map((w, i) => (
        <div key={i} className="flex gap-3">
          <div className="shimmer size-9 shrink-0 rounded-full bg-panel" />
          <div className="grid flex-1 gap-2 pt-0.5">
            <div className="shimmer h-3 w-24 rounded-sm bg-panel" />
            <div className="shimmer h-3 rounded-sm bg-panel" style={{ width: `${w * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const STICK_PX = 120;

/**
 * Lista de mensajes de un canal de Discord: separadores de día, agrupado por autor, scroll infinito
 * hacia arriba sin saltos, seguimiento del fondo solo si ya estabas abajo, y salto a un mensaje
 * (cita o enlace) con resaltado.
 */
export function DiscordMessageList({
  channelId,
  messages,
  hasMore,
  backfillComplete,
  loading,
  loadingOlder,
  onLoadOlder,
  detached,
  missed,
  onJumpPresent,
  focusId,
  onSeen,
  handlers,
  empty,
}: {
  channelId: string;
  messages: UiMessage[];
  hasMore: boolean;
  backfillComplete: boolean;
  loading: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  detached: boolean;
  missed: number;
  onJumpPresent: () => void;
  focusId: string | null;
  /** El último mensaje quedó a la vista (se marca como leído). */
  onSeen: (messageId: string) => void;
  handlers: MessageHandlers;
  empty: ReactNode;
}) {
  const { myDevId } = useDiscord();
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const firstId = useRef<string | null>(null);
  const lastId = useRef<string | null>(null);
  const prevHeight = useRef(0);
  const initialized = useRef<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const newestReal = () => messages.filter((m) => !isLocal(m)).slice(-1)[0]?.id ?? null;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || loading) return;
    const key = `${channelId}:${detached ? 'd' : 'p'}`;
    if (initialized.current !== key) {
      initialized.current = key;
      if (!focusId) el.scrollTop = el.scrollHeight;
      atBottom.current = !focusId;
      firstId.current = messages[0]?.id ?? null;
      lastId.current = messages[messages.length - 1]?.id ?? null;
      prevHeight.current = el.scrollHeight;
      return;
    }
    const first = messages[0]?.id ?? null;
    const last = messages[messages.length - 1];
    if (first !== firstId.current && lastId.current === (last?.id ?? null)) {
      // Se cargaron anteriores: se compensa el alto nuevo para no saltar.
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (last && last.id !== lastId.current) {
      const mine = !!myDevId && last.author.devId === myDevId;
      if (atBottom.current || mine) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      else setShowJump(true);
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    firstId.current = first;
    lastId.current = last?.id ?? null;
    prevHeight.current = el.scrollHeight;
  }, [messages, loading, channelId, detached, focusId, myDevId]);

  // Imágenes que terminan de cargar: mantener el fondo si se estaba ahí.
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
  }, [channelId]);

  // Salto a un mensaje: centrarlo y resaltarlo un momento.
  useEffect(() => {
    if (!focusId || loading) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(focusId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    setFlash(focusId);
    const t = window.setTimeout(() => setFlash(null), 2200);
    return () => window.clearTimeout(t);
  }, [focusId, loading, messages.length]);

  // Al fondo y con la pestaña visible: lo último cuenta como visto.
  useEffect(() => {
    const id = newestReal();
    if (id && atBottom.current && !detached && document.visibilityState === 'visible') onSeen(id);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distance < STICK_PX;
    if (atBottom.current) {
      setShowJump(false);
      const id = newestReal();
      if (id && !detached) onSeen(id);
    }
    if (el.scrollTop < 300 && hasMore && !loadingOlder) onLoadOlder();
  }

  const jumpVisible = detached || showJump;

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain">
        <div className="flex min-h-full flex-col justify-end pb-2">
          {loading ? (
            <Skeleton />
          ) : (
            <>
              {hasMore ? (
                <div className="flex justify-center py-3 text-muted-foreground">
                  {loadingOlder ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <button
                      type="button"
                      onClick={onLoadOlder}
                      className="rounded-btn bg-panel px-3 py-1.5 label-caps text-muted-foreground transition-colors hover:bg-toggle-off/70 hover:text-foreground"
                    >
                      Cargar mensajes anteriores
                    </button>
                  )}
                </div>
              ) : (
                <>
                  {!backfillComplete && (
                    <p className="mx-4 my-2 flex items-center gap-2 rounded-md bg-panel px-3 py-2 text-xs text-muted-foreground md:mx-5">
                      <History className="size-3.5" /> roz todavía está trayendo el historial de este canal desde Discord.
                    </p>
                  )}
                  {empty}
                </>
              )}
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const newDay = startsDay(prev, m);
                return (
                  <Fragment key={m.clientNonce && isLocal(m) ? m.clientNonce : m.id}>
                    {newDay && <DayDivider iso={m.createdAt} />}
                    <DiscordMessage m={m} grouped={!newDay && continuesGroup(prev, m)} focused={flash === m.id} handlers={handlers} />
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
          if (detached) {
            onJumpPresent();
          } else {
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
          }
          setShowJump(false);
        }}
        className={cn(
          'absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-btn bg-ink px-3 py-2 label-caps text-ink-foreground shadow-lg transition-all duration-200 ease-spring',
          jumpVisible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
        )}
      >
        <ArrowDown className="size-3.5" />
        {detached ? (missed > 0 ? `Volver al presente · ${missed} nuevos` : 'Volver al presente') : 'Mensajes nuevos'}
      </button>
    </div>
  );
}
