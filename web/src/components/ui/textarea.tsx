import * as React from 'react';
import { cn } from '@/lib/utils';
import { fieldSkin } from './input';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Crece con el contenido (por defecto sí). Arranca en `rows` líneas y no pasa de `maxRows`. */
  autoGrow?: boolean;
  maxRows?: number;
  invalid?: boolean;
}

/**
 * Área de texto que crece sola: empieza en una o dos líneas y se estira conforme se escribe, en vez
 * de reservar un hueco grande vacío. Pasado `maxRows` hace scroll dentro.
 */
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, autoGrow = true, maxRows = 10, rows = 2, invalid, onInput, value, ...props }, ref) => {
    const inner = React.useRef<HTMLTextAreaElement | null>(null);
    const setRef = (el: HTMLTextAreaElement | null) => {
      inner.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    };

    const fit = React.useCallback(() => {
      const el = inner.current;
      if (!el || !autoGrow) return;
      const cs = getComputedStyle(el);
      const line = parseFloat(cs.lineHeight) || 20;
      const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + border;
      const max = line * maxRows + pad;
      el.style.height = 'auto';
      const want = el.scrollHeight + border;
      el.style.height = `${Math.min(want, max)}px`;
      el.style.overflowY = want > max ? 'auto' : 'hidden';
    }, [autoGrow, maxRows]);

    // `value` cambia también desde fuera (reset del formulario, dato que llega del servidor).
    React.useLayoutEffect(fit, [fit, value]);

    return (
      <textarea
        ref={setRef}
        rows={rows}
        value={value}
        aria-invalid={invalid || undefined}
        onInput={(e) => { fit(); onInput?.(e); }}
        className={cn(fieldSkin, 'scroll-thin block w-full resize-none px-3 py-2 leading-snug', className)}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

export { Textarea };
