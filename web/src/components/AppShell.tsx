import { createContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Link, NavLink, Outlet, matchPath, useLocation, useNavigationType } from 'react-router-dom';
import {
  LayoutDashboard, Users, FolderGit2, Server, BarChart3, GraduationCap, Sun, Moon, LogOut, Menu, Bell, BellOff, Settings,
  ListChecks, Gauge, MessagesSquare, TicketPlus, HeartPulse, Users2, Bot, Monitor, Network, FileText, Inbox, Building2,
  KeyRound, Plug, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { usePush } from '@/push/PushContext';
import { useChat } from '@/chat/ChatContext';
import { useTheme } from '@/components/theme';
import { MeAvatar } from '@/components/avatars';
import { useApi } from '@/lib/useApi';
import { usePoll } from '@/lib/usePoll';
import { DISCORD_STATUS_KEY, discordStatusOrOff } from '@/discord/status';
import { RozLogo } from '@/components/RozLogo';
import { QueuePill } from '@/components/QueuePill';
import { useRozV2 } from '@/components/pulse/roz-v2';
import { useZeusMe } from '@/components/zeus/zeus-ui';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { R } from '@/lib/routes';
import { cn } from '@/lib/utils';

/**
 * Chrome del dashboard: sidebar, header y contenedor de la página. Es un LAYOUT DE RUTA (ver
 * `App.tsx`), así que permanece montado al navegar entre secciones — igual que el `AppLayout` de
 * hyperflow-app.
 *
 * Antes cada una de las 13 páginas renderizaba su propio `<Layout>` DENTRO de sí misma, así que
 * cambiar de sección tiraba y reconstruía el sidebar, el header y el pulso de la cola, y redisparaba
 * todas las animaciones de entrada. Se sentía como una recarga completa de la app.
 *
 * Para no tocar las 13 páginas, `<Layout>` conserva su firma y publica título y acciones AQUÍ, por
 * portal, en los tres huecos que expone este componente.
 *
 * El menú lateral se CONTRAE a un riel de íconos (botón del header, botón al pie del menú o
 * Ctrl/Cmd + B; se recuerda en localStorage). Contraer no mueve nada de sitio: cada ícono conserva su
 * x, el texto se desvanece y el ancho se anima con CSS.
 *
 * Variables que publica en su raíz (ver DESIGN.md → "Alto de pantalla completa"):
 *  · `--shell-top`   — lo que hay entre el borde superior de la ventana y el inicio del contenido
 *                      (header + padding superior de `<main>`).
 *  · `--shell-pad-b` — el padding inferior de `<main>`.
 */

export interface ShellSlots {
  title: HTMLElement | null;
  actionsDesktop: HTMLElement | null;
  actionsMobile: HTMLElement | null;
  /** Sección del menú de la ruta actual: el eyebrow por defecto del título. */
  section?: string | null;
  /** La ruta ocupa todo el alto y ancho (chat): `Layout` no acota el contenido. */
  fullBleed?: boolean;
}

/** `null` = no hay shell (se está renderizando un `<Layout>` fuera de su ruta). */
export const ShellSlotsContext = createContext<ShellSlots | null>(null);

// `badge` pinta un contador junto a la etiqueta (o sobre el ícono, con el menú contraído):
//  · `chat`  — MDs + menciones, o un punto si solo hay actividad en canales
//  · `inbox` — mensajes sin leer + solicitudes que esperan tu respuesta en la bandeja de zeus
//  · `admin` — punto amarillo: zeus todavía no tiene administrador
type NavIcon = ComponentType<{ className?: string; strokeWidth?: number | string }>;
type NavBadgeKind = 'chat' | 'inbox' | 'admin';
type NavItem = { to: string; label: string; icon: NavIcon; end: boolean; badge?: NavBadgeKind };
type NavSection = { label: string; items: NavItem[] };

/**
 * Logo de Discord en MONOCROMO (currentColor), con el mismo estándar que los íconos de lucide del
 * menú: hereda el color del ítem (atenuado, o naranja cuando está activo). Decisión del usuario: nada
 * de colores de marca en el menú. Se dibuja un poco más chico porque es relleno y lucide es trazo.
 */
function DiscordNavIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="-2 -2 28 28" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

// Prohibido el ícono de chispa (Sparkle/Sparkles/WandSparkles…) en toda la app: lo vigila
// test/web-banned-icons.test.ts.
const I = {
  // Zeus: una entrada por sección (antes eran pestañas dentro de la página).
  mapa: { to: R.mapa, label: 'Mapa', icon: Network, end: true },
  biblioteca: { to: R.biblioteca, label: 'Biblioteca', icon: FileText, end: false },
  bandeja: { to: R.bandeja, label: 'Bandeja', icon: Inbox, end: false, badge: 'inbox' },
  equipo: { to: R.equipo, label: 'Equipo', icon: Building2, end: false, badge: 'admin' },
  llaves: { to: R.llaves, label: 'Llaves', icon: KeyRound, end: false },
  acceso: { to: R.acceso, label: 'Acceso', icon: Plug, end: false },
  pulse: { to: R.pulso, label: 'Pulso', icon: HeartPulse, end: false },
  overview: { to: R.resumen, label: 'Resumen', icon: LayoutDashboard, end: false },
  chat: { to: R.chat, label: 'Chat', icon: MessagesSquare, end: false, badge: 'chat' },
  developers: { to: R.developers, label: 'Developers', icon: Users, end: false },
  capacity: { to: R.capacidad, label: 'Capacidad', icon: Gauge, end: false },
  projects: { to: R.proyectos, label: 'Proyectos', icon: FolderGit2, end: false },
  infra: { to: R.infra, label: 'Infraestructura', icon: Server, end: false },
  ticket: { to: R.ticket, label: 'Ticket', icon: TicketPlus, end: false },
  tasks: { to: R.tareas, label: 'Tareas', icon: ListChecks, end: false },
  reports: { to: R.reportes, label: 'Reportes', icon: BarChart3, end: false },
  skills: { to: R.skills, label: 'Skills', icon: GraduationCap, end: false },
  meetings: { to: R.juntas, label: 'Juntas', icon: Users2, end: false },
  plans: { to: R.planes, label: 'Planes', icon: Bot, end: false },
} as const satisfies Record<string, NavItem>;

/**
 * Menú según roz v2, agrupado en secciones como la consola del mock. Zeus (el contexto del equipo)
 * encabeza el menú con sus seis secciones: el mapa es la pantalla principal (`/`). Pulso y Resumen
 * viven en su propia ruta (con Linear como fuente de verdad el Pulso va primero). Con ese flag
 * aparecen además Juntas y Planes (sus endpoints responden 409 con el flag apagado, así que sin él no
 * se ofrecen).
 *
 * Actividad ya no es página (se unificó con el Pulso: su historial de eventos vive ahí) e Ideas se
 * quitó por completo. Con el chat de Discord activo, "Chat" se llama "Discord" y lleva su logo.
 */
function useNav(): NavSection[] {
  const v2 = useRozV2();
  // Misma caché que MeAvatar y la página del chat: no agrega peticiones.
  const discord = useApi(() => discordStatusOrOff(), [], { key: DISCORD_STATUS_KEY, ttl: 60_000 });
  const sot = v2.linearSourceOfTruth;
  const chat: NavItem = discord.data?.enabled ? { ...I.chat, label: 'Discord', icon: DiscordNavIcon } : I.chat;
  const visibility = sot ? [I.pulse, I.overview] : [I.overview, I.pulse];
  return [
    // Zeus no depende del flag de Linear: el contexto del equipo existe con o sin él.
    { label: 'Zeus', items: [I.mapa, I.biblioteca, I.bandeja, I.equipo, I.llaves, I.acceso] },
    { label: 'Visibilidad', items: [...visibility, I.developers, I.capacity, I.projects] },
    { label: 'Entrada', items: [I.meetings, I.ticket, I.tasks, chat] },
    { label: 'Agentes', items: [...(sot ? [I.plans] : []), I.skills] },
    // Configuración vive en el menú del avatar (abajo a la izquierda), no en el menú lateral.
    { label: 'Operación', items: [I.infra, I.reports] },
  ];
}

/** Sección del menú a la que pertenece la ruta actual (para el eyebrow del header). */
function useSection(): string | null {
  const nav = useNav();
  const { pathname } = useLocation();
  for (const s of nav) {
    for (const n of s.items) {
      if (matchPath({ path: n.to, end: n.end }, pathname)) return s.label;
    }
  }
  return null;
}

/** Lo que cuenta cada insignia del menú. `count` gana sobre `dot`. */
type BadgeState = { count: number; dot: boolean; tone: 'red' | 'orange' | 'yellow'; label: string };

/**
 * Estado de las insignias. La de zeus sale de `/zeus/me` (la misma caché que usan sus pantallas) y
 * se sondea aquí porque el menú está siempre montado: un agente puede escribirte en cualquier
 * momento y el aviso tiene que verse desde cualquier sección.
 */
function useNavBadges(): Record<NavBadgeKind, BadgeState | null> {
  // Se llama UNA vez, en `AppShell`: dos llamadas serían dos sondeos.
  const { badge } = useChat();
  const me = useZeusMe();
  usePoll(me.reload, me.data ? 45_000 : null);
  const inbox = (me.data?.unreadMessages ?? 0) + (me.data?.pendingForMe ?? 0);
  return {
    chat: badge.count > 0
      ? { count: badge.count, dot: false, tone: 'red', label: `${badge.count} sin leer` }
      : badge.dot
        ? { count: 0, dot: true, tone: 'orange', label: 'Hay mensajes nuevos' }
        : null,
    inbox: inbox > 0 ? { count: inbox, dot: false, tone: 'orange', label: `${inbox} por atender` } : null,
    admin: me.data?.needsAdmin ? { count: 0, dot: true, tone: 'yellow', label: 'Falta un administrador' } : null,
  };
}

const BADGE_TONE = {
  red: 'bg-destructive text-destructive-foreground',
  orange: 'bg-orange text-white',
  yellow: 'bg-yellow text-foreground',
} as const;

/**
 * Insignia de un ítem. En línea (menú abierto, menú móvil) va a la derecha de la etiqueta; con el
 * menú contraído se monta sobre la esquina del ícono, con un aro del color del fondo para que no se
 * funda con él.
 */
function NavBadge({ state, rail = false, className }: { state: BadgeState | null; rail?: boolean; className?: string }) {
  if (!state) return null;
  const tone = BADGE_TONE[state.tone];
  if (state.count > 0) {
    return (
      <span
        aria-label={state.label}
        className={cn(
          'grid place-items-center rounded-full font-semibold tabular-nums',
          tone,
          rail
            ? 'absolute -right-1.5 -top-1.5 h-[15px] min-w-[15px] px-[3px] text-[9.5px] leading-none ring-2 ring-sidebar'
            : 'ml-auto h-[18px] min-w-[18px] shrink-0 px-1.5 text-[10.5px]',
          className,
        )}
      >
        {state.count > 99 ? '99+' : state.count}
      </span>
    );
  }
  return (
    <span
      aria-label={state.label}
      className={cn(
        'rounded-full',
        tone,
        rail ? 'absolute -right-0.5 -top-0.5 size-2 ring-2 ring-sidebar' : 'ml-auto mr-1 size-2 shrink-0',
        className,
      )}
    />
  );
}

/** Texto que se desvanece al contraer el menú. No cambia de tamaño: lo recorta el `aside`. */
const FADE = 'transition-opacity duration-quick ease-out group-data-[collapsed=true]/aside:pointer-events-none group-data-[collapsed=true]/aside:opacity-0';

type NavBadges = Record<NavBadgeKind, BadgeState | null>;

function NavItems({ collapsed, badges }: { collapsed: boolean; badges: NavBadges }) {
  const nav = useNav();
  const { pathname } = useLocation();
  return (
    <>
      {nav.map((section, i) => (
        // Columna flex y no grid: en un grid la etiqueta `nowrap` fija el ancho mínimo de la pista y,
        // con el menú contraído, los ítems quedarían más anchos que el riel (y su centro, fuera de él).
        <div key={section.label} className="flex min-w-0 flex-col gap-0.5">
          {/* Etiqueta de sección. Contraído conserva su alto (nada salta) y deja una raya punteada. */}
          <div className="relative flex h-7 shrink-0 items-end overflow-hidden px-2 pb-1.5">
            <span className={cn('label-caps whitespace-nowrap text-faint', FADE)}>{section.label}</span>
            {i > 0 && (
              <span
                aria-hidden
                className="connector absolute inset-x-2 bottom-3 opacity-0 transition-opacity duration-quick group-data-[collapsed=true]/aside:opacity-100"
              />
            )}
          </div>
          {section.items.map((n) => {
            const badge = n.badge ? badges[n.badge] : null;
            // `Link` con el activo calculado aquí, y no `NavLink` con `className` como función: el
            // `asChild` del tooltip fusiona `className` como TEXTO y la función acabaría en el DOM.
            const isActive = !!matchPath({ path: n.to, end: n.end }, pathname);
            return (
              // El tooltip (el global, `ui/hover-tip`) solo existe con el menú contraído: abierto, la
              // etiqueta ya se ve.
              <Link
                    key={n.to}
                    to={n.to}
                    data-tip={collapsed ? `${n.label}${badge ? ` · ${badge.label}` : ''}` : undefined}
                    data-tip-side="right"
                    data-tip-now=""
                    aria-label={n.label}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'group/nav relative flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 text-[13.5px] outline-none transition-colors duration-200 ease-spring focus-visible:ring-2 focus-visible:ring-ring',
                      isActive ? 'nav-active font-semibold text-orange-ink' : 'text-foreground hover:bg-panel',
                    )}
                  >
                    {/* El "cuadrito" del mock: gris en reposo, naranja con halo en el activo. */}
                    <span
                      className={cn(
                        'relative grid size-[22px] shrink-0 place-items-center rounded-[5px] transition-[background-color,color,box-shadow] duration-200',
                        isActive ? 'bg-orange text-white shadow-glow' : 'bg-panel text-muted-foreground group-hover/nav:bg-toggle-off/60 group-hover/nav:text-foreground',
                      )}
                    >
                      <n.icon className="size-[13px]" strokeWidth={2.25} />
                      {collapsed && <NavBadge state={badge} rail />}
                    </span>
                    <span className={cn('min-w-0 flex-1 truncate', FADE)}>{n.label}</span>
                    {!collapsed && <NavBadge state={badge} />}
                  </Link>
            );
          })}
        </div>
      ))}
    </>
  );
}

