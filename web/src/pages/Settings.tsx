import { Bell, BellOff, Sun, Moon, Monitor, LogOut, TriangleAlert, Smartphone, Check } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { useAuth } from '@/auth/AuthContext';
import { useTheme } from '@/components/theme';
import { usePush } from '@/lib/usePush';
import { UserAvatar } from '@/components/bits';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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

export default function Settings() {
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const push = usePush();

  const iosNeedsInstall = isIOS && !isStandalone;
  const blocked = push.permission === 'denied';

  return (
    <Layout title="Configuración" subtitle="Notificaciones, apariencia y cuenta">
      <div className="mx-auto max-w-2xl space-y-4">
        {/* Notificaciones */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Bell className="size-4" /> Notificaciones</CardTitle>
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
          </CardContent>
        </Card>

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
