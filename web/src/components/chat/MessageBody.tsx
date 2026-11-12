import { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChat } from '@/chat/ChatContext';
import { mentionsToMarkdown, taskRefsToMarkdown, type ChatTaskRef } from '@/lib/chat';
import { useTaskBridge } from './TaskChip';
import { cn } from '@/lib/utils';

/**
 * Cuerpo de un mensaje: markdown (GFM, sin HTML crudo → sin XSS) con menciones y citas de tareas.
 *   · Menciones: tokens `<@id>` → enlaces `#mention-<id>` → píldoras como en Slack (la tuya resalta).
 *   · Tareas: `#ROZ-12` que existe → enlace `#task-<id>` → ficha en línea que abre la tarea. Su
 *     tarjeta del kanban va debajo del mensaje (MessageTasks); aquí solo el identificador clicable.
 */
export const MessageBody = memo(function MessageBody({
  body,
  citedTasks,
  className,
}: {
  body: string;
  citedTasks?: ChatTaskRef[];
  className?: string;
}) {
  const { nameOf, me } = useChat();
  const { openTask } = useTaskBridge();
  const md = useMemo(() => {
    const known = new Map((citedTasks ?? []).map((t) => [t.identifier.toUpperCase(), t.id]));
    return taskRefsToMarkdown(mentionsToMarkdown(body, nameOf), known);
  }, [body, nameOf, citedTasks]);

  return (
    <div className={cn('chat-md', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ node, href, children, ...props }) {
            void node;
            if (href?.startsWith('#mention-')) {
              const id = href.slice('#mention-'.length);
              const isMe = id === 'canal' || (!!me && id === me.toLowerCase());
              return (
                // A mí (o @canal): amarillo, lo humano. A otra persona: naranja suave de marca.
                <span className={cn('rounded-sm px-1 font-medium', isMe ? 'bg-yellow-soft text-yellow-ink' : 'bg-orange-soft text-orange-ink')}>
                  {children}
                </span>
              );
            }
            if (href?.startsWith('#task-')) {
              const id = href.slice('#task-'.length);
              return (
                <button
                  type="button"
                  onClick={() => openTask(id)}
                  className="rounded-sm border bg-panel px-1 py-px font-mono text-[0.82em] font-medium text-foreground transition-colors hover:border-orange hover:bg-orange-soft hover:text-orange-ink"
                >
                  {children}
                </button>
              );
            }
            return <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
          },
        }}
      >
        {md}
      </ReactMarkdown>
    </div>
  );
});
