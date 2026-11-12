import { createContext, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { NavLink, Outlet, matchPath, useLocation, useNavigationType } from 'react-router-dom';
import { LayoutDashboard, Users, FolderGit2, Server, BarChart3, GraduationCap, Sun, Moon, LogOut, Menu, Bell, BellOff, Settings, ListChecks, Gauge, MessagesSquare, TicketPlus, HeartPulse, Users2, Bot, Monitor } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { usePush } from '@/push/PushContext';
import { useChat } from '@/chat/ChatContext';
import { useTheme } from '@/components/theme';
import { MeAvatar } from '@/components/avatars';
import { useApi } from '@/lib/useApi';
import { DISCORD_STATUS_KEY, discordStatusOrOff } from '@/discord/status';
import { RozLogo } from '@/components/RozLogo';
import { QueuePill } from '@/components/QueuePill';
import { useRozV2 } from '@/components/pulse/roz-v2';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
 * Identidad roz v2: el sidebar es el `aside` de la consola del mock (fondo un punto distinto,
 * secciones con `label-caps`, activo en naranja suave con su cuadrito naranja) y el header lleva
 * eyebrow + título compacto, sin descripción.
 */

export interface ShellSlots {
  title: HTMLElement | null;
  actionsDesktop: HTMLElement | null;
  actionsMobile: HTMLElement | null;
  /** Sección del menú de la ruta actual: el eyebrow por defecto del título. */
  section?: string | null;
}

/** `null` = no hay shell (se está renderizando un `<Layout>` fuera de su ruta). */
export const ShellSlotsContext = createContext<ShellSlots | null>(null);

// `badge: 'chat'` pinta junto a la etiqueta el contador del chat (MDs + menciones, o un punto).
type NavIcon = ComponentType<{ className?: string; strokeWidth?: number | string }>;
type NavItem = { to: string; label: string; icon: NavIcon; end: boolean; badge?: 'chat' };
type NavSection = { label: string; items: NavItem[] };

/** Logo oficial de Discord como ícono del menú (cuando el chat ES Discord). */
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
  overview: { label: 'Resumen', icon: LayoutDashboard },
  chat: { to: '/app/chat', label: 'Chat', icon: MessagesSquare, end: false, badge: 'chat' },
  developers: { to: '/app/developers', label: 'Developers', icon: Users, end: false },
  capacity: { to: '/app/capacity', label: 'Capacidad', icon: Gauge, end: false },
  projects: { to: '/app/projects', label: 'Proyectos', icon: FolderGit2, end: false },
  infra: { to: '/app/infra', label: 'Infraestructura', icon: Server, end: false },
  ticket: { to: '/app/ticket', label: 'Ticket', icon: TicketPlus, end: false },
  tasks: { to: '/app/tasks', label: 'Tareas', icon: ListChecks, end: false },
  reports: { to: '/app/tickets', label: 'Reportes', icon: BarChart3, end: false },
  skills: { to: '/app/skills', label: 'Skills', icon: GraduationCap, end: false },
  settings: { to: '/app/settings', label: 'Configuración', icon: Settings, end: false },
  meetings: { to: '/app/meetings', label: 'Juntas', icon: Users2, end: false },
  plans: { to: '/app/plans', label: 'Planes', icon: Bot, end: false },
} as const satisfies Record<string, Partial<NavItem>>;

/**
 * Menú según roz v2, agrupado en secciones como la consola del mock. Con Linear como fuente de
 * verdad el Pulso pasa a ser la pantalla principal (`/app`), el Resumen se mueve a `/app/overview`
 * y aparecen Juntas y Planes (sus endpoints responden 409 con el flag apagado, así que sin él no se
 * ofrecen). Con el flag apagado el menú es el de siempre más el Pulso, que es lectura pura.
 *
 * Actividad ya no es página (se unificó con el Pulso: su historial de eventos vive ahí) e Ideas se
 * quitó por completo. Con el chat de Discord activo, "Chat" se llama "Discord" y lleva su logo.
 */
