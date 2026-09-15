import { useRef } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
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
import Activity from '@/pages/Activity';
import Ideas from '@/pages/Ideas';
import Tasks from '@/pages/Tasks';
import Capacity from '@/pages/Capacity';
import Tickets from '@/pages/Tickets';
import Skills from '@/pages/Skills';
import Settings from '@/pages/Settings';

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
    <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-xs text-warning backdrop-blur">
      <span className="size-1.5 animate-pulse rounded-full bg-warning" />
      <span className="truncate">{text}</span>
      {onRetry && (
        <button onClick={onRetry} className="press font-medium underline underline-offset-2">
          Reintentar
        </button>
      )}
    </div>
  );
}

// Puerta de autenticación SOLO para el dashboard (/app/*). La landing pública (/) queda fuera.
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

export default function App() {
  return (
    <Routes>
        {/* Pública: landing del producto (self-host / GitHub Developer Program) */}
        <Route path="/" element={<Landing />} />

        {/* Dashboard operativo, detrás de login. El chrome (sidebar/header) es una ruta layout SIN
            path, así que permanece montado al navegar entre secciones. */}
        <Route path="/app" element={<RequireAuth />}>
          <Route element={<AppShell />}>
            <Route index element={<Overview />} />
            <Route path="developers" element={<Developers />} />
            <Route path="developers/:id" element={<DeveloperProfile />} />
            <Route path="projects" element={<Projects />} />
            <Route path="projects/:id" element={<ProjectDetail />} />
            <Route path="infra" element={<Infra />} />
            {/* A propósito FUERA del nav lateral: se llega desde el pulso del header. */}
            <Route path="activity" element={<Activity />} />
            <Route path="ideas" element={<Ideas />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="capacity" element={<Capacity />} />
            <Route path="tickets" element={<Tickets />} />
            <Route path="skills" element={<Skills />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
