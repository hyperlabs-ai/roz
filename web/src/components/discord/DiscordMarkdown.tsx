import { Fragment, memo, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Hash, ListChecks } from 'lucide-react';
import { useDiscord } from '@/discord/DiscordContext';
import {
  formatDiscordTime, isEmojiOnly, parseDiscordMarkdown, parseInline, type MdBlock, type MdInline,
} from '@/discord/markdown';
import { discordColor, emojiUrl } from '@/discord/model';
import type { DiscordMentionedUser, DiscordTaskRef } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Qué hacer al pulsar una ficha de tarea dentro del texto. */
export type OnTask = (ref: DiscordTaskRef) => void;

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={shown ? undefined : 'Spoiler: pulsa para ver'}
      onClick={(e) => {
        e.stopPropagation();
        setShown(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') setShown(true);
      }}
      className={cn(
        'rounded-[3px] px-0.5 transition-colors',
        shown ? 'bg-panel' : 'cursor-pointer select-none bg-ink text-transparent [&_*]:invisible',
      )}
    >
      {children}
    </span>
  );
}

const PILL = 'rounded-[3px] px-0.5 font-medium transition-colors';

interface Ctx {
  mentions: DiscordMentionedUser[];
  tasks: DiscordTaskRef[];
  onTask?: OnTask;
  jumbo: boolean;
}

function Inline({ nodes, ctx }: { nodes: MdInline[]; ctx: Ctx }) {
  const { members, roles, channels, me } = useDiscord();
  const navigate = useNavigate();

  const render = (n: MdInline, i: number): ReactNode => {
    switch (n.t) {
      case 'text':
        return <Fragment key={i}>{n.v}</Fragment>;
      case 'br':
        return <br key={i} />;
      case 'strong':
        return <strong key={i} className="font-semibold">{n.c.map(render)}</strong>;
      case 'em':
        return <em key={i}>{n.c.map(render)}</em>;
      case 'u':
        return <u key={i} className="underline-offset-2">{n.c.map(render)}</u>;
      case 's':
        return <s key={i}>{n.c.map(render)}</s>;
      case 'spoiler':
        return <Spoiler key={i}>{n.c.map(render)}</Spoiler>;
      case 'code':
        return (
          <code key={i} className="rounded-[4px] bg-panel px-1 py-px font-mono text-[0.85em]">
            {n.v}
          </code>
        );
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="text-blue-ink underline-offset-2 hover:underline">
            {n.c.map(render)}
          </a>
        );
      case 'user': {
        const m = members.get(n.id);
        const u = ctx.mentions.find((x) => x.id === n.id);
        const name = m?.displayName ?? u?.globalName ?? u?.username ?? 'desconocido';
        const isMe = !!me && n.id === me;
        return (
          <span
            key={i}
            title={m?.username ?? u?.username}
            className={cn(PILL, isMe ? 'bg-orange-soft text-orange-ink' : 'bg-blue-soft text-blue-ink')}
          >
            @{name}
          </span>
        );
      }
      case 'role': {
        const r = roles.get(n.id);
        const color = discordColor(r?.color);
        return (
          <span
            key={i}
            className={cn(PILL, !color && 'bg-blue-soft text-blue-ink')}
            // Color del rol = dato de Discord (como en Discord), con fondo al 12%.
            style={color ? { color, backgroundColor: `${color}1f` } : undefined}
          >
            @{r?.name ?? 'rol-desconocido'}
          </span>
        );
      }
      case 'channel': {
        const c = channels.get(n.id);
        return (
          <button
            key={i}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (c) navigate(`/app/chat/${n.id}`);
            }}
            className={cn(PILL, 'inline-flex items-baseline gap-0.5 bg-blue-soft text-blue-ink', c ? 'hover:underline' : 'cursor-default')}
          >
            <Hash className="size-[0.85em] self-center" />
            {c?.name ?? 'canal-desconocido'}
          </button>
        );
      }
      case 'emoji':
        return (
          <img
            key={i}
            src={emojiUrl(n.id, n.animated, ctx.jumbo ? 96 : 48)}
            alt={`:${n.name}:`}
            title={`:${n.name}:`}
            draggable={false}
            loading="lazy"
            className={cn('inline-block object-contain align-[-0.3em]', ctx.jumbo ? 'size-12' : 'size-[1.375em]')}
          />
        );
      case 'everyone':
        return (
          <span key={i} className={cn(PILL, 'bg-orange-soft text-orange-ink')}>
            {n.v}
          </span>
        );
      case 'time':
        return (
          <time
            key={i}
            dateTime={new Date(n.unix * 1000).toISOString()}
            title={formatDiscordTime(n.unix, 'F')}
            className="rounded-[3px] bg-panel px-1"
          >
            {formatDiscordTime(n.unix, n.style)}
          </time>
        );
      case 'task': {
        const ref = ctx.tasks.find((t) => t.identifier.toUpperCase() === n.identifier.toUpperCase());
        if (!ref || !ctx.onTask) return <Fragment key={i}>{n.raw}</Fragment>;
        return (
          <button
            key={i}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              ctx.onTask?.(ref);
            }}
            title={ref.name ?? `Abrir ${ref.identifier}`}
            className="inline-flex items-baseline gap-1 rounded-[4px] bg-yellow-soft px-1 font-mono text-[0.85em] font-medium text-yellow-ink hover:underline"
          >
            <ListChecks className="size-[0.95em] self-center" />
            {ref.identifier}
          </button>
        );
      }
    }
  };

  return <>{nodes.map(render)}</>;
}

