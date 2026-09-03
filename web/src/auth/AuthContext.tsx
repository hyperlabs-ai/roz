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
    // supabase-js re-emite SIGNED_IN / TOKEN_REFRESHED cada vez que la pestaña vuelve a estar
    // visible, y entrega un OBJETO NUEVO aunque la sesión sea exactamente la misma. Guardarlo tal
    // cual cambiaba la identidad de `session` → se re-disparaba /me → `resolving` → RequireAuth
    // pintaba el spinner en lugar del <Outlet/>: el dashboard entero se DESMONTABA y cada página
    // volvía a cargar desde cero al regresar de otra pestaña (perdiendo scroll, filtros abiertos y
    // lo que estuvieras escribiendo en un modal). Solo se propaga si de verdad cambió el token.
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession((prev) =>
        prev?.access_token === s?.access_token && prev?.user?.id === s?.user?.id ? prev : s,
      );
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Con sesión, el backend resuelve el perfil — y decide si esta persona puede entrar. Tener
  // credenciales válidas de Supabase no basta: hay que estar registrado como dev en roz.
  //
  // Depende del ID de usuario, NO del objeto `session`: el token se renueva solo cada ~50 min y
  // volver a preguntar /me por eso no aporta nada (el perfil no cambió) y sí desmontaba la página
  // que estuvieras usando. Cambiar de cuenta sí cambia el id y vuelve a resolver.
  const sessionUserId = session?.user?.id ?? null;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUserId, attempt]);

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
