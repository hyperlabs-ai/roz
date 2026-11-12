import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, LayoutDashboard, Monitor, Moon, Sun } from 'lucide-react';
import { RozLogo, ROZ_MONOGRAM_PATH } from '@/components/RozLogo';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Eyebrow, GithubAvatar, IntegrationIcon, CapsLabel, tokenColor, type BrandColor, type IntegrationName } from '@/components/brand';
import { useTheme } from '@/components/theme';
import { FlowDiagram } from '@/components/landing/FlowDiagram';
import { cn } from '@/lib/utils';

/*
 * Landing pública de roz (open source, self-host). Sigue el mock "plano de control" sección por
 * sección: hero con el pipeline sobre bloque amarillo, cuadrícula de integraciones, tarjetas grises
 * numeradas 001–006, bloque salmón (visibilidad), bloque morado (agentes), carriles del flujo, bloque
 * oscuro (seguridad), módulos y las fases de self-host sobre amarillo.
 *
 * Color por significado: naranja = roz/marca, morado = agentes/LLM, amarillo = humano/juntas,
 * verde = ok/CTA, rojo = error. Todo sale de tokens (también dentro de los SVG: `fill-orange`…).
 * En oscuro los bloques de color pasan a su tinte profundo (`dark:bg-yellow-soft`…) para que el
 * texto conserve contraste sin invertir la página.
 */

const REPO = 'https://github.com/hyperlabs-ai/roz';
const DOCS = `${REPO}#self-hosting`;
const GH_SETUP = `${REPO}/blob/main/docs/GITHUB-SETUP.md`;
const ARCH = `${REPO}/blob/main/ARCHITECTURE.md`;
const SECURITY = `${REPO}/blob/main/SECURITY.md`;
const RUNNER = `${REPO}/tree/main/runner`;
const SUPPORT_EMAIL = 'manuel@hyperlabs.vc';

/** Íconos de integraciones para usar dentro de un SVG (`<image href>`): misma regla que IntegrationIcon. */
const DARK_VARIANT = new Set<IntegrationName>(['github', 'anthropic', 'vercel', 'railway', 'resend', 'orwel', 'hyperops']);
function useIconSrc() {
  const { resolved } = useTheme();
  return (name: IntegrationName) => {
    const file = DARK_VARIANT.has(name) && resolved === 'dark' ? `${name}-light` : name;
    return `/integrations/${file}.${name === 'granola' ? 'png' : 'svg'}`;
  };
}

/* ── Movimiento: solo revelado al hacer scroll y el pulso de la línea de agente ─────────────── */
function LandingStyles() {
  return (
    <style>{`
      html { scroll-padding-top: 84px; }
      @media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
      /* La duración (.7s) y la distancia (20px) del revelado no corresponden a ningún uso de la
         escala de transitions.dev; solo la curva se tokeniza. */
      [data-reveal] { opacity: 0; transform: translateY(20px); transition: opacity .7s var(--ease-smooth-out), transform .7s var(--ease-smooth-out); }
      [data-reveal].is-visible { opacity: 1; transform: none; }
      @keyframes lpPulse { 50% { opacity: .25; } }
      .lp-pulse { animation: lpPulse 1.6s ease-in-out infinite; }
      @keyframes lpDash { to { stroke-dashoffset: -36; } }
      .lp-dash { stroke-dasharray: 6 4; animation: lpDash 1.4s linear infinite; }
      @keyframes lpFlow { to { stroke-dashoffset: -64; } }
      .lp-flow { stroke-dasharray: 4 28; stroke-linecap: round; animation: lpFlow 2.4s linear infinite; }
      @media (prefers-reduced-motion: reduce) {
        [data-reveal] { opacity: 1 !important; transform: none !important; transition: none !important; }
        .lp-pulse, .lp-dash, .lp-flow { animation: none !important; }
        .lp-flow, .lp-travel { display: none; }
      }
    `}</style>
  );
}

/* ── Piezas chicas ────────────────────────────────────────────────────────────────────────── */

/** Contenedor de página: 1200px, gutter de 16px como el mock. */
function Wrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-[1200px] px-4 sm:px-6', className)}>{children}</div>;
}

/** Tarjeta blanca flotante del mock (`.widget`): sobre paneles grises y bloques de color. */
function Widget({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid min-w-0 content-start gap-2.5 rounded-lg bg-card p-4 text-foreground shadow-md', className)}>{children}</div>;
}

/** Fila "etiqueta ↔ chip" de los widgets. */
function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center justify-between gap-2 text-[13px]', className)}>{children}</div>;
}

/** Etiqueta del mock (`.tag`): `label-caps` sobre lavanda, o sobre tarjeta en los bloques. */
function Tag({ children, tone = 'llm' }: { children: ReactNode; tone?: 'llm' | 'card' | 'dark' }) {
  return (
    <span
      className={cn(
        'inline-block w-fit rounded-[3px] px-[7px] py-[3px] label-caps',
        tone === 'llm' && 'bg-lavender text-purple-deep',
        tone === 'card' && 'bg-card text-foreground',
        tone === 'dark' && 'border border-ink-foreground/20 bg-ink-foreground/10 dark:border-border dark:bg-panel',
      )}
    >
      {children}
    </span>
  );
}

/** Casilla del mock (`.check`): verde marcada o vacía. */
function CheckItem({ on = true, children }: { on?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 py-1 text-sm">
      <span
        className={cn(
          'grid size-[18px] shrink-0 place-items-center rounded-[4px]',
          on ? 'bg-green text-white' : 'border-[1.5px] border-toggle-off bg-card',
        )}
      >
        {on && <Check className="size-3" strokeWidth={3} />}
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** Línea de agente trabajando (`.agentline`): lavanda con punto que late. */
function AgentLine({ tone = 'llm', children }: { tone?: 'llm' | 'ok' | 'idle'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-[5px] text-xs',
        tone === 'llm' && 'bg-lavender text-purple-deep',
        tone === 'ok' && 'bg-green-soft text-green',
        tone === 'idle' && 'bg-panel text-muted-foreground',
      )}
    >
      <span className={cn('size-2 shrink-0 rounded-full bg-current', tone !== 'idle' && 'lp-pulse')} />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** Escala única de título y párrafo de sección: la usan también los bloques de color. */
const H2 = 'max-w-[20ch] text-[clamp(28px,3.6vw,44px)] leading-[1.06] tracking-[-0.04em]';
const LEDE = 'max-w-[52ch] text-base sm:text-[17px]';

/** Encabezado de sección centrado o a la izquierda (eyebrow + título grande + lede). */
function SectionTitle({
  eyebrow,
  color,
  title,
  lede,
  center,
}: {
  eyebrow: string;
  color?: BrandColor;
  title: ReactNode;
  lede?: ReactNode;
  center?: boolean;
}) {
  return (
    <div data-reveal className={cn('grid gap-3.5', center && 'justify-items-center text-center')}>
      <Eyebrow color={color}>{eyebrow}</Eyebrow>
      <h2 className={H2}>{title}</h2>
      {lede && <p className={cn(LEDE, 'text-muted-foreground')}>{lede}</p>}
    </div>
  );
}

/** Mini avatar de iniciales (`.mini-av`) para filas densas de ejemplo. */
function MiniAv({ name, color }: { name: string; color: 'orange' | 'purple-deep' | 'green' }) {
  return <GithubAvatar name={name} color={color} className="size-[18px] text-[8px] [&_span]:text-[8px]" />;
}

/* ── Header ───────────────────────────────────────────────────────────────────────────────── */

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
  const Ico = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Cambiar tema" onClick={() => setTheme(next)}>
      <Ico className="size-[18px]" />
    </Button>
  );
}

