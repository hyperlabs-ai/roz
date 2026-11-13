// Lienzo del mapa de zeus: el radial POR ZONAS. SVG hecho a mano (sin librería de grafos): recibe un
// layout ya calculado (`zoneLayout`) y solo dibuja, encuadra y anima. Tres cosas se hacen FUERA de
// React a propósito, porque ocurren muchas veces por segundo y no deben re-renderizar cientos de nodos:
//   · el encuadre (pan/zoom) se escribe directo en el `transform` del grupo;
//   · los pulsos de actividad son elementos SVG creados y destruidos a mano;
//   · el destello de un nodo es un anillo temporal en esa misma capa.
// El lienzo es SIEMPRE oscuro (la clase `dark` re-declara los tokens dentro de él): es un instrumento,
// y los tonos de las zonas se leen igual con el tema claro o el oscuro alrededor.
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react';
import { CornerLeftUp, Maximize2, Pin, ZoomIn, ZoomOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ZeusGraphNode } from '@/lib/zeus';
import { Z_LABEL_BAND, fitTransform, pathToRoot, zoomAt, type Placed, type ViewTransform, type ZoneLayout, type ZoneSector } from './layout';
import { STATUS_META, edgeMeta, kindMeta, type Tone } from './zeus-ui';
import './zeus.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_PULSES = 28;

export interface ZoneCanvasHandle {
  /** Manda un pulso desde ese nodo hasta el centro y lo destella. false si el nodo no está a la vista. */
  pulse: (id: string) => boolean;
  fit: () => void;
}

export interface ZoneInfo {
  label: string;
  tone: Tone;
}

