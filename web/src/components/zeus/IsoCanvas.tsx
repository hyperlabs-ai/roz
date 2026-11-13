// Mapa de zeus en ISOMÉTRICO. El mismo layout por zonas que el radial plano (`zoneLayout`), llevado a
// una escena con volumen sobre un <canvas> 2D:
//   · cada zona es una losa cuyo alto dice cuánto contiene, con su canto de neón;
//   · cada entrada es un pilar de luz sobre su losa (más alto cuanto más conectada está);
//   · las categorías flotan sobre el anillo interior, unidas al núcleo por haces punteados;
//   · la escena se gira arrastrando, se acerca con la rueda y deriva despacio cuando nadie la toca.
// Se dibuja a mano (sin three.js): proyección paralela con giro sobre el eje vertical y orden de
// pintado por profundidad. Nada de esto pasa por React: un solo bucle de animación repinta cuando hay
// algo que cambió. La lista lateral es la alternativa accesible; el lienzo lleva `role="img"`.
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { CornerLeftUp, Maximize2, Pin, ZoomIn, ZoomOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pathToRoot, type Placed, type ZoneSector } from './layout';
import type { ZoneCanvasHandle, ZoneCanvasProps } from './ZoneCanvas';
import { STATUS_META, edgeMeta, kindMeta, type Tone } from './zeus-ui';
import './zeus.css';

export interface IsoCanvasProps extends ZoneCanvasProps {
  /** Peso de cada entrada (sus conexiones): alza su pilar. */
  weights?: Map<string, number>;
}

interface Cam {
  yaw: number;
  /** Achatamiento vertical del suelo: 1 = vista cenital, 0 = de canto. */
  pitch: number;
  k: number;
  px: number;
  py: number;
}

interface Pt {
  x: number;
  y: number;
  d: number;
}

const TAU = Math.PI * 2;
const CAT_Z = 84;
const CORE_Z = 112;
const START_YAW = -0.5;
const START_PITCH = 0.56;
const FONT = "'Inter Tight', ui-sans-serif, system-ui, sans-serif";

