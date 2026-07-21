import { useEffect } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
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

// Puerta de autenticación SOLO para el dashboard (/app/*). La landing pública (/) queda fuera.
// Sin sesión muestra el login; con sesión renderiza la ruta hija (Outlet). El listener de
// onAuthStateChange actualiza la sesión tras iniciar, así que esto re-renderiza solo.
function RequireAuth() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  if (!session) return <Login />;
  return <Outlet />;
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