export interface ZoneCanvasProps {
  layout: ZoneLayout;
  /** Nodos del grafo por referencia (título, estado, meta). */
  nodes: Map<string, ZeusGraphNode>;
  /** Nombre y tono de cada zona, por id de sector. */
  zones: Map<string, ZoneInfo>;
  /** Qué hay en el centro: "zeus" en la raíz, la zona abierta al entrar a una. */
  center: { label: string; caption: string; canGoUp: boolean };
  /** Elemento del anillo exterior al que pertenece una entrada (su proyecto), si está dibujado. */
  outerOf: (id: string) => string | null;
  projectNames: Map<string, string>;
  selectedId: string | null;
  /** Ids que NO pasan el filtro de texto: se atenúan sin moverse. null = sin filtro. */
  dimmed: Set<string> | null;
  /** Zona resaltada desde fuera (al pasar por la lista lateral). */
  hotZone?: string | null;
  /** Cambia cuando hay que volver a encuadrar (otra vista, primeros datos). */
  fitKey: string;
  /** Franjas tapadas por paneles flotantes: el encuadre usa solo el hueco que dejan. */
  inset?: { left: number; right: number };
  reducedMotion: boolean;
  onSelect: (id: string) => void;
  onOpenZone: (zoneId: string) => void;
  onOpenOuter: (id: string) => void;
  onUp: () => void;
  className?: string;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const deg = (rad: number): number => (rad * 180) / Math.PI;

/** Sector anular entre dos radios y dos ángulos. */
function wedge(s: ZoneSector, rIn: number, rOut: number): string {
  const span = s.a1 - s.a0;
  if (span >= Math.PI * 2 - 1e-6) {
    // Una vuelta completa no se puede dibujar con un solo arco: dos medias lunas.
    return `M${rOut} 0 A${rOut} ${rOut} 0 1 1 ${-rOut} 0 A${rOut} ${rOut} 0 1 1 ${rOut} 0 Z M${rIn} 0 A${rIn} ${rIn} 0 1 0 ${-rIn} 0 A${rIn} ${rIn} 0 1 0 ${rIn} 0 Z`;
  }
  const large = span > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
  return `M${p(rIn, s.a0)} L${p(rOut, s.a0)} A${rOut} ${rOut} 0 ${large} 1 ${p(rOut, s.a1)} L${p(rIn, s.a1)} A${rIn} ${rIn} 0 ${large} 0 ${p(rIn, s.a0)} Z`;
}

/** Arco de radio `r` entre dos ángulos. */
function arc(r: number, a0: number, a1: number): string {
  const p = (a: number) => `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
  return `M${p(a0)} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)}`;
}

/** Curva entre dos nodos que se comba hacia el centro: las conexiones no tapan las zonas vecinas. */
function chord(a: Placed, b: Placed): string {
  const mx = ((a.x + b.x) / 2) * 0.45;
  const my = ((a.y + b.y) / 2) * 0.45;
  return `M${a.x} ${a.y} Q${mx.toFixed(1)} ${my.toFixed(1)} ${b.x} ${b.y}`;
}

/** Atributos de un texto escrito hacia afuera en el ángulo `a`, siempre legible (nunca de cabeza). */
function radialText(a: number, offset: number): { transform: string; textAnchor: 'start' | 'end'; x: number } {
  const flip = Math.cos(a) < 0;
  return { transform: `rotate(${(deg(a) + (flip ? 180 : 0)).toFixed(2)})`, textAnchor: flip ? 'end' : 'start', x: flip ? -offset : offset };
}

export const ZoneCanvas = memo(
  forwardRef<ZoneCanvasHandle, ZoneCanvasProps>(function ZoneCanvas(
    { layout, nodes, zones, center, outerOf, projectNames, selectedId, dimmed, hotZone, fitKey, inset, reducedMotion, onSelect, onOpenZone, onOpenOuter, onUp, className },
    ref,
  ) {
    const insetRef = useRef(inset);
    insetRef.current = inset;
    const wrapRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<SVGGElement>(null);
    const pulseRef = useRef<SVGGElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const view = useRef<ViewTransform>({ x: 0, y: 0, k: 1 });
    const [size, setSize] = useState<{ w: number; h: number } | null>(null);
    const [hover, setHover] = useState<string | null>(null);
    const [hoverZone, setHoverZone] = useState<string | null>(null);

    const placeCard = useCallback(() => {
      const card = cardRef.current;
      const wrap = wrapRef.current;
      const id = card?.dataset.for;
      const p = id ? layoutRef.current.byId.get(id) : undefined;
      if (!card || !wrap || !p) return;
      const t = view.current;
      const x = p.x * t.k + t.x;
      const y = p.y * t.k + t.y;
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      // A la derecha del punto si cabe; si no, a la izquierda. Nunca fuera del lienzo.
      const left = x + 16 + w > wrap.clientWidth - 8 ? x - 16 - w : x + 16;
      const top = Math.min(Math.max(8, y - h / 2), wrap.clientHeight - h - 8);
      card.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
    }, []);

    const apply = useCallback(
      (t: ViewTransform, animate = false) => {
        view.current = t;
        const g = viewRef.current;
        if (g) {
          g.dataset.anim = animate ? '1' : '0';
          g.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
        }
        placeCard();
      },
      [placeCard],
    );

    const layoutRef = useRef(layout);
    layoutRef.current = layout;
    const fit = useCallback(
      (animate = true) => {
        const el = wrapRef.current;
        if (!el) return;
        const left = insetRef.current?.left ?? 0;
        const right = insetRef.current?.right ?? 0;
        const t = fitTransform(layoutRef.current.bounds, Math.max(120, el.clientWidth - left - right), el.clientHeight, 1.6);
        apply({ ...t, x: t.x + left }, animate);
      },
      [apply],
    );

    useEffect(() => {
      const el = wrapRef.current;
      if (!el) return;
      const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    // Encuadre al cambiar de vista o de tamaño. El primero va sin animación (no hay "desde dónde").
    const fitted = useRef(false);
    useEffect(() => {
      if (!size) return;
      fit(fitted.current && !reducedMotion);
      fitted.current = true;
    }, [fitKey, size, fit, reducedMotion]);

    // Otra vista: la ficha flotante apuntaría a un nodo que ya no está.
    useEffect(() => {
      setHover(null);
      setHoverZone(null);
    }, [layout]);
    useEffect(placeCard, [hover, placeCard]);

    // ---------------------------------------------------------------- pulsos (imperativo)

    const pulse = useCallback(
      (id: string): boolean => {
        const layer = pulseRef.current;
        const path = pathToRoot(layoutRef.current, id);
        if (!layer || !path.length) return false;
        if (layer.childElementCount > MAX_PULSES) return true;
        const origin = path[0]!;

        const flash = document.createElementNS(SVG_NS, 'circle');
        flash.setAttribute('class', 'zeus-flash');
        flash.setAttribute('cx', String(origin.x));
        flash.setAttribute('cy', String(origin.y));
        flash.setAttribute('r', String(origin.r + 3));
        layer.appendChild(flash);
        window.setTimeout(() => flash.remove(), 1500);

        if (reducedMotion || path.length < 2 || typeof flash.animate !== 'function') return true;

        const hot: Element[] = [];
        for (let i = 0; i < path.length - 1; i++) {
          const el = viewRef.current?.querySelector(`[data-link="${CSS.escape(`s:${path[i + 1]!.id}>${path[i]!.id}`)}"]`);
          if (el) {
            el.setAttribute('data-hot', '1');
            hot.push(el);
          }
        }

        const dot = document.createElementNS(SVG_NS, 'g');
        const glow = document.createElementNS(SVG_NS, 'circle');
        glow.setAttribute('class', 'zeus-pulse-glow');
        glow.setAttribute('r', '9');
        const core = document.createElementNS(SVG_NS, 'circle');
        core.setAttribute('class', 'zeus-pulse-core');
        core.setAttribute('r', '3.5');
        dot.append(glow, core);
        layer.appendChild(dot);

        const frames = path.map((p) => ({ transform: `translate(${p.x}px, ${p.y}px)` }));
        const anim = dot.animate(frames, { duration: 560 * (path.length - 1), easing: 'ease-in-out', fill: 'forwards' });
        const done = () => {
          dot.remove();
          for (const el of hot) el.removeAttribute('data-hot');
        };
        anim.onfinish = done;
        anim.oncancel = done;
        return true;
      },
      [reducedMotion],
    );

    useImperativeHandle(ref, () => ({ pulse, fit: () => fit(!reducedMotion) }), [pulse, fit, reducedMotion]);

    // Al cambiar de disposición los pulsos en vuelo apuntarían a coordenadas viejas.
    useEffect(() => {
      const layer = pulseRef.current;
      return () => {
        layer?.replaceChildren();
        viewRef.current?.querySelectorAll('[data-hot]').forEach((el) => el.removeAttribute('data-hot'));
      };
    }, [layout]);

    // ---------------------------------------------------------------- pan / zoom

    const pointers = useRef(new Map<number, { x: number; y: number }>());
    const gesture = useRef({ sx: 0, sy: 0, moved: false, dist: 0 });
    const suppressClick = useRef(false);

    const local = (clientX: number, clientY: number) => {
      const r = wrapRef.current!.getBoundingClientRect();
      return { x: clientX - r.left, y: clientY - r.top };
    };

    const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 1) gesture.current = { sx: e.clientX, sy: e.clientY, moved: false, dist: 0 };
      else gesture.current.dist = 0;
    };

    const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
      const prev = pointers.current.get(e.pointerId);
      if (!prev) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gesture.current;

      if (pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (g.dist > 0 && dist > 0) {
          const mid = local((a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
          apply(zoomAt(view.current, mid.x, mid.y, dist / g.dist));
        }
        g.dist = dist;
        g.moved = true;
        return;
      }

      if (!g.moved) {
        // Umbral: un clic con pulso tembloroso no debe convertirse en arrastre (ni tragarse el clic).
        if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 5) return;
        g.moved = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        setHover(null);
      }
      const t = view.current;
      apply({ ...t, x: t.x + e.clientX - prev.x, y: t.y + e.clientY - prev.y });
    };

    const onPointerEnd = (e: PointerEvent<SVGSVGElement>) => {
      if (!pointers.current.delete(e.pointerId)) return;
      gesture.current.dist = 0;
      if (gesture.current.moved && pointers.current.size === 0) {
        suppressClick.current = true;
        window.setTimeout(() => { suppressClick.current = false; }, 0);
      }
    };

    // `wheel` de React es pasivo: para frenar el scroll de la página hay que registrarlo a mano.
    useEffect(() => {
      const el = wrapRef.current;
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const p = local(e.clientX, e.clientY);
        // Con ctrl (pellizco de trackpad) los deltas son chicos: se amplifican.
        apply(zoomAt(view.current, p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016))));
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return () => el.removeEventListener('wheel', onWheel);
    }, [apply]);

    const zoomBy = (factor: number) => {
      const el = wrapRef.current;
      if (!el) return;
      apply(zoomAt(view.current, el.clientWidth / 2, el.clientHeight / 2, factor), !reducedMotion);
    };

    // ---------------------------------------------------------------- dibujo

    const single = layout.sectors.length === 1;
    const zoneOf = useCallback(
      (p: Placed): ZoneInfo | undefined => zones.get(p.role === 'category' ? p.id : single ? layout.sectors[0]!.id : p.parent ?? ''),
      [zones, single, layout],
    );

    const backdrop = useMemo(() => {
      const [outer, ...inner] = layout.discs;
      return (
        <g className="zeus-fade pointer-events-none">
          <circle r={outer} className="fill-foreground" fillOpacity={0.035} />
          <circle r={outer} className="fill-none stroke-foreground" strokeOpacity={0.14} strokeWidth={1} />
          {/* Aro de marcas, como el dial de un instrumento: 180 rayitas con un solo círculo punteado. */}
          <circle r={outer + 7} className="fill-none stroke-foreground" strokeOpacity={0.22} strokeWidth={5} strokeDasharray={`1 ${((Math.PI * 2 * (outer + 7)) / 180 - 1).toFixed(3)}`} />
          {inner.map((r, i) => (
            <g key={i}>
              <circle r={r} className="fill-foreground" fillOpacity={0.03} />
              <circle r={r} className="fill-none stroke-foreground" strokeOpacity={0.09} strokeWidth={0.8} strokeDasharray={i === 0 ? undefined : '2 5'} />
            </g>
          ))}
        </g>
      );
    }, [layout]);

    const wedges = useMemo(() => {
      if (single) return null;
      const outer = layout.discs[0]!;
      const innerR = layout.discs[1]!;
      return layout.sectors.map((s) => {
        const info = zones.get(s.id);
        return (
          <g key={`w:${layout.rootId}:${s.id}`} className="zeus-fade">
            <path
              d={wedge(s, innerR, outer)}
              data-zone={s.id}
              className={cn('zeus-wedge', info?.tone.fill)}
              onPointerEnter={() => setHoverZone(s.id)}
              onPointerLeave={() => setHoverZone((z) => (z === s.id ? null : z))}
              onClick={() => !suppressClick.current && onOpenZone(s.id)}
            />
            {/* Canto de la zona con su tono: el disco se lee como un dial de colores. */}
            <path d={arc(outer, s.a0 + 0.012, s.a1 - 0.012)} fill="none" className={cn('pointer-events-none', info?.tone.stroke)} strokeWidth={3} strokeLinecap="round" />
            {/* Linde de la zona: una raya fina desde el anillo de categorías hasta el borde. */}
            <line
              x1={Math.cos(s.a0) * innerR} y1={Math.sin(s.a0) * innerR}
              x2={Math.cos(s.a0) * outer} y2={Math.sin(s.a0) * outer}
              className="pointer-events-none stroke-foreground" strokeOpacity={0.1} strokeWidth={0.8}
            />
          </g>
        );
      });
    }, [layout, zones, single, onOpenZone]);

    const activate = useCallback(
      (p: Placed) => {
        if (suppressClick.current) return;
        if (p.role === 'category') onOpenZone(p.id);
        else if (p.role === 'outer') onOpenOuter(p.id);
        else if (p.role === 'center') onUp();
        else onSelect(p.id);
      },
      [onOpenZone, onOpenOuter, onSelect, onUp],
    );

    const spokes = useMemo(() => {
      const out: ReactElement[] = [];
      for (const l of layout.links) {
        if (!l.structural) continue;
        const a = layout.byId.get(l.from);
        const b = layout.byId.get(l.to);
        if (!a || !b) continue;
        out.push(
          <line
            key={`${layout.rootId}:${l.id}`}
            data-link={l.id}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            className="zeus-link stroke-foreground"
            strokeOpacity={0.3}
            strokeWidth={1.1}
          />,
        );
      }
      return out;
    }, [layout]);

    // Conexiones reales: solo las del nodo elegido o el que está bajo el cursor. Todas a la vez son
    // una maraña que tapa justo lo que el radial sí cuenta (cuánto hay de cada cosa y dónde).
    const wires = useMemo(() => {
      const focus = hover && layout.byId.get(hover)?.role !== 'category' ? hover : selectedId;
      const out: ReactElement[] = [];
      if (!focus) return out;
      const me = layout.byId.get(focus);
      if (!me) return out;

      if (me.role === 'outer') {
        // Un proyecto del anillo: todo lo suyo, de un vistazo.
        for (const p of layout.nodes) {
          if (p.role !== 'entry' || outerOf(p.id) !== focus) continue;
          out.push(<path key={`o:${p.id}`} d={chord(me, p)} fill="none" className="stroke-foreground" strokeOpacity={0.28} strokeWidth={0.7} />);
        }
        return out;
      }

      const mine = outerOf(focus);
      const home = mine ? layout.byId.get(mine) : undefined;
      if (home) out.push(<path key="home" d={`M${me.x} ${me.y} L${home.x} ${home.y}`} fill="none" className="stroke-foreground" strokeOpacity={0.45} strokeWidth={0.9} strokeDasharray="2 4" />);
      for (const l of layout.links) {
        if (l.structural || (l.from !== focus && l.to !== focus)) continue;
        const a = layout.byId.get(l.from);
        const b = layout.byId.get(l.to);
        if (!a || !b || a.role === 'outer' || b.role === 'outer') continue;
        const m = edgeMeta(l.kind);
        out.push(<path key={l.id} d={chord(a, b)} fill="none" className="stroke-orange" strokeOpacity={0.9} strokeWidth={m.width + 0.3} strokeDasharray={m.dash} strokeLinecap="round" />);
      }
      return out;
    }, [layout, hover, selectedId, outerOf]);

    /** Los nodos conectados al que está en foco se quedan encendidos aunque haya filtro. */
    const lit = useMemo(() => {
      // Solo la selección (o un proyecto del anillo bajo el cursor) apaga al resto: pasar el cursor por
      // una entrada enseña su ficha y sus conexiones, pero no hace parpadear el mapa entero.
      const focus = hover && layout.byId.get(hover)?.role === 'outer' ? hover : selectedId;
      if (!focus) return null;
      const s = new Set<string>([focus]);
      for (const l of layout.links) {
        if (l.structural) continue;
        if (l.from === focus) s.add(l.to);
        else if (l.to === focus) s.add(l.from);
      }
      const o = outerOf(focus);
      if (o) s.add(o);
      return s;
    }, [layout, hover, selectedId, outerOf]);

    const drawn = useMemo(
      () =>
        layout.nodes.map((p) => {
          const node = nodes.get(p.id);
          const selected = p.id === selectedId;
          const common = {
            'data-id': p.id,
            'data-role': p.role,
            'data-dim': dimmed?.has(p.id) ? '1' : undefined,
            'data-selected': selected ? '1' : undefined,
            className: 'zeus-node',
            style: { transform: `translate(${p.x}px, ${p.y}px)` },
          };
          const keys = {
            role: 'button' as const,
            tabIndex: 0,
            onClick: () => activate(p),
            onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              suppressClick.current = false;
              activate(p);
            },
          };

          if (p.role === 'center') {
            return (
              <g
                key={`c:${p.id}`}
                {...common}
                {...(center.canGoUp ? keys : {})}
                aria-label={center.canGoUp ? `${center.label}: subir un nivel` : center.label}
                style={{ ...common.style, cursor: center.canGoUp ? 'pointer' : 'default' }}
              >
                <circle r={p.r + 10} className="zeus-orbit fill-none stroke-orange" strokeOpacity={0.6} strokeWidth={1} strokeDasharray="2 7" strokeLinecap="round" />
                <circle r={p.r + 3} className="zeus-focus fill-none stroke-transparent" />
                <circle r={p.r} className="fill-card stroke-orange" strokeWidth={2} />
                <circle r={p.r - 5} className="fill-orange" fillOpacity={0.14} />
                <text y={-2} textAnchor="middle" dominantBaseline="central" className="fill-foreground text-[11px] font-semibold tracking-[-0.02em]">
                  {clip(center.label, 9)}
                </text>
                <text y={11} textAnchor="middle" dominantBaseline="central" className="fill-muted-foreground text-[8px] font-semibold tabular-nums">
                  {center.caption}
                </text>
              </g>
            );
          }

          if (p.role === 'category') {
            const info = zones.get(p.id);
            const sector = layout.sectors.find((s) => s.id === p.id);
            const a = p.angle ?? 0;
            // La etiqueta va del lado de afuera, en el hueco entre el anillo de categorías y la zona.
            // El nombre va hacia AFUERA, en la banda libre entre la categoría y sus entradas, separado del
            // nodo lo que mida en esa dirección. Si la zona es tan angosta que no cabe, se esconde y
            // aparece al pasar por ella (la lista lateral lo dice siempre).
            const label = clip(info?.label ?? '', 13);
            const w = label.length * 5.7;
            const reach = (Math.abs(Math.cos(a)) * w) / 2 + Math.abs(Math.sin(a)) * 6;
            const off = p.r + 7 + reach;
            const lx = Math.cos(a) * off;
            const ly = Math.sin(a) * off;
            const across = Math.abs(Math.sin(a)) * w + Math.abs(Math.cos(a)) * 12;
            const room = sector ? (sector.a1 - sector.a0) * (layout.orbit + off) : 0;
            const fits = across + 6 <= room && p.r + 7 + 2 * reach <= Z_LABEL_BAND - 10;
            return (
              <g
                key={p.id}
                {...common}
                {...keys}
                aria-label={`Abrir ${info?.label ?? p.id}, ${sector?.count ?? 0} entradas`}
                onPointerEnter={() => setHoverZone(p.id)}
                onPointerLeave={() => setHoverZone((z) => (z === p.id ? null : z))}
              >
                <circle r={p.r + 4} className="zeus-focus fill-none stroke-transparent" />
                <circle r={p.r} className={cn('zeus-dot fill-card', info?.tone.stroke)} strokeWidth={1.8} />
                <text textAnchor="middle" dominantBaseline="central" className="fill-foreground text-[11px] font-semibold tabular-nums">
                  {sector?.count ?? ''}
                </text>
                <text
                  x={lx}
                  y={ly}
                  textAnchor="middle"
                  dominantBaseline="central"
                  data-auto={fits ? undefined : '1'}
                  className="zeus-label fill-foreground stroke-background text-[10px] font-semibold"
                  strokeWidth={3}
                  style={{ paintOrder: 'stroke' }}
                >
                  {label}
                </text>
              </g>
            );
          }

          if (p.role === 'outer') {
            const t = radialText(p.angle ?? 0, 9);
            const title = node?.title ?? p.id;
            return (
              <g key={p.id} {...common} {...keys} aria-label={`Proyecto ${title}`} onPointerEnter={() => setHover(p.id)} onPointerLeave={() => setHover((h) => (h === p.id ? null : h))}>
                <circle r={11} className="zeus-focus fill-transparent stroke-transparent" />
                <rect x={-3} y={-3} width={6} height={6} rx={1.5} className="zeus-dot fill-muted-foreground" />
                <text {...t} dominantBaseline="central" className="zeus-outer fill-muted-foreground text-[9.5px] font-medium">
                  {clip(title, 22)}
                </text>
              </g>
            );
          }

          // Entradas.
          const info = zoneOf(p);
          const title = node?.title ?? p.id;
          const muted = node?.status === 'archived' || node?.status === 'superseded';
          const draft = node?.status === 'draft';
          const online = node?.meta?.online === true;
          const shape = cn('zeus-dot', draft ? 'fill-card' : info?.tone.fill ?? 'fill-faint', draft && (info?.tone.stroke ?? 'stroke-faint'));
          return (
            <g
              key={p.id}
              {...common}
              {...keys}
              aria-label={`${kindMeta(p.kind).label}: ${title}`}
              aria-pressed={selected}
              onPointerEnter={() => setHover(p.id)}
              onPointerLeave={() => setHover((h) => (h === p.id ? null : h))}
              onFocus={() => setHover(p.id)}
              onBlur={() => setHover((h) => (h === p.id ? null : h))}
            >
              {/* Zona de toque: el punto mide 5px y un dedo no. */}
              <circle r={10} className="zeus-focus fill-transparent stroke-transparent" />
              {online && <circle r={p.r + 2} className="zeus-live" />}
              {selected && <circle r={p.r + 5} className="fill-none stroke-foreground" strokeWidth={1.5} />}
              {node?.pinned ? (
                // Rombo = fijada: se carga siempre en el contexto del agente.
                <rect x={-p.r} y={-p.r} width={p.r * 2} height={p.r * 2} rx={1.2} transform="rotate(45)" className={shape} fillOpacity={muted ? 0.35 : 1} strokeWidth={draft ? 1.4 : 0} />
              ) : (
                <circle r={p.r} className={shape} fillOpacity={muted ? 0.35 : 1} strokeWidth={draft ? 1.4 : 0} />
              )}
              {layout.labelled && (
                <text {...radialText(p.angle ?? 0, p.r + 7)} dominantBaseline="central" className="zeus-outer fill-foreground text-[9.5px] font-medium">
                  {clip(title, 26)}
                </text>
              )}
            </g>
          );
        }),
      [layout, nodes, zones, center, selectedId, dimmed, activate, zoneOf],
    );

    const hovered = hover ? nodes.get(hover) : undefined;
    const hoveredPlaced = hover ? layout.byId.get(hover) : undefined;
    const activeZone = hoverZone ?? hotZone ?? null;

    return (
      <div ref={wrapRef} className={cn('dark zeus-stage relative select-none overflow-hidden bg-background text-foreground', className)}>
        <svg
          width="100%"
          height="100%"
          role="group"
          aria-label="Mapa de zeus: radial por zonas"
          className={cn('absolute inset-0 block size-full touch-none', lit && 'zeus-has-focus')}
          style={{ cursor: 'grab' }}
          data-zone={activeZone ?? undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <g ref={viewRef} className="zeus-view">
            {backdrop}
            <g data-hot-zone={activeZone ?? undefined}>{wedges}</g>
            {activeZone && <style>{`.zeus-wedge[data-zone="${CSS.escape(activeZone)}"]{fill-opacity:.2}`}</style>}
            <g>{spokes}</g>
            <g className="pointer-events-none">{wires}</g>
            <g ref={pulseRef} className="pointer-events-none" />
            <g>{drawn}</g>
            {lit && <style>{[...lit].map((id) => `.zeus-has-focus .zeus-node[data-id="${CSS.escape(id)}"]`).join(',') + '{opacity:1}'}</style>}
          </g>
        </svg>

        {/* Ficha flotante del nodo bajo el cursor. La coloca `placeCard` sin pasar por React. */}
        <div
          ref={cardRef}
          data-for={hover ?? undefined}
          className={cn(
            'pointer-events-none absolute left-0 top-0 z-10 w-[270px] rounded-lg border bg-card/95 p-3 shadow-lg backdrop-blur transition-opacity duration-150',
            hovered && hoveredPlaced ? 'opacity-100' : 'opacity-0',
          )}
          aria-hidden
        >
          {hovered && (
            <div className="grid gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className={cn('size-2 shrink-0 rounded-sm', kindMeta(hovered.kind).tone.dot)} />
                <span className="label-caps text-muted-foreground">{kindMeta(hovered.kind).label}</span>
                {hovered.pinned && <Pin className="size-3 text-orange" />}
                {hovered.source !== 'derived' && <span className="label-caps ml-auto text-faint">{STATUS_META[hovered.status]?.label ?? hovered.status}</span>}
              </div>
              <p className="text-[13px] font-semibold leading-snug">{hovered.title}</p>
              {hovered.summary && <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{hovered.summary}</p>}
              {hovered.projectId && projectNames.has(hovered.projectId) && hovered.kind !== 'project' && (
                <p className="text-[11px] text-faint">{projectNames.get(hovered.projectId)}</p>
              )}
            </div>
          )}
        </div>

        {center.canGoUp && (
          <button
            type="button"
            onClick={onUp}
            style={{ left: (inset?.left ?? 0) + 12 }}
            className="absolute left-3 top-3 inline-flex h-8 items-center gap-1.5 rounded-md border bg-card/90 px-2.5 text-xs font-semibold text-foreground backdrop-blur transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CornerLeftUp className="size-3.5" /> Subir
          </button>
        )}

        <div style={{ right: (inset?.right ?? 0) + 12 }} className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-md border bg-card/90 p-0.5 backdrop-blur">
          {([
            ['Alejar', ZoomOut, () => zoomBy(1 / 1.35)],
            ['Encuadrar todo', Maximize2, () => fit(!reducedMotion)],
            ['Acercar', ZoomIn, () => zoomBy(1.35)],
          ] as const).map(([label, Icon, fn]) => (
            <button key={label} type="button" onClick={fn} aria-label={label} title={label} className="grid size-7 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Icon className="size-3.5" />
            </button>
          ))}
        </div>
      </div>
    );
  }),
);
