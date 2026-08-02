import { useState } from 'react';
import { ChevronRight, Trash2, StickyNote, MessagesSquare, Link2, BookMarked, HelpCircle, Check, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Markdown } from '@/components/Markdown';
import { EmptyState } from '@/components/bits';
import { BLOCK_KIND_LABEL } from '@/lib/ideas';
import { markdownFromPaste } from '@/lib/rich-text';
import type { IdeaBlock } from '@/lib/api';
import { cn } from '@/lib/utils';

const KIND_ICON: Record<string, typeof StickyNote> = {
  nota: StickyNote,
  chat: MessagesSquare,
  link: Link2,
  referencia: BookMarked,
  pregunta: HelpCircle,
};

/** Cuánto texto es "largo": a partir de aquí el bloque nace colapsado. Una conversación con un LLM
 *  son miles de caracteres, y desplegada entierra todo lo demás. */
const LONG = 400;

export interface BlockHandlers {
  onAdd: (kind: string) => void;
  onUpdate: (id: string, patch: { title?: string | null; body?: string | null; source?: string | null; url?: string | null; resolved?: boolean }) => void;
  onDelete: (id: string) => void;
}

/**
 * Bloques libres: lo que no cabe en un campo guiado. Notas sueltas, conversaciones pegadas de un
 * LLM, links, referencias y preguntas abiertas.
 *
 * Las preguntas van en su propia sección: no son contenido, son deuda de definición — lo que
 * todavía no sabes de tu propia idea. Verlas juntas es el valor.
 */
export function BlockList({ blocks, readOnly, handlers }: { blocks: IdeaBlock[]; readOnly?: boolean; handlers: BlockHandlers }) {
  const questions = blocks.filter((b) => b.kind === 'pregunta');
  const rest = blocks.filter((b) => b.kind !== 'pregunta');
  const open = questions.filter((q) => !q.resolved).length;

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Preguntas abiertas {open > 0 && <span className="ml-1 text-warning">· {open}</span>}
          </h3>
          {!readOnly && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => handlers.onAdd('pregunta')}>
              <HelpCircle className="size-3.5" />
              <span className="ml-1">Añadir</span>
            </Button>
          )}
        </div>
        {questions.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground/70">
            ¿Qué no sabes todavía? Apuntar la duda vale tanto como resolverla.
          </p>
        ) : (
          questions.map((b) => <BlockCard key={b.id} block={b} readOnly={readOnly} handlers={handlers} />)
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notas y referencias</h3>
          {!readOnly && (
            <div className="flex flex-wrap items-center gap-1">
              {(['nota', 'chat', 'link', 'referencia'] as const).map((k) => {
                const Icon = KIND_ICON[k]!;
                return (
                  <Button key={k} size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => handlers.onAdd(k)}>
                    <Icon className="size-3.5" />
                    <span className="ml-1">{BLOCK_KIND_LABEL[k]}</span>
                  </Button>
                );
              })}
            </div>
          )}
        </div>
        {rest.length === 0 ? (
          readOnly ? (
            <EmptyState>Sin notas</EmptyState>
          ) : (
            <p className="rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground/70">
              Pega aquí una conversación con un LLM, un link o cualquier nota suelta. Al pegar con formato se
              convierte en markdown.
            </p>
          )
        ) : (
          rest.map((b) => <BlockCard key={b.id} block={b} readOnly={readOnly} handlers={handlers} />)
        )}
      </section>
    </div>
  );
}