const NAV = [
  { href: '#plataforma', label: 'Plataforma' },
  { href: '#visibilidad', label: 'Visibilidad' },
  { href: '#agentes', label: 'Agentes' },
  { href: '#flujo', label: 'Flujo' },
  { href: '#self-host', label: 'Self-host' },
];

function Header() {
  return (
    <header className="sticky top-0 z-40 border-b bg-card/90 backdrop-blur-md">
      <Wrap className="flex h-16 items-center gap-7">
        <a href="#inicio" aria-label="roz" className="shrink-0">
          <RozLogo wordmark className="size-[26px]" />
        </a>
        <nav aria-label="Secciones" className="hidden items-center gap-[22px] text-[14.5px] lg:flex">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} className="transition-colors hover:text-orange">
              {n.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <Button asChild variant="secondary" className="hidden sm:inline-flex">
            <Link to="/app">
              <LayoutDashboard /> Dashboard
            </Link>
          </Button>
          <Button asChild>
            <a href={REPO} target="_blank" rel="noreferrer">
              Ver en GitHub
            </a>
          </Button>
        </div>
      </Wrap>
    </header>
  );
}

/* ── Hero ─────────────────────────────────────────────────────────────────────────────────── */

function HeroArt() {
  const icon = useIconSrc();
  const src = [
    { y: 44, t: 'Juntas', s: 'Granola o manual', ic: 'granola' as const },
    { y: 178, t: 'Apps', s: 'POST /v1/intake', ic: null },
    { y: 312, t: 'Producción', s: 'errores y caídas', ic: 'vercel' as const },
  ];
  return (
    <svg viewBox="0 28 640 384" role="img" className="block h-auto w-full" aria-label="Juntas, apps y producción entran a roz, que arma el issue y lo manda a Linear y al agente del dev">
      <defs>
        <filter id="lp-sh" x="-20%" y="-20%" width="140%" height="160%">
          <feDropShadow dx="0" dy="6" stdDeviation="8" style={{ floodColor: tokenColor('scrim'), floodOpacity: 0.14 }} />
        </filter>
        <marker id="lp-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" className="fill-foreground" />
        </marker>
      </defs>
      {/* conectores: base fija + trazo que viaja */}
      {['M168 86 H204 V200 H232', 'M168 220 H232', 'M168 354 H204 V240 H232'].map((d) => (
        <g key={d} className="fill-none" strokeWidth={1.8}>
          <path d={d} className="stroke-foreground/40" />
          <path d={d} className="lp-flow stroke-foreground" />
        </g>
      ))}
      <g className="fill-none stroke-foreground" strokeWidth={1.8}>
        <path d="M408 204 H436 V110 H466" markerEnd="url(#lp-ah)" />
        <path d="M408 236 H436 V330 H466" markerEnd="url(#lp-ah)" />
      </g>
      {/* fuentes */}
      {src.map((n) => (
        <g key={n.t}>
          <rect x="12" y={n.y} width="156" height="84" rx="10" filter="url(#lp-sh)" className="fill-card" />
          {n.ic ? (
            <>
              <rect x="26" y={n.y + 14} width="32" height="32" rx="8" className="fill-card stroke-border" />
              <image href={icon(n.ic)} x="32" y={n.y + 20} width="20" height="20" />
            </>
          ) : (
            <>
              <rect x="26" y={n.y + 14} width="32" height="32" rx="8" className="fill-blue" />
              <text x="42" y={n.y + 35} fontSize="12" fontWeight="700" textAnchor="middle" className="fill-white font-mono">{'{}'}</text>
            </>
          )}
          <text x="26" y={n.y + 62} fontSize="15" fontWeight="600" className="fill-foreground">{n.t}</text>
          <text x="26" y={n.y + 77} fontSize="12" className="fill-muted-foreground">{n.s}</text>
        </g>
      ))}
      <circle cx="58" cy="326" r="5.5" className="lp-pulse fill-red" />
      {/* roz */}
      <g filter="url(#lp-sh)">
        <rect x="232" y="150" width="176" height="140" rx="14" className="fill-orange" />
      </g>
      <rect x="248" y="166" width="42" height="42" rx="9" className="fill-white" />
      <path d={ROZ_MONOGRAM_PATH} transform="translate(248 166) scale(0.875)" className="fill-none stroke-orange" strokeWidth={4.6} strokeLinecap="round" strokeLinejoin="round" />
      <text x="300" y="193" fontSize="17" fontWeight="600" className="fill-white">roz</text>
      <text x="248" y="232" fontSize="15" fontWeight="600" className="fill-white">Arma el issue</text>
      {['reglas', 'LLM', 'riesgo'].map((t, i) => (
        <g key={t}>
          <rect x={248 + i * 50} y="246" width="46" height="24" rx="12" className="fill-white/20" />
          <text x={271 + i * 50} y="262" fontSize="11" fontWeight="600" textAnchor="middle" className="fill-white">{t}</text>
        </g>
      ))}
      {/* destinos */}
      <g filter="url(#lp-sh)" className="fill-card">
        <rect x="468" y="56" width="160" height="108" rx="10" />
        <rect x="468" y="276" width="160" height="108" rx="10" />
      </g>
      <image href={icon('linear')} x="482" y="70" width="26" height="26" />
      <text x="518" y="82" fontSize="15" fontWeight="600" className="fill-foreground">Linear</text>
      <text x="518" y="97" fontSize="12" className="fill-muted-foreground">entra a Triage</text>
      <rect x="482" y="118" width="132" height="30" rx="6" className="fill-green-soft" />
      <text x="494" y="137" fontSize="12" className="fill-green font-mono">WAT-44</text>
      <text x="602" y="137" fontSize="12" fontWeight="600" textAnchor="end" className="fill-green">riesgo 0</text>
      <image href={icon('claude')} x="482" y="290" width="26" height="26" />
      <text x="518" y="302" fontSize="15" fontWeight="600" className="fill-foreground">Agente</text>
      <text x="518" y="317" fontSize="12" className="fill-muted-foreground">en la PC del dev</text>
      <rect x="482" y="338" width="132" height="30" rx="6" className="fill-lavender" />
      <circle cx="497" cy="353" r="4" className="lp-pulse fill-purple-deep" />
      <text x="508" y="357" fontSize="12" fontWeight="600" className="fill-purple-deep">implementando</text>
    </svg>
  );
}

