// Mapa de zeus como MAQUETA 3D (three.js). El mismo layout por zonas que el radial plano y el
// isométrico (`zoneLayout`), construido como una maqueta con luz y sombras:
//   · cada zona es una losa extruida (más alta cuanto más contiene) con sus cantos marcados;
//   · cada entrada es una torre sobre su losa, más alta cuanto más conectada está;
//   · el núcleo es un holograma de líneas (estilo Jarvis) que flota sobre un zócalo en un pozo oscuro;
//   · cada zona se une al núcleo con un cable por el que corre un flujo de su color;
//   · al enfocar una entrada se levantan arcos hacia sus vecinos;
//   · cada pulso de actividad viaja como un paquete por el cable de su zona.
// Sigue el tema de roz: en claro la maqueta es hueso, en oscuro es negra. Todos los colores salen de
// los tokens del tema (`--orange`, `--card`, el tono de cada tipo…), resueltos al construir la escena.
// Las torres son una sola InstancedMesh: cientos de entradas cuestan un draw call. Este módulo se
// carga perezoso desde MapTab, así three.js solo baja cuando alguien abre el Mapa.
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CornerLeftUp, Maximize2, Pin, ZoomIn, ZoomOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTheme } from '@/components/theme';
import { pathToRoot } from './layout';
import type { ZoneCanvasHandle, ZoneCanvasProps } from './ZoneCanvas';
import { STATUS_META, kindMeta, type Tone } from './zeus-ui';
import './zeus.css';

export interface MaquetteCanvasProps extends ZoneCanvasProps {
  /** Peso de cada entrada (sus conexiones): alza su torre. */
  weights?: Map<string, number>;
}

const TAU = Math.PI * 2;
const FOV = 30;
const START_YAW = 0.75;
const START_PITCH = 0.62;
/** Lado de la base de cada torre (las entradas del layout van a 17 unidades entre sí). */
const TOWER_W = 9;
const CORE = { plinthR: 46, plinthH: 8, stepR: 34, stepH: 7 };
/** Altura del zócalo (base + escalón): de ahí sale el haz hacia el holograma. */
const CORE_BASE = CORE.plinthH + CORE.stepH;
/** Holograma del núcleo: radio y altura de su centro. */
const HOLO_R = 62;
const HOLO_Y = CORE_BASE + 86;
const CORE_TOP = HOLO_Y + HOLO_R + 6;

/** `fill-purple-deep` → `--purple-deep`: el token detrás de la clase de relleno de un tono. */
const tokenOf = (tone: Tone | undefined): string => `--${(tone?.fill ?? 'fill-faint').replace(/^fill-/, '')}`;

/** Token del tema ("217 91% 60%") como color de three. */
function readToken(el: Element, token: string): THREE.Color {
  const raw = getComputedStyle(el).getPropertyValue(token).trim();
  const m = raw.match(/^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  const c = new THREE.Color();
  return m ? c.setHSL(Number(m[1]) / 360, Number(m[2]) / 100, Number(m[3]) / 100) : c.setScalar(0.5);
}

/** La paleta de la maqueta para el tema activo, derivada de los tokens. */
function paletteFor(el: Element, dark: boolean) {
  const t = (name: string) => readToken(el, name);
  const bg = t('--background');
  const fg = t('--foreground');
  const card = t('--card');
  const black = new THREE.Color(0, 0, 0);
  return {
    dark,
    fg,
    orange: t('--orange'),
    card,
    /** Losa: el tono de la zona hundido hacia la tarjeta; las torres llevan el tono pleno encima. */
    slab: card,
    slabMix: dark ? 0.7 : 0.42,
    line: fg,
    lineOp: dark ? 0.22 : 0.3,
    gridOp: dark ? 0.1 : 0.12,
    tickOp: dark ? 0.3 : 0.28,
    /** Torre apagada (fuera del foco o del filtro). */
    dim: dark ? t('--muted').lerp(fg, 0.08) : t('--toggle-off'),
    plinth: dark ? bg.clone().lerp(black, 0.55) : fg.clone().lerp(card, 0.08),
    step: dark ? t('--muted') : card.clone().lerp(bg, 0.5),
    cable: dark ? fg.clone().lerp(bg, 0.72) : fg.clone().lerp(card, 0.25),
    sky: dark ? fg : card,
    hemiGround: dark ? bg : t('--toggle-off'),
    // Intensidades físicas de three (sin el factor π del modo heredado). El mapa de entorno aporta el
    // resto: reflejos suaves que quitan el aspecto de plastilina.
    hemiI: (dark ? 0.22 : 0.3) * Math.PI,
    sunI: (dark ? 1.15 : 1.05) * Math.PI,
    env: dark ? 0.22 : 0.32,
    exposure: dark ? 1.15 : 0.95,
    /** Pozo bajo el núcleo: oscuro en los dos temas para que el holograma tenga contraste. */
    well: dark ? bg.clone().lerp(black, 0.55) : fg.clone().lerp(card, 0.07),
    gold: t('--yellow'),
    /** Brillo de la energía del núcleo: en claro se quema a blanco si se pasa. */
    glow: dark ? 1.1 : 0.7,
    shadow: dark ? 0.6 : 0.22,
  };
}
type Palette = ReturnType<typeof paletteFor>;

interface TowerSpot {
  id: string;
  zone: string | null;
  x: number;
  z: number;
  y: number;
  h: number;
  angle: number;
}

interface World {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  ground: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
  focus: THREE.Group;
  packets: THREE.Group;
}

interface Built {
  group: THREE.Group;
  pal: Palette;
  slabs: THREE.Mesh<THREE.ExtrudeGeometry, THREE.MeshStandardMaterial>[];
  slabBase: Map<string, THREE.Color>;
  zoneColor: Map<string, THREE.Color>;
  towers: THREE.InstancedMesh | null;
  /** Tapa iluminada de cada torre (mismo índice que `towers`). */
  lids: THREE.InstancedMesh | null;
  towerBase: THREE.Color[];
  outer: THREE.InstancedMesh | null;
  outerIds: string[];
  coreParts: THREE.Mesh[];
  cables: Map<string, THREE.CatmullRomCurve3>;
  /** Animación: flujo de los cables, energía del núcleo, anillos y la onda del piso. */
  flow: THREE.ShaderMaterial[];
  glow: THREE.MeshStandardMaterial;
  light: THREE.PointLight;
  holo: Holo;
  ripple: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  floorR: number;
}

const polar = (r: number, a: number, y = 0) => new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);

/** Azar determinista: el holograma es el mismo en cada carga. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Holo {
  group: THREE.Group;
  shell: THREE.Group;
  dials: THREE.Group[];
  traces: THREE.Group;
  nucleus: THREE.Group;
  halo: THREE.Sprite;
  mats: THREE.LineBasicMaterial[];
}

/**
 * El núcleo como holograma de Jarvis: una esfera de arcos de líneas finas, diales con marcas que giran
 * en ejes distintos, radios y trazas de circuito, y un núcleo brillante. Solo líneas (nada de nube de
 * puntos). En oscuro se suman a la luz (aditivo); en claro se pintan normal para no lavarse a blanco.
 */
