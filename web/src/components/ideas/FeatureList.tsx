import { useState } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/bits';
import { FEATURE_PRIORITY_DOT, FEATURE_PRIORITY_LABEL, FEATURE_PRIORITY_OPTIONS } from '@/lib/ideas';
import type { IdeaFeature } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * El alcance de la idea: qué cosas la componen y cuáles son imprescindibles.
 *
 * MoSCoW en cuatro niveles, incluido 'Fuera'. Marcar algo como fuera y dejarlo a la vista es
 * deliberado: la lista de lo descartado es lo que evita que la idea se vuelva a inflar sola.
 *
 * Cada cambio se guarda al instante contra su endpoint (como los comentarios de una tarea): la
 * lista es una entidad propia, no parte del formulario que se guarda con el botón.
 */
export function FeatureList({
  features,
  readOnly,
  busy,
  onAdd,
  onUpdate,
  onDelete,
  onMove,
}: {
  features: IdeaFeature[];
  readOnly?: boolean;
  busy?: boolean;
  onAdd: (title: string) => void;
  onUpdate: (id: string, patch: { title?: string; detail?: string | null; priority?: string }) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}) {
  const [draft, setDraft] = useState('');

  function add() {
    const t = draft.trim();
    if (!t) return;
    onAdd(t);
    setDraft('');
  }

  return (
    <div id="ideas-features" className="space-y-2">
      {features.length === 0 && readOnly && <EmptyState>Sin features todavía</EmptyState>}

      {features.map((f, i) => (
        <FeatureRow
          key={f.id}
          feature={f}
          readOnly={readOnly}
          first={i === 0}
          last={i === features.length - 1}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onMove={onMove}
        />
      ))}

      {!readOnly && (
        <div className="flex items-center gap-2 pt-1">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Añadir feature…  (Enter)"
            className="h-9"
          />
          <Button size="icon" variant="secondary" className="size-9 shrink-0" onClick={add} disabled={!draft.trim() || busy} aria-label="Añadir feature">
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          </Button>
        </div>
      )}
    </div>
  );
}

function FeatureRow({
  feature,
  readOnly,
  first,
  last,
  onUpdate,
  onDelete,
  onMove,
}: {
  feature: IdeaFeature;
  readOnly?: boolean;
  first: boolean;
  last: boolean;
  onUpdate: (id: string, patch: { title?: string; detail?: string | null; priority?: string }) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}) {
  const [title, setTitle] = useState(feature.title);
  const [detail, setDetail] = useState(feature.detail ?? '');
  const [openDetail, setOpenDetail] = useState(false);
  const out = feature.priority === 'descartada';

  return (
    <div className={cn('rounded-lg border bg-card p-2 transition-opacity', out && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <span className={cn('size-2 shrink-0 rounded-full', FEATURE_PRIORITY_DOT[feature.priority] ?? 'bg-muted')} />

        {readOnly ? (
          <span className={cn('min-w-0 flex-1 truncate text-sm', out && 'line-through')}>{feature.title}</span>
        ) : (
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              const t = title.trim();
              if (!t) return setTitle(feature.title); // no se permite vaciar el título
              if (t !== feature.title) onUpdate(feature.id, { title: t });
            }}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            className={cn(
              'min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 text-sm outline-none transition-colors hover:border-input focus:border-input focus:ring-1 focus:ring-ring',
              out && 'line-through',
            )}
          />
        )}

        {readOnly ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">{FEATURE_PRIORITY_LABEL[feature.priority]}</span>
        ) : (
          <Select value={feature.priority} onValueChange={(v) => onUpdate(feature.id, { priority: v })}>
            <SelectTrigger className="h-7 w-[136px] shrink-0 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FEATURE_PRIORITY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {!readOnly && (
          <div className="flex shrink-0 items-center">
            <Button size="icon" variant="ghost" className="size-7" onClick={() => onMove(feature.id, -1)} disabled={first} aria-label="Subir">
              <ChevronUp className="size-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="size-7" onClick={() => onMove(feature.id, 1)} disabled={last} aria-label="Bajar">
              <ChevronDown className="size-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => onDelete(feature.id)} aria-label="Eliminar feature">
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      {(feature.detail || openDetail) && (
        <div className="mt-1.5 pl-4">
          {readOnly ? (
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">{feature.detail}</p>
          ) : (
            <textarea
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              onBlur={() => {
                const d = detail.trim();
                if (d !== (feature.detail ?? '')) onUpdate(feature.id, { detail: d || null });
              }}
              placeholder="Detalle…"
              rows={2}
              className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          )}
        </div>
      )}

      {!readOnly && !feature.detail && !openDetail && (
        <button
          type="button"
          onClick={() => setOpenDetail(true)}
          className="ml-4 mt-0.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          + detalle
        </button>
      )}
    </div>
  );
}
