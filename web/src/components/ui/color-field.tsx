import * as React from 'react';
import { Check } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { FieldChange } from '@/components/ui/date-field';
import { cn } from '@/lib/utils';

/**
 * Selector de color PROPIO (reemplaza a `<input type="color">`, que abre el selector del sistema).
 * Una paleta de muestras tomadas de los TOKENS del tema y un campo para escribir un hex libre.
 *
 * El valor es un hex `#rrggbb` (lo que guardaba el input nativo). Las muestras se resuelven a hex
 * leyendo el token ya calculado en el DOM, así que aquí no hay un solo hex escrito a mano; se
 * resuelven con el tema vigente al abrir.
 *
 * `onChange` recibe `{ target: { value } }`, como el input que sustituye.
 */

/** Tokens que se ofrecen como muestra, en orden de rueda de color. */
const SWATCHES = [
  ['orange', 'Naranja'], ['salmon', 'Salmón'], ['yellow', 'Amarillo'], ['warning', 'Ámbar'],
  ['green', 'Verde'], ['chart-5', 'Cielo'], ['blue', 'Azul'], ['purple-deep', 'Morado'],
  ['purple', 'Lila'], ['red', 'Rojo'], ['faint', 'Gris'], ['ink', 'Tinta'],
] as const;

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Hex del token tal como lo pinta el navegador ahora mismo (sigue al tema). */
function resolveTokens(): Record<string, string> {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const out: Record<string, string> = {};
  for (const [token] of SWATCHES) {
    probe.style.color = `hsl(var(--${token}))`;
    const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(getComputedStyle(probe).color);
    if (m) out[token] = `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  }
  probe.remove();
  return out;
}

export function ColorField({
  value, onChange, onValueChange, children, className, disabled, align = 'start', ...aria
}: {
  /** Hex `#rrggbb`. */
  value: string;
  onChange?: (e: FieldChange) => void;
  onValueChange?: (v: string) => void;
  /** Contenido del disparador (muestra + texto). Por defecto, la muestra y el hex. */
  children?: React.ReactNode;
  /** Clases del disparador (un `<button>`). */
  className?: string;
  disabled?: boolean;
  align?: 'start' | 'center' | 'end';
  'aria-label'?: string;
  title?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [hexes, setHexes] = React.useState<Record<string, string>>({});
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => { if (open) { setHexes(resolveTokens()); setDraft(value); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { setDraft(value); }, [value]);

  const emit = (v: string) => {
    onChange?.({ target: { value: v } });
    onValueChange?.(v);
  };
  const current = value.toLowerCase();
  const draftOk = HEX_RE.test(draft);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button type="button" className={className} aria-label={aria['aria-label']} title={aria.title}>
          {children ?? (
            <>
              <span className="size-3.5 rounded-[4px] ring-1 ring-border" style={{ background: value }} />
              <span className="font-mono text-[12px] uppercase">{value}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[212px] p-3">
        <div className="label-caps mb-2">Color</div>
        <div className="grid grid-cols-6 gap-1.5">
          {SWATCHES.map(([token, name]) => {
            const hex = hexes[token];
            const on = !!hex && hex === current;
            return (
              <button
                key={token}
                type="button"
                aria-label={name}
                aria-pressed={on}
                data-tip={name}
                onClick={() => hex && emit(hex)}
                className={cn(
                  'grid size-7 place-items-center rounded-md ring-1 ring-foreground/10 transition-transform duration-quick hover:scale-110',
                  on && 'ring-2 ring-foreground/70 ring-offset-2 ring-offset-popover',
                )}
                style={{ background: `hsl(var(--${token}))` }}
              >
                {on && <Check className={cn('size-3.5', token === 'ink' ? 'text-ink-foreground' : 'text-white')} strokeWidth={3} />}
              </button>
            );
          })}
        </div>
        <label className="mt-3 flex h-8 items-center gap-2 rounded-md border border-input bg-card px-2 transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/15 aria-[invalid=true]:border-red" aria-invalid={!draftOk && draft !== '' ? true : undefined}>
          <span className="size-4 shrink-0 rounded-[4px] ring-1 ring-border" style={{ background: draftOk ? draft : value }} />
          <input
            value={draft}
            spellCheck={false}
            maxLength={7}
            placeholder="#rrggbb"
            aria-label="Color en hexadecimal"
            onChange={(e) => {
              let v = e.target.value.trim().toLowerCase().replace(/[^#0-9a-f]/g, '');
              if (v && !v.startsWith('#')) v = `#${v}`;
              setDraft(v.slice(0, 7));
              if (HEX_RE.test(v)) emit(v);
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setOpen(false); } }}
            className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] uppercase outline-none placeholder:normal-case placeholder:text-faint"
          />
        </label>
      </PopoverContent>
    </Popover>
  );
}
