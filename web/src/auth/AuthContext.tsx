import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { apiGet, type AuthedUser } from '../lib/api';

interface AuthState {
  session: Session | null;
  user: AuthedUser | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState>({ session: null, user: null, loading: true, signOut: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<AuthedUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Cuando hay sesión, resolvemos el perfil/rol vía el backend (que valida dominio).
  useEffect(() => {
    if (!session) {
      setUser(null);
      return;
    }
    apiGet<{ user: AuthedUser }>('/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
  }, [session]);

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  return <Ctx.Provider value={{ session, user, loading, signOut }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