function Block({ b, ctx }: { b: MdBlock; ctx: Ctx }) {
  switch (b.t) {
    case 'p':
      return (
        <p className={cn('whitespace-pre-wrap break-words', ctx.jumbo && 'leading-[3.25rem]')}>
          <Inline nodes={b.c} ctx={ctx} />
        </p>
      );
    case 'h':
      return (
        <p
          className={cn(
            'mt-1 font-semibold tracking-[-0.02em]',
            b.level === 1 && 'text-xl',
            b.level === 2 && 'text-lg',
            b.level === 3 && 'text-base',
          )}
        >
          <Inline nodes={b.c} ctx={ctx} />
        </p>
      );
    case 'sub':
      return (
        <p className="text-xs text-faint">
          <Inline nodes={b.c} ctx={ctx} />
        </p>
      );
    case 'quote':
      return (
        <blockquote className="my-0.5 border-l-[3px] border-toggle-off pl-3">
          {b.c.map((x, i) => (
            <Block key={i} b={x} ctx={ctx} />
          ))}
        </blockquote>
      );
    case 'codeblock':
      return (
        <pre className="scroll-thin my-1 max-w-full overflow-x-auto rounded-md border bg-panel p-3 font-mono text-[12.5px] leading-relaxed">
          {b.lang && <span className="mb-1 block label-caps text-faint">{b.lang}</span>}
          <code>{b.v}</code>
        </pre>
      );
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul';
      return (
        <Tag start={b.ordered ? b.start : undefined} className={cn('my-0.5 pl-5', b.ordered ? 'list-decimal' : 'list-disc')}>
          {b.items.map((it, i) => (
            <li key={i} className="break-words">
              <Inline nodes={it} ctx={ctx} />
            </li>
          ))}
        </Tag>
      );
    }
  }
}

/**
 * Markdown de Discord pintado con la identidad de roz: menciones como píldoras (la tuya en naranja),
 * canales clicables, emojis propios del CDN de Discord, spoilers, código, citas y fichas de tarea
 * (HYP-12 / ROZ-123) cuando el backend las resolvió en `tasks`.
 */
export const DiscordMarkdown = memo(function DiscordMarkdown({
  content,
  mentions = [],
  tasks = [],
  onTask,
  className,
}: {
  content: string;
  mentions?: DiscordMentionedUser[];
  tasks?: DiscordTaskRef[];
  onTask?: OnTask;
  className?: string;
}) {
  const blocks = useMemo(() => parseDiscordMarkdown(content), [content]);
  const ctx: Ctx = { mentions, tasks, onTask, jumbo: isEmojiOnly(blocks) };
  return (
    <div className={cn('min-w-0 space-y-0.5 text-[14.5px] leading-[1.45] text-foreground', className)}>
      {blocks.map((b, i) => (
        <Block key={i} b={b} ctx={ctx} />
      ))}
    </div>
  );
});

/** Una sola línea de markdown en línea (tema del canal, extracto de una cita). */
export function DiscordInline({ text, className }: { text: string; className?: string }) {
  const nodes = useMemo(() => parseInline(text.replace(/\n+/g, ' ')), [text]);
  return (
    <span className={cn('min-w-0', className)}>
      <Inline nodes={nodes} ctx={{ mentions: [], tasks: [], jumbo: false }} />
    </span>
  );
}
