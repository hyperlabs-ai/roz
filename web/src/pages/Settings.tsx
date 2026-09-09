import { useEffect, useState } from 'react';
import {
  Bell, BellOff, Sun, Moon, Monitor, LogOut, TriangleAlert, Smartphone, Check, Mail, Power, Users,
} from 'lucide-react';
import { Layout } from '@/components/Layout';
import { useAuth } from '@/auth/AuthContext';
import { useTheme } from '@/components/theme';
import { usePush } from '@/push/PushContext';
import { CalendarConnectCard } from '@/components/CalendarConnectCard';
import { UserAvatar } from '@/components/bits';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useApi } from '@/lib/useApi';
import { useAction } from '@/lib/useAction';
import { apiGet, apiSend, type NotificationSwitch, type NotificationSwitches, type SwitchPatch } from '@/lib/api';
import { relative } from '@/lib/format';

// iPhone/iPad y si la app corre instalada (standalone). En iOS el push SOLO funciona con la PWA
// añadida a la pantalla de inicio, así que si no está instalada lo indicamos.
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

const THEMES = [
  { key: 'light' as const, label: 'Claro', icon: Sun },
  { key: 'dark' as const, label: 'Oscuro', icon: Moon },
  { key: 'system' as const, label: 'Sistema', icon: Monitor },
];

/** Interruptor. Sin dependencia nueva: un botón con role="switch" (accesible por teclado). */
function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        't-toggle press relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:pointer-events-none disabled:opacity-50',
        checked ? 'border-primary bg-primary' : 'border-input bg-muted',
      )}
    >
      {/* El recorrido y la curva los pone la receta `27-toggle` desde `aria-checked`, que este
          botón ya expone por accesibilidad: no hace falta un segundo estado en las clases. */}
      <span className="t-toggle-thumb size-3.5 rounded-full bg-background shadow-sm" />
    </button>
  );
}

/** Fila título + descripción + interruptor. */
function SwitchRow({
  icon: Icon,
  title,
  hint,
  checked,
  disabled,
  onChange,
}: {
  icon: typeof Mail;
  title: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className={cn('mt-0.5 size-4 shrink-0', checked ? 'text-foreground' : 'text-muted-foreground')} />
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{hint}</div>
        </div>
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={title} />
    </div>
  );
}

