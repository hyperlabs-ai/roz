import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '@/auth/AuthContext';
import { SyncProvider } from '@/sync/SyncContext';
import { ThemeProvider } from '@/components/theme';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { ErrorBoundary, ErrorScreen } from '@/components/ErrorScreen';
import App from '@/App';
// Geist (tipografía de marca, variable) — sans para UI, mono para números/código.
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';

// Registra el service worker de la PWA (shell offline + web push). Solo en build de producción:
// en dev interferiría con el HMR de Vite. Se prueba desde el deploy o con `vite preview`.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

const root = createRoot(document.getElementById('root')!);

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

root.render(
  <StrictMode>
    <ThemeProvider>
      {!url || !key ? (
        <ErrorScreen
          title="Falta configuración"
          detail={
            'No se encontraron VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.\n\n' +
            '1) Crea web/.env con esas variables (ver web/.env.example)\n' +
            '2) Reinicia el servidor de Vite — solo lee .env al arrancar.'
          }
        />
      ) : (
        <ErrorBoundary>
          <TooltipProvider delayDuration={200}>
            <BrowserRouter>
              <AuthProvider>
                <SyncProvider>
                  <App />
                </SyncProvider>
              </AuthProvider>
            </BrowserRouter>
            <Toaster />
          </TooltipProvider>
        </ErrorBoundary>
      )}
    </ThemeProvider>
  </StrictMode>,
);
