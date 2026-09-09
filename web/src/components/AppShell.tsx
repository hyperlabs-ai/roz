import { createContext, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigationType } from 'react-router-dom';
import { LayoutDashboard, Users, FolderGit2, Server, BarChart3, Sparkles, Sun, Moon, Monitor, LogOut, Menu, Bell, BellOff, Settings, ListChecks, Lightbulb, Activity } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { usePush } from '@/push/PushContext';
import { useTheme } from '@/components/theme';
import { IconSwap, UserAvatar } from '@/components/bits';
import { RozLogo } from '@/components/RozLogo';
import { QueuePill } from '@/components/QueuePill';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
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
 */

export interface ShellSlots {
  title: HTMLElement | null;
  actionsDesktop: HTMLElement | null;
  actionsMobile: HTMLElement | null;
}

/** `null` = no hay shell (se está renderizando un `<Layout>` fuera de su ruta). */
export const ShellSlotsContext = createContext<ShellSlots | null>(null);

const NAV = [
  { to: '/app', label: 'Resumen', icon: LayoutDashboard, end: true },
  { to: '/app/developers', label: 'Developers', icon: Users, end: false },
  { to: '/app/activity', label: 'Actividad', icon: Activity, end: false },
  { to: '/app/projects', label: 'Proyectos', icon: FolderGit2, end: false },
  { to: '/app/infra', label: 'Infraestructura', icon: Server, end: false },
  { to: '/app/ideas', label: 'Ideas', icon: Lightbulb, end: false },
  { to: '/app/tasks', label: 'Tareas', icon: ListChecks, end: false },
  { to: '/app/tickets', label: 'Reportes', icon: BarChart3, end: false },
  { to: '/app/skills', label: 'Skills', icon: Sparkles, end: false },
  { to: '/app/settings', label: 'Configuración', icon: Settings, end: false },
];

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'group/nav relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 ease-spring',
              isActive
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground hover:translate-x-0.5',
            )
          }
        >
          {({ isActive }) => (
            <>
              {/* Indicador activo que crece verticalmente */}
              <span
                className={cn(
                  'absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary transition-all duration-300 ease-spring',
                  isActive ? 'opacity-100' : 'scale-y-0 opacity-0',
                )}
              />
              <n.icon className="size-[18px] transition-transform duration-200 ease-spring group-hover/nav:scale-110" />
              {n.label}
            </>
          )}
        </NavLink>
      ))}
    </>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Tema">
          {/* Los tres iconos están siempre montados y solo cambia cuál está activo: cambiar el
              componente de golpe hacía que el icono nuevo apareciera sin relación con el viejo. */}
          <IconSwap
            state={theme}
            icons={{
              light: <Sun className="size-[18px]" />,
              dark: <Moon className="size-[18px]" />,
              system: <Monitor className="size-[18px]" />,
            }}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}><Sun /> Claro</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}><Moon /> Oscuro</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}><Monitor /> Sistema</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1">
      <RozLogo className="size-8" />
      <div className="leading-tight">
        <div className="text-sm font-extrabold tracking-wide">ROZ</div>
        <div className="text-[11px] text-muted-foreground">Desarrollo</div>
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
        <button className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-accent">
          <UserAvatar url={null} name={user?.name ?? user?.email ?? '?'} className="size-8" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{user?.name ?? user?.email}</div>
            <div className="truncate text-xs capitalize text-muted-foreground">{user?.role ?? 'miembro'}</div>
          </div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{user?.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="shrink-0 md:hidden" aria-label="Menú">
          <Menu />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {NAV.map((n) => (
          <DropdownMenuItem key={n.to} asChild>
            <NavLink to={n.to} end={n.end}>
              <n.icon /> {n.label}
            </NavLink>
          </DropdownMenuItem>
        ))}
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
  useScrollToTop();

  // Los huecos del header viven en estado (no en refs) porque `Layout` necesita re-renderizar
  // cuando existen para poder portalizar dentro de ellos.
  const [slots, setSlots] = useState<ShellSlots>({ title: null, actionsDesktop: null, actionsMobile: null });
  const set = useRef({
    title: (el: HTMLDivElement | null) => setSlots((s) => (s.title === el ? s : { ...s, title: el })),
    actionsDesktop: (el: HTMLDivElement | null) => setSlots((s) => (s.actionsDesktop === el ? s : { ...s, actionsDesktop: el })),
    actionsMobile: (el: HTMLDivElement | null) => setSlots((s) => (s.actionsMobile === el ? s : { ...s, actionsMobile: el })),
  }).current;

  return (
    <div className="flex min-h-dvh">
      {/* Sidebar (md+) */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-1 border-r bg-card p-3 md:flex">
        <Brand />
        <Separator className="my-2" />
        <nav className="flex flex-col gap-1">
          <NavItems />
        </nav>
        <div className="mt-auto">
          <Separator className="mb-2" />
          <UserMenu />
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          {/* Fila principal */}
          <div className="flex items-center gap-2 px-4 py-2.5 md:px-7 md:py-3">
            <MobileNav />
            {/* Logo compacto solo en móvil (la sidebar lo trae en desktop) */}
            <RozLogo className="size-8 shrink-0 md:hidden" />
            <div ref={set.title} className="min-w-0 flex-1" />
            {/* Desktop: acciones + pulso de la cola + tema en línea */}
            <div className="hidden shrink-0 items-center gap-2 sm:flex">
              <div ref={set.actionsDesktop} className="contents" />
              <QueuePill />
              <ThemeToggle />
            </div>
            {/* Móvil: el pulso (colapsado a solo el avatar) y el toggle de tema */}
            <div className="flex shrink-0 items-center gap-1 sm:hidden">
              <QueuePill />
              <ThemeToggle />
            </div>
          </div>
          {/* Móvil: acciones en segunda fila, a todo el ancho. `empty:hidden` para que el borde no
              aparezca en las páginas sin acciones (antes la fila entera era condicional). */}
          <div ref={set.actionsMobile} className="border-t px-4 py-2 empty:hidden sm:hidden [&_button]:w-full" />
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 overflow-x-hidden px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-7 md:pt-7 md:pb-7">
          {/* key por ruta → la VISTA se re-monta y re-dispara la transición de entrada. El chrome
              de arriba ya no: vive fuera de esta key. */}
          <div key={pathname} className="animate-page">
            <ShellSlotsContext.Provider value={slots}>
              <Outlet />
            </ShellSlotsContext.Provider>
          </div>
        </main>
      </div>
    </div>
  );
}