function Hero() {
  return (
    <section className="pb-10 pt-10 sm:pb-12 sm:pt-16">
      <Wrap className="grid items-center gap-10 lg:grid-cols-2 lg:gap-14">
        <div data-reveal className="grid content-start gap-6">
          <Eyebrow>Open source · MIT · self-host</Eyebrow>
          <h1 className="max-w-[13ch] text-[clamp(38px,5vw,64px)] leading-[1.02] tracking-[-0.045em]">El plano de control de tu equipo de desarrollo</h1>
          <p className={cn(LEDE, 'max-w-[46ch] text-muted-foreground')}>
            roz convierte juntas, apps y errores de producción en issues bien armados, los manda al agente de cada dev y
            muestra el avance en vivo. Corre en tu Vercel y tu Supabase.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="lg">
              <a href={REPO} target="_blank" rel="noreferrer">Self-host en GitHub</a>
            </Button>
            <Button asChild size="lg" variant="secondary">
              <a href="#flujo">Ver el flujo completo</a>
            </Button>
          </div>
        </div>
        <div data-reveal style={{ transitionDelay: '.12s' }} className="relative overflow-hidden rounded-2xl bg-yellow p-4 dark:bg-yellow-soft sm:p-6">
          <HeroArt />
        </div>
      </Wrap>
    </section>
  );
}

/* ── Integraciones ────────────────────────────────────────────────────────────────────────── */

const LOGOS: { name: IntegrationName; label: string; sub: string }[] = [
  { name: 'linear', label: 'Linear', sub: 'tareas' },
  { name: 'granola', label: 'Granola', sub: 'juntas' },
  { name: 'github', label: 'GitHub', sub: 'código' },
  { name: 'claude', label: 'Claude', sub: 'agentes' },
  { name: 'vercel', label: 'Vercel', sub: 'prod + crons' },
  { name: 'railway', label: 'Railway', sub: 'servicios' },
  { name: 'supabase', label: 'Supabase', sub: 'datos' },
  { name: 'posthog', label: 'PostHog', sub: 'uso real' },
  { name: 'orwel', label: 'Orwel', sub: 'leads' },
  { name: 'googlecalendar', label: 'Calendar', sub: 'presencia' },
  { name: 'hyperops', label: 'HyperOps', sub: 'proyectos' },
  { name: 'resend', label: 'Resend', sub: 'avisos' },
];

const FACTS: { n: string; label: string; sub: string }[] = [
  { n: '3', label: 'fuentes de trabajo', sub: 'Juntas, apps y producción' },
  { n: '1', label: 'agente por dev', sub: 'Corre en su propia PC' },
  { n: '0', label: 'tareas capturadas a mano', sub: 'Todo llega armado y con evidencia' },
];

function Logos() {
  return (
    <Wrap>
      <div data-reveal className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3 lg:grid-cols-6">
        {FACTS.map((f) => (
          <div key={f.label} className="col-span-2 flex items-center gap-4 bg-panel px-5 py-5 sm:col-span-1 sm:flex-col sm:items-start sm:gap-2 lg:col-span-2 lg:flex-row lg:items-center lg:gap-4 lg:px-7">
            <b className="w-[1ch] shrink-0 text-[44px] font-semibold leading-none tabular-nums tracking-[-0.04em] text-orange">{f.n}</b>
            <span className="grid gap-0.5">
              <span className="label-caps text-foreground">{f.label}</span>
              <span className="text-[13.5px] text-muted-foreground">{f.sub}</span>
            </span>
          </div>
        ))}
        {LOGOS.map((l) => (
          <div key={l.name} className="flex items-center gap-3 bg-card px-4 py-5 lg:px-5">
            <IntegrationIcon name={l.name} framed />
            <span className="grid min-w-0 gap-0.5 leading-tight">
              <span className="text-[15px] font-semibold tracking-[-0.02em]">{l.label}</span>
              <small className="label-caps text-faint">{l.sub}</small>
            </span>
          </div>
        ))}
      </div>
    </Wrap>
  );
}

/* ── Plataforma: tarjetas grises numeradas 001–006 ──────────────────────────────────────────── */

/**
 * Paso de la plataforma. UNA estructura para los seis: número + título + una frase arriba, y la demo
 * abajo con alto fijo, así títulos y demos alinean entre columnas sea cual sea el largo del texto.
 */
function Step({ n, title, children, widget }: { n: number; title: string; children: ReactNode; widget: ReactNode }) {
  return (
    <div data-reveal className="flex min-w-0 flex-col gap-5 rounded-xl bg-panel p-5 sm:p-6">
      <div className="grid flex-1 content-start gap-2">
        <span className="text-[13px] font-semibold tabular-nums tracking-[0.06em] text-orange">{String(n).padStart(2, '0')}</span>
        <h3 className="text-[21px] leading-[1.15] tracking-[-0.03em]">{title}</h3>
        <p className="text-[14.5px] text-muted-foreground">{children}</p>
      </div>
      <div className="grid min-h-[236px] [&>*]:h-full">{widget}</div>
    </div>
  );
}

function ManualSessionWidget() {
  const [done, setDone] = useState(false);
  const lines: [string, string][] = [
    ['Ana', 'El cliente quiere ver el estatus del envío en el correo.'],
    ['Cliente', 'Y que el cupón de bienvenida no se acumule.'],
    ['Luis', 'Lo del cupón es un bug, ya lo vimos ayer.'],
  ];
  return (
    <Widget className="content-between gap-3">
      <Row>
        <b className="text-[13px]">Seguimiento con el cliente</b>
        <span className="rounded-[3px] bg-yellow-soft px-1.5 py-px label-caps text-yellow-ink">manual</span>
      </Row>
      <div className="grid gap-1.5 rounded-md border bg-sidebar p-2.5 text-[12.5px] leading-snug">
        {lines.map(([who, t]) => (
          <p key={who}>
            <b className="font-semibold">{who}:</b> <span className="text-muted-foreground">{t}</span>
          </p>
        ))}
      </div>
      <Row>
        {done ? (
          <span className="flex flex-wrap gap-1.5 animate-fade-in-up">
            <Badge variant="llm" dot>2 candidatas</Badge>
            <Badge variant="warn" dot>1 duplicado</Badge>
          </span>
        ) : (
          <span className="text-xs text-faint">.txt · .vtt · .docx</span>
        )}
        <Button type="button" variant="dark" size="sm" onClick={() => setDone(true)}>
          Extraer tareas
        </Button>
      </Row>
    </Widget>
  );
}

