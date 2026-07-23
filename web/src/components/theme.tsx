import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';
const ThemeCtx = createContext<{ theme: Theme; setTheme: (t: Theme) => void; resolved: 'light' | 'dark' }>({
  theme: 'system',
  setTheme: () => {},
  resolved: 'light',
});

const KEY = 'roz-theme';

function systemPrefersDark() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Default: 'system' — light y dark son ambos first-class, así que se respeta la preferencia del
  // SO salvo elección explícita del usuario (recordada en localStorage). El flash inicial lo evita
  // el script anti-FOUC de index.html, que aplica el mismo criterio antes de montar React.
  const initial = (localStorage.getItem(KEY) as Theme) || 'system';
  const [theme, setThemeState] = useState<Theme>(initial);
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    initial === 'dark' || (initial === 'system' && systemPrefersDark()) ? 'dark' : 'light',
  );

  useEffect(() => {
    const apply = () => {
      const r = theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme;
      setResolved(r);
      document.documentElement.classList.toggle('dark', r === 'dark');
    };
    apply();
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [theme]);

  const setTheme = (t: Theme) => {
    localStorage.setItem(KEY, t);
    setThemeState(t);
  };

  return <ThemeCtx.Provider value={{ theme, setTheme, resolved }}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
