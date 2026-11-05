import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * "¿Por qué cambias al responsable que eligió roz?" — aparece SOLO cuando se cambia al responsable
 * que eligió la asignación automática, y solo la primera vez. Las categorías son cerradas a
 * propósito: cada una apunta a una palanca del algoritmo, y un texto libre no se puede contar.
 */
export function OverrideReasonDialog({
  open,
  categories,
  chosenName,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  categories: { value: string; label: string; hint: string }[];
  /** A quién había elegido roz (para que la pregunta sea concreta). */
  chosenName: string | null;
  onConfirm: (category: string, note: string | null) => void;
  onCancel: () => void;
}) {
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) {
      setCategory('');
      setNote('');
    }
  }, [open]);

  const needsNote = category === 'otro';
  const canConfirm = !!category && (!needsNote || note.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>¿Por qué cambias al responsable?</DialogTitle>
          <DialogDescription>
            {chosenName ? <>roz había elegido a <span className="font-medium text-foreground">{chosenName}</span>. </> : null}
            Tu motivo es lo que hace que la asignación automática mejore.
          </DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label="Motivo" className="space-y-1">
          {categories.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={category === c.value}
              onClick={() => setCategory(c.value)}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent',
                category === c.value ? 'border-primary bg-primary/5' : 'border-transparent',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border',
                  category === c.value ? 'border-primary' : 'border-input',
                )}
              >
                {category === c.value && <span className="size-2 rounded-full bg-primary" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{c.label}</span>
                <span className="block text-xs text-muted-foreground">{c.hint}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="override-note">Nota {needsNote ? '(obligatoria)' : '(opcional)'}</Label>
          <textarea
            id="override-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="Contexto que roz no podía ver…"
            className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancelar
          </Button>
          <Button disabled={!canConfirm} onClick={() => onConfirm(category, note.trim() || null)}>
            Cambiar responsable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