function buildHolo(pal: Palette): Holo {
  const rnd = seeded(29);
  const group = new THREE.Group();
  const gold = pal.orange.clone().lerp(pal.gold, 0.45);
  const blending = pal.dark ? THREE.AdditiveBlending : THREE.NormalBlending;
  const mats: THREE.LineBasicMaterial[] = [];
  const mat = (color: THREE.Color, alpha: number) => {
    // Sin suma de luz (claro) las líneas necesitan más cuerpo para no perderse.
    const opacity = pal.dark ? alpha : Math.min(1, alpha * 1.7);
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending, depthWrite: false, toneMapped: false });
    m.userData.base = opacity;
    mats.push(m);
    return m;
  };
  const arc = (r: number, a0: number, a1: number) => {
    const n = Math.max(8, Math.ceil(((a1 - a0) * r) / 3));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  };

  // esfera de arcos parciales, cada uno en su propia orientación
  const shell = new THREE.Group();
  for (let i = 0; i < 38; i++) {
    const r = HOLO_R * (0.7 + rnd() * 0.32);
    const a0 = rnd() * TAU;
    const line = new THREE.Line(arc(r, a0, a0 + 0.5 + rnd() * 2.4), mat(rnd() < 0.5 ? pal.orange : gold, 0.22 + rnd() * 0.55));
    line.rotation.set(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI);
    shell.add(line);
  }

  // diales: segmentos con huecos y una escala de marcas, cada uno inclinado distinto
  const dials = ([
    [HOLO_R * 1.12, 0.18],
    [HOLO_R * 0.92, -0.55],
    [HOLO_R * 0.6, 1.05],
  ] as const).map(([r, tilt], k) => {
    const d = new THREE.Group();
    for (let a = rnd() * 0.4; a < TAU; ) {
      const span = Math.min(TAU - a, 0.25 + rnd() * 0.9);
      d.add(new THREE.Line(arc(r, a, a + span), mat(gold, 0.85)));
      a += span + 0.06 + rnd() * 0.3;
    }
    const tk: THREE.Vector3[] = [];
    for (let i = 0; i < 144; i++) {
      const t = (i / 144) * TAU;
      const l = i % 12 === 0 ? 6 : 2.4;
      tk.push(new THREE.Vector3(Math.cos(t) * (r + 2), Math.sin(t) * (r + 2), 0), new THREE.Vector3(Math.cos(t) * (r + 2 + l), Math.sin(t) * (r + 2 + l), 0));
    }
    d.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(tk), mat(pal.orange, 0.5)));
    d.rotation.set(Math.PI / 2 + tilt, k * 0.7, 0);
    d.userData.spin = (k % 2 ? -1 : 1) * (0.22 + k * 0.14);
    return d;
  });

  // radios del núcleo hacia la superficie y trazas de circuito (escalonadas: ángulo, luego radio)
  const traces = new THREE.Group();
  const spokes: THREE.Vector3[] = [];
  for (let i = 0; i < 30; i++) {
    const dir = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    spokes.push(dir.clone().multiplyScalar(10), dir.clone().multiplyScalar(HOLO_R * (0.55 + rnd() * 0.5)));
  }
  traces.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokes), mat(gold, 0.3)));
  for (let i = 0; i < 16; i++) {
    let a = rnd() * TAU;
    let r = HOLO_R * (0.35 + rnd() * 0.45);
    const pts = [new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0)];
    for (let k = 0; k < 5; k++) {
      const na = a + (rnd() - 0.3) * 0.6;
      const n = 6;
      for (let j = 1; j <= n; j++) pts.push(new THREE.Vector3(Math.cos(a + ((na - a) * j) / n) * r, Math.sin(a + ((na - a) * j) / n) * r, 0));
      a = na;
      r = Math.min(HOLO_R * 0.95, r + (rnd() - 0.35) * 9);
      pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat(pal.orange, 0.75));
    line.rotation.set(rnd() * Math.PI, rnd() * Math.PI, 0);
    traces.add(line);
  }

  // núcleo: esfera brillante con dos anillos cerrados
  const nucleus = new THREE.Group();
  nucleus.add(new THREE.Mesh(new THREE.SphereGeometry(6.5, 32, 24), new THREE.MeshBasicMaterial({ color: gold, toneMapped: false })));
  [11, 15.5].forEach((r, i) => {
    const t = new THREE.Mesh(new THREE.TorusGeometry(r, i ? 0.35 : 0.7, 8, 96), new THREE.MeshBasicMaterial({ color: pal.orange, toneMapped: false, transparent: true, opacity: 0.9 }));
    t.rotation.set(i ? 1.1 : Math.PI / 2, i ? 0.4 : 0, 0);
    nucleus.add(t);
  });

  // resplandor: un degradado radial en blanco que se tiñe con el color del material
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), color: pal.orange, transparent: true, opacity: pal.dark ? 0.75 : 0.45, blending, depthWrite: false, toneMapped: false }));
  halo.scale.setScalar(HOLO_R * 1.5);

  group.add(halo, shell, ...dials, traces, nucleus);
  return { group, shell, dials, traces, nucleus, halo, mats };
}

