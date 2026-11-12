import * as React from 'react';
import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface NumberFieldProps {
  /** `null` = vacío (se ve el `placeholder`). */
  value: number | null;
  /** Se llama al CONFIRMAR: al salir, con Enter, con las flechas o con −/+. Nunca en cada tecla. */
  onCommit: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Unidad pegada al número (`%`, `h`). */
  unit?: string;
  placeholder?: string;
  /** Permite dejarlo vacío (confirma `null`). Si no, vaciarlo restaura el valor anterior. */
  nullable?: boolean;
  /** Botones −/+ a los lados. Sin ellos, las flechas ↑/↓ siguen funcionando. */
  stepper?: boolean;
  size?: 'sm' | 'md';
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
}

function StepButton({ dir, disabled, onClick }: { dir: 1 | -1; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      disabled={disabled}
      aria-label={dir === 1 ? 'Subir' : 'Bajar'}
      onClick={onClick}
      className={cn(
        'grid w-7 shrink-0 place-items-center text-muted-foreground transition-colors hover:bg-panel hover:text-foreground disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-3',
        dir === 1 ? 'border-l' : 'border-r',
      )}
    >
      {dir === 1 ? <Plus strokeWidth={2.5} /> : <Minus strokeWidth={2.5} />}
    </button>
  );
}

/**
 * Número entero con unidad y pasos. Solo deja teclear dígitos, recorta al rango al confirmar, y
 * sube/baja con ↑/↓ (Shift = ×5) o con los botones −/+.
 */
export function NumberField({
  value, onCommit, min = 0, max = 100, step = 1, unit, placeholder, nullable, stepper = false,
  size = 'md', disabled, invalid, id, className, ...aria
}: NumberFieldProps) {
  const asText = (v: number | null) => (v == null ? '' : String(v));
  const [draft, setDraft] = React.useState(asText(value));
  const focused = React.useRef(false);
  React.useEffect(() => { if (!focused.current) setDraft(asText(value)); }, [value]);

  const clamp = (n: number) => Math.min(max, Math.max(min, Math.trunc(n)));
  const commit = (raw: string) => {
    const t = raw.trim();
    if (!t) {
      if (nullable) { if (value != null) onCommit(null); }
      else setDraft(asText(value));
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) { setDraft(asText(value)); return; }
    const next = clamp(n);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  const bump = (dir: 1 | -1, mult = 1) => {
    const base = draft.trim() ? Number(draft) : value ?? (placeholder ? Number(placeholder) : min);
    const next = clamp((Number.isFinite(base) ? base : min) + dir * step * mult);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <div
      aria-invalid={invalid || undefined}
      className={cn(
        'flex shrink-0 items-stretch overflow-hidden rounded-md border border-input bg-card text-[13.5px] transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/15 aria-[invalid=true]:border-red',
        disabled ? 'cursor-not-allowed opacity-55' : 'hover:border-foreground/25 focus-within:hover:border-ring',
        size === 'sm' ? 'h-8 text-[13px]' : 'h-9',
        stepper ? 'w-[112px]' : 'w-[72px]',
        className,
      )}
    >
      {stepper && <StepButton dir={-1} disabled={disabled || (value != null && value <= min)} onClick={() => bump(-1)} />}
      <label className="flex min-w-0 flex-1 cursor-text items-center justify-center gap-0.5 px-1.5">
        <input
          id={id}
          value={draft}
          disabled={disabled}
          inputMode="numeric"
          placeholder={placeholder}
          aria-label={aria['aria-label']}
          onFocus={(e) => { focused.current = true; e.target.select(); }}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={(e) => { focused.current = false; commit(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'Escape') {
              e.stopPropagation();
              const el = e.target as HTMLInputElement;
              el.value = asText(value); // el blur confirma lo que lea del campo: se le devuelve el valor viejo
              setDraft(asText(value));
              el.blur();
            }
            // Sin autorrepetición: cada paso confirma (y guarda), y dejar la tecla pulsada mandaba una ráfaga.
            if (e.key === 'ArrowUp') { e.preventDefault(); if (!e.repeat) bump(1, e.shiftKey ? 5 : 1); }
            if (e.key === 'ArrowDown') { e.preventDefault(); if (!e.repeat) bump(-1, e.shiftKey ? 5 : 1); }
          }}
          style={{ width: `${Math.max(1, (draft || placeholder || '').length) + 0.5}ch` }}
          className="min-w-0 bg-transparent text-right font-medium tabular-nums outline-none placeholder:font-normal placeholder:text-faint disabled:cursor-not-allowed"
        />
        {unit && <span className="select-none text-[12px] text-faint">{unit}</span>}
      </label>
      {stepper && <StepButton dir={1} disabled={disabled || (value != null && value >= max)} onClick={() => bump(1)} />}
    </div>
  );
}
