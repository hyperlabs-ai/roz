import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { apiGet, ApiError, type AuthedUser } from '../lib/api';
import { resetScope } from '../lib/store';
import { useAuthSnapshot, signOut as storeSignOut } from './store';

interface AuthState {
  session: Session | null;
  user: AuthedUser | null;
  loading: boolean;      // resolviendo la sesión de Supabase
  resolving: boolean;    // hay sesión y aún no sabemos si el backend la acepta
  denied: string | null; // el backend rechazó a este usuario (no está en roz.dev, dominio, etc.)
  failed: string | null; // /me no respondió (red, 500): no es un "no", es que no sabemos
  recovering: boolean;   // se perdió el token y se está recuperando en silencio (ver auth/store.ts)
  retry: () => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState>({
  session: null, user: null, loading: true, resolving: false, denied: null, failed: null,
  recovering: false, retry: () => {}, signOut: async () => {},
});

/**
 * La SESIÓN vive fuera de React (`auth/store.ts`); aquí solo se le añade el perfil que resuelve el
 * backend en /me. Este provider es una fachada delgada para que los ~14 consumidores de `useAuth()`
 * no cambien.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { session, loading, recovering } = useAuthSnapshot();
  const [user, setUser] = useState<AuthedUser | null>(null);
  const [resolving, setResolving] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const sessionUserId = session?.user?.id ?? null;

  // Aislamiento de la caché entre cuentas. Va en el CUERPO DE RENDER, no en un efecto: un efecto
  // corre después de que los hijos ya renderizaron, así que quedaría un frame con los datos del
  // usuario anterior pintados en pantalla. Es un compare-and-set idempotente, seguro con el doble
  // render de StrictMode.
  resetScope(sessionUserId);

  // Con sesión, el backend resuelve el perfil — y decide si esta persona puede entrar. Tener
  // credenciales válidas de Supabase no basta: hay que estar registrado como dev en roz.
  //
  // Depende del ID de usuario, NO del objeto `session`: el token se renueva solo cada ~50 min y
  // volver a preguntar /me por eso no aporta nada (el perfil no cambió) y sí desmontaba la página
  // que estuvieras usando. Cambiar de cuenta sí cambia el id y vuelve a resolver.
  useEffect(() => {
    if (!sessionUserId) {
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

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  const signOut = useCallback(async () => {
    await storeSignOut(); // el store limpia sesión y token; la caché la tira `resetScope`
    setUser(null);
    setDenied(null);
    setFailed(null);
  }, []);

  // Memoizado: sin esto el value era un objeto literal nuevo en cada render, así que un refresh de
  // token re-renderizaba a los 14 consumidores de useAuth() sin que nada hubiera cambiado.
  const value = useMemo<AuthState>(
    () => ({ session, user, loading, resolving, denied, failed, recovering, retry, signOut }),
    [session, user, loading, resolving, denied, failed, recovering, retry, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
