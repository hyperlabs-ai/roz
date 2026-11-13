import { useRef } from 'react';
import { Routes, Route, Navigate, Outlet, generatePath, useLocation, useParams } from 'react-router-dom';
import { ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/auth/AuthContext';
import { AppShell } from '@/components/AppShell';
import Login from '@/auth/Login';
import Landing from '@/pages/Landing';
import Overview from '@/pages/Overview';
import Developers from '@/pages/Developers';
import DeveloperProfile from '@/pages/DeveloperProfile';
import Projects from '@/pages/Projects';
import ProjectDetail from '@/pages/ProjectDetail';
import Infra from '@/pages/Infra';
import Tasks from '@/pages/Tasks';
import Capacity from '@/pages/Capacity';
import Tickets from '@/pages/Tickets';
import Ticket from '@/pages/Ticket';
import Skills from '@/pages/Skills';
import Settings from '@/pages/Settings';
import Chat from '@/pages/Chat';
import Pulse from '@/pages/Pulse';
import Meetings from '@/pages/Meetings';
import Plans from '@/pages/Plans';
import Zeus from '@/pages/Zeus';
import { LEGACY_ROUTES, R, stripAppPrefix, zeusTabTarget } from '@/lib/routes';

/**
 * `/zeus` fue la dirección de zeus antes de volverse la pantalla principal, y sus secciones
 * fueron pestañas (`?tab=bandeja`). Los enlaces viejos (avisos push, marcadores) siguen llegando
 * ahí: se mandan a la ruta de la sección conservando el resto de la consulta.
 */
function ZeusRedirect() {
  const { search, hash } = useLocation();
  const target = zeusTabTarget(search) ?? { pathname: R.mapa, search };
  return <Navigate to={{ ...target, hash }} replace />;
}

/** Ruta que cambió de nombre: redirige a la nueva con sus parámetros, su consulta y su hash. */
function Renamed({ to }: { to: string }) {
  const params = useParams();
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: generatePath(`/${to}`, params), search, hash }} replace />;
}

/**
 * La app vivió bajo `/app`. Los avisos push, los correos y los enlaces de Discord que genera el
 * backend siguen apuntando ahí: `/app/lo-que-sea` se manda a `/lo-que-sea` con su consulta y su hash.
 * Si ese nombre además es viejo (`/app/tasks`, `/app/zeus?tab=bandeja`), la ruta de destino hace la
 * segunda redirección. Va FUERA de la puerta de sesión: primero se corrige la dirección y luego,
 * si hace falta, se pide el login ya en la dirección buena.
 */
export function FromAppPrefix() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={{ pathname: stripAppPrefix(pathname), search, hash }} replace />;
}

function Spinner() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
    </div>
  );
}

/**
 * Franja fina y no bloqueante bajo el header. Es el reemplazo de "intercambiar el árbol" cuando algo
 * de la sesión se tuerce a media faena: se sigue viendo el dashboard con sus datos, y la app te dice
 * qué está pasando. Un toast de sonner no sirve aquí — se auto-cierra y mentiría mientras el
 * problema sigue vivo.
 */
function SessionStrip({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 border-b border-yellow/40 bg-yellow-soft px-4 py-1.5 label-caps text-yellow-ink backdrop-blur">
      <span className="size-1.5 animate-pulse rounded-full bg-yellow" />
      <span className="truncate">{text}</span>
      {onRetry && (
        <button onClick={onRetry} className="press font-medium underline underline-offset-2">
          Reintentar
        </button>
      )}
    </div>
  );
}

// Puerta de autenticación de la app (todo salvo la landing pública, que vive en /landing).
//
// Dos puertas, no una: la sesión de Supabase solo prueba quién eres. Entrar además exige estar
// registrado como dev en roz, y de eso responde el backend en /me. Mientras resuelve se espera —
// si no, el dashboard se pintaría un instante para alguien que no tiene acceso.
//
// El invariante que hace IMPOSIBLE el remount: una vez que alguien entró, ningún estado posterior
// vuelve a sustituir el <Outlet/> por otro árbol. Antes había cinco early-returns antes de él y
// cualquier tránsito por uno de ellos desmontaba el dashboard completo (perdiendo scroll, filtros y
// lo que estuvieras escribiendo). Ahora eso solo puede pasar con un rechazo real del backend
// (`denied`) o un cierre de sesión confirmado; el resto degrada en sitio, con la franja.
function RequireAuth() {
  const { session, loading, resolving, denied, failed, recovering, retry, user } = useAuth();
  const enteredOnce = useRef(false);
  if (user) enteredOnce.current = true;

  // Un 403 es una respuesta real del backend: saca, aunque sea a media sesión.
  if (denied) return <AccessDenied reason={denied} />;

  if (enteredOnce.current) {
    return (
      <>
        {recovering && <SessionStrip text="Reconectando tu sesión…" />}
        {!recovering && failed && <SessionStrip text={`Sin conexión con el servidor: ${failed}`} onRetry={retry} />}
        <Outlet />
      </>
    );
  }

  // Primera vez, y solo la primera vez.
  if (loading) return <Spinner />;
  if (!session) return <Login />;
  if (resolving) return <Spinner />;
  // El backend no contestó. No es un rechazo, así que se ofrece reintentar en vez de dejar la
  // pantalla girando para siempre.
  return <AuthUnavailable reason={failed} onRetry={retry} />;
}

