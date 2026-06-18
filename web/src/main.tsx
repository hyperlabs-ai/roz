import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '@/auth/AuthContext';
import { ThemeProvider } from '@/components/theme';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { ErrorBoundary, ErrorScreen } from '@/components/ErrorScreen';
import App from '@/App';
import './styles.css';

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
                <App />
              </AuthProvider>
            </BrowserRouter>
            <Toaster />
          </TooltipProvider>
        </ErrorBoundary>
      )}
    </ThemeProvider>
  </StrictMode>,
);