function BlockCard({ block, readOnly, handlers }: { block: IdeaBlock; readOnly?: boolean; handlers: BlockHandlers }) {
  const [title, setTitle] = useState(block.title ?? '');
  const [body, setBody] = useState(block.body ?? '');
  const [url, setUrl] = useState(block.url ?? '');
  // Nace desplegado si está vacío (se acaba de crear y hay que escribirlo) o si es corto.
  const [expanded, setExpanded] = useState((block.body ?? '').length < LONG);
  const [editing, setEditing] = useState(!block.body && !readOnly);
  const Icon = KIND_ICON[block.kind] ?? StickyNote;
  const isQuestion = block.kind === 'pregunta';
  const isLink = block.kind === 'link' || block.kind === 'referencia';

  function saveBody() {
    if (body !== (block.body ?? '')) handlers.onUpdate(block.id, { body: body || null });
    setEditing(false);
  }

  return (
    <div className={cn('rounded-lg border bg-card', isQuestion && block.resolved && 'opacity-60')}>
      <div className="flex items-center gap-2 px-2.5 py-2">
        {isQuestion && !readOnly ? (
          <button
            type="button"
            onClick={() => handlers.onUpdate(block.id, { resolved: !block.resolved })}
            className={cn(
              'grid size-4 shrink-0 place-items-center rounded border transition-colors',
              block.resolved ? 'border-success bg-success text-success-foreground' : 'border-input hover:border-foreground',
            )}
            aria-label={block.resolved ? 'Marcar como abierta' : 'Marcar como resuelta'}
          >
            {block.resolved && <Check className="size-3" />}
          </button>
        ) : (
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        )}

        {readOnly ? (
          <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', isQuestion && block.resolved && 'line-through')}>
            {block.title || BLOCK_KIND_LABEL[block.kind]}
          </span>
        ) : (
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title !== (block.title ?? '') && handlers.onUpdate(block.id, { title: title || null })}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            placeholder={isQuestion ? '¿Qué no sabes todavía?' : `Título de la ${BLOCK_KIND_LABEL[block.kind].toLowerCase()}…`}
            className={cn(
              'min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-medium outline-none transition-colors hover:border-input focus:border-input focus:ring-1 focus:ring-ring',
              isQuestion && block.resolved && 'line-through',
            )}
          />
        )}

        {block.source && (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {block.source}
          </Badge>
        )}

        <Button size="icon" variant="ghost" className="size-7 shrink-0" onClick={() => setExpanded((v) => !v)} aria-label={expanded ? 'Colapsar' : 'Desplegar'}>
          <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
        </Button>

        {!readOnly && (
          <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => handlers.onDelete(block.id)}
            aria-label="Eliminar bloque"
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>

      {expanded && (
        <div className="space-y-2 border-t px-2.5 py-2">
          {isLink &&
            (readOnly ? (
              block.url && (
                <a href={block.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-chart-1 hover:underline">
                  <ExternalLink className="size-3" />
                  {block.url}
                </a>
              )
            ) : (
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => url !== (block.url ?? '') && handlers.onUpdate(block.id, { url: url || null })}
                placeholder="https://…"
                className="h-8 text-xs"
              />
            ))}

          {editing && !readOnly ? (
            <>
              <textarea
                autoFocus
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onBlur={saveBody}
                onPaste={(e) => {
                  // Pegar una respuesta de Claude/ChatGPT conserva encabezados, listas y código.
                  const md = markdownFromPaste(e);
                  if (!md) return;
                  e.preventDefault();
                  const el = e.currentTarget;
                  const next = body.slice(0, el.selectionStart ?? body.length) + md + body.slice(el.selectionEnd ?? body.length);
                  setBody(next);
                  // El origen se anota solo la primera vez: sirve para recordar de dónde salió.
                  if (block.kind === 'chat' && !block.source) handlers.onUpdate(block.id, { source: guessSource(e) });
                }}
                placeholder={isQuestion ? 'Notas, o la respuesta cuando la tengas…' : 'Escribe o pega aquí. Soporta Markdown.'}
                rows={isQuestion ? 2 : 6}
                className="scroll-thin w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="text-[11px] text-muted-foreground">Se guarda al salir del campo.</p>
            </>
          ) : block.body ? (
            <div className={cn('cursor-text', readOnly && 'cursor-default')} onClick={() => !readOnly && setEditing(true)}>
              <Markdown className="text-sm">{block.body}</Markdown>
            </div>
          ) : (
            !readOnly && (
              <button type="button" onClick={() => setEditing(true)} className="text-xs text-muted-foreground hover:text-foreground">
                Escribir…
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

/** De dónde se pegó, a partir del propio contenido del portapapeles. Best-effort y sin red. */
function guessSource(e: { clipboardData: DataTransfer | null }): string | null {
  const html = e.clipboardData?.getData('text/html') ?? '';
  if (/claude\.ai|anthropic/i.test(html)) return 'Claude';
  if (/chatgpt|openai/i.test(html)) return 'ChatGPT';
  if (/gemini|bard/i.test(html)) return 'Gemini';
  return null;
}
