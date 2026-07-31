import { useEffect } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/auth/AuthContext';
import Login from '@/auth/Login';
import Landing from '@/pages/Landing';
import Overview from '@/pages/Overview';
import Developers from '@/pages/Developers';
import DeveloperProfile from '@/pages/DeveloperProfile';
import Projects from '@/pages/Projects';
import ProjectDetail from '@/pages/ProjectDetail';
import Infra from '@/pages/Infra';
import Tasks from '@/pages/Tasks';
import Tickets from '@/pages/Tickets';
import Skills from '@/pages/Skills';
import Settings from '@/pages/Settings';

// Al cambiar de ruta, vuelve al inicio (el navegador conserva el scroll del SPA entre páginas;
// se nota sobre todo en móvil, donde una página larga deja la siguiente a media altura).
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    document.scrollingElement?.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function Spinner() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
    </div>
  );
}

// Puerta de autenticación SOLO para el dashboard (/app/*). La landing pública (/) queda fuera.
//
// Dos puertas, no una: la sesión de Supabase solo prueba quién eres. Entrar además exige estar
// registrado como dev en roz, y de eso responde el backend en /me. Mientras resuelve se espera —
// si no, el dashboard se pintaría un instante para alguien que no tiene acceso.
function RequireAuth() {
  const { session, loading, resolving, denied, failed, retry, user } = useAuth();

  if (loading) return <Spinner />;
  if (!session) return <Login />;
  if (denied) return <AccessDenied reason={denied} />;
  if (resolving) return <Spinner />;
  // El backend no contestó. No es un rechazo, así que se ofrece reintentar en vez de dejar la
  // pantalla girando para siempre.
  if (failed || !user) return <AuthUnavailable reason={failed} onRetry={retry} />;
  return <Outlet />;
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
    <>
      <ScrollToTop />
      <Routes>
        {/* Pública: landing del producto (self-host / GitHub Developer Program) */}
        <Route path="/" element={<Landing />} />

        {/* Dashboard operativo, detrás de login */}
        <Route path="/app" element={<RequireAuth />}>
          <Route index element={<Overview />} />
          <Route path="developers" element={<Developers />} />
          <Route path="developers/:id" element={<DeveloperProfile />} />
          <Route path="projects" element={<Projects />} />
          <Route path="projects/:id" element={<ProjectDetail />} />
          <Route path="infra" element={<Infra />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="tickets" element={<Tickets />} />
          <Route path="skills" element={<Skills />} />
          <Route path="settings" element={<Settings />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
