import { useEffect, useLayoutEffect, useRef } from 'react';
import { Loader2, X } from 'lucide-react';
import { useChat } from '@/chat/ChatContext';
import { useThread } from '@/chat/useMessages';
import { Composer } from './Composer';
import { MessageItem } from './MessageItem';
import { continuesGroup, conversationTitle, type ChatConversation } from '@/lib/chat';

/** Panel de hilo: el mensaje raíz, sus respuestas y un compositor propio. */
export function ThreadPanel({
  conversation,
  rootId,
  canWrite,
  onClose,
}: {
  conversation: ChatConversation;
  rootId: string;
  canWrite: boolean;
  onClose: () => void;
}) {
  const { nameOf, me } = useChat();
  const { root, replies, loading, error, send, discard } = useThread(rootId, conversation.id);
  const scroller = useRef<HTMLDivElement>(null);
  const count = useRef(0);

  // Al abrir y con cada respuesta nueva: al fondo.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (replies.length !== count.current) el.scrollTop = el.scrollHeight;
    count.current = replies.length;
  }, [replies.length, loading]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = conversation.kind === 'channel' ? `#${conversation.name}` : conversationTitle(conversation, nameOf, me);
  const visibleReplies = replies.filter((r) => r.kind === 'user').length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-16 shrink-0 items-center gap-2 border-b bg-card px-4">
        <div className="grid min-w-0 flex-1 gap-1">
          <span className="eyebrow truncate text-[10px]">
            Hilo · {title}
          </span>
          <span className="text-[17px] font-semibold leading-none tracking-[-0.03em]">Respuestas</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar hilo"
          className="grid size-[30px] shrink-0 place-items-center rounded-md bg-panel text-muted-foreground transition-colors hover:bg-toggle-off/70 hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
        {loading ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : error || !root ? (
          <div className="m-4 grid gap-1.5 rounded-xl bg-panel p-5 text-center">
            <span className="label-caps">Hilo no disponible</span>
            <p className="text-sm text-muted-foreground">{error ?? 'No se encontró el hilo.'}</p>
          </div>
        ) : (
          <>
            <div className="pt-2">
              <MessageItem message={root} grouped={false} inThread isRoot />
            </div>
            <div className="flex items-center gap-3 px-4 py-2 md:px-5">
              <span className="label-caps text-faint">
                {visibleReplies === 0 ? 'Sin respuestas todavía' : visibleReplies === 1 ? '1 respuesta' : `${visibleReplies} respuestas`}
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>
            {replies.map((r, i) => (
              <MessageItem
                key={r.clientNonce ?? r.id}
                message={r}
                grouped={continuesGroup(replies[i - 1], r)}
                inThread
                onRetry={(m) => {
                  discard(m.clientNonce!);
                  void send(m.body, m.attachments);
                }}
                onDiscard={(m) => discard(m.clientNonce!)}
              />
            ))}
          </>
        )}
      </div>

      {canWrite && root && !root.deletedAt ? (
        <Composer
          compact
          conversationId={conversation.id}
          draftKey={`thread:${rootId}`}
          memberIds={conversation.memberIds}
          placeholder="Responder en el hilo…"
          onSend={(body, attachments) => void send(body, attachments)}
          autoFocus
        />
      ) : null}
    </div>
  );
}