function disposeTree(o: THREE.Object3D) {
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

export const MaquetteCanvas = memo(
  forwardRef<ZoneCanvasHandle, MaquetteCanvasProps>(function MaquetteCanvas(
    { layout, nodes, zones, center, outerOf, projectNames, selectedId, dimmed, hotZone, fitKey, inset, reducedMotion, weights, onSelect, onOpenZone, onOpenOuter, onUp, className },
    ref,
  ) {
    const { resolved } = useTheme();
    const wrapRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const world = useRef<World | null>(null);
    const built = useRef<Built | null>(null);
    const size = useRef({ w: 0, h: 0 });
    const cam = useRef({ yaw: START_YAW, pitch: START_PITCH, dist: 900, target: new THREE.Vector3() });
    const goal = useRef({ yaw: START_YAW, pitch: START_PITCH, dist: 900, target: new THREE.Vector3() });
    const fitDist = useRef(900);
    const hoverRef = useRef<{ id: string | null; zone: string | null }>({ id: null, zone: null });
    const [hover, setHover] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const labels = useRef(new Map<string, HTMLElement>());
    const flashes = useRef(new Map<string, number>());
    const packets = useRef<Array<{ mesh: THREE.Mesh; curve: THREE.Curve<THREE.Vector3>; t0: number; dur: number }>>([]);
    const drag = useRef<{ x: number; y: number; moved: boolean; pan: boolean } | null>(null);

    // ---------------------------------------------------------------- geometría (pura, sin colores)

    const geo = useMemo(() => {
      const single = layout.sectors.length <= 1;
      const max = Math.max(1, ...layout.sectors.map((s) => s.count));
      const slabH = new Map(layout.sectors.map((s) => [s.id, single ? 8 : 9 + 20 * Math.sqrt(s.count / max)]));
      const towers: TowerSpot[] = [];
      for (const p of layout.nodes) {
        if (p.role !== 'entry') continue;
        const zone = single ? layout.sectors[0]?.id ?? null : p.parent;
        let hash = 0;
        for (let i = 0; i < p.id.length; i++) hash = (hash * 31 + p.id.charCodeAt(i)) >>> 0;
        const node = nodes.get(p.id);
        const h = 6 + (hash % 4) * 2.4 + Math.min(14, weights?.get(p.id) ?? 0) * 6.2 + (node?.pinned ? 10 : 0);
        towers.push({ id: p.id, zone, x: p.x, z: p.y, y: (zone ? slabH.get(zone) ?? 0 : 0) + 0.9, h, angle: p.angle ?? Math.atan2(p.y, p.x) });
      }
      const towerIndex = new Map(towers.map((t, i) => [t.id, i]));
      const outer = layout.nodes.filter((p) => p.role === 'outer');
      const disc = layout.discs[0] ?? 200;
      const reach = disc + (outer.length ? 36 : 14);
      return { single, slabH, towers, towerIndex, outer, disc, reach };
    }, [layout, nodes, weights]);

    const latest = useRef({ geo, layout, nodes, selectedId, dimmed, hotZone, outerOf, inset, center, reducedMotion });
    latest.current = { geo, layout, nodes, selectedId, dimmed, hotZone, outerOf, inset, center, reducedMotion };

    // ---------------------------------------------------------------- mundo (una vez)

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      let renderer: THREE.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      } catch {
        setFailed(true);
        return;
      }
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.setClearColor(0x000000, 0);
      renderer.shadowMap.enabled = true;
      // Sombras de borde nítido y tono fílmico: contraste de maqueta fotografiada, no de plastilina.
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      const scene = new THREE.Scene();
      // Entorno de estudio: da reflejos y volumen a los materiales sin luces extra.
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
      scene.environment = envTex;
      const camera = new THREE.PerspectiveCamera(FOV, 1, 5, 20000);
      const hemi = new THREE.HemisphereLight();
      const sun = new THREE.DirectionalLight();
      sun.castShadow = true;
      sun.shadow.mapSize.set(4096, 4096);
      sun.shadow.bias = -0.0006;
      scene.add(hemi, sun, sun.target);
      // El suelo solo recibe sombras: el fondo lo pone el tablero (CSS), así coincide con el tema.
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.2 }));
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      scene.add(ground);
      const focus = new THREE.Group();
      const packetsG = new THREE.Group();
      scene.add(focus, packetsG);
      world.current = { renderer, scene, camera, hemi, sun, ground, focus, packets: packetsG };
      return () => {
        disposeTree(scene);
        envTex.dispose();
        renderer.dispose();
        world.current = null;
        built.current = null;
      };
    }, []);

    // ---------------------------------------------------------------- encuadre

    const applyView = useCallback(() => {
      const w = world.current;
      const { w: W, h: H } = size.current;
      if (!w || !W || !H) return;
      const ins = latest.current.inset;
      w.renderer.setSize(W, H, false);
      w.camera.aspect = W / H;
      // Con paneles flotantes a los lados, el centro de la escena se corre al hueco libre.
      const shift = ((ins?.right ?? 0) - (ins?.left ?? 0)) / 2;
      if (shift) w.camera.setViewOffset(W, H, shift, 0, W, H);
      else w.camera.clearViewOffset();
      w.camera.updateProjectionMatrix();
    }, []);

    const fit = useCallback(() => {
      const { w: W, h: H } = size.current;
      if (!W || !H) return;
      const { geo: g, inset: ins } = latest.current;
      const g0 = goal.current;
      const free = Math.max(200, W - (ins?.left ?? 0) - (ins?.right ?? 0) - 40);
      const tv = Math.tan(((FOV / 2) * Math.PI) / 180);
      const th = tv * (free / H);
      const R = g.reach;
      const dist = Math.max(R / th, (R * Math.sin(START_PITCH) + CORE_TOP * Math.cos(START_PITCH) * 0.6) / tv) * 1.04;
      fitDist.current = dist;
      g0.yaw = START_YAW;
      g0.pitch = START_PITCH;
      g0.dist = dist;
      g0.target.set(0, 12, 0);
      applyView();
    }, [applyView]);

    useEffect(() => {
      const el = wrapRef.current;
      if (!el) return;
      const ro = new ResizeObserver(() => {
        const first = size.current.w === 0;
        size.current = { w: el.clientWidth, h: el.clientHeight };
        if (first) {
          fit();
          const c = cam.current;
          const g0 = goal.current;
          c.yaw = g0.yaw;
          c.pitch = g0.pitch;
          c.dist = g0.dist * 1.25; // entra acercándose
          c.target.copy(g0.target);
        } else applyView();
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, [fit, applyView]);

    useEffect(() => {
      fit();
    }, [fitKey, fit]);
    useEffect(() => {
      applyView();
    }, [inset?.left, inset?.right, applyView]);

    // ---------------------------------------------------------------- escena (layout, zonas, tema)

    useEffect(() => {
      // El tema cambia la clase `dark` en <html> desde el efecto del proveedor, que corre DESPUÉS que
      // los de los hijos: se espera un cuadro para leer los tokens ya actualizados.
      const raf = requestAnimationFrame(() => {
        const w = world.current;
        const el = wrapRef.current;
        if (!w || !el) return;
        if (built.current) {
          w.scene.remove(built.current.group);
          disposeTree(built.current.group);
        }
        const pal = paletteFor(el, resolved === 'dark');
        const g = new THREE.Group();
        const R = geo.disc;

        // luces y sombra según el tamaño de la escena
        w.hemi.color.copy(pal.sky);
        w.hemi.groundColor.copy(pal.hemiGround);
        w.hemi.intensity = pal.hemiI;
        w.sun.intensity = pal.sunI;
        w.scene.environmentIntensity = pal.env;
        w.renderer.toneMappingExposure = pal.exposure;
        w.sun.position.set(-R * 0.8, R * 1.4, R * 0.65);
        const sc = w.sun.shadow.camera;
        sc.left = -R * 1.15;
        sc.right = R * 1.15;
        sc.top = R * 1.15;
        sc.bottom = -R * 1.15;
        sc.near = 10;
        sc.far = R * 4;
        sc.updateProjectionMatrix();
        w.ground.scale.set(R * 8, R * 8, 1);
        w.ground.material.opacity = pal.shadow;

        // piso: anillos y radios que se abren hasta muy afuera y se desvanecen, dos escalas de marcas
        const floorR = R * 2.9;
        const circle = (r: number, n = 240) => {
          const pts: THREE.Vector3[] = [];
          for (let i = 0; i <= n; i++) pts.push(polar(r, (i / n) * TAU, 0.3));
          return new THREE.BufferGeometry().setFromPoints(pts);
        };
        const faded = (r: number) => pal.gridOp * 1.5 * Math.max(0.08, 1 - Math.pow(r / floorR, 1.3));
        for (let r = CORE.plinthR + 22; r <= floorR; r += r < R ? 46 : 72) {
          g.add(new THREE.Line(circle(r), new THREE.LineBasicMaterial({ color: pal.line, transparent: true, opacity: faded(r), depthWrite: false })));
        }
        {
          // Radios con alfa por vértice: nacen en el disco y se apagan hacia el horizonte.
          const pos: number[] = [];
          const col: number[] = [];
          for (let i = 0; i < 48; i++) {
            const a = (i / 48) * TAU;
            const a0 = polar(R + 14, a, 0.3);
            const a1 = polar(floorR, a, 0.3);
            pos.push(a0.x, a0.y, a0.z, a1.x, a1.y, a1.z);
            const op = (i % 4 === 0 ? 1.6 : 0.8) * pal.gridOp * 1.4;
            col.push(pal.line.r, pal.line.g, pal.line.b, op, pal.line.r, pal.line.g, pal.line.b, 0);
          }
          const sg = new THREE.BufferGeometry();
          sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
          sg.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
          g.add(new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false })));
        }
        const ticks = (r: number, n: number, every: number, short: number, long: number, op: number) => {
          const tk: THREE.Vector3[] = [];
          for (let i = 0; i < n; i++) {
            const a = (i / n) * TAU;
            tk.push(polar(r, a, 0.3), polar(r + (i % every === 0 ? long : short), a, 0.3));
          }
          g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(tk), new THREE.LineBasicMaterial({ color: pal.line, transparent: true, opacity: op, depthWrite: false })));
        };
        ticks(R + 40, 144, 12, 6, 18, pal.tickOp);
        ticks(R * 1.75, 360, 10, 5, 14, pal.tickOp * 0.55);
        // Onda que sale del núcleo y recorre el piso (la anima el bucle).
        const ripple = new THREE.Line(circle(1, 160), new THREE.LineBasicMaterial({ color: pal.orange, transparent: true, opacity: 0, depthWrite: false }));
        g.add(ripple);

        // losas: casi neutras, con un canto del color de su zona
        const slabs: Built['slabs'] = [];
        const slabBase = new Map<string, THREE.Color>();
        const zoneColor = new Map<string, THREE.Color>();
        const sector = (rIn: number, rOut: number, a0: number, a1: number) => {
          const shape = new THREE.Shape();
          if (a1 - a0 >= TAU - 1e-6) {
            shape.absarc(0, 0, rOut, 0, TAU, false);
            const hole = new THREE.Path();
            hole.absarc(0, 0, rIn, 0, TAU, true);
            shape.holes.push(hole);
          } else {
            shape.absarc(0, 0, rOut, a0, a1, false);
            shape.absarc(0, 0, rIn, a1, a0, true);
            shape.closePath();
          }
          return shape;
        };
        // La forma vive en el plano XY con el ángulo del layout; girada sobre X queda tendida en el
        // suelo (z del mundo = y del layout) y extruida hacia abajo: se sube su alto.
        const lay = (m: THREE.Mesh, top: number) => {
          m.rotation.x = Math.PI / 2;
          m.position.y = top;
          m.castShadow = true;
          m.receiveShadow = true;
        };
        for (const s of layout.sectors) {
          // Los tokens están pensados para CSS (sRGB). Pasarlos una vez más a lineal los satura y oscurece:
          // en la escena iluminada se ven profundos en vez de pastel.
          const tone = readToken(el, tokenOf(zones.get(s.id)?.tone)).convertSRGBToLinear();
          zoneColor.set(s.id, tone);
          const H = geo.slabH.get(s.id) ?? 8;
          const full = s.a1 - s.a0 >= TAU - 1e-6;
          const pad = full ? 0 : Math.min(0.012, (s.a1 - s.a0) / 10);
          const rIn = full ? Math.max(CORE.plinthR + 22, s.rIn) : s.rIn;
          const eg = new THREE.ExtrudeGeometry(sector(rIn, s.rOut, s.a0 + pad, s.a1 - pad), { depth: H, bevelEnabled: false, curveSegments: 96 });
          const base = tone.clone().lerp(pal.slab, pal.slabMix).convertSRGBToLinear();
          slabBase.set(s.id, base);
          const mesh = new THREE.Mesh(eg, new THREE.MeshStandardMaterial({ color: base.clone(), roughness: 0.45, metalness: 0.1 }));
          lay(mesh, H);
          mesh.userData = { zone: s.id };
          mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(eg, 25), new THREE.LineBasicMaterial({ color: pal.line, transparent: true, opacity: pal.lineOp })));
          g.add(mesh);
          slabs.push(mesh);
          // Canto: una banda del tono de la zona que sobresale apenas en el borde exterior.
          const rim = new THREE.Mesh(
            new THREE.ExtrudeGeometry(sector(s.rOut - 2.6, s.rOut + 0.9, s.a0 + pad, s.a1 - pad), { depth: H + 2.2, bevelEnabled: false, curveSegments: 96 }),
            new THREE.MeshStandardMaterial({ color: tone, emissive: tone, emissiveIntensity: pal.dark ? 0.35 : 0.12, roughness: 0.35 }),
          );
          lay(rim, H + 2.2);
          rim.raycast = () => {};
          g.add(rim);
        }

        // torres: una InstancedMesh, con un degradado de oscuro (base) a claro (punta)
        let towers: THREE.InstancedMesh | null = null;
        let lids: THREE.InstancedMesh | null = null;
        const towerBase: THREE.Color[] = [];
        if (geo.towers.length) {
          const box = new THREE.BoxGeometry(TOWER_W, 1, TOWER_W);
          box.translate(0, 0.5, 0);
          const ys = box.getAttribute('position');
          const shade: number[] = [];
          for (let i = 0; i < ys.count; i++) {
            const k = 0.32 + 0.68 * Math.pow(ys.getY(i), 1.4);
            shade.push(k, k, k);
          }
          box.setAttribute('color', new THREE.Float32BufferAttribute(shade, 3));
          towers = new THREE.InstancedMesh(box, new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.22, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.08 }), geo.towers.length);
          towers.castShadow = true;
          towers.receiveShadow = true;
          const dummy = new THREE.Object3D();
          geo.towers.forEach((t, i) => {
            dummy.position.set(t.x, t.y, t.z);
            dummy.rotation.set(0, -t.angle, 0);
            dummy.scale.set(1, t.h, 1);
            dummy.updateMatrix();
            towers!.setMatrixAt(i, dummy.matrix);
            const node = nodes.get(t.id);
            const c = (t.zone ? zoneColor.get(t.zone) : undefined)?.clone() ?? pal.fg.clone();
            // Lo reemplazado y lo archivado pierden color; el borrador queda lavado.
            if (node?.status === 'archived' || node?.status === 'superseded') c.lerp(pal.dim, 0.6);
            else if (node?.status === 'draft') c.lerp(pal.card, 0.55);
            towerBase.push(c);
            towers!.setColorAt(i, c);
          });
          g.add(towers);
          // Tapa iluminada en cada torre: una placa delgada que emite el tono de su zona.
          const lidG = new THREE.BoxGeometry(TOWER_W - 1.6, 0.8, TOWER_W - 1.6);
          lidG.translate(0, 0.4, 0);
          lids = new THREE.InstancedMesh(lidG, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: pal.dark ? 0.55 : 0.3, roughness: 0.2 }), geo.towers.length);
          lids.raycast = () => {};
          geo.towers.forEach((t, i) => {
            dummy.position.set(t.x, t.y + t.h, t.z);
            dummy.rotation.set(0, -t.angle, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            lids!.setMatrixAt(i, dummy.matrix);
            lids!.setColorAt(i, towerBase[i]!.clone().lerp(pal.card, 0.35));
          });
          g.add(lids);
          // Las fijadas llevan una tapa naranja que brilla.
          const pinned = geo.towers.filter((t) => nodes.get(t.id)?.pinned);
          if (pinned.length) {
            const capG = new THREE.BoxGeometry(TOWER_W + 1.4, 2.6, TOWER_W + 1.4);
            capG.translate(0, 1.3, 0);
            const caps = new THREE.InstancedMesh(capG, new THREE.MeshStandardMaterial({ color: pal.orange, emissive: pal.orange, emissiveIntensity: 0.45, roughness: 0.3 }), pinned.length);
            caps.castShadow = true;
            pinned.forEach((t, i) => {
              dummy.position.set(t.x, t.y + t.h, t.z);
              dummy.rotation.set(0, -t.angle, 0);
              dummy.scale.set(1, 1, 1);
              dummy.updateMatrix();
              caps.setMatrixAt(i, dummy.matrix);
            });
            caps.raycast = () => {};
            g.add(caps);
          }
        }

        // anillo exterior (proyectos): mojones bajos en el suelo
        let outer: THREE.InstancedMesh | null = null;
        if (geo.outer.length) {
          const cyl = new THREE.CylinderGeometry(4.5, 4.5, 5, 24);
          cyl.translate(0, 2.5, 0);
          outer = new THREE.InstancedMesh(cyl, new THREE.MeshStandardMaterial({ color: pal.plinth, roughness: 0.4, metalness: 0.2 }), geo.outer.length);
          outer.castShadow = true;
          const dummy = new THREE.Object3D();
          geo.outer.forEach((p, i) => {
            dummy.position.set(p.x, 0, p.y);
            dummy.updateMatrix();
            outer!.setMatrixAt(i, dummy.matrix);
          });
          g.add(outer);
        }

        // núcleo: zócalo oscuro con filos encendidos, un haz y el holograma flotando encima
        const coreParts: THREE.Mesh[] = [];
        const solid = (geom: THREE.BufferGeometry, mat: THREE.Material, y: number) => {
          const m = new THREE.Mesh(geom, mat);
          m.position.y = y;
          m.castShadow = true;
          m.receiveShadow = true;
          g.add(m);
          coreParts.push(m);
          return m;
        };
        const glow = new THREE.MeshStandardMaterial({ color: pal.orange, emissive: pal.orange, emissiveIntensity: pal.glow, roughness: 0.25 });
        const trim = (r: number, y: number, tube = 0.7) => {
          const t = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 10, 200), glow);
          t.rotation.x = Math.PI / 2;
          t.position.y = y;
          t.raycast = () => {};
          g.add(t);
        };
        // Pozo: el piso interior oscuro en ambos temas, con su filo encendido.
        const wellR = Math.max(CORE.plinthR + 30, Math.min(...layout.sectors.map((s) => s.rIn)) - 10);
        const well = new THREE.Mesh(new THREE.CircleGeometry(wellR, 160), new THREE.MeshStandardMaterial({ color: pal.well, roughness: 0.5, metalness: 0.25 }));
        well.rotation.x = -Math.PI / 2;
        well.position.y = 0.15;
        well.receiveShadow = true;
        well.raycast = () => {};
        g.add(well);
        trim(wellR, 0.4, 0.9);
        const dark = new THREE.MeshPhysicalMaterial({ color: pal.plinth, roughness: 0.3, metalness: 0.4, clearcoat: 0.6 });
        solid(new THREE.CylinderGeometry(CORE.plinthR, CORE.plinthR + 3, CORE.plinthH, 96), dark, CORE.plinthH / 2);
        trim(CORE.plinthR - 0.4, CORE.plinthH);
        solid(new THREE.CylinderGeometry(CORE.stepR, CORE.stepR, CORE.stepH, 96), dark, CORE.plinthH + CORE.stepH / 2);
        trim(CORE.stepR - 0.4, CORE_BASE);
        // haz del zócalo al holograma
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(5, 16, HOLO_Y - CORE_BASE, 48, 1, true),
          new THREE.MeshBasicMaterial({ color: pal.orange, transparent: true, opacity: pal.dark ? 0.14 : 0.1, blending: pal.dark ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
        );
        beam.position.y = CORE_BASE + (HOLO_Y - CORE_BASE) / 2;
        beam.raycast = () => {};
        g.add(beam);
        const holo = buildHolo(pal);
        holo.group.position.y = HOLO_Y;
        g.add(holo.group);
        // Esfera invisible para poder hacer clic en el holograma (subir de nivel).
        const hit = new THREE.Mesh(new THREE.SphereGeometry(HOLO_R, 16, 12), new THREE.MeshBasicMaterial({ visible: false }));
        hit.position.y = HOLO_Y;
        g.add(hit);
        coreParts.push(hit);
        // el holograma ilumina lo que tiene cerca
        const light = new THREE.PointLight(pal.orange, R * 0.5 * pal.glow, R * 1.4, 1);
        light.position.y = HOLO_Y;
        g.add(light);

        // cables zona → núcleo, con un flujo de su color corriendo hacia el centro
        const cables = new Map<string, THREE.CatmullRomCurve3>();
        const flow: THREE.ShaderMaterial[] = [];
        if (!geo.single) {
          layout.sectors.forEach((s, i) => {
            const H = geo.slabH.get(s.id) ?? 8;
            const from = polar(s.rIn - 1, s.mid, H * 0.55);
            const lift = 34 + (i % 3) * 14;
            const p1 = polar(s.rIn - (s.rIn - HOLO_R) * 0.35, s.mid + 0.05, H + lift);
            const p2 = polar(HOLO_R + 34, s.mid - 0.04, HOLO_Y + lift * 0.3);
            const to = polar(HOLO_R * 0.82, s.mid, HOLO_Y);
            const curve = new THREE.CatmullRomCurve3([from, p1, p2, to], false, 'centripetal');
            const mat = new THREE.ShaderMaterial({
              uniforms: { uTime: { value: 0 }, uBase: { value: pal.cable }, uFlow: { value: zoneColor.get(s.id) ?? pal.orange }, uOffset: { value: (i * 0.137) % 1 } },
              vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
              fragmentShader: `varying vec2 vUv; uniform float uTime; uniform vec3 uBase; uniform vec3 uFlow; uniform float uOffset;
                void main(){
                  float s = fract(vUv.x * 4.0 - uTime * 0.42 + uOffset);
                  float head = smoothstep(0.0, 0.03, s) * (1.0 - smoothstep(0.03, 0.34, s));
                  float rim = 0.55 + 0.45 * abs(sin(vUv.y * 3.14159));
                  gl_FragColor = vec4(mix(uBase * rim, uFlow * 1.25, head), 1.0);
                  #include <colorspace_fragment>
                }`,
            });
            flow.push(mat);
            const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 96, 0.6, 8, false), mat);
            tube.castShadow = true;
            tube.raycast = () => {};
            g.add(tube);
            cables.set(s.id, curve);
          });
        }

        w.scene.add(g);
        built.current = { group: g, pal, slabs, slabBase, zoneColor, towers, lids, towerBase, outer, outerIds: geo.outer.map((p) => p.id), coreParts, cables, flow, glow, light, holo, ripple, floorR };
        refocus();
      });
      return () => cancelAnimationFrame(raf);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [geo, layout, zones, nodes, resolved]);

    // ---------------------------------------------------------------- foco (selección, filtro, cursor)

    const refocus = useCallback(() => {
      const w = world.current;
      const b = built.current;
      if (!w || !b) return;
      const { geo: g, layout: l, selectedId: sel, dimmed: dim, hotZone: hz, outerOf: oo } = latest.current;
      const focusId = hoverRef.current.id ?? sel;
      const focusIsOuter = focusId != null && b.outerIds.includes(focusId);
      const lit = new Set<string>();
      if (focusId) {
        lit.add(focusId);
        for (const k of l.links) {
          if (k.structural) continue;
          if (k.from === focusId) lit.add(k.to);
          else if (k.to === focusId) lit.add(k.from);
        }
      }
      const dimAll = sel != null || focusIsOuter;
      if (b.towers) {
        g.towers.forEach((t, i) => {
          const mine = focusIsOuter && oo(t.id) === focusId;
          const faded = dim?.has(t.id) || (dimAll && !lit.has(t.id) && !mine);
          b.towers!.setColorAt(i, faded ? b.pal.dim : b.towerBase[i]!);
          b.lids?.setColorAt(i, faded ? b.pal.dim : b.towerBase[i]!.clone().lerp(b.pal.card, 0.35));
        });
        b.towers.instanceColor!.needsUpdate = true;
        if (b.lids) b.lids.instanceColor!.needsUpdate = true;
      }
      const hot = hoverRef.current.zone ?? hz ?? null;
      for (const s of b.slabs) {
        const z = s.userData.zone as string;
        const base = b.slabBase.get(z)!;
        s.material.color.copy(z === hot ? base.clone().lerp(b.zoneColor.get(z)!, 0.35) : base);
      }
      // arcos hacia los vecinos del foco
      disposeTree(w.focus);
      w.focus.clear();
      const top = (id: string): THREE.Vector3 | null => {
        const i = g.towerIndex.get(id);
        if (i !== undefined) {
          const t = g.towers[i]!;
          return new THREE.Vector3(t.x, t.y + t.h, t.z);
        }
        const o = g.outer.find((p) => p.id === id);
        return o ? new THREE.Vector3(o.x, 5, o.y) : null;
      };
      if (focusId) {
        const from = top(focusId);
        if (from) {
          const mat = new THREE.MeshStandardMaterial({ color: b.pal.orange, roughness: 0.4, emissive: b.pal.orange, emissiveIntensity: 0.2 });
          const targets = focusIsOuter ? g.towers.filter((t) => oo(t.id) === focusId).map((t) => t.id) : [...lit].filter((id) => id !== focusId);
          for (const id of targets.slice(0, 60)) {
            const to = top(id);
            if (!to) continue;
            const mid = from.clone().add(to).multiplyScalar(0.5);
            mid.x *= 0.7;
            mid.z *= 0.7;
            mid.y = Math.max(from.y, to.y) + 30 + from.distanceTo(to) * 0.22;
            const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(from, mid, to), 48, 0.9, 6, false), mat);
            tube.castShadow = true;
            w.focus.add(tube);
          }
          // anillo en la base de lo seleccionado
          if (sel && sel === focusId && g.towerIndex.has(sel)) {
            const t = g.towers[g.towerIndex.get(sel)!]!;
            const ring = new THREE.Mesh(new THREE.TorusGeometry(TOWER_W, 0.9, 8, 48), mat);
            ring.rotation.x = Math.PI / 2;
            ring.position.set(t.x, t.y + 0.6, t.z);
            w.focus.add(ring);
          }
        }
      }
      // rótulos de zona: el foco apaga los ajenos
      for (const s of l.sectors) {
        const el = labels.current.get(`z:${s.id}`);
        if (el) el.style.opacity = hot && hot !== s.id ? '0.45' : sel ? '0.6' : '1';
      }
    }, []);

    useEffect(() => {
      refocus();
    }, [selectedId, dimmed, hotZone, refocus]);

    // ---------------------------------------------------------------- pulsos

    const pulse = useCallback((id: string): boolean => {
      const w = world.current;
      const b = built.current;
      const { geo: g, layout: l } = latest.current;
      const i = g.towerIndex.get(id);
      if (!w || !b || i === undefined || !pathToRoot(l, id).length) return false;
      flashes.current.set(id, performance.now());
      const t = g.towers[i]!;
      const start = new THREE.Vector3(t.x, t.y + t.h, t.z);
      const coreTop = new THREE.Vector3(0, HOLO_Y, 0);
      const cable = t.zone ? b.cables.get(t.zone) : undefined;
      const pts = cable ? [start, cable.getPoint(0).setY(t.y + 4), ...cable.getPoints(8).slice(1), coreTop] : [start, new THREE.Vector3(t.x * 0.5, t.y + t.h + 40, t.z * 0.5), coreTop];
      if (packets.current.length < 24) {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(3.4, 16, 12), new THREE.MeshStandardMaterial({ color: b.pal.orange, emissive: b.pal.orange, emissiveIntensity: 0.6 }));
        mesh.castShadow = true;
        w.packets.add(mesh);
        packets.current.push({ mesh, curve: new THREE.CatmullRomCurve3(pts), t0: performance.now(), dur: 1900 });
      }
      return true;
    }, []);

    useImperativeHandle(ref, () => ({ pulse, fit }), [pulse, fit]);

    // ---------------------------------------------------------------- bucle

    useEffect(() => {
      let raf = 0;
      let last = performance.now();
      const dummy = new THREE.Object3D();
      const v = new THREE.Vector3();
      const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        const w = world.current;
        const b = built.current;
        if (!w || !b || document.hidden || !size.current.w) {
          last = now;
          return;
        }
        const dt = Math.min(64, now - last);
        last = now;
        const { geo: g, reducedMotion: rm } = latest.current;
        const c = cam.current;
        const g0 = goal.current;
        if (!rm && !drag.current) g0.yaw += dt * 0.00004;
        const k = rm ? 1 : 1 - Math.pow(0.003, dt / 1000);
        c.yaw += (g0.yaw - c.yaw) * k;
        c.pitch += (g0.pitch - c.pitch) * k;
        c.dist += (g0.dist - c.dist) * k;
        c.target.lerp(g0.target, k);
        w.camera.position.set(Math.cos(c.pitch) * Math.sin(c.yaw), Math.sin(c.pitch), Math.cos(c.pitch) * Math.cos(c.yaw)).multiplyScalar(c.dist).add(c.target);
        w.camera.lookAt(c.target);
        if (!rm) {
          const sec = now / 1000;
          for (const m of b.flow) m.uniforms.uTime!.value = sec;
          // holograma: cada capa gira a su ritmo, las líneas titilan y el núcleo late
          const beat = 0.5 + 0.5 * Math.sin(sec * 2.1);
          b.glow.emissiveIntensity = b.pal.glow * (1 + 0.5 * beat);
          b.light.intensity = latest.current.geo.disc * b.pal.glow * (0.4 + 0.2 * beat);
          const h = b.holo;
          h.shell.rotation.y += dt * 0.00016;
          h.shell.rotation.x = Math.sin(sec * 0.13) * 0.25;
          h.dials.forEach((d) => {
            d.rotation.z += dt * 0.001 * (d.userData.spin as number);
          });
          h.traces.rotation.y -= dt * 0.00022;
          h.traces.rotation.z = Math.sin(sec * 0.21) * 0.3;
          h.nucleus.rotation.y += dt * 0.0012;
          h.nucleus.scale.setScalar(0.9 + 0.2 * beat);
          h.halo.material.opacity = (b.pal.dark ? 0.6 : 0.35) + 0.25 * beat;
          h.mats.forEach((m, i) => {
            m.opacity = (m.userData.base as number) * (0.72 + 0.28 * Math.sin(sec * (1.3 + (i % 7) * 0.37) + i));
          });
          // onda del piso: sale del núcleo cada 5 s y se apaga al llegar al horizonte
          const f = (sec % 5) / 5;
          const r = CORE.plinthR + f * (b.floorR - CORE.plinthR);
          b.ripple.scale.set(r, 1, r);
          b.ripple.material.opacity = 0.55 * (1 - f) * (1 - f);
        }

        // destellos: la torre crece un poco y se tiñe de naranja
        if (flashes.current.size && b.towers) {
          flashes.current.forEach((t0, id) => {
            const i = g.towerIndex.get(id);
            if (i === undefined) return void flashes.current.delete(id);
            const t = g.towers[i]!;
            const f = Math.min(1, (now - t0) / 1300);
            const s = Math.sin(Math.PI * f);
            dummy.position.set(t.x, t.y, t.z);
            dummy.rotation.set(0, -t.angle, 0);
            dummy.scale.set(1, t.h * (1 + 0.3 * s), 1);
            dummy.updateMatrix();
            b.towers!.setMatrixAt(i, dummy.matrix);
            if (b.lids) {
              dummy.position.set(t.x, t.y + t.h * (1 + 0.3 * s), t.z);
              dummy.scale.set(1, 1, 1);
              dummy.updateMatrix();
              b.lids.setMatrixAt(i, dummy.matrix);
              b.lids.instanceMatrix.needsUpdate = true;
            }
            if (f < 1) b.towers!.setColorAt(i, b.towerBase[i]!.clone().lerp(b.pal.orange, s));
            else {
              // Al terminar, `refocus` devuelve el color que toca según el foco y el filtro.
              flashes.current.delete(id);
              refocus();
            }
          });
          b.towers.instanceMatrix.needsUpdate = true;
          b.towers.instanceColor!.needsUpdate = true;
        }
        packets.current = packets.current.filter((p) => {
          const f = (now - p.t0) / p.dur;
          if (f >= 1) {
            w.packets.remove(p.mesh);
            disposeTree(p.mesh);
            return false;
          }
          p.mesh.position.copy(p.curve.getPoint(f));
          return true;
        });

        w.renderer.render(w.scene, w.camera);

        // rótulos HTML sobre la escena
        const { w: W, h: H } = size.current;
        const place = (key: string, p: THREE.Vector3, dx = '-50%', dy = '-50%') => {
          const el = labels.current.get(key);
          if (!el) return;
          v.copy(p).project(w.camera);
          const hidden = v.z > 1 || v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2;
          el.style.visibility = hidden ? 'hidden' : 'visible';
          if (!hidden) el.style.transform = `translate(${((v.x + 1) / 2) * W}px, ${((1 - v.y) / 2) * H}px) translate(${dx}, ${dy})`;
        };
        for (const s of latest.current.layout.sectors) place(`z:${s.id}`, polar(s.rOut + 24, s.mid, 1));
        place('center', new THREE.Vector3(0, CORE_TOP + 10, 0), '-50%', '-100%');
        for (const p of g.outer) place(`o:${p.id}`, new THREE.Vector3(p.x * 1.06, 2, p.y * 1.06));
        if (latest.current.layout.labelled) for (const t of g.towers) place(`e:${t.id}`, new THREE.Vector3(t.x, t.y + t.h + 6, t.z), '-50%', '-100%');

        // ficha del nodo bajo el cursor
        const card = cardRef.current;
        const hid = hoverRef.current.id;
        if (card && hid) {
          const i = g.towerIndex.get(hid);
          const t = i !== undefined ? g.towers[i] : undefined;
          const o = t ? null : g.outer.find((p) => p.id === hid);
          const at = t ? v.set(t.x, t.y + t.h, t.z) : o ? v.set(o.x, 5, o.y) : null;
          if (at) {
            at.project(w.camera);
            const sx = ((at.x + 1) / 2) * W;
            const sy = ((1 - at.y) / 2) * H;
            const cw = card.offsetWidth;
            const ch = card.offsetHeight;
            const left = sx + 18 + cw > W - 8 ? sx - 18 - cw : sx + 18;
            card.style.transform = `translate(${Math.max(8, left)}px, ${Math.min(Math.max(8, sy - ch / 2), H - ch - 8)}px)`;
          }
        }
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [refocus]);

    // ---------------------------------------------------------------- puntero

    const ray = useMemo(() => new THREE.Raycaster(), []);
    const pick = useCallback(
      (sx: number, sy: number): { id: string | null; zone: string | null; core: boolean } => {
        const w = world.current;
        const b = built.current;
        const none = { id: null, zone: null, core: false };
        if (!w || !b) return none;
        const { w: W, h: H } = size.current;
        ray.setFromCamera(new THREE.Vector2((sx / W) * 2 - 1, -(sy / H) * 2 + 1), w.camera);
        const targets: THREE.Object3D[] = [...b.coreParts, ...b.slabs];
        if (b.towers) targets.push(b.towers);
        if (b.outer) targets.push(b.outer);
        const hit = ray.intersectObjects(targets, false)[0];
        if (!hit) return none;
        if (hit.object === b.towers && hit.instanceId !== undefined) return { id: latest.current.geo.towers[hit.instanceId]!.id, zone: null, core: false };
        if (hit.object === b.outer && hit.instanceId !== undefined) return { id: b.outerIds[hit.instanceId]!, zone: null, core: false };
        if (b.coreParts.includes(hit.object as THREE.Mesh)) return { id: null, zone: null, core: true };
        return { id: null, zone: (hit.object.userData.zone as string) ?? null, core: false };
      },
      [ray],
    );

    const local = (e: { clientX: number; clientY: number }) => {
      const r = wrapRef.current!.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const setHot = (h: { id: string | null; zone: string | null; core: boolean }) => {
      const prev = hoverRef.current;
      if (canvasRef.current) canvasRef.current.style.cursor = h.id || h.zone || (h.core && latest.current.center.canGoUp) ? 'pointer' : 'grab';
      if (prev.id === h.id && prev.zone === h.zone) return;
      hoverRef.current = { id: h.id, zone: h.zone };
      setHover(h.id);
      refocus();
    };

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType === 'mouse' && e.button > 2) return;
      drag.current = { x: e.clientX, y: e.clientY, moved: false, pan: e.button !== 0 || e.shiftKey };
    };
    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const d = drag.current;
      if (!d) {
        const p = local(e);
        setHot(pick(p.x, p.y));
        return;
      }
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < 5) return;
        d.moved = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        setHot({ id: null, zone: null, core: false });
        e.currentTarget.style.cursor = 'grabbing';
      }
      const g0 = goal.current;
      if (d.pan) {
        // Desplaza el punto de mira sobre el suelo, en el plano de la cámara.
        const s = g0.dist / (size.current.h || 1);
        const right = new THREE.Vector3(Math.cos(g0.yaw), 0, -Math.sin(g0.yaw));
        const fwd = new THREE.Vector3(-Math.sin(g0.yaw), 0, -Math.cos(g0.yaw));
        g0.target.addScaledVector(right, -dx * s * 0.55).addScaledVector(fwd, dy * s * 0.55);
      } else {
        g0.yaw -= dx * 0.005;
        g0.pitch = Math.min(1.35, Math.max(0.2, g0.pitch + dy * 0.004));
      }
      d.x = e.clientX;
      d.y = e.clientY;
    };
    const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const d = drag.current;
      drag.current = null;
      e.currentTarget.style.cursor = 'grab';
      if (!d || d.moved) return;
      const p = local(e);
      const hit = pick(p.x, p.y);
      if (hit.id) {
        if (latest.current.geo.towerIndex.has(hit.id)) onSelect(hit.id);
        else onOpenOuter(hit.id);
      } else if (hit.core) {
        if (latest.current.center.canGoUp) onUp();
      } else if (hit.zone && !latest.current.geo.single) onOpenZone(hit.zone);
    };

    const zoomBy = useCallback((factor: number) => {
      const g0 = goal.current;
      g0.dist = Math.min(fitDist.current * 2.5, Math.max(fitDist.current * 0.2, g0.dist * factor));
    }, []);
    useEffect(() => {
      const el = canvasRef.current;
      if (!el) return;
      // `wheel` de React es pasivo: para frenar el scroll de la página hay que registrarlo a mano.
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        zoomBy(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0012)));
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return () => el.removeEventListener('wheel', onWheel);
    }, [zoomBy]);

    const hovered = hover ? nodes.get(hover) : undefined;
    const setLabel = (key: string) => (el: HTMLElement | null) => {
      if (el) labels.current.set(key, el);
      else labels.current.delete(key);
    };

    if (failed) {
      return (
        <div className={cn('zeus-stage-maqueta grid place-items-center bg-background p-6 text-center text-sm text-muted-foreground', className)}>
          Este navegador no tiene WebGL activo. Cambia a la vista isométrica o plana.
        </div>
      );
    }

    return (
      <div ref={wrapRef} className={cn('zeus-stage-maqueta relative select-none overflow-hidden bg-background text-foreground', className)}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Mapa de zeus como maqueta 3D: cada zona es una losa y cada entrada una torre. La lista lateral contiene las mismas zonas y entradas."
          className="absolute inset-0 block size-full touch-none"
          style={{ cursor: 'grab' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onPointerLeave={() => {
            if (!drag.current) setHot({ id: null, zone: null, core: false });
          }}
          onContextMenu={(e) => e.preventDefault()}
        />

        {/* Rótulos: los coloca el bucle sin pasar por React. */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {layout.sectors.length > 1 &&
            layout.sectors.map((s) => {
              const info = zones.get(s.id);
              return (
                <button
                  key={s.id}
                  ref={setLabel(`z:${s.id}`)}
                  type="button"
                  onClick={() => onOpenZone(s.id)}
                  className="zeus-mq-label pointer-events-auto absolute left-0 top-0 flex items-center gap-1.5 whitespace-nowrap rounded-[5px] px-1.5 py-0.5 text-[11px] font-semibold transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className={cn('size-[7px] rounded-[2px]', info?.tone.dot ?? 'bg-faint')} />
                  <span className="max-w-[140px] truncate">{info?.label ?? s.id}</span>
                  <span className="font-medium tabular-nums text-muted-foreground">{s.count}</span>
                </button>
              );
            })}
          <button
            ref={setLabel('center')}
            type="button"
            disabled={!center.canGoUp}
            onClick={onUp}
            className="zeus-mq-core pointer-events-auto absolute left-0 top-0 flex items-center gap-1.5 whitespace-nowrap rounded-[5px] px-1.5 py-0.5 text-[11px] font-semibold tracking-[0.06em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
          >
            <span className="max-w-[160px] truncate">{center.label}</span>
            <span className="font-medium tabular-nums opacity-65">{center.caption}</span>
          </button>
          {geo.outer.map((p) => (
            <button
              key={p.id}
              ref={setLabel(`o:${p.id}`)}
              type="button"
              onClick={() => onOpenOuter(p.id)}
              className="pointer-events-auto absolute left-0 top-0 max-w-[140px] truncate whitespace-nowrap text-[10.5px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {nodes.get(p.id)?.title ?? p.id}
            </button>
          ))}
          {layout.labelled &&
            geo.towers.map((t) => (
              <span key={t.id} ref={setLabel(`e:${t.id}`)} className="absolute left-0 top-0 max-w-[150px] truncate whitespace-nowrap text-[10px] font-medium text-foreground/80">
                {nodes.get(t.id)?.title ?? ''}
              </span>
            ))}
        </div>

        {/* Ficha flotante del nodo bajo el cursor. La coloca el bucle. */}
        <div
          ref={cardRef}
          className={cn('zeus-glass pointer-events-none absolute left-0 top-0 z-10 w-[250px] rounded-lg p-3 transition-opacity duration-150', hovered ? 'opacity-100' : 'opacity-0')}
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
              {hovered.summary && <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{hovered.summary}</p>}
              {hovered.projectId && projectNames.has(hovered.projectId) && hovered.kind !== 'project' && <p className="text-[11px] text-faint">{projectNames.get(hovered.projectId)}</p>}
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
          {(
            [
              ['Alejar', ZoomOut, () => zoomBy(1.3)],
              ['Vista inicial', Maximize2, fit],
              ['Acercar', ZoomIn, () => zoomBy(1 / 1.3)],
            ] as const
          ).map(([label, Icon, fn]) => (
            <button key={label} type="button" onClick={fn} aria-label={label} title={label} className="grid size-7 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Icon className="size-3.5" />
            </button>
          ))}
        </div>
      </div>
    );
  }),
);

export default MaquetteCanvas;
