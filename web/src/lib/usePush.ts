import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { isPushSupported, currentSubscription, enablePush, disablePush } from './push';

type Permission = NotificationPermission | 'unsupported';

// Estado de las notificaciones push de ESTE dispositivo + acción para activarlas/desactivarlas.
export function usePush() {
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

  return { supported, enabled, busy, permission, toggle };
}
