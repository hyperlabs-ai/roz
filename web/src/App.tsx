import { useEffect } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import Login from '@/auth/Login';
import Overview from '@/pages/Overview';
import Developers from '@/pages/Developers';
import DeveloperProfile from '@/pages/DeveloperProfile';
import Projects from '@/pages/Projects';
import ProjectDetail from '@/pages/ProjectDetail';
import Infra from '@/pages/Infra';
import Tickets from '@/pages/Tickets';
import Skills from '@/pages/Skills';

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

export default function App() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  if (!session) return <Login />;

  return (
    <>
    <ScrollToTop />
    <Routes>
      <Route path="/" element={<Overview />} />
      <Route path="/developers" element={<Developers />} />
      <Route path="/developers/:id" element={<DeveloperProfile />} />
      <Route path="/projects" element={<Projects />} />
      <Route path="/projects/:id" element={<ProjectDetail />} />
      <Route path="/infra" element={<Infra />} />
      <Route path="/tickets" element={<Tickets />} />
      <Route path="/skills" element={<Skills />} />
      <Route path="*" element={<Overview />} />
    </Routes>
    </>
  );
}