function AnatomyWidget() {
  const rows: [string, ReactNode][] = [
    ['Proyecto y repos', <Badge key="a" variant="rule">regla</Badge>],
    ['Tipo y título', <Badge key="b" variant="llm">LLM</Badge>],
    ['Prioridad', <Badge key="c" variant="rule">regla + LLM</Badge>],
    ['Criterio de aceptación', <Badge key="d" variant="llm">LLM</Badge>],
    ['Cita de evidencia', <Badge key="e" variant="rule">verificada</Badge>],
    ['Aceptar', <Badge key="g" variant="human">humano</Badge>],
  ];
  return (
    <Widget className="content-between gap-1.5">
      <Row>
        <b>Anatomía del issue</b>
        <span className="text-xs text-faint">quién decide</span>
      </Row>
      {rows.map(([l, chip]) => (
        <Row key={l} className="flex-nowrap">
          <span>{l}</span>
          {chip}
        </Row>
      ))}
    </Widget>
  );
}

function DedupWidget() {
  return (
    <Widget className="content-between gap-3">
      <Row>
        <b>Detector de duplicados</b>
        <Badge variant="warn" dot>coincidencia</Badge>
      </Row>
      <svg viewBox="0 0 360 116" role="img" className="block h-auto w-full" aria-label="Similitud 0.89 con WAT-31">
        <rect x="1" y="8" width="150" height="100" rx="8" className="fill-sidebar stroke-border" />
        <text x="14" y="32" fontSize="10.5" fontWeight="600" letterSpacing="0.06em" className="fill-faint">NUEVA</text>
        <text x="14" y="55" fontSize="14" fontWeight="600" className="fill-foreground">Cupón se</text>
        <text x="14" y="73" fontSize="14" fontWeight="600" className="fill-foreground">acumula</text>
        <text x="14" y="95" fontSize="11" className="fill-muted-foreground">junta del 11 nov</text>
        <rect x="209" y="8" width="150" height="100" rx="8" className="fill-sidebar stroke-border" />
        <text x="222" y="32" fontSize="10.5" className="fill-faint font-mono">WAT-31</text>
        <text x="222" y="55" fontSize="14" fontWeight="600" className="fill-foreground">Cupones</text>
        <text x="222" y="73" fontSize="14" fontWeight="600" className="fill-foreground">apilables</text>
        <text x="222" y="95" fontSize="11" className="fill-muted-foreground">Luis · en curso</text>
        <circle cx="180" cy="58" r="30" className="fill-card stroke-border" />
        <circle cx="180" cy="58" r="24" className="fill-none stroke-orange" strokeWidth={5.5} strokeLinecap="round" strokeDasharray="134 151" transform="rotate(-90 180 58)" />
        <text x="180" y="63" fontSize="14" fontWeight="700" textAnchor="middle" className="fill-foreground tabular-nums">.89</text>
      </svg>
      <Row className="flex-nowrap">
        <span className="text-muted-foreground">Resultado</span>
        <Badge variant="ok">comentario en WAT-31</Badge>
      </Row>
    </Widget>
  );
}