export default function Settings() {
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const push = usePush();

  const iosNeedsInstall = isIOS && !isStandalone;
  const blocked = push.permission === 'denied';

  // Interruptores de notificaciones: los míos y el killswitch del equipo.
  const switches = useApi(() => apiGet<NotificationSwitches>('/notifications/switches'), [], {
    key: '/notifications/switches',
    ttl: 60_000,
  });
  // Espejo local para el update optimista: el interruptor tiene que responder al instante y
  // revertirse solo si el backend rechaza el cambio.
  const [state, setState] = useState<NotificationSwitches | null>(null);
  // `busy` POR INTERRUPTOR: antes era un solo flag para los cuatro, así que mover "mis correos"
  // bloqueaba visualmente también los del equipo.
  const action = useAction();

  useEffect(() => {
    if (switches.data) setState(switches.data);
  }, [switches.data]);

  /** Clave del candado: un interruptor concreto (`me:email`, `global:push`…). */
  const switchKey = (scope: 'me' | 'global', body: SwitchPatch) =>
    `${scope}:${body.emailEnabled !== undefined ? 'email' : 'push'}`;

  async function patch(scope: 'me' | 'global', body: SwitchPatch, note?: { title: string; description?: string }) {
    if (!state) return;
    const previous = state;
    setState(
      scope === 'global'
        ? { ...state, global: { ...state.global, ...body } }
        : { ...state, me: { ...state.me, ...body } },
    );
    const ok = await action.run(switchKey(scope, body), async () => {
      const res = await apiSend<{ global?: NotificationSwitch; me?: NotificationSwitch }>(
        'PATCH',
        `/notifications/switches/${scope}`,
        body,
      );
      // El backend devuelve la fila real (incluye quién y cuándo movió el interruptor global).
      setState((s) =>
        !s
          ? s
          : {
              ...s,
              global: res.global ?? s.global,
              me: res.me ? { emailEnabled: res.me.emailEnabled, pushEnabled: res.me.pushEnabled } : s.me,
            },
      );
      // El contador de "personas silenciadas" del killswitch me incluye: se revalida en silencio
      // (useApi conserva los datos, así que no parpadea).
      if (scope === 'me') switches.reload();
      return true;
    }, {
      success: note ? { title: note.title, description: note.description } : false,
      error: 'No se pudo cambiar el interruptor',
    });
    if (!ok) setState(previous);
  }

  const global = state?.global;
  const me = state?.me;
  const allOff = !!global && !global.emailEnabled && !global.pushEnabled;
  const anyOff = !!global && (!global.emailEnabled || !global.pushEnabled);

  return (
    <Layout title="Configuración" subtitle="Notificaciones, calendario, apariencia y cuenta">
      <div className="mx-auto max-w-2xl space-y-4">
        {/* Notificaciones — mis avisos */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Bell className="size-4" /> Mis notificaciones</CardTitle>
            <CardDescription>Recibe un aviso cuando un servicio se cae, te asignan una tarea, se documenta tu trabajo y más.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!push.supported ? (
              <div className="flex items-start gap-2 rounded-lg border px-3 py-3 text-sm text-muted-foreground">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>Este navegador no soporta notificaciones push.</span>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Notificaciones en este dispositivo</div>
                    <div className="text-xs text-muted-foreground">
                      {push.enabled ? 'Activadas — recibirás los avisos aquí.' : 'Desactivadas.'}
                    </div>
                  </div>
                  <Button
                    variant={push.enabled ? 'outline' : 'default'}
                    size="sm"
                    onClick={push.toggle}
                    disabled={push.busy || (iosNeedsInstall && !push.enabled) || (blocked && !push.enabled)}
                    className="shrink-0"
                  >
                    {push.enabled ? <BellOff /> : <Bell />}
                    {push.busy ? '…' : push.enabled ? 'Desactivar' : 'Activar'}
                  </Button>
                </div>

                {iosNeedsInstall && (
                  <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-3 text-sm">
                    <Smartphone className="mt-0.5 size-4 shrink-0 text-primary" />
                    <div className="text-muted-foreground">
                      <p className="font-medium text-foreground">Instala la app primero</p>
                      En iPhone/iPad las notificaciones solo funcionan con la app instalada. Toca{' '}
                      <span className="font-medium text-foreground">Compartir</span> →{' '}
                      <span className="font-medium text-foreground">Añadir a inicio</span>, ábrela desde el ícono y vuelve aquí.
                    </div>
                  </div>
                )}

                {blocked && !push.enabled && (
                  <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-3 text-sm">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                    <div className="text-muted-foreground">
                      <p className="font-medium text-foreground">Notificaciones bloqueadas</p>
                      Las bloqueaste en el navegador. Actívalas desde los ajustes del sitio (permisos → notificaciones) y recarga.
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Mis interruptores: valen para TODOS mis dispositivos y para mi correo, a diferencia
                del control de arriba, que es solo de este navegador. */}
            {switches.loading && !me ? (
              <>
                <Skeleton className="h-[58px] w-full rounded-lg" />
                <Skeleton className="h-[58px] w-full rounded-lg" />
              </>
            ) : me ? (
              <>
                <SwitchRow
                  icon={Mail}
                  title="Avisos por correo"
                  hint={
                    global && !global.emailEnabled
                      ? 'El correo del equipo está apagado, así que no llegará ninguno.'
                      : me.emailEnabled
                        ? 'roz te escribe a tu correo.'
                        : 'Silenciado — no recibirás correos de roz.'
                  }
                  checked={me.emailEnabled}
                  disabled={action.busy('me:email')}
                  onChange={(next) =>
                    patch('me', { emailEnabled: next }, {
                      title: next ? 'Correos activados' : 'Correos silenciados',
                      description: next ? undefined : 'No recibirás correos de roz (el resto del equipo sí).',
                    })
                  }
                />
                <SwitchRow
                  icon={Bell}
                  title="Avisos push"
                  hint={
                    me.pushEnabled
                      ? 'Válido para todos tus dispositivos suscritos.'
                      : 'Silenciado en todos tus dispositivos.'
                  }
                  checked={me.pushEnabled}
                  disabled={action.busy('me:push')}
                  onChange={(next) =>
                    patch('me', { pushEnabled: next }, {
                      title: next ? 'Push activado' : 'Push silenciado',
                      description: next ? undefined : 'No recibirás push en ningún dispositivo.',
                    })
                  }
                />
              </>
            ) : (
              switches.error && <div className="text-xs text-muted-foreground">No se pudieron cargar tus interruptores.</div>
            )}
          </CardContent>
        </Card>

        {/* Notificaciones del equipo — killswitch */}
        <Card className={cn(anyOff && 'border-warning/40')}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="size-4" /> Notificaciones del equipo
              {anyOff && <Badge variant="warning">{allOff ? 'Todo apagado' : 'Parcialmente apagado'}</Badge>}
            </CardTitle>
            <CardDescription>
              Killswitch de todo el entorno: apaga los avisos de roz para <span className="font-medium text-foreground">todas</span>{' '}
              las personas. Útil si el proveedor de correo falla o se agota la cuota — con el interruptor abajo, los avisos se omiten
              en silencio en lugar de reintentarse hasta morir en la cola.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {switches.loading && !global ? (
              <>
                <Skeleton className="h-[58px] w-full rounded-lg" />
                <Skeleton className="h-[58px] w-full rounded-lg" />
              </>
            ) : global ? (
              <>
                <SwitchRow
                  icon={Mail}
                  title="Correo (Resend)"
                  hint={global.emailEnabled ? 'Encendido — roz envía correos.' : 'Apagado — nadie recibe correos de roz.'}
                  checked={global.emailEnabled}
                  disabled={action.busy('global:email')}
                  onChange={(next) =>
                    patch('global', { emailEnabled: next }, {
                      title: next ? 'Correo del equipo encendido' : 'Correo del equipo apagado',
                      description: next
                        ? 'roz vuelve a enviar correos a todo el equipo.'
                        : 'Ningún correo saldrá de roz hasta que lo reenciendas.',
                    })
                  }
                />
                <SwitchRow
                  icon={Bell}
                  title="Push"
                  hint={global.pushEnabled ? 'Encendido — roz envía push.' : 'Apagado — nadie recibe push de roz.'}
                  checked={global.pushEnabled}
                  disabled={action.busy('global:push')}
                  onChange={(next) =>
                    patch('global', { pushEnabled: next }, {
                      title: next ? 'Push del equipo encendido' : 'Push del equipo apagado',
                      description: next ? undefined : 'Ningún push saldrá de roz hasta que lo reenciendas.',
                    })
                  }
                />

                {anyOff && (
                  <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-3 text-sm">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                    <div className="text-muted-foreground">
                      <p className="font-medium text-foreground">Los avisos apagados no se guardan para después</p>
                      Mientras esté apagado, roz omite el aviso y cierra el evento: al reencenderlo no se envía lo que quedó atrás
                      (los cambios documentados sí, en cuanto haya un push nuevo).
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-foreground">
                  <Power className="size-3.5" />
                  {global.updatedAt ? (
                    <span>
                      Último cambio {relative(global.updatedAt)}
                      {global.updatedBy ? ` · ${global.updatedBy}` : ''}
                    </span>
                  ) : (
                    <span>Nadie ha movido estos interruptores.</span>
                  )}
                  {!!state?.mutedDevs && (
                    <span>
                      · {state.mutedDevs} {state.mutedDevs === 1 ? 'persona silenció sus avisos' : 'personas silenciaron sus avisos'}
                    </span>
                  )}
                </div>
              </>
            ) : (
              switches.error && (
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>No se pudieron cargar los interruptores del equipo.</span>
                  <Button variant="outline" size="sm" onClick={switches.reload}>Reintentar</Button>
                </div>
              )
            )}
          </CardContent>
        </Card>

        {/* Google Calendar */}
        <CalendarConnectCard />

        {/* Apariencia */}
        <Card>
          <CardHeader>
            <CardTitle>Apariencia</CardTitle>
            <CardDescription>Tema de la interfaz.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-2">
              {THEMES.map(({ key, label, icon: Icon }) => {
                const active = theme === key;
                return (
                  <button
                    key={key}
                    onClick={() => setTheme(key)}
                    className={cn(
                      'press flex flex-col items-center gap-2 rounded-xl border p-4 text-sm transition-colors',
                      active ? 'border-primary bg-primary/5 text-foreground' : 'text-muted-foreground hover:bg-accent',
                    )}
                  >
                    <Icon className="size-5" />
                    {label}
                    {active && <Check className="size-3.5 text-primary" />}
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Cuenta */}
        <Card>
          <CardHeader>
            <CardTitle>Cuenta</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <UserAvatar url={null} name={user?.name ?? user?.email ?? '?'} className="size-11" />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{user?.name ?? user?.email}</div>
                <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
                {user?.role && <div className="truncate text-xs capitalize text-muted-foreground">{user.role}</div>}
              </div>
            </div>
            <Button variant="outline" onClick={signOut} className="w-full text-destructive hover:text-destructive sm:w-auto">
              <LogOut /> Cerrar sesión
            </Button>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
