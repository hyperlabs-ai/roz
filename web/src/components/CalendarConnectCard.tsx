import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, TriangleAlert, Link2, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/useApi';
import { apiGet, apiSend, type CalendarConnection } from '@/lib/api';
import { relative } from '@/lib/format';
import { usePresence } from '@/presence/PresenceContext';

/** Desenlaces con los que el callback de OAuth devuelve al usuario a esta pantalla. */
const OUTCOME: Record<string, { ok: boolean; text: string }> = {
  ok: { ok: true, text: 'Calendario conectado' },
  denied: { ok: false, text: 'No autorizaste el acceso' },
  state: { ok: false, text: 'La sesión de conexión expiró — vuelve a intentarlo' },
  error: { ok: false, text: 'No se pudo conectar el calendario' },
};

/**
 * Conexión con Google Calendar. Cada quien conecta SU cuenta: el backend saca el dev del token de
 * sesión, así que desde aquí no se puede tocar el calendario de nadie más.
 */
export function CalendarConnectCard() {
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const { refresh: refreshPresence } = usePresence();
  const { data, reload } = useApi<CalendarConnection>(() => apiGet('/calendar/status'), []);

  // Feedback del redirect de Google. Se limpia el query param para que un refresh no vuelva a
  // mostrar el mismo aviso.
  const outcome = params.get('calendar');
  useEffect(() => {
    if (!outcome) return;
    const o = OUTCOME[outcome];
    if (o) (o.ok ? toast.success : toast.error)(o.text);
    if (o?.ok) {
      reload();
      refreshPresence();
    }
    params.delete('calendar');
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  if (!data?.available) return null; // deploy sin credenciales de Google: no hay nada que ofrecer

  const revoked = data.status === 'revoked';
  // Conectada pero sin poder leer la agenda. Importa mostrarlo: el flujo de OAuth puede terminar
  // "bien" y fallar el primer sondeo (permisos insuficientes, API deshabilitada), y sin este aviso
  // la tarjeta diría "conectado" mientras el dashboard no muestra ningún estado.
  const failing = data.status === 'error';

  async function connect() {
    setBusy(true);
    try {
      const { url } = await apiSend<{ url: string }>('POST', '/calendar/connect');
      window.location.assign(url);
    } catch (e) {
      setBusy(false);
      toast.error('No se pudo iniciar la conexión', { description: String((e as Error)?.message ?? e) });
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await apiSend('DELETE', '/calendar');
      toast.success('Calendario desconectado');
      reload();
      refreshPresence();
    } catch (e) {
      toast.error('No se pudo desconectar', { description: String((e as Error)?.message ?? e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CalendarDays className="size-4" /> Google Calendar</CardTitle>
        <CardDescription>
          Muestra al equipo si estás ocupado y hasta qué hora. roz solo lee tus eventos — nunca crea,
          edita ni borra nada.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {data.connected ? (data.googleEmail ?? 'Cuenta conectada') : 'Sin conectar'}
            </div>
            <div className="text-xs text-muted-foreground">
              {data.connected
                ? data.lastSyncedAt
                  ? `Última sincronización ${relative(data.lastSyncedAt)}`
                  : 'Sincronizando…'
                : 'Tu estado no aparece en el dashboard.'}
            </div>
          </div>
          <Button
            variant={data.connected ? 'outline' : 'default'}
            size="sm"
            onClick={data.connected ? disconnect : connect}
            disabled={busy}
            className="shrink-0"
          >
            {data.connected ? <Unlink /> : <Link2 />}
            {busy ? '…' : data.connected ? 'Desconectar' : 'Conectar'}
          </Button>
        </div>

        {(revoked || failing) && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="text-muted-foreground">
              <p className="font-medium text-foreground">
                {revoked ? 'Se revocó el acceso' : 'No se pudo leer tu calendario'}
              </p>
              {revoked
                ? 'roz ya no puede leer tu calendario. Desconecta y vuelve a conectar para restablecerlo.'
                : 'La cuenta está conectada pero el último intento de leer tu agenda falló. Desconecta y vuelve a conectar; si sigue, revísalo con quien administre el proyecto de Google Cloud.'}
            </div>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          El equipo ve el título del evento en curso y la hora en que termina. Los eventos marcados como
          «Disponible», los de todo el día y los que rechazaste no cuentan como ocupado.
        </p>
      </CardContent>
    </Card>
  );
}