function AutonomyWidget() {
  return (
    <Widget className="content-between gap-3">
      <Row>
        <b>Nivel de autonomía</b>
        <span className="text-xs text-faint">calculado</span>
      </Row>
      <svg viewBox="0 0 360 66" role="img" className="block h-auto w-full" aria-label="Escala de riesgo de 0 a 2, issue en nivel 1">
        <rect x="2" y="30" width="114" height="14" rx="7" className="fill-green" />
        <rect x="123" y="30" width="114" height="14" rx="7" className="fill-yellow" />
        <rect x="244" y="30" width="114" height="14" rx="7" className="fill-red" />
        <g fontSize="12.5" fontWeight="600" textAnchor="middle" className="fill-foreground">
          <text x="59" y="19">0 · solo</text>
          <text x="180" y="19">1 · con plan</text>
          <text x="301" y="19">2 · humano</text>
        </g>
        <path d="M180 51 l-8 12 h16z" className="fill-foreground" />
      </svg>
      <div>
        <CheckItem>
          Solo toca <span className="font-mono text-xs">src/checkout/*</span>
        </CheckItem>
        <CheckItem>Migración aditiva</CheckItem>
        <CheckItem on={false}>Auth, RLS o pagos</CheckItem>
      </div>
    </Widget>
  );
}

function TriageWidget() {
  const rows = [
    { id: 'WAT-44', t: 'Estatus de envío', risk: 0, who: 'Ana', c: 'orange' as const },
    { id: 'CFD-12', t: 'Reintento de timbrado', risk: 1, who: 'Luis', c: 'purple-deep' as const },
    { id: 'ORW-88', t: 'Scoring por UTM', risk: 0, who: 'Sofía', c: 'green' as const },
  ];
  return (
    <Widget className="content-between gap-2">
      <Row>
        <span className="flex items-center gap-2">
          <IntegrationIcon name="linear" size="sm" />
          <b>Linear · Triage</b>
        </span>
        <span className="text-xs text-faint">3 por decidir</span>
      </Row>
      {rows.map((r) => (
        <div key={r.id} className="flex items-center gap-2 rounded-md bg-sidebar px-2.5 py-2 text-[13px]">
          <MiniAv name={r.who} color={r.c} />
          <span className="grid min-w-0 flex-1 leading-tight">
            <span>{r.t}</span>
            <span className="font-mono text-[11px] text-faint">{r.id}</span>
          </span>
          <Badge variant={r.risk === 0 ? 'ok' : 'human'}>riesgo {r.risk}</Badge>
        </div>
      ))}
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="secondary" tabIndex={-1}>Descartar</Button>
        <Button size="sm" variant="dark" tabIndex={-1}>Aceptar</Button>
      </div>
    </Widget>
  );
}

function DispatchWidget() {
  const steps: [string, 'ok' | 'wip' | 'todo'][] = [
    ['Plan', 'ok'],
    ['Código', 'ok'],
    ['Tests', 'wip'],
    ['PR', 'todo'],
  ];
  return (
    <Widget className="content-between gap-2.5">
      <Row>
        <b>Despacho</b>
        <Badge variant="llm" dot>2 trabajando</Badge>
      </Row>
      <div className="grid grid-cols-4 gap-1.5 text-xs">
        {steps.map(([s, st]) => (
          <span key={s} className="grid gap-1.5">
            <i
              className={cn(
                'h-1.5 rounded-full',
                st === 'ok' && 'bg-green',
                st === 'wip' && 'lp-pulse bg-purple-deep',
                st === 'todo' && 'bg-toggle-off',
              )}
            />
            <span className={cn(st === 'todo' && 'text-faint')}>{s}</span>
          </span>
        ))}
      </div>
      <div className="grid gap-1.5">
        <AgentLine>
          <b className="font-mono">WAT-44</b> PC de Ana · 18 min
        </AgentLine>
        <AgentLine tone="ok">
          <b className="font-mono">CFD-12</b> PR abierta · CI verde
        </AgentLine>
        <AgentLine tone="idle">
          <b className="font-mono">ORW-88</b> en cola · PC apagada
        </AgentLine>
      </div>
    </Widget>
  );
}

function Platform() {
  return (
    <section id="plataforma" className="py-12 sm:py-[72px]">
      <Wrap className="grid gap-9">
        <SectionTitle
          color="green"
          eyebrow="Cómo funciona"
          title="De una conversación a un PR, con evidencia en cada paso"
          lede="Seis pasos. Las reglas deciden donde hay certeza, el LLM donde hay lenguaje y un humano donde hay riesgo."
        />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Step n={1} title="Captura la junta" widget={<ManualSessionWidget />}>
            Con la API de Granola se sincroniza sola. Sin ella, pega el transcript o sube el archivo.
          </Step>
          <Step n={2} title="Arma el issue por capas" widget={<AnatomyWidget />}>
            Cada campo dice quién lo decidió. Si el modelo falla, la regla sostiene el piso.
          </Step>
          <Step n={3} title="Nada se duplica" widget={<DedupWidget />}>
            Búsqueda híbrida contra los issues abiertos. Si ya existe, le suma contexto.
          </Step>
          <Step n={4} title="Calcula la autonomía" widget={<AutonomyWidget />}>
            Reglas auditables sobre paths, migraciones, auth y pagos fijan qué tan solo va el agente.
          </Step>
          <Step n={5} title="El humano decide en Linear" widget={<TriageWidget />}>
            Todo entra a Triage con el asignado que sugiere roz por skill, disponibilidad y carga.
          </Step>
          <Step n={6} title="Despacha al agente del dev" widget={<DispatchWidget />}>
            Corre en la PC del dev con su sesión de Claude Code. Si está apagada, espera en cola.
          </Step>
        </div>
      </Wrap>
    </section>
  );
}

/* ── Visibilidad (bloque salmón) ───────────────────────────────────────────────────────────── */

function Burnup() {
  return (
    <svg viewBox="0 0 300 130" role="img" className="block h-auto w-full" aria-label="Burnup: 29 de 50 puntos hechos al día 8 de 10">
      <g className="stroke-border">
        <line x1="20" y1="20" x2="290" y2="20" />
        <line x1="20" y1="65" x2="290" y2="65" />
        <line x1="20" y1="110" x2="290" y2="110" />
      </g>
      <polyline points="20,47 50,47 80,44 110,38 140,38 170,34 200,34 230,29 260,29 290,29" className="fill-none stroke-purple" strokeWidth={2} />
      <polyline points="20,108 50,103 80,96 110,91 140,82 170,75 200,70 230,61" className="fill-none stroke-orange" strokeWidth={2.5} />
      <polyline points="230,61 290,40" className="fill-none stroke-orange" strokeWidth={2} strokeDasharray="4 4" />
      <circle cx="230" cy="61" r="4" className="fill-orange" />
      <text x="234" y="56" fontSize="10.5" fontWeight="600" className="fill-foreground tabular-nums">29/50</text>
      <text x="20" y="126" fontSize="9.5" className="fill-faint">día 1</text>
      <text x="290" y="126" fontSize="9.5" textAnchor="end" className="fill-faint">día 10</text>
    </svg>
  );
}

function Visibility() {
  const people = [
    { n: 'Ana', c: 'orange' as const, p: 'on' as const, s: 'WAT-44 · agente activo', chip: <Badge variant="info">en código</Badge> },
    { n: 'Luis', c: 'purple-deep' as const, p: 'meet' as const, s: 'Con el cliente hasta 12:30', chip: <Badge variant="human">en junta</Badge> },
    { n: 'Sofía', c: 'green' as const, p: 'off' as const, s: 'ORW-88 · commit hace 3 h', chip: <Badge variant="neutral">fuera</Badge> },
    { n: 'Diego', c: 'orange' as const, p: 'on' as const, s: 'CFD-12 · PR en revisión', chip: <Badge variant="ok">en PR</Badge> },
  ];
  return (
    <section id="visibilidad" className="pb-12 sm:pb-[72px]">
      <Wrap>
        <div data-reveal className="relative overflow-hidden rounded-2xl bg-salmon px-5 py-7 dark:bg-orange-soft sm:p-12">
          <div className="mb-8 grid items-end gap-5 md:grid-cols-[minmax(0,1fr)_auto]">
            <div className="grid gap-3.5">
              <Tag>Para dirección</Tag>
              <h2 className={H2}>Entra y ve en qué trabaja cada quien, ahora</h2>
              <p className={cn(LEDE, 'text-foreground/80')}>
                Linear, GitHub, el calendario y los agentes en una sola vista: quién tiene qué, cómo va el ciclo y qué se
                le prometió a cada cliente.
              </p>
            </div>
            <Button asChild variant="outline" className="justify-self-start border-transparent">
              <Link to="/app">
                Abrir el pulso <ArrowRight />
              </Link>
            </Button>
          </div>
          <div className="grid gap-3.5 md:grid-cols-2 lg:grid-cols-3">
            <Widget className="content-between gap-3">
              <Row>
                <b>Ahora mismo</b>
                <Badge variant="ok" dot>en vivo</Badge>
              </Row>
              {people.map((r) => (
                <div key={r.n} className="flex items-center gap-2.5">
                  <GithubAvatar name={r.n} color={r.c} presence={r.p} />
                  <div className="grid min-w-0 flex-1 leading-tight">
                    <b className="text-[13px]">{r.n}</b>
                    <span className="text-xs text-muted-foreground">{r.s}</span>
                  </div>
                  {r.chip}
                </div>
              ))}
            </Widget>
            <Widget className="content-between gap-2">
              <Row>
                <b>Ciclo 46 · avance</b>
                <Badge variant="ok">a tiempo</Badge>
              </Row>
              <Burnup />
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5"><i className="h-0.5 w-3.5 bg-purple" /> alcance</span>
                <span className="flex items-center gap-1.5"><i className="h-0.5 w-3.5 bg-orange" /> hecho</span>
                <span className="flex items-center gap-1.5"><i className="w-3.5 border-t-2 border-dashed border-orange" /> proyección</span>
              </div>
            </Widget>
            <Widget className="content-between gap-0 md:col-span-2 lg:col-span-1">
              <Row className="pb-2">
                <b>Prometido vs entregado</b>
                <span className="text-xs text-faint">desde juntas</span>
              </Row>
              {[
                ['Ecommerce', 'Estatus de envío', <Badge key="a" variant="info">en curso</Badge>],
                ['Portal', 'Cotizador con IVA', <Badge key="b" variant="ok">en prod</Badge>],
                ['Formularios', 'Multi-sede', <Badge key="c" variant="bad">atrasado 4 d</Badge>],
                ['Leads', 'Scoring por UTM', <Badge key="d" variant="human">en triage</Badge>],
              ].map(([p, l, chip], i) => (
                <div key={i} className="flex items-center justify-between gap-2 border-t py-2 text-[13px]">
                  <span className="grid min-w-0 leading-tight">
                    <span>{l}</span>
                    <span className="text-xs text-muted-foreground">{p}</span>
                  </span>
                  {chip}
                </div>
              ))}
            </Widget>
          </div>
        </div>
      </Wrap>
    </section>
  );
}

/* ── Agentes (bloque morado) ──────────────────────────────────────────────────────────────── */

function HarnessDiagram() {
  const icon = useIconSrc();
  const runners = [
    { x: 40, name: 'Ana', c: 'orange', os: 'PC · Windows', dot: 'fill-green', st: 'en línea · 1/2', job: 'WAT-44 ▸ tests', off: false },
    { x: 250, name: 'Luis', c: 'purple-deep', os: 'PC · macOS', dot: 'fill-yellow', st: 'esperando plan', job: 'CFD-12 ▸ plan', off: false },
    { x: 460, name: 'Sofía', c: 'green', os: 'PC · apagada', dot: 'fill-toggle-off', st: 'fuera hace 2 h', job: 'ORW-88 → en cola', off: true },
  ];
  return (
    <svg viewBox="0 0 640 360" role="img" className="block h-auto w-full" aria-label="Linear delega a roz; roz despacha al runner de la PC de cada dev">
      <defs>
        <marker id="lp-ah2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" className="fill-foreground" />
        </marker>
      </defs>
      <rect x="250" y="12" width="140" height="48" rx="8" className="fill-card stroke-border" />
      <image href={icon('linear')} x="262" y="24" width="24" height="24" />
      <text x="294" y="34" fontSize="12.5" fontWeight="600" className="fill-foreground">Linear</text>
      <text x="294" y="49" fontSize="10" className="fill-faint">delegado: roz</text>
      <path d="M320 60 V108" className="stroke-foreground" strokeWidth={1.5} markerEnd="url(#lp-ah2)" />
      <text x="328" y="90" fontSize="10" className="fill-muted-foreground font-mono">AgentSession</text>
      <rect x="232" y="110" width="176" height="64" rx="10" className="fill-orange" />
      <text x="320" y="138" fontSize="14" fontWeight="600" textAnchor="middle" className="fill-white">roz · despachador</text>
      <text x="320" y="156" fontSize="10.5" textAnchor="middle" className="fill-white/80">política: asignado · riesgo · horario</text>
      <g className="fill-none stroke-foreground" strokeWidth={1.5}>
        <path d="M270 174 C230 220 130 220 110 252" markerEnd="url(#lp-ah2)" />
        <path d="M320 174 V252" markerEnd="url(#lp-ah2)" />
        <path d="M370 174 C410 220 510 220 530 252" className="lp-dash" markerEnd="url(#lp-ah2)" />
      </g>
      {runners.map((r, i) => (
        <g key={r.name} fontSize="11.5" opacity={r.off ? 0.7 : 1}>
          <rect
            x={r.x}
            y="254"
            width="140"
            height="88"
            rx="8"
            className={r.off ? 'fill-panel stroke-toggle-off' : 'fill-card stroke-border'}
            strokeDasharray={r.off ? '4 3' : undefined}
          />
          <circle cx={r.x + 22} cy="276" r="12" style={{ fill: tokenColor(r.c) }} />
          <text x={r.x + 22} y="280" fontSize="10" fontWeight="700" textAnchor="middle" className="fill-white">
            {r.name[0]}
          </text>
          <text x={r.x + 40} y="274" fontWeight="600" className="fill-foreground">{r.name}</text>
          <text x={r.x + 40} y="287" fontSize="9.5" className="fill-faint">{r.os}</text>
          <circle cx={r.x + 14} cy="306" r="4" className={r.dot} />
          <text x={r.x + 24} y="310" fontSize="10.5" className="fill-foreground">{r.st}</text>
          <text x={r.x + 10} y="330" fontSize="10" className={cn('font-mono', i === 2 ? 'fill-muted-foreground' : 'fill-purple-deep')}>
            {r.job}
          </text>
        </g>
      ))}
    </svg>
  );
}

function Agents() {
  return (
    <section id="agentes" className="pb-12 sm:pb-[72px]">
      <Wrap>
        <div data-reveal className="relative overflow-hidden rounded-2xl bg-purple px-5 py-7 dark:bg-lavender sm:p-12">
          <div className="mb-8 grid gap-3.5">
            <Tag tone="card">Harness de agentes</Tag>
            <h2 className={H2}>Un agente por dev, con su cola y su memoria</h2>
            <p className={cn(LEDE, 'text-foreground/80')}>
              El trabajo corre en la PC del dev, con su sesión de Claude Code y en un worktree aislado. Como un runner
              self-hosted: polling saliente, sin abrir puertos.
            </p>
          </div>
          <div className="grid gap-3.5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Widget className="content-center">
              <HarnessDiagram />
            </Widget>
            <div className="grid gap-3.5 [&>*]:content-between">
              <Widget>
                <b className="text-[13px]">Qué decide el despachador</b>
                <Row><span>Issue del dev, PC en línea</span><Badge variant="llm">su PC</Badge></Row>
                <Row><span>PC apagada</span><Badge variant="neutral">en cola</Badge></Row>
                <Row><span>Riesgo 1</span><Badge variant="human">plan primero</Badge></Row>
                <Row><span>Riesgo 2</span><Badge variant="bad">solo humano</Badge></Row>
              </Widget>
              <Widget className="gap-2">
                <b className="text-[13px]">En la PC de cada dev</b>
                <code className="block whitespace-pre-wrap rounded-md bg-ink p-2.5 font-mono text-[11.5px] leading-relaxed text-ink-foreground dark:bg-background dark:text-foreground">
                  {'$ roz-runner login --url https://roz.tu-equipo.com\n✓ vinculado · token por equipo\n$ roz-runner start --max 1 --horario 9-19\n● esperando trabajo…'}
                </code>
                <p className="text-[11.5px] text-muted-foreground">
                  Cada trabajo corre con <span className="font-mono">claude -p</span>, el MCP de roz y una lista blanca de
                  herramientas, y abre la PR con <span className="font-mono">gh</span>.{' '}
                  <a href={RUNNER} target="_blank" rel="noreferrer" className="font-medium text-foreground underline-offset-2 hover:underline">
                    Ver roz-runner
                  </a>
                </p>
              </Widget>
            </div>
          </div>
        </div>
      </Wrap>
    </section>
  );
}

/* ── Flujo completo (carriles) ─────────────────────────────────────────────────────────────── */

function Flow() {
  return (
    <section id="flujo" className="pb-12 sm:pb-[72px]">
      <Wrap className="grid gap-8">
        <SectionTitle
          eyebrow="Flujo completo"
          title="De una junta a producción, y de vuelta"
          lede="Doce pasos, ida y vuelta. Si algo falla en producción, entra solo por el paso 4: nadie lo captura a mano."
        />
        <div data-reveal className="rounded-xl border bg-card p-4 sm:p-6">
          <FlowDiagram />
        </div>
      </Wrap>
    </section>
  );
}

/* ── Seguridad (bloque oscuro) ─────────────────────────────────────────────────────────────── */

function Security() {
  const seals = [
    ['HMAC', 'webhooks'],
    ['RLS', 'deny-all'],
    ['Audit', 'log'],
    ['MIT', 'tu infra'],
  ];
  const checks = [
    'Token por runner, revocable',
    'Sin puertos abiertos en las PCs',
    'GitHub con PAT de solo lectura',
    'Secretos y datos en tu propio Supabase',
  ];
  return (
    <section className="pb-12 sm:pb-[72px]">
      <Wrap>
        <div
          data-reveal
          className="relative overflow-hidden rounded-2xl bg-ink px-5 py-7 text-ink-foreground dark:border dark:bg-card dark:text-foreground sm:p-12"
        >
          <div className="grid items-center gap-10 md:grid-cols-2">
            <div className="grid gap-[18px]">
              <Tag tone="dark">Seguridad</Tag>
              <h2 className={H2}>Agentes con permisos que puedes auditar</h2>
              <p className={cn(LEDE, 'opacity-75')}>
                Sin un humano no tocan auth, RLS ni pagos. Cada acción queda registrada: quién la delegó, en qué runner
                corrió y qué PR abrió.
              </p>
              <Button asChild variant="outline" className="justify-self-start border-transparent">
                <a href={SECURITY} target="_blank" rel="noreferrer">
                  Política de seguridad <ArrowRight />
                </a>
              </Button>
            </div>
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {seals.map(([a, b]) => (
                  <div
                    key={a}
                    className="grid gap-0.5 rounded-lg border px-3 py-3 text-center text-sm font-semibold leading-tight [border-color:color-mix(in_srgb,currentColor_25%,transparent)]"
                  >
                    {a}
                    <span className="text-xs font-normal opacity-70">{b}</span>
                  </div>
                ))}
              </div>
              <div className="grid gap-2 rounded-lg bg-ink-foreground/10 p-3.5 text-[13px] dark:bg-panel">
                {checks.map((c) => (
                  <Row key={c} className="flex-nowrap">
                    <span>{c}</span>
                    <Badge variant="ok"><Check className="size-3" strokeWidth={3} /></Badge>
                  </Row>
                ))}
              </div>
            </div>
          </div>
        </div>
      </Wrap>
    </section>
  );
}

/* ── Módulos ──────────────────────────────────────────────────────────────────────────────── */

const MODULES: { head: ReactNode; items: { b: string; s: string; code: string }[] }[] = [
  {
    head: <Badge variant="warn" dot>Visibilidad</Badge>,
    items: [
      { b: 'Pulso', s: 'Quién trabaja en qué, por persona, proyecto y cliente', code: 'src/dashboard/pulse.ts' },
      { b: 'Proyectos y capacidad', s: 'Avance del ciclo y carga real de cada dev', code: 'src/projects/ · src/assign/' },
      { b: 'Atribución', s: 'Separa commits de agente de los de humanos', code: 'src/reconcile/' },
    ],
  },
  {
    head: <Badge variant="human" dot>Entrada</Badge>,
    items: [
      { b: 'Juntas', s: 'Granola por API o sesión manual', code: 'src/meetings/' },
      { b: 'Intake por capas', s: 'Reglas + LLM; el destino es Linear Triage', code: 'src/intake/' },
      { b: 'Sync con Linear', s: 'Webhooks, GraphQL y Agent API', code: 'src/linear/' },
    ],
  },
  {
    head: <Badge variant="llm" dot>Agentes</Badge>,
    items: [
      { b: 'Planes y despacho', s: 'Cola por dev, riesgo y horario', code: 'src/plans/' },
      { b: 'roz-runner', s: 'CLI en la PC del dev: worktree + claude -p', code: 'runner/' },
      { b: 'MCP de roz', s: 'Decisiones, contexto y tareas para el agente', code: 'src/mcp/server.ts' },
    ],
  },
  {
    head: <Badge variant="ok" dot>Operación</Badge>,
    items: [
      { b: 'Infraestructura', s: 'Vercel, Railway y Supabase en una vista', code: 'src/infra/' },
      { b: 'Outbox + cron', s: 'Eventos idempotentes con reintentos, sin colas externas', code: 'src/events/outbox.ts' },
      { b: 'Avisos', s: 'Correo, push y chat del equipo', code: 'src/notify/ · src/chat/' },
    ],
  },
];

function Modules() {
  return (
    <section className="pb-12 sm:pb-[72px]">
      <Wrap className="grid gap-7">
        <SectionTitle color="purple-deep" eyebrow="Qué trae" title="Cuatro áreas, un solo repo que tú despliegas" />
        <div data-reveal className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {MODULES.map((col, i) => (
            <div key={i} className="grid content-start gap-2">
              <h4 className="flex items-center gap-2 pb-1.5 text-[15px]">{col.head}</h4>
              {col.items.map((m) => (
                <div key={m.b} className="grid gap-[3px] rounded-md border bg-card px-3 py-[11px]">
                  <b className="text-sm font-semibold">{m.b}</b>
                  <span className="text-[12.5px] text-muted-foreground">{m.s}</span>
                  <code className="font-mono text-[11px] text-faint">{m.code}</code>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Wrap>
    </section>
  );
}

/* ── Self-host (bloque amarillo con fases) ─────────────────────────────────────────────────── */

const PHASES: { bar: string; t: string; p: string; sig: string }[] = [
  { bar: 'bg-ink', t: 'Clona', p: 'Clona el repo y corre npm install.', sig: 'git clone hyperlabs-ai/roz' },
  { bar: 'bg-orange', t: 'Variables', p: 'Copia .env.example a .env y llena tus llaves.', sig: 'CRON_SECRET obligatorio' },
  { bar: 'bg-purple-deep', t: 'Migraciones', p: 'Aplícalas a tu proyecto de Supabase.', sig: 'Expón el schema roz en la API' },
  { bar: 'bg-purple', t: 'Deploy', p: 'Despliega en Vercel, crons incluidos.', sig: 'vercel --prod' },
  { bar: 'bg-red', t: 'GitHub', p: 'PAT de solo lectura y el webhook firmado.', sig: 'push · pull_request · repository' },
  { bar: 'bg-green', t: 'Equipo', p: 'Conecta Linear, Granola y el runner de cada dev.', sig: 'roz empieza a reconciliar' },
];

function SelfHost() {
  return (
    <section id="self-host" className="pb-12 sm:pb-[72px]">
      <Wrap>
        <div data-reveal className="grid gap-8 rounded-2xl bg-yellow px-5 py-7 dark:bg-yellow-soft sm:p-12">
          <div className="grid gap-3.5">
            <Tag tone="card">Self-host</Tag>
            <h2 className={H2}>Tus datos, tu deploy. Seis pasos y está corriendo</h2>
            <p className={cn(LEDE, 'text-foreground/80')}>
              Open source bajo MIT. Nadie más guarda tu base de datos: corre en tu Vercel y tu Supabase.
            </p>
          </div>
          <div className="grid gap-y-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
            {PHASES.map((ph, i) => (
              <div key={ph.t} className="grid content-start gap-2.5 pr-3">
                <div className={cn('h-2 rounded-full', ph.bar, i < PHASES.length - 1 && 'lg:-mr-3')} />
                <span className="label-caps text-foreground/60">PASO {i + 1}</span>
                <h4 className="text-base">{ph.t}</h4>
                <p className="text-[13px] text-foreground/75">{ph.p}</p>
                <div className="rounded-md border bg-card p-2 font-mono text-[11px] text-muted-foreground">{ph.sig}</div>
              </div>
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <Widget className="gap-1">
              <b className="pb-1 text-[13px]">Antes de empezar, necesitas</b>
              <CheckItem on={false}>Un proyecto de Supabase y una cuenta de Vercel.</CheckItem>
              <CheckItem on={false}>Un token de GitHub de solo lectura (Contents, Metadata, Pull requests).</CheckItem>
              <CheckItem on={false}>Una API key de Anthropic para el intake; los agentes usan la sesión de cada dev.</CheckItem>
            </Widget>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="lg">
                <a href={REPO} target="_blank" rel="noreferrer">Self-host en GitHub</a>
              </Button>
              <Button asChild size="lg" variant="outline" className="border-transparent">
                <a href={DOCS} target="_blank" rel="noreferrer">Guía de self-hosting</a>
              </Button>
            </div>
          </div>
        </div>
      </Wrap>
    </section>
  );
}

/* ── Footer ───────────────────────────────────────────────────────────────────────────────── */

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  const external = href.startsWith('http') || href.startsWith('mailto:');
  return (
    <a href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})} className="block text-muted-foreground transition-colors hover:text-foreground">
      {children}
    </a>
  );
}

function Footer() {
  return (
    <footer className="border-t">
      <Wrap className="py-12">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div className="grid max-w-sm gap-3">
            <RozLogo wordmark className="size-[26px]" />
            <p className="text-sm text-muted-foreground">El plano de control del desarrollo. Open source, self-host.</p>
            <div className="flex gap-1.5">
              <Badge variant="neutral">MIT</Badge>
              <Badge variant="ok" dot>self-host</Badge>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-8 text-sm sm:grid-cols-3">
            <div className="grid content-start gap-2.5">
              <CapsLabel>Producto</CapsLabel>
              <FooterLink href="#plataforma">Cómo funciona</FooterLink>
              <FooterLink href="#visibilidad">Visibilidad</FooterLink>
              <FooterLink href="#agentes">Agentes</FooterLink>
            </div>
            <div className="grid content-start gap-2.5">
              <CapsLabel>Docs</CapsLabel>
              <FooterLink href={DOCS}>Self-hosting</FooterLink>
              <FooterLink href={GH_SETUP}>Configurar GitHub</FooterLink>
              <FooterLink href={ARCH}>Arquitectura</FooterLink>
              <FooterLink href={SECURITY}>Seguridad</FooterLink>
            </div>
            <div className="grid content-start gap-2.5">
              <CapsLabel>Más</CapsLabel>
              <FooterLink href={REPO}>Código fuente</FooterLink>
              <FooterLink href={`mailto:${SUPPORT_EMAIL}`}>Soporte</FooterLink>
              <Link to="/app" className="block text-muted-foreground transition-colors hover:text-foreground">Dashboard</Link>
            </div>
          </div>
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span className="label-caps">© 2026 HyperLabs · Licencia MIT</span>
          <span>
            ¿Preguntas? <a href={`mailto:${SUPPORT_EMAIL}`} className="text-foreground hover:underline">{SUPPORT_EMAIL}</a>
          </span>
        </div>
      </Wrap>
    </footer>
  );
}

export default function Landing() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in window)) {
      els.forEach((e) => e.classList.add('is-visible'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((en) => {
          if (en.isIntersecting) {
            en.target.classList.add('is-visible');
            io.unobserve(en.target);
          }
        }),
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);

  return (
    <div id="inicio" className="min-h-dvh overflow-x-clip bg-background text-[15px] text-foreground">
      <LandingStyles />
      <Header />
      <main>
        <Hero />
        <Logos />
        <Platform />
        <Visibility />
        <Agents />
        <Flow />
        <Security />
        <Modules />
        <SelfHost />
      </main>
      <Footer />
    </div>
  );
}