function Brand() {
  return (
    <div className="flex h-9 items-center gap-2 px-[7px]">
      <RozLogo className="size-6" />
      <span className={cn('text-[20px] font-bold leading-none tracking-[-0.04em]', FADE)}>roz</span>
      <span className={cn('label-caps ml-auto whitespace-nowrap text-faint', FADE)}>Desarrollo</span>
    </div>
  );
}

/**
 * Selector de tema DENTRO del menú del avatar (decisión del usuario): tres opciones en una fila,
 * sin cerrar el menú al elegir. Reemplaza al botón de tema del header.
 */
function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  const opts = [
    { value: 'light', label: 'Claro', icon: Sun },
    { value: 'dark', label: 'Oscuro', icon: Moon },
    { value: 'system', label: 'Sistema', icon: Monitor },
  ] as const;
  return (
    <div className="px-2 pb-1.5 pt-1">
      <div className="label-caps mb-1.5 text-faint">Tema</div>
      <div role="radiogroup" aria-label="Tema" className="grid grid-cols-3 gap-1 rounded-md bg-panel p-1">
        {opts.map((o) => {
          const on = theme === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setTheme(o.value)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-sm px-1 py-1.5 text-[11.5px] transition-colors',
                on ? 'bg-card font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <o.icon className="size-4" />
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function UserMenu() {
  const { user, signOut } = useAuth();
  const push = usePush();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Tu cuenta"
          className="flex w-full items-center gap-2.5 rounded-md px-[3px] py-1.5 text-left outline-none transition-colors hover:bg-panel focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MeAvatar className="size-8" />
          <div className={cn('min-w-0 flex-1', FADE)}>
            <div className="truncate text-[13px] font-semibold">{user?.name ?? user?.email}</div>
            <div className="label-caps mt-0.5 truncate">{user?.role ?? 'miembro'}</div>
          </div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel className="truncate font-sans text-xs font-normal normal-case tracking-normal text-muted-foreground">{user?.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ThemeSelector />
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <NavLink to={R.configuracion}><Settings /> Configuración</NavLink>
        </DropdownMenuItem>
        {push.supported && (
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); push.toggle(); }} disabled={push.busy}>
            {push.enabled ? <BellOff /> : <Bell />}
            {push.enabled ? 'Desactivar notificaciones' : 'Activar notificaciones'}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={signOut} className="text-destructive focus:text-destructive">
          <LogOut /> Cerrar sesión
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MobileNav({ badges }: { badges: NavBadges }) {
  const nav = useNav();
  const any = badges.chat ?? badges.inbox ?? badges.admin;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative shrink-0 md:hidden" aria-label="Menú">
          <Menu />
          {any && <span className={cn('absolute right-1 top-1 size-2 rounded-full ring-2 ring-background', BADGE_TONE[any.tone])} />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="scroll-thin max-h-[80dvh] w-52 overflow-y-auto">
        {nav.map((section, i) => (
          <div key={section.label}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="label-caps text-faint">
              {section.label}
            </DropdownMenuLabel>
            {section.items.map((n) => (
              <DropdownMenuItem key={n.to} asChild>
                <NavLink to={n.to} end={n.end}>
                  <n.icon /> {n.label}
                  {n.badge && <NavBadge state={badges[n.badge]} />}
                </NavLink>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        {/* En móvil no hay menú del avatar: Configuración y el tema van al final de este menú. */}
        <DropdownMenuSeparator />
        <ThemeSelector />
        <DropdownMenuItem asChild>
          <NavLink to={R.configuracion}><Settings /> Configuración</NavLink>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Al cambiar de ruta, vuelve al inicio (el navegador conserva el scroll del SPA entre páginas; se
 * nota sobre todo en móvil, donde una página larga deja la siguiente a media altura).
 *
 * EXCEPTO en `POP` (atrás/adelante del navegador): ahí el usuario espera volver a donde estaba, y
 * con el chrome persistente esa navegación ya se siente como la del navegador de verdad.
 */
function useScrollToTop() {
  const { pathname } = useLocation();
  const navType = useNavigationType();
  useEffect(() => {
    if (navType === 'POP') return;
    window.scrollTo(0, 0);
    document.scrollingElement?.scrollTo(0, 0);
  }, [pathname, navType]);
}

const COLLAPSED_KEY = 'roz-nav-collapsed';
const IS_MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform);
const SHORTCUT = IS_MAC ? '⌘B' : 'Ctrl B';

/** Menú contraído o no. Se recuerda entre visitas y se alterna con Ctrl/Cmd + B. */
function useCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try { localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1'); } catch { /* modo privado: no se recuerda */ }
      return !c;
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'b' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      // En un campo de texto Ctrl+B es "negrita" (editor de tareas, chat): ahí no se toca.
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
  return [collapsed, toggle];
}

export function AppShell() {
  const { pathname } = useLocation();
  const section = useSection();
  useScrollToTop();
  const [collapsed, toggleCollapsed] = useCollapsed();
  const badges = useNavBadges();
  // El chat ocupa todo el alto y ancho disponible (sus columnas hacen su propio scroll). Su key es
  // fija: cambiar de conversación cambia la URL, pero no debe re-montar la página entera.
  const fullBleed = pathname === R.chat || pathname.startsWith(`${R.chat}/`);

  // Los huecos del header viven en estado (no en refs) porque `Layout` necesita re-renderizar
  // cuando existen para poder portalizar dentro de ellos.
  const [slots, setSlots] = useState<ShellSlots>({ title: null, actionsDesktop: null, actionsMobile: null });
  const set = useRef({
    title: (el: HTMLDivElement | null) => setSlots((s) => (s.title === el ? s : { ...s, title: el })),
    actionsDesktop: (el: HTMLDivElement | null) => setSlots((s) => (s.actionsDesktop === el ? s : { ...s, actionsDesktop: el })),
    actionsMobile: (el: HTMLDivElement | null) => setSlots((s) => (s.actionsMobile === el ? s : { ...s, actionsMobile: el })),
  }).current;
  const ctx = useMemo(() => ({ ...slots, section, fullBleed }), [slots, section, fullBleed]);

  // `--shell-top` y `--shell-pad-b` se MIDEN (no se escriben a mano): el header cambia de alto con
  // el notch, con la fila de acciones en móvil y si algún día se le añade una franja. Así una
  // pantalla puede pedir "el alto que queda" sin números fijos que se desfasan.
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const header = headerRef.current;
    const main = mainRef.current;
    if (!root || !header || !main) return;
    const measure = () => {
      const cs = getComputedStyle(main);
      root.style.setProperty('--shell-top', `${header.offsetHeight + (parseFloat(cs.paddingTop) || 0)}px`);
      root.style.setProperty('--shell-pad-b', `${parseFloat(cs.paddingBottom) || 0}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(header);
    ro.observe(main);
    return () => ro.disconnect();
  }, [fullBleed]);

  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleLabel = collapsed ? 'Expandir menú' : 'Contraer menú';

  return (
    <div ref={rootRef} className={cn('shell flex bg-background', fullBleed ? 'h-dvh overflow-hidden' : 'min-h-dvh')}>
      {/* Sidebar (md+). El ancho se anima; adentro nada cambia de x, así que no hay saltos. */}
      <aside
        data-collapsed={collapsed}
        className="shell-aside group/aside sticky top-0 z-30 hidden h-dvh shrink-0 flex-col overflow-hidden border-r bg-sidebar px-2.5 py-3 md:flex"
      >
        <Brand />
        <nav className="shell-nav scroll-none -mx-1 mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-1 pb-2">
          <NavItems collapsed={collapsed} badges={badges} />
        </nav>
        <div className="flex min-w-0 flex-col gap-0.5 border-t border-dashed pt-2">
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label={toggleLabel}
                aria-expanded={!collapsed}
                className="flex h-8 shrink-0 w-full items-center gap-2.5 rounded-md px-2 text-[13px] text-muted-foreground outline-none transition-colors hover:bg-panel hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="grid size-[22px] shrink-0 place-items-center"><ToggleIcon className="size-4" /></span>
                <span className={cn('min-w-0 flex-1 truncate text-left', FADE)}>Contraer menú</span>
                <kbd className={cn('whitespace-nowrap rounded-[4px] border px-1 py-px font-sans text-[10.5px] font-medium text-faint', FADE)}>{SHORTCUT}</kbd>
              </button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" sideOffset={10}>{toggleLabel} <span className="ml-1.5 opacity-70">{SHORTCUT}</span></TooltipContent>
            )}
          </Tooltip>
          <UserMenu />
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          ref={headerRef}
          className={cn('shell-header sticky top-0 z-20 border-b', fullBleed && 'md:hidden')}
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          {/* Una sola franja: menú, título y acciones. */}
          <div className="flex items-center gap-2 px-4 py-2 md:h-12 md:px-5 md:py-0">
            <MobileNav badges={badges} />
            {/* Logo compacto solo en móvil (la sidebar lo trae en desktop) */}
            <RozLogo className="size-7 shrink-0 md:hidden" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={toggleCollapsed}
                  aria-label={toggleLabel}
                  aria-expanded={!collapsed}
                  className="-ml-1.5 hidden shrink-0 text-muted-foreground md:inline-flex"
                >
                  <ToggleIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start">{toggleLabel} <span className="ml-1.5 opacity-70">{SHORTCUT}</span></TooltipContent>
            </Tooltip>
            <span aria-hidden className="hidden h-4 w-px shrink-0 bg-border md:block" />
            <div ref={set.title} className="min-w-0 flex-1 md:pl-1" />
            {/* Desktop: acciones + pulso de la cola (el tema vive en el menú del avatar) */}
            <div className="hidden shrink-0 items-center gap-2 sm:flex">
              <div ref={set.actionsDesktop} className="contents" />
              <QueuePill />
            </div>
            {/* Móvil: el pulso (colapsado a solo el avatar) */}
            <div className="flex shrink-0 items-center gap-1 sm:hidden">
              <QueuePill />
            </div>
          </div>
          {/* Móvil: acciones en segunda fila, a todo el ancho. `empty:hidden` para que el borde no
              aparezca en las páginas sin acciones (antes la fila entera era condicional). */}
          <div ref={set.actionsMobile} className="border-t px-4 py-2 empty:hidden sm:hidden [&_button]:w-full" />
        </header>
        {/* Sin tope de ancho: cada página elige el suyo con `<Layout width>`. `overflow-x-clip` (no
            `hidden`) para que `position: sticky` siga funcionando dentro de las páginas. */}
        <main
          ref={mainRef}
          className={cn(
            fullBleed
              ? 'min-h-0 w-full flex-1 overflow-hidden'
              : 'w-full flex-1 overflow-x-clip px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-5 md:pb-5',
          )}
        >
          {/* key por ruta → la VISTA se re-monta y re-dispara la transición de entrada. El chrome
              de arriba ya no: vive fuera de esta key. */}
          <div key={fullBleed ? R.chat : pathname} className={cn('animate-page', fullBleed && 'h-full')}>
            <ShellSlotsContext.Provider value={ctx}>
              <Outlet />
            </ShellSlotsContext.Provider>
          </div>
        </main>
      </div>
    </div>
  );
}
