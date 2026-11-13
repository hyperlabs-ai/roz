import { useEffect, useRef } from 'react';
import './hover-tip.css';

/**
 * Tooltip GLOBAL de la app. Se monta una sola vez (en `main.tsx`) y atiende a cualquier elemento con
 * `data-tip="…"` o con `title="…"`: el `title` se convierte al vuelo en `data-tip` y se retira del DOM,
 * así que el tooltip gris del navegador no llega a salir en ninguna parte, tampoco en código viejo o
 * futuro que siga escribiendo `title`.
 *
 * Es UN solo elemento flotante: por construcción no pueden quedar dos tooltips abiertos a la vez ni
 * uno "pegado" (se cierra al salir, al hacer clic, al teclear, al hacer scroll y si su elemento
 * desaparece o se mueve, como pasa al contraer el menú).
 *
 *   <button data-tip="Sincronizar" data-tip-side="right">…</button>
 *
 * `data-tip-side`: top (por defecto) | right | bottom | left. Si no cabe, se voltea al lado opuesto.
 * Para contenido rico (JSX) sigue existiendo `ui/tooltip.tsx` (Radix).
 */
export function HoverTips() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tip = ref.current;
    if (!tip) return;
    let cur: Element | null = null;
    let timer = 0;
    let lastShown = 0;
    let anchor = '';

    /** `title` → `data-tip`, conservando el nombre accesible si el elemento no tiene otro. */
    const claim = (el: Element) => {
      const title = el.getAttribute('title');
      if (title == null) return;
      el.removeAttribute('title');
      if (!title.trim()) return;
      el.setAttribute('data-tip', title);
      if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !(el.textContent ?? '').trim()) el.setAttribute('aria-label', title);
    };
    const find = (n: EventTarget | null): Element | null => (n instanceof Element ? n.closest('[title],[data-tip]') : null);
    const rectKey = (el: Element) => {
      const r = el.getBoundingClientRect();
      return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}`;
    };

    const hide = () => {
      window.clearTimeout(timer);
      if (cur) lastShown = performance.now();
      cur = null;
      tip.dataset.on = '0';
    };

    const place = (el: Element, text: string) => {
      if (!el.isConnected) return hide();
      tip.textContent = text;
      const r = el.getBoundingClientRect();
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const gap = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let side = el.getAttribute('data-tip-side') ?? 'top';
      if (side === 'top' && r.top - h - gap < 4) side = 'bottom';
      else if (side === 'bottom' && r.bottom + h + gap > vh - 4) side = 'top';
      else if (side === 'right' && r.right + w + gap > vw - 4) side = 'left';
      else if (side === 'left' && r.left - w - gap < 4) side = 'right';
      let x = r.left + r.width / 2 - w / 2;
      let y = r.top - h - gap;
      if (side === 'bottom') y = r.bottom + gap;
      else if (side === 'right') {
        x = r.right + gap;
        y = r.top + r.height / 2 - h / 2;
      } else if (side === 'left') {
        x = r.left - w - gap;
        y = r.top + r.height / 2 - h / 2;
      }
      tip.style.left = `${Math.round(Math.min(Math.max(4, x), vw - w - 4))}px`;
      tip.style.top = `${Math.round(Math.min(Math.max(4, y), vh - h - 4))}px`;
      tip.dataset.side = side;
      tip.dataset.on = '1';
      anchor = rectKey(el);
    };

    const arm = (el: Element, instant: boolean) => {
      claim(el);
      const text = el.getAttribute('data-tip');
      if (!text) return;
      cur = el;
      // Sin espera si se viene de otro tooltip (recorrer una barra de iconos) o si lo pide el elemento.
      const delay = instant || performance.now() - lastShown < 320 || el.hasAttribute('data-tip-now') ? 0 : 380;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => cur === el && place(el, text), delay);
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = find(e.target);
      if (el === cur) return;
      hide();
      if (el) arm(el, false);
    };
    // El elemento puede moverse o desaparecer bajo un cursor quieto (el menú al contraerse): se suelta.
    const onMove = () => {
      if (cur && tip.dataset.on === '1' && (!cur.isConnected || rectKey(cur) !== anchor)) hide();
    };
    const onFocus = (e: FocusEvent) => {
      const el = find(e.target);
      if (el && el === e.target && (el as HTMLElement).matches(':focus-visible')) {
        hide();
        arm(el, true);
      }
    };
    const onLeaveDoc = (e: PointerEvent) => {
      if (!e.relatedTarget) hide();
    };

    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerout', onLeaveDoc, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('wheel', hide, { capture: true, passive: true });
    window.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerout', onLeaveDoc, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('wheel', hide, true);
      window.removeEventListener('blur', hide);
      window.removeEventListener('resize', hide);
    };
  }, []);

  return <div ref={ref} role="tooltip" className="hover-tip" data-on="0" />;
}