/** `fill-purple-deep` → `--purple-deep`: el token detrás de la clase de relleno de un tono. */
const tokenOf = (tone: Tone | undefined): string => `--${(tone?.fill ?? 'fill-faint').replace(/^fill-/, '')}`;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export const IsoCanvas = memo(
  forwardRef<ZoneCanvasHandle, IsoCanvasProps>(function IsoCanvas(
    { layout, nodes, zones, center, outerOf, projectNames, selectedId, dimmed, hotZone, fitKey, inset, reducedMotion, weights, onSelect, onOpenZone, onOpenOuter, onUp, className },
    ref,
  ) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const cam = useRef<Cam>({ yaw: START_YAW, pitch: START_PITCH, k: 1, px: 0, py: 0 });
    const size = useRef({ w: 0, h: 0 });
    const dirty = useRef(true);
    const inside = useRef(false);
    const hoverRef = useRef<{ id: string | null; zone: string | null }>({ id: null, zone: null });
    const pulses = useRef<Array<{ path: Array<[number, number, number]>; t0: number; dur: number }>>([]);
    const flashes = useRef<Array<{ at: [number, number, number]; t0: number }>>([]);
    const colors = useRef(new Map<string, string>());
    const [hover, setHover] = useState<string | null>(null);

    // ---------------------------------------------------------------- escena (del layout a volumen)

    const scene = useMemo(() => {
      const single = layout.sectors.length <= 1;
      const max = Math.max(1, ...layout.sectors.map((s) => s.count));
      const height = new Map<string, number>();
      for (const s of layout.sectors) height.set(s.id, single ? 0 : 9 + 42 * Math.sqrt(s.count / max));
      const tallest = Math.max(0, ...height.values());
      const sectorOf = (p: Placed): string | null => (single ? layout.sectors[0]?.id ?? null : p.parent);

      const items = layout.nodes.map((p) => {
        const node = nodes.get(p.id);
        if (p.role === 'entry') {
          const sid = sectorOf(p);
          const z0 = sid ? height.get(sid) ?? 0 : 0;
          // Alto del pilar: sus conexiones mandan; un desfase fijo por entrada rompe la fila pareja y
          // le da a cada zona su silueta (determinista: sale del propio id).
          let hash = 0;
          for (let i = 0; i < p.id.length; i++) hash = (hash * 31 + p.id.charCodeAt(i)) >>> 0;
          const lift = 12 + (hash % 4) * 4 + Math.min(46, 7 * (weights?.get(p.id) ?? 0)) + (node?.pinned ? 9 : 0);
          return { p, node, zone: sid, z0, z1: z0 + lift };
        }
        if (p.role === 'category') return { p, node, zone: p.id, z0: 0, z1: CAT_Z };
        if (p.role === 'center') return { p, node, zone: null, z0: 0, z1: single ? 46 : CORE_Z };
        return { p, node, zone: null, z0: 0, z1: 0 };
      });
      const byId = new Map(items.map((i) => [i.p.id, i]));
      // Los rótulos aquí van horizontales: el margen es menor que el del radial plano.
      const hasOuter = layout.nodes.some((n) => n.role === 'outer');
      const reach = (layout.discs[0] ?? 120) + (hasOuter ? 96 : 30);
      return { single, height, tallest, items, byId, reach };
    }, [layout, nodes, weights]);

    const sceneRef = useRef(scene);
    sceneRef.current = scene;
    const layoutRef = useRef(layout);
    layoutRef.current = layout;
    const props = useRef({ zones, center, selectedId, dimmed, hotZone, outerOf, inset });
    props.current = { zones, center, selectedId, dimmed, hotZone, outerOf, inset };
    const pointer = useRef<{ x: number; y: number } | null>(null);
    useEffect(() => {
      dirty.current = true;
    }, [scene, zones, center, selectedId, dimmed, hotZone]);

    // ---------------------------------------------------------------- proyección

    const project = useCallback((x: number, y: number, z: number): Pt => {
      const c = cam.current;
      const cos = Math.cos(c.yaw);
      const sin = Math.sin(c.yaw);
      const xr = x * cos - y * sin;
      const yr = x * sin + y * cos;
      const zs = Math.sqrt(1 - c.pitch * c.pitch);
      return { x: size.current.w / 2 + c.px + xr * c.k, y: size.current.h / 2 + c.py + (yr * c.pitch - z * zs) * c.k, d: yr };
    }, []);

    /** Punto del plano z=`h` que cae bajo el pixel (sx, sy): en polares, para saber sobre qué zona está. */
    const unproject = useCallback((sx: number, sy: number, h: number): { r: number; a: number } => {
      const c = cam.current;
      const zs = Math.sqrt(1 - c.pitch * c.pitch);
      const xr = (sx - size.current.w / 2 - c.px) / c.k;
      const yr = ((sy - size.current.h / 2 - c.py) / c.k + h * zs) / c.pitch;
      const cos = Math.cos(c.yaw);
      const sin = Math.sin(c.yaw);
      const x = xr * cos + yr * sin;
      const y = -xr * sin + yr * cos;
      return { r: Math.hypot(x, y), a: Math.atan2(y, x) };
    }, []);

    const fit = useCallback(() => {
      const { w, h } = size.current;
      if (!w || !h) return;
      const s = sceneRef.current;
      const c = cam.current;
      const zs = Math.sqrt(1 - c.pitch * c.pitch);
      const tall = Math.max(CAT_Z, s.tallest + 50) * zs;
      const left = props.current.inset?.left ?? 0;
      const right = props.current.inset?.right ?? 0;
      c.k = Math.min(4, Math.max(0.15, Math.min((w - left - right - 40) / (2 * s.reach), (h - 30) / (2 * s.reach * c.pitch + tall))));
      c.px = (left - right) / 2;
      c.py = (tall * c.k) / 2 - 4;
      dirty.current = true;
    }, []);

    // ---------------------------------------------------------------- color (tokens del tema, resueltos una vez)

    const color = useCallback((token: string, alpha = 1): string => {
      let v = colors.current.get(token);
      if (v === undefined) {
        v = wrapRef.current ? getComputedStyle(wrapRef.current).getPropertyValue(token).trim() : '';
        colors.current.set(token, v);
      }
      return alpha >= 1 ? `hsl(${v})` : `hsl(${v} / ${alpha})`;
    }, []);

    // ---------------------------------------------------------------- pintado

    const draw = useCallback(
      (now: number) => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        const { w, h } = size.current;
        // Sobremuestreo: nunca menos de 2 píxeles reales por píxel de CSS. Con el zoom del navegador por
        // debajo de 100 % (o una pantalla de densidad 1) el lienzo se vería borroso junto al resto.
        const dpr = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        const l = layoutRef.current;
        const s = sceneRef.current;
        const pr = props.current;
        const c = cam.current;
        const fg = '--foreground';
        const focusId = hoverRef.current.id ?? pr.selectedId;
        const activeZone = hoverRef.current.zone ?? pr.hotZone ?? null;

        const ring = (r: number, z: number, stroke: string, width: number, dash?: number[], fill?: string) => {
          const o = project(0, 0, z);
          ctx.beginPath();
          ctx.ellipse(o.x, o.y, r * c.k, r * c.k * c.pitch, 0, 0, TAU);
          if (fill) {
            ctx.fillStyle = fill;
            ctx.fill();
          }
          ctx.setLineDash(dash ?? []);
          ctx.lineWidth = width;
          ctx.strokeStyle = stroke;
          ctx.stroke();
          ctx.setLineDash([]);
        };
        const arcPts = (r: number, a0: number, a1: number, z: number): Pt[] => {
          const n = Math.max(2, Math.ceil((a1 - a0) / 0.07));
          return Array.from({ length: n + 1 }, (_, i) => {
            const a = a0 + ((a1 - a0) * i) / n;
            return project(Math.cos(a) * r, Math.sin(a) * r, z);
          });
        };
        const poly = (pts: Pt[], close = true) => {
          ctx.beginPath();
          pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          if (close) ctx.closePath();
        };
        const glow = (col: string, blur: number) => {
          ctx.shadowColor = col;
          ctx.shadowBlur = blur;
        };
        const noGlow = () => {
          ctx.shadowBlur = 0;
        };

        // --- suelo: el disco, sus anillos punteados y el dial de marcas
        const [outerR, ...inner] = l.discs;
        const R = outerR ?? 120;
        ring(R + 16, 0, color(fg, 0.1), 1, [1, 7]);
        ring(R, 0, color(fg, 0.16), 1, undefined, color(fg, 0.035));
        inner.forEach((r, i) => ring(r, 0, color(fg, 0.12), 1, i ? [2, 6] : undefined, color(fg, 0.025)));
        {
          // Marcas del dial: 120 rayitas que giran con la escena (dicen "esto se mueve").
          ctx.beginPath();
          for (let i = 0; i < 120; i++) {
            const a = (i / 120) * TAU;
            const long = i % 10 === 0;
            const p0 = project(Math.cos(a) * (R + 4), Math.sin(a) * (R + 4), 0);
            const p1 = project(Math.cos(a) * (R + (long ? 13 : 8)), Math.sin(a) * (R + (long ? 13 : 8)), 0);
            ctx.moveTo(p0.x, p0.y);
            ctx.lineTo(p1.x, p1.y);
          }
          ctx.lineWidth = 1;
          ctx.strokeStyle = color(fg, 0.22);
          ctx.stroke();
        }

        // --- losas de las zonas, de la más lejana a la más cercana
        const innerR = l.discs[1] ?? 60;
        const slabs = s.single ? [] : [...l.sectors].sort((a, b) => project(Math.cos(a.mid) * R, Math.sin(a.mid) * R, 0).d - project(Math.cos(b.mid) * R, Math.sin(b.mid) * R, 0).d);
        const slabTone = (z: ZoneSector) => tokenOf(pr.zones.get(z.id)?.tone);
        for (const z of slabs) {
          const hgt = s.height.get(z.id) ?? 0;
          const tone = slabTone(z);
          const hot = activeZone === z.id;
          const a0 = z.a0 + 0.008;
          const a1 = z.a1 - 0.008;
          const topOuter = arcPts(R, a0, a1, hgt);
          const topInner = arcPts(innerR, a0, a1, hgt);
          const baseOuter = arcPts(R, a0, a1, 0);
          const baseInner = arcPts(innerR, a0, a1, 0);
          const wall = (top: Pt[], base: Pt[], alpha: number) => {
            poly([...top, ...[...base].reverse()]);
            ctx.fillStyle = color(tone, alpha);
            ctx.fill();
          };
          // Paredes: canto exterior, canto interior y los dos costados. Las que miran al fondo quedan
          // tapadas por la tapa, que se pinta después.
          wall(topOuter, baseOuter, hot ? 0.34 : 0.22);
          wall(topInner, baseInner, 0.16);
          wall([topInner[0]!, topOuter[0]!], [baseInner[0]!, baseOuter[0]!], 0.18);
          wall([topInner[topInner.length - 1]!, topOuter[topOuter.length - 1]!], [baseInner[baseInner.length - 1]!, baseOuter[baseOuter.length - 1]!], 0.18);
          // Tapa: vidrio teñido con el tono de la zona, más encendido hacia el borde.
          poly([...topOuter, ...[...topInner].reverse()]);
          const o = project(0, 0, hgt);
          const g = ctx.createRadialGradient(o.x, o.y, innerR * c.k * c.pitch, o.x, o.y, R * c.k);
          g.addColorStop(0, color(tone, hot ? 0.2 : 0.07));
          g.addColorStop(1, color(tone, hot ? 0.42 : 0.2));
          ctx.fillStyle = color('--background', 0.82);
          ctx.fill();
          ctx.fillStyle = g;
          ctx.fill();
          ctx.lineWidth = 0.8;
          ctx.strokeStyle = color(tone, 0.4);
          ctx.stroke();
          // Canto de neón en el borde exterior de la tapa.
          poly(topOuter, false);
          glow(color(tone, 0.9), hot ? 22 : 12);
          ctx.lineWidth = hot ? 2.6 : 2;
          ctx.strokeStyle = color(tone);
          ctx.stroke();
          noGlow();
        }

        // --- haces del núcleo a las categorías (punteados) y sus plomadas al suelo
        const coreItem = s.items.find((i) => i.p.role === 'center');
        const coreTop = project(0, 0, coreItem?.z1 ?? CORE_Z);
        for (const it of s.items) {
          if (it.p.role !== 'category') continue;
          const top = project(it.p.x, it.p.y, CAT_Z);
          const foot = project(it.p.x, it.p.y, 0);
          ctx.setLineDash([2, 4]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = color(tokenOf(pr.zones.get(it.p.id)?.tone), 0.55);
          ctx.beginPath();
          ctx.moveTo(coreTop.x, coreTop.y);
          ctx.lineTo(top.x, top.y);
          ctx.stroke();
          ctx.strokeStyle = color(fg, 0.22);
          ctx.beginPath();
          ctx.moveTo(top.x, top.y);
          ctx.lineTo(foot.x, foot.y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.ellipse(foot.x, foot.y, 5 * c.k, 5 * c.k * c.pitch, 0, 0, TAU);
          ctx.fillStyle = color(fg, 0.12);
          ctx.fill();
        }

        // --- lo que tiene volumen, de atrás hacia adelante
        const lit = new Set<string>();
        if (focusId) {
          lit.add(focusId);
          for (const k of l.links) {
            if (k.structural) continue;
            if (k.from === focusId) lit.add(k.to);
            else if (k.to === focusId) lit.add(k.from);
          }
          const home = pr.outerOf(focusId);
          if (home) lit.add(home);
        }
        const dimAll = pr.selectedId != null || (hoverRef.current.id != null && s.byId.get(hoverRef.current.id)?.p.role === 'outer');
        const focusIsOuter = focusId != null && s.byId.get(focusId)?.p.role === 'outer';
        const dotR = Math.max(2.2, Math.min(5.5, 3.1 * Math.sqrt(c.k)));
        const order = s.items.map((it) => ({ it, top: project(it.p.x, it.p.y, it.z1) })).sort((a, b) => a.top.d - b.top.d);
        const labels: Array<{ x: number; y: number; text: string; align: CanvasTextAlign; alpha: number; d: number }> = [];

        for (const { it, top } of order) {
          const { p, node } = it;
          if (p.role === 'entry') {
            const tone = tokenOf(it.zone ? pr.zones.get(it.zone)?.tone : undefined);
            const mine = focusIsOuter && pr.outerOf(p.id) === focusId;
            const faded = pr.dimmed?.has(p.id) || (dimAll && !lit.has(p.id) && !mine);
            const muted = node?.status === 'archived' || node?.status === 'superseded';
            const a = faded ? 0.13 : muted ? 0.4 : 1;
            const base = project(p.x, p.y, it.z0);
            const focus = p.id === focusId || p.id === pr.selectedId;
            // Pilar: una línea que nace tenue en la losa y llega encendida a la punta.
            const grad = ctx.createLinearGradient(base.x, base.y, top.x, top.y);
            grad.addColorStop(0, color(tone, 0.05 * a));
            grad.addColorStop(1, color(tone, 0.85 * a));
            ctx.strokeStyle = grad;
            ctx.lineWidth = focus ? 2 : 1.2;
            ctx.beginPath();
            ctx.moveTo(base.x, base.y);
            ctx.lineTo(top.x, top.y);
            ctx.stroke();
            ctx.beginPath();
            ctx.ellipse(base.x, base.y, dotR * 0.9, dotR * 0.9 * c.pitch, 0, 0, TAU);
            ctx.fillStyle = color(tone, 0.28 * a);
            ctx.fill();
            // Punta: punto (rombo si está fijada, hueco si es borrador) con su halo.
            const r = focus ? dotR * 1.5 : dotR;
            // Halo: un disco translúcido detrás (más barato que un desenfoque por cada uno de cientos).
            if (!faded) {
              ctx.beginPath();
              ctx.arc(top.x, top.y, r * 2, 0, TAU);
              ctx.fillStyle = color(tone, focus ? 0.4 : 0.16);
              ctx.fill();
            }
            if (focus) glow(color(tone, 0.95), 18);
            ctx.beginPath();
            if (node?.pinned) {
              ctx.moveTo(top.x, top.y - r * 1.25);
              ctx.lineTo(top.x + r * 1.25, top.y);
              ctx.lineTo(top.x, top.y + r * 1.25);
              ctx.lineTo(top.x - r * 1.25, top.y);
              ctx.closePath();
            } else ctx.arc(top.x, top.y, r, 0, TAU);
            if (node?.status === 'draft') {
              ctx.fillStyle = color('--background', a);
              ctx.fill();
              ctx.lineWidth = 1.4;
              ctx.strokeStyle = color(tone, a);
              ctx.stroke();
            } else {
              ctx.fillStyle = color(tone, a);
              ctx.fill();
            }
            noGlow();
            if (p.id === pr.selectedId) {
              ctx.beginPath();
              ctx.arc(top.x, top.y, r + 4.5, 0, TAU);
              ctx.lineWidth = 1.5;
              ctx.strokeStyle = color(fg);
              ctx.stroke();
            }
            if (l.labelled && !faded) labels.push({ x: top.x, y: top.y - r - 5, text: clip(node?.title ?? '', 24), align: 'center', alpha: focus ? 1 : 0.82, d: top.d + (focus ? 1e6 : 0) });
          } else if (p.role === 'category') {
            const info = pr.zones.get(p.id);
            const tone = tokenOf(info?.tone);
            const hot = activeZone === p.id;
            const r = hot ? 16 : 14;
            glow(color(tone, 0.9), hot ? 24 : 14);
            ctx.beginPath();
            ctx.arc(top.x, top.y, r, 0, TAU);
            ctx.fillStyle = color('--card');
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = color(tone);
            ctx.stroke();
            noGlow();
            const sector = l.sectors.find((z) => z.id === p.id);
            ctx.fillStyle = color(fg);
            ctx.font = `600 11px ${FONT}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(sector?.count ?? ''), top.x, top.y + 0.5);
            labels.push({ x: top.x, y: top.y - r - 12, text: clip(info?.label ?? '', 16), align: 'center', alpha: 1, d: (hot ? 9e6 : 2e6) + top.d });
          } else if (p.role === 'center') {
            const foot = project(0, 0, 0);
            // Núcleo: un haz vertical con anillos que suben, y la esfera arriba.
            const beam = ctx.createLinearGradient(foot.x, foot.y, top.x, top.y);
            beam.addColorStop(0, color('--orange', 0.05));
            beam.addColorStop(1, color('--orange', 0.9));
            glow(color('--orange', 0.9), 18);
            ctx.strokeStyle = beam;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(foot.x, foot.y);
            ctx.lineTo(top.x, top.y);
            ctx.stroke();
            noGlow();
            const zTop = it.z1;
            for (let i = 0; i < 4; i++) {
              const f = ((reducedMotion ? 0 : now / 2600) + i / 4) % 1;
              ring(26 - 14 * f, zTop * f, color('--orange', 0.55 * (1 - f)), 1.2);
            }
            ring(30, 0, color('--orange', 0.5), 1, [2, 5], color('--orange', 0.08));
            glow(color('--orange', 0.95), 30);
            ctx.beginPath();
            ctx.arc(top.x, top.y, 24, 0, TAU);
            ctx.fillStyle = color('--card');
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = color('--orange');
            ctx.stroke();
            noGlow();
            ctx.beginPath();
            ctx.arc(top.x, top.y, 19, 0, TAU);
            ctx.fillStyle = color('--orange', 0.16);
            ctx.fill();
            ctx.fillStyle = color(fg);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = `600 10.5px ${FONT}`;
            ctx.fillText(clip(pr.center.label, 9), top.x, top.y - 4);
            ctx.font = `600 8.5px ${FONT}`;
            ctx.fillStyle = color('--muted-foreground');
            ctx.fillText(pr.center.caption, top.x, top.y + 8);
          } else {
            // Anillo exterior (proyectos): marca en el suelo y nombre; los del fondo se apagan.
            const front = Math.min(1, Math.max(0, (top.d / s.reach + 1) / 2));
            const on = lit.has(p.id) || p.id === focusId;
            const a = on ? 1 : dimAll ? 0.18 : 0.32 + 0.5 * front;
            ctx.fillStyle = color(on ? fg : '--muted-foreground', a);
            ctx.fillRect(top.x - 2.5, top.y - 2.5, 5, 5);
            const right = top.x >= size.current.w / 2 + c.px;
            labels.push({ x: top.x + (right ? 8 : -8), y: top.y, text: clip(node?.title ?? '', 20), align: right ? 'left' : 'right', alpha: a, d: (on ? 1e6 : 0) + top.d - 1e7 });
          }
        }

        // --- conexiones del nodo en foco: arcos que se levantan sobre la escena
        if (focusId) {
          const me = s.byId.get(focusId);
          const arc3 = (a: { p: Placed; z1: number }, b: { p: Placed; z1: number }, stroke: string, width: number, dash?: string) => {
            const lift = 40 + Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y) * 0.18;
            ctx.beginPath();
            for (let i = 0; i <= 24; i++) {
              const t = i / 24;
              const u = 1 - t;
              const mx = ((a.p.x + b.p.x) / 2) * 0.6;
              const my = ((a.p.y + b.p.y) / 2) * 0.6;
              const mz = Math.max(a.z1, b.z1) + lift;
              const q = project(u * u * a.p.x + 2 * u * t * mx + t * t * b.p.x, u * u * a.p.y + 2 * u * t * my + t * t * b.p.y, u * u * a.z1 + 2 * u * t * mz + t * t * b.z1);
              if (i) ctx.lineTo(q.x, q.y);
              else ctx.moveTo(q.x, q.y);
            }
            ctx.setLineDash(dash ? dash.split(' ').map(Number) : []);
            ctx.lineWidth = width;
            ctx.strokeStyle = stroke;
            ctx.stroke();
            ctx.setLineDash([]);
          };
          if (me) {
            if (me.p.role === 'outer') {
              for (const it of s.items) if (it.p.role === 'entry' && pr.outerOf(it.p.id) === focusId) arc3(me, it, color(fg, 0.3), 0.8);
            } else {
              const home = pr.outerOf(focusId);
              const homeItem = home ? s.byId.get(home) : undefined;
              if (homeItem) arc3(me, homeItem, color(fg, 0.5), 1, '2 4');
              glow(color('--orange', 0.9), 10);
              for (const k of l.links) {
                if (k.structural || (k.from !== focusId && k.to !== focusId)) continue;
                const a = s.byId.get(k.from);
                const b = s.byId.get(k.to);
                if (!a || !b || a.p.role === 'outer' || b.p.role === 'outer') continue;
                const m = edgeMeta(k.kind);
                arc3(a, b, color('--orange', 0.95), m.width + 0.4, m.dash);
              }
              noGlow();
            }
          }
        }

        // --- pulsos de actividad: una chispa que viaja de la entrada al núcleo
        pulses.current = pulses.current.filter((pu) => now - pu.t0 < pu.dur);
        for (const pu of pulses.current) {
          const t = (now - pu.t0) / pu.dur;
          const seg = Math.min(pu.path.length - 2, Math.floor(t * (pu.path.length - 1)));
          const f = t * (pu.path.length - 1) - seg;
          const a = pu.path[seg]!;
          const b = pu.path[seg + 1]!;
          const q = project(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
          glow(color('--orange'), 18);
          ctx.beginPath();
          ctx.arc(q.x, q.y, 3.6, 0, TAU);
          ctx.fillStyle = color('--orange');
          ctx.fill();
          noGlow();
        }
        flashes.current = flashes.current.filter((fl) => now - fl.t0 < 1400);
        for (const fl of flashes.current) {
          const t = (now - fl.t0) / 1400;
          const q = project(...fl.at);
          ctx.beginPath();
          ctx.arc(q.x, q.y, 4 + 22 * t, 0, TAU);
          ctx.lineWidth = 2;
          ctx.strokeStyle = color('--orange', 1 - t);
          ctx.stroke();
        }

        // --- rótulos: de mayor a menor prioridad, sin encimarse
        ctx.textBaseline = 'middle';
        const taken: Array<[number, number, number, number]> = [];
        // Los nodos grandes (categorías, núcleo) también ocupan sitio: un rótulo no los pisa.
        for (const { it, top } of order) {
          const r = it.p.role === 'category' ? 15 : it.p.role === 'center' ? 25 : 0;
          if (r) taken.push([top.x - r, top.y - r, top.x + r, top.y + r]);
        }
        for (const lb of labels.sort((a, b) => b.d - a.d)) {
          if (!lb.text) continue;
          const big = lb.d >= 2e6;
          ctx.font = `600 ${big ? 11 : 10}px ${FONT}`;
          const tw = ctx.measureText(lb.text).width;
          const x0 = lb.align === 'center' ? lb.x - tw / 2 : lb.align === 'right' ? lb.x - tw : lb.x;
          const box: [number, number, number, number] = [x0 - 3, lb.y - 7, x0 + tw + 3, lb.y + 7];
          if (taken.some((t) => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1])) continue;
          taken.push(box);
          ctx.textAlign = lb.align;
          ctx.lineWidth = 3;
          ctx.strokeStyle = color('--background', 0.85 * lb.alpha);
          ctx.strokeText(lb.text, lb.x, lb.y);
          ctx.fillStyle = color(big ? fg : '--foreground', (big ? 1 : 0.9) * lb.alpha);
          ctx.fillText(lb.text, lb.x, lb.y);
        }
      },
      [project, color, reducedMotion],
    );

    // ---------------------------------------------------------------- bucle y tamaño

    useEffect(() => {
      const el = wrapRef.current;
      if (!el) return;
      const ro = new ResizeObserver(() => {
        const first = size.current.w === 0;
        size.current = { w: el.clientWidth, h: el.clientHeight };
        if (first) fit();
        dirty.current = true;
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, [fit]);

    useEffect(() => {
      fit();
    }, [fitKey, fit]);

    // Otro tema u otras zonas: los tokens resueltos ya no valen.
    useEffect(() => {
      colors.current.clear();
      dirty.current = true;
    }, [zones]);

    useEffect(() => {
      let raf = 0;
      let last = performance.now();
      const tick = (now: number) => {
        const dt = Math.min(64, now - last);
        last = now;
        const busy = pulses.current.length > 0 || flashes.current.length > 0;
        // Deriva lenta y constante: solo se detiene mientras alguien la arrastra. Como la escena se
        // mueve bajo un cursor quieto, lo que hay debajo se vuelve a calcular en cada cuadro.
        const drift = !reducedMotion && !drag.current && !document.hidden;
        if (drift) {
          cam.current.yaw += dt * 0.000045;
          if (inside.current && pointer.current) setHot(pick(pointer.current.x, pointer.current.y));
        }
        if (dirty.current || busy || drift || !reducedMotion) {
          dirty.current = false;
          draw(now);
          placeCard();
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draw, reducedMotion]);

    // ---------------------------------------------------------------- ficha flotante

    const placeCard = useCallback(() => {
      const card = cardRef.current;
      const wrap = wrapRef.current;
      const it = hoverRef.current.id ? sceneRef.current.byId.get(hoverRef.current.id) : undefined;
      if (!card || !wrap || !it) return;
      const q = project(it.p.x, it.p.y, it.z1);
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      const left = q.x + 18 + w > wrap.clientWidth - 8 ? q.x - 18 - w : q.x + 18;
      const top = Math.min(Math.max(8, q.y - h / 2), wrap.clientHeight - h - 8);
      card.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
    }, [project]);

    // ---------------------------------------------------------------- pulsos

    const pulse = useCallback((id: string): boolean => {
      const s = sceneRef.current;
      const path = pathToRoot(layoutRef.current, id);
      if (!path.length) return false;
      const pts = path.map((p): [number, number, number] => [p.x, p.y, s.byId.get(p.id)?.z1 ?? 0]);
      flashes.current.push({ at: pts[0]!, t0: performance.now() });
      if (pts.length > 1 && pulses.current.length < 28) pulses.current.push({ path: pts, t0: performance.now(), dur: 620 * (pts.length - 1) });
      return true;
    }, []);

    useImperativeHandle(ref, () => ({ pulse, fit }), [pulse, fit]);

    // ---------------------------------------------------------------- puntero

    const pick = useCallback(
      (sx: number, sy: number): { id: string | null; zone: string | null } => {
        const s = sceneRef.current;
        const l = layoutRef.current;
        let best: { id: string; d2: number } | null = null;
        for (const it of s.items) {
          const reach = it.p.role === 'center' ? 26 : it.p.role === 'category' ? 17 : it.p.role === 'outer' ? 12 : 9;
          const q = project(it.p.x, it.p.y, it.z1);
          const d2 = (q.x - sx) ** 2 + (q.y - sy) ** 2;
          if (d2 <= reach * reach && (!best || d2 < best.d2)) best = { id: it.p.id, d2 };
        }
        if (best) return { id: best.id, zone: s.byId.get(best.id)?.p.role === 'category' ? best.id : null };
        if (s.single) return { id: null, zone: null };
        const outerR = l.discs[0] ?? 0;
        const innerR = l.discs[1] ?? 0;
        for (const z of l.sectors) {
          const u = unproject(sx, sy, s.height.get(z.id) ?? 0);
          if (u.r < innerR || u.r > outerR) continue;
          let a = u.a;
          while (a < z.a0) a += TAU;
          while (a >= z.a0 + TAU) a -= TAU;
          if (a <= z.a1) return { id: null, zone: z.id };
        }
        return { id: null, zone: null };
      },
      [project, unproject],
    );

    const drag = useRef<{ x: number; y: number; moved: boolean; pan: boolean; id: number } | null>(null);
    const local = (e: { clientX: number; clientY: number }) => {
      const r = wrapRef.current!.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const setHot = (h: { id: string | null; zone: string | null }) => {
      const prev = hoverRef.current;
      if (prev.id === h.id && prev.zone === h.zone) return;
      hoverRef.current = h;
      dirty.current = true;
      const role = h.id ? sceneRef.current.byId.get(h.id)?.p.role : null;
      setHover(role === 'entry' || role === 'outer' ? h.id : null);
      if (canvasRef.current) canvasRef.current.style.cursor = h.id || h.zone ? 'pointer' : 'grab';
    };

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType === 'mouse' && e.button > 2) return;
      drag.current = { x: e.clientX, y: e.clientY, moved: false, pan: e.button !== 0 || e.shiftKey, id: e.pointerId };
    };
    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      inside.current = true;
      const d = drag.current;
      if (!d) {
        const p = local(e);
        pointer.current = p;
        setHot(pick(p.x, p.y));
        return;
      }
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < 5) return;
        d.moved = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        setHot({ id: null, zone: null });
        e.currentTarget.style.cursor = 'grabbing';
      }
      const c = cam.current;
      if (d.pan) {
        c.px += dx;
        c.py += dy;
      } else {
        c.yaw -= dx * 0.006;
        c.pitch = Math.min(0.92, Math.max(0.3, c.pitch + dy * 0.0028));
      }
      d.x = e.clientX;
      d.y = e.clientY;
      dirty.current = true;
    };
    const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const d = drag.current;
      drag.current = null;
      e.currentTarget.style.cursor = 'grab';
      if (!d || d.moved) return;
      const p = local(e);
      const hit = pick(p.x, p.y);
      const role = hit.id ? sceneRef.current.byId.get(hit.id)?.p.role : null;
      if (role === 'entry') onSelect(hit.id!);
      else if (role === 'outer') onOpenOuter(hit.id!);
      else if (role === 'center') {
        if (props.current.center.canGoUp) onUp();
      } else if (hit.zone) onOpenZone(hit.zone);
    };

    // `wheel` de React es pasivo: para frenar el scroll de la página hay que registrarlo a mano.
    const zoomAtPoint = useCallback((sx: number, sy: number, factor: number) => {
      const c = cam.current;
      const k = Math.min(5, Math.max(0.15, c.k * factor));
      const f = k / c.k;
      const cx = size.current.w / 2;
      const cy = size.current.h / 2;
      c.px = sx - cx - (sx - cx - c.px) * f;
      c.py = sy - cy - (sy - cy - c.py) * f;
      c.k = k;
      dirty.current = true;
    }, []);
    useEffect(() => {
      const el = canvasRef.current;
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        zoomAtPoint(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016)));
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return () => el.removeEventListener('wheel', onWheel);
    }, [zoomAtPoint]);

    const reset = () => {
      cam.current.yaw = START_YAW;
      cam.current.pitch = START_PITCH;
      fit();
    };

    const hovered = hover ? nodes.get(hover) : undefined;

    return (
      <div ref={wrapRef} className={cn('dark zeus-stage zeus-stage-iso relative select-none overflow-hidden bg-background text-foreground', className)}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Mapa de zeus en isométrico. La lista lateral contiene las mismas zonas y entradas."
          className="absolute inset-0 block size-full touch-none"
          style={{ cursor: 'grab' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { drag.current = null; }}
          onPointerLeave={() => {
            inside.current = false;
            pointer.current = null;
            if (!drag.current) setHot({ id: null, zone: null });
          }}
          onContextMenu={(e) => e.preventDefault()}
        />

        {/* Ficha flotante del nodo bajo el cursor. La coloca `placeCard` sin pasar por React. */}
        <div
          ref={cardRef}
          className={cn(
            'zeus-glass pointer-events-none absolute left-0 top-0 z-10 w-[270px] rounded-lg p-3 transition-opacity duration-150',
            hovered ? 'opacity-100' : 'opacity-0',
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
            className="zeus-glass absolute left-3 top-3 inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CornerLeftUp className="size-3.5" /> Subir
          </button>
        )}

        <div style={{ right: (inset?.right ?? 0) + 12 }} className="zeus-glass absolute bottom-3 right-3 flex items-center gap-0.5 rounded-md p-0.5">
          {([
            ['Alejar', ZoomOut, () => zoomAtPoint(size.current.w / 2, size.current.h / 2, 1 / 1.35)],
            ['Vista inicial', Maximize2, reset],
            ['Acercar', ZoomIn, () => zoomAtPoint(size.current.w / 2, size.current.h / 2, 1.35)],
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
