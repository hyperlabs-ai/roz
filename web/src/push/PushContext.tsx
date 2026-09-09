import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { isPushSupported, currentSubscription, enablePush, disablePush } from '@/lib/push';

// Estado de las notificaciones push de ESTE dispositivo, en UN solo sitio.
//
// Antes era un hook con estado propio (`lib/usePush.ts`) y se instanciaba dos veces: en el menú de
// usuario del layout y en la tarjeta de Configuración. Cada copia tenía su propio `enabled`, así que
// activabas el push desde el menú y la tarjeta seguía diciendo "Desactivadas" hasta recargar. Mismo
// patrón que `presence/`, `queue/` y `sync/`: el estado compartido vive en un contexto.

type Permission = NotificationPermission | 'unsupported';

interface PushState {
  supported: boolean;
  enabled: boolean;
  busy: boolean;
  permission: Permission;
  toggle: () => Promise<void>;
}

const Ctx = createContext<PushState>({
  supported: false,
  enabled: false,
  busy: false,
  permission: 'unsupported',
  toggle: async () => {},
});

export function PushProvider({ children }: { children: ReactNode }) {
  const [supported] = useState(isPushSupported);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<Permission>(() =>
    'Notification' in window ? Notification.permission : 'unsupported',
  );

  useEffect(() => {
    if (!supported) return;
    currentSubscription().then((s) => setEnabled(!!s)).catch(() => {});
  }, [supported]);

  const toggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (enabled) {
        await disablePush();
        setEnabled(false);
        toast.success('Notificaciones desactivadas');
      } else {
        await enablePush();
        setEnabled(true);
        toast.success('Notificaciones activadas', { description: 'Te avisaremos si un servicio se cae.' });
      }
      if ('Notification' in window) setPermission(Notification.permission);
    } catch (e) {
      if ('Notification' in window) setPermission(Notification.permission);
      toast.error('No se pudo cambiar las notificaciones', { description: String((e as Error)?.message ?? e) });
    } finally {
      setBusy(false);
    }
  }, [busy, enabled]);

  const value = useMemo<PushState>(
    () => ({ supported, enabled, busy, permission, toggle }),
    [supported, enabled, busy, permission, toggle],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const usePush = () => useContext(Ctx);
