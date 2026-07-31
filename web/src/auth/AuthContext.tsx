import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { apiGet, ApiError, type AuthedUser } from '../lib/api';

interface AuthState {
  session: Session | null;
  user: AuthedUser | null;
  loading: boolean;      // resolviendo la sesión de Supabase
  resolving: boolean;    // hay sesión y aún no sabemos si el backend la acepta
  denied: string | null; // el backend rechazó a este usuario (no está en roz.dev, dominio, etc.)
  failed: string | null; // /me no respondió (red, 500): no es un "no", es que no sabemos
  retry: () => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState>({
  session: null, user: null, loading: true, resolving: false, denied: null, failed: null,
  retry: () => {}, signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<AuthedUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Con sesión, el backend resuelve el perfil — y decide si esta persona puede entrar. Tener
  // credenciales válidas de Supabase no basta: hay que estar registrado como dev en roz.
  useEffect(() => {
    if (!session) {
      setUser(null);
      setDenied(null);
      setFailed(null);
      setResolving(false);
      return;
    }
    let alive = true;
    setResolving(true);
    setDenied(null);
    setFailed(null);
    apiGet<{ user: AuthedUser }>('/me')
      .then((r) => {
        if (!alive) return;
        setUser(r.user);
        setResolving(false);
      })
      .catch((e) => {
        if (!alive) return;
        setUser(null);
        // 401/403 es un "no" del backend: esta persona no entra, y merece su pantalla.
        // Cualquier otro fallo (red caída, 500) NO es un rechazo — es que no pudimos preguntar.
        // Distinguirlos importa: si se tratan igual, una caída del servidor deja la app colgada
        // en un spinner eterno sin decir por qué.
        const status = e instanceof ApiError ? e.status : 0;
        if (status === 401 || status === 403) setDenied(String(e.message));
        else setFailed(String(e?.message ?? e));
        setResolving(false);
      });
    return () => { alive = false; };
  }, [session, attempt]);

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setDenied(null);
    setFailed(null);
  };

  return (
    <Ctx.Provider value={{ session, user, loading, resolving, denied, failed, retry: () => setAttempt((a) => a + 1), signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
