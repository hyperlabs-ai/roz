import { useState } from 'react';
import { Eye, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/Markdown';
import { markdownFromPaste } from '@/lib/rich-text';
import type { GuidedField as FieldDef } from '@/lib/ideas';
import { cn } from '@/lib/utils';

/**
 * Un campo guiado del cuestionario.
 *
 * La pregunta se muestra SIEMPRE, también (sobre todo) cuando el campo está vacío: es la invitación
 * a escribir, y es lo que diferencia esto de un documento en blanco. Un campo sin contestar se ve
 * atenuado pero presente — que falte tiene que notarse.
 */
export function GuidedFieldEditor({
  field,
  value,
  onChange,
  readOnly,
}: {
  field: FieldDef;
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
}) {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const empty = !value.trim();
  const editing = mode === 'edit' && !readOnly;

  return (
    <div id={`guided-${field.key}`} className={cn('rounded-xl border p-3 transition-colors', empty && 'border-dashed bg-muted/20')}>
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{field.label}</div>
          <p className="mt-0.5 text-xs text-muted-foreground/80">{field.question}</p>
        </div>
        {!readOnly && !empty && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => setMode(editing ? 'view' : 'edit')}
          >
            {editing ? <Eye className="size-3.5" /> : <Pencil className="size-3.5" />}
            <span className="ml-1">{editing ? 'Vista' : 'Editar'}</span>
          </Button>
        )}
      </div>

      {editing || (empty && !readOnly) ? (
        <textarea
          data-guided-input={field.key}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setMode('edit')}
          onPaste={(e) => {
            // Pegar de un LLM o de un doc con formato conserva la estructura como markdown.
            const md = markdownFromPaste(e);
            if (!md) return;
            e.preventDefault();
            const el = e.currentTarget;
            const next = value.slice(0, el.selectionStart ?? value.length) + md + value.slice(el.selectionEnd ?? value.length);
            onChange(next);
          }}
          placeholder={field.placeholder}
          rows={3}
          className="scroll-thin w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : empty ? (
        <p className="py-1 text-sm text-muted-foreground/60">Sin contestar</p>
      ) : (
        <div
          className={cn('cursor-text', readOnly && 'cursor-default')}
          onClick={() => !readOnly && setMode('edit')}
        >
          <Markdown className="text-sm">{value}</Markdown>
        </div>
      )}
    </div>
  );
}
