import { Routes, Route } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import Login from '@/auth/Login';
import Overview from '@/pages/Overview';
import Developers from '@/pages/Developers';
import DeveloperProfile from '@/pages/DeveloperProfile';
import Projects from '@/pages/Projects';
import ProjectDetail from '@/pages/ProjectDetail';
import Skills from '@/pages/Skills';

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
    <Routes>
      <Route path="/" element={<Overview />} />
      <Route path="/developers" element={<Developers />} />
      <Route path="/developers/:id" element={<DeveloperProfile />} />
      <Route path="/projects" element={<Projects />} />
      <Route path="/projects/:id" element={<ProjectDetail />} />
      <Route path="/skills" element={<Skills />} />
      <Route path="*" element={<Overview />} />
    </Routes>
  );
}
