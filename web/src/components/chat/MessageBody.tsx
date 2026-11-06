import { memo, useMemo } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { FolderKanban } from 'lucide-react';
import remarkGfm from 'remark-gfm';
import { useChat } from '@/chat/ChatContext';
import { mentionsToMarkdown, taskRefsToMarkdown, type ChatTaskRef } from '@/lib/chat';
import { useTaskBridge } from './TaskChip';
import { cn } from '@/lib/utils';

/**
 * Cuerpo de un mensaje: markdown (GFM, sin HTML crudo → sin XSS) con menciones y citas de tareas.
 *   · Menciones: tokens `<@id>` → enlaces `#mention-<id>` → píldoras como en Slack (la tuya resalta).
 *   · Proyectos: `<@proyecto:id|Nombre>` → enlace `#project-<id>` → píldora que lleva al proyecto.
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
                <span className={cn('rounded px-0.5 font-medium', isMe ? 'bg-warning/15 text-warning' : 'bg-primary/10 text-primary')}>
                  {children}
                </span>
              );
            }
            if (href?.startsWith('#project-')) {
              const id = href.slice('#project-'.length);
              return (
                <Link
                  to={`/app/projects/${id}`}
                  className="inline-flex items-baseline gap-0.5 rounded bg-success/10 px-1 font-medium text-success no-underline hover:bg-success/20"
                >
                  <FolderKanban className="size-3 translate-y-[1px] self-center" />
                  {children}
                </Link>
              );
            }
            if (href?.startsWith('#task-')) {
              const id = href.slice('#task-'.length);
              return (
                <button
                  type="button"
                  onClick={() => openTask(id)}
                  className="rounded bg-primary/10 px-1 font-mono text-[0.85em] font-medium text-primary hover:bg-primary/20"
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