function AuthUnavailable({ reason, onRetry }: { reason: string | null; onRetry: () => void }) {
  const { signOut } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center p-5">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-4 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
          <ShieldX className="size-5" />
        </div>
        <h1 className="text-lg font-semibold tracking-tight">No pudimos verificar tu sesión</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {reason ?? 'El servidor no respondió.'}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={onRetry}>Reintentar</Button>
          <Button variant="outline" onClick={signOut}>Cerrar sesión</Button>
        </div>
      </div>
    </div>
  );
}

function AccessDenied({ reason }: { reason: string }) {
  const { session, signOut } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center p-5">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-4 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
          <ShieldX className="size-5" />
        </div>
        <h1 className="text-lg font-semibold tracking-tight">Sin acceso</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{reason}</p>
        {session?.user?.email && (
          <p className="mt-3 text-xs text-muted-foreground">
            Entraste como <span className="font-medium text-foreground">{session.user.email}</span>.
            Pide que te den de alta como developer, o entra con otra cuenta.
          </p>
        )}
        <Button variant="outline" className="mt-6" onClick={signOut}>Cerrar sesión</Button>
      </div>
    </div>
  );
}

/**
 * El árbol del dashboard: el chrome (`AppShell`) como ruta layout SIN path, así que permanece
 * montado al navegar entre secciones, y debajo cada pantalla. Va aparte de `App` para poder
 * montarlo sin la puerta de sesión (vista previa del shell, pruebas de rutas).
 */
export function dashboardRoutes() {
  return (
    <Route element={<AppShell />}>
      {/* Zeus (el contexto del equipo): el mapa es la pantalla principal y cada sección tiene su
          ruta. La navegación entre ellas vive en el menú lateral. */}
      <Route index element={<Zeus section="mapa" />} />
      <Route path="biblioteca" element={<Zeus section="biblioteca" />} />
      <Route path="bandeja" element={<Zeus section="bandeja" />} />
      <Route path="equipo" element={<Zeus section="equipo" />} />
      <Route path="llaves" element={<Zeus section="llaves" />} />
      <Route path="acceso" element={<Zeus section="acceso" />} />

      <Route path="pulso" element={<Pulse />} />
      <Route path="resumen" element={<Overview />} />
      <Route path="developers" element={<Developers />} />
      <Route path="developers/:id" element={<DeveloperProfile />} />
      <Route path="capacidad" element={<Capacity />} />
      <Route path="proyectos" element={<Projects />} />
      <Route path="proyectos/:id" element={<ProjectDetail />} />

      <Route path="juntas" element={<Meetings />} />
      {/* Ticket inteligente (crear). Los reportes de trabajo viven en /reportes. */}
      <Route path="ticket" element={<Ticket />} />
      <Route path="tareas" element={<Tasks />} />
      <Route path="chat" element={<Chat />} />
      <Route path="chat/m/:messageId" element={<Chat />} />
      <Route path="chat/:conversationId" element={<Chat />} />

      <Route path="planes" element={<Plans />} />
      <Route path="skills" element={<Skills />} />

      <Route path="infra" element={<Infra />} />
      <Route path="reportes" element={<Tickets />} />
      <Route path="configuracion" element={<Settings />} />

      {/* Compatibilidad: rutas con el nombre viejo (ver `routes.ts`). */}
      <Route path="zeus" element={<ZeusRedirect />} />
      {/* Actividad se unificó con el Pulso: el historial de eventos vive ahí. */}
      <Route path="activity" element={<Navigate to={`${R.pulso}#historial`} replace />} />
      {LEGACY_ROUTES.map(([from, to]) => (
        <Route key={from} path={from} element={<Renamed to={to} />} />
      ))}
      {/* Ruta desconocida: al mapa. */}
      <Route path="*" element={<Navigate to={R.mapa} replace />} />
    </Route>
  );
}

export default function App() {
  return (
    <Routes>
        {/* Pública: landing del producto (self-host / GitHub Developer Program). Ya no es la raíz:
            quien entra a diario cae directo en la app. */}
        <Route path={R.landing} element={<Landing />} />

        {/* Compatibilidad: la app vivió bajo /app. */}
        <Route path="/app/*" element={<FromAppPrefix />} />

        {/* La app, detrás de login, en la raíz. Su comodín recoge cualquier ruta desconocida. */}
        <Route path="/" element={<RequireAuth />}>
          {dashboardRoutes()}
        </Route>
    </Routes>
  );
}