function useNav(): NavSection[] {
  const v2 = useRozV2();
  // Misma caché que MeAvatar y la página del chat: no agrega peticiones.
  const discord = useApi(() => discordStatusOrOff(), [], { key: DISCORD_STATUS_KEY, ttl: 60_000 });
  const sot = v2.linearSourceOfTruth;
  const pulse: NavItem = sot
    ? { to: '/app', label: 'Pulso', icon: HeartPulse, end: true }
    : { to: '/app/pulse', label: 'Pulso', icon: HeartPulse, end: false };
  const overview: NavItem = sot
    ? { ...I.overview, to: '/app/overview', end: false }
    : { ...I.overview, to: '/app', end: true };
  const chat: NavItem = discord.data?.enabled ? { ...I.chat, label: 'Discord', icon: DiscordNavIcon } : I.chat;
  const visibility = sot ? [pulse, overview] : [overview, pulse];
  return [
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

/** Contador del chat: número con MDs sin leer / menciones; punto si solo hay actividad en canales. */
function ChatBadge({ className }: { className?: string }) {
  const { badge } = useChat();
  if (badge.count > 0) {
    return (
      <span className={cn('ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-destructive px-1.5 text-[10.5px] font-semibold text-destructive-foreground tabular-nums', className)}>
        {badge.count > 99 ? '99+' : badge.count}
      </span>
    );
  }
  if (badge.dot) return <span className={cn('ml-auto size-2 rounded-full bg-primary', className)} aria-label="Hay mensajes nuevos" />;
  return null;
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const nav = useNav();
  return (
    <>
      {nav.map((section) => (
        <div key={section.label} className="grid gap-0.5">
          {/* Etiqueta de sección del mock (`.aside .sec`). */}
          <div className="px-2.5 pb-1 pt-3 label-caps text-faint">{section.label}</div>
          {section.items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'group/nav flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] transition-colors duration-200 ease-spring',
                  isActive
                    ? 'bg-orange-soft font-semibold text-orange-ink'
                    : 'text-foreground hover:bg-panel',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {/* El "cuadrito" del mock (`.tab .ic`): gris en reposo, naranja en el activo, con
                      el icono adentro para no perder la lectura rápida de cada sección. */}
                  <span
                    className={cn(
                      'grid size-[18px] shrink-0 place-items-center rounded-[4px] transition-colors duration-200',
                      isActive ? 'bg-orange text-white' : 'bg-panel text-muted-foreground group-hover/nav:bg-toggle-off/60',
                    )}
                  >
                    <n.icon className="size-3" strokeWidth={2.25} />
                  </span>
                  <span className="min-w-0 truncate">{n.label}</span>
                  {n.badge === 'chat' && <ChatBadge />}
                </>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </>
  );
}


function Brand() {
  return (
    <div className="flex items-center justify-between gap-2 px-2.5 pb-1 pt-1.5">
      <RozLogo wordmark className="size-[26px]" />
      <span className="label-caps text-faint">Desarrollo</span>
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
        <button className="flex w-full items-center gap-2.5 rounded-md p-2 text-left transition-colors hover:bg-panel">
          <MeAvatar className="size-8" />
          <div className="min-w-0 flex-1">
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
          <NavLink to="/app/settings"><Settings /> Configuración</NavLink>
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

function MobileNav() {
  const { badge } = useChat();
  const nav = useNav();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative shrink-0 md:hidden" aria-label="Menú">
          <Menu />
          {(badge.count > 0 || badge.dot) && (
            <span className={cn('absolute right-1 top-1 size-2 rounded-full ring-2 ring-background', badge.count > 0 ? 'bg-destructive' : 'bg-primary')} />
          )}
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
                  {n.badge === 'chat' && <ChatBadge />}
                </NavLink>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        {/* En móvil no hay menú del avatar: Configuración y el tema van al final de este menú. */}
        <DropdownMenuSeparator />
        <ThemeSelector />
        <DropdownMenuItem asChild>
          <NavLink to="/app/settings"><Settings /> Configuración</NavLink>
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

export function AppShell() {
  const { pathname } = useLocation();
  const section = useSection();
  useScrollToTop();
  // El chat ocupa todo el alto y ancho disponible (sus columnas hacen su propio scroll). Su key es
  // fija: cambiar de conversación cambia la URL, pero no debe re-montar la página entera.
  const fullBleed = pathname === '/app/chat' || pathname.startsWith('/app/chat/');

  // Los huecos del header viven en estado (no en refs) porque `Layout` necesita re-renderizar
  // cuando existen para poder portalizar dentro de ellos.
  const [slots, setSlots] = useState<ShellSlots>({ title: null, actionsDesktop: null, actionsMobile: null });
  const set = useRef({
    title: (el: HTMLDivElement | null) => setSlots((s) => (s.title === el ? s : { ...s, title: el })),
    actionsDesktop: (el: HTMLDivElement | null) => setSlots((s) => (s.actionsDesktop === el ? s : { ...s, actionsDesktop: el })),
    actionsMobile: (el: HTMLDivElement | null) => setSlots((s) => (s.actionsMobile === el ? s : { ...s, actionsMobile: el })),
  }).current;
  const ctx = useMemo(() => ({ ...slots, section }), [slots, section]);

  return (
    <div className={cn('flex bg-background', fullBleed ? 'h-dvh overflow-hidden' : 'min-h-dvh')}>
      {/* Sidebar (md+): el `aside` de la consola del mock. */}
      <aside className="sticky top-0 hidden h-screen w-[220px] shrink-0 flex-col border-r bg-sidebar px-2.5 py-3.5 md:flex">
        <Brand />
        <nav className="scroll-thin -mx-1 mt-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1 pb-2">
          <NavItems />
        </nav>
        <div className="border-t pt-2">
          <UserMenu />
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={cn('sticky top-0 z-20 border-b bg-background/85 backdrop-blur-md', fullBleed && 'md:hidden')}
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          {/* Fila principal */}
          <div className="flex items-center gap-2 px-4 py-2.5 md:min-h-[68px] md:px-8 md:py-3">
            <MobileNav />
            {/* Logo compacto solo en móvil (la sidebar lo trae en desktop) */}
            <RozLogo className="size-7 shrink-0 md:hidden" />
            <div ref={set.title} className="min-w-0 flex-1" />
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
        <main
          className={cn(
            fullBleed
              ? 'min-h-0 w-full flex-1 overflow-hidden'
              : 'mx-auto w-full max-w-[1680px] flex-1 overflow-x-clip px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-8 md:pt-6 md:pb-8',
          )}
        >
          {/* key por ruta → la VISTA se re-monta y re-dispara la transición de entrada. El chrome
              de arriba ya no: vive fuera de esta key. */}
          <div key={fullBleed ? '/app/chat' : pathname} className={cn('animate-page', fullBleed && 'h-full')}>
            <ShellSlotsContext.Provider value={ctx}>
              <Outlet />
            </ShellSlotsContext.Provider>
          </div>
        </main>
      </div>
    </div>
  );
}
