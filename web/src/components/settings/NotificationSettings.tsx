import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  Bell, BellOff, CircleCheck, CircleX, Laptop, Power, Send, Smartphone, TriangleAlert, Users, User, Volume2, VolumeX,
} from 'lucide-react';
import { playSound, setSoundsEnabled, soundsEnabled, subscribeSounds } from '@/lib/sound';
import { sendTestPush, type TestPushResult } from '@/lib/push';
import { usePush } from '@/push/PushContext';
import { CapsLabel, IntegrationIcon } from '@/components/brand';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useApi } from '@/lib/useApi';
import { useAction } from '@/lib/useAction';
import { apiGet, apiSend, type NotificationSwitch, type NotificationSwitches, type SwitchPatch } from '@/lib/api';
import { relative } from '@/lib/format';
import { Notice, Row, RowsCard } from './parts';

// iPhone/iPad y si la app corre instalada (standalone). En iOS el push SOLO funciona con la PWA
// añadida a la pantalla de inicio, así que si no está instalada lo indicamos.
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

export const SWITCHES_KEY = '/notifications/switches';
export const fetchSwitches = () => apiGet<NotificationSwitches>('/notifications/switches');

const BLOCKED_REASON: Record<NonNullable<TestPushResult['blocked']>, string> = {
  vapid: 'El servidor no tiene configuradas las llaves VAPID.',
  global: 'El push del equipo está apagado (columna "Todo el equipo").',
  muted: 'Tienes los avisos push silenciados (columna "Para ti").',
};

/** Resultado de la prueba: a qué dispositivos salió. Los que no aparecen no están suscritos. */
function TestResult({ result }: { result: TestPushResult }) {
  if (result.blocked) {
    return <div className="rounded-md bg-sidebar px-3 py-2 text-xs text-muted-foreground">{BLOCKED_REASON[result.blocked]}</div>;
  }
  if (!result.devices.length) {
    return (
      <div className="rounded-md bg-sidebar px-3 py-2 text-xs text-muted-foreground">
        No tienes dispositivos suscritos. Pulsa <span className="font-semibold text-foreground">Activar</span> en cada uno (teléfono y computadora).
      </div>
    );
  }
  return (
    <ul className="space-y-1.5 rounded-md bg-sidebar px-3 py-2.5 text-[11.5px] tabular-nums">
      {result.devices.map((d, i) => {
        const Icon = /android|iphone|ipad/i.test(d.label) ? Smartphone : Laptop;
        return (
          <li key={i} className="flex items-center gap-2">
            <Icon className="size-3.5 shrink-0 text-faint" />
            <span className="min-w-0 flex-1 truncate">{d.label}</span>
            {d.ok ? (
              <span className="flex items-center gap-1 text-green"><CircleCheck className="size-3.5" /> Enviada</span>
            ) : (
              <span className="flex items-center gap-1 text-red">
                <CircleX className="size-3.5" /> {d.gone ? 'Caducada — vuelve a activar ahí' : 'Falló'}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Plantilla de la tabla canal × alcance: nombre del canal, "para ti", "todo el equipo". */
const MATRIX = 'grid grid-cols-[minmax(0,1fr)_5.5rem_5.5rem] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_9rem_9rem]';

function SwitchCell({
  checked,
  disabled,
  blockedBy,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  /** El interruptor está encendido pero no sirve porque el del equipo está apagado. */
  blockedBy?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1 sm:flex-row sm:justify-center sm:gap-2">
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
      <span className={cn('text-[11px] tabular-nums', blockedBy ? 'text-yellow-ink' : checked ? 'text-muted-foreground' : 'text-faint')}>
        {blockedBy ? 'sin efecto' : checked ? 'encendido' : 'apagado'}
      </span>
    </div>
  );
}

/**
 * Configuración → Notificaciones. Arriba la tabla canal × alcance (tus avisos y el killswitch del
 * equipo, lado a lado, porque uno condiciona al otro); abajo lo que vale solo para este dispositivo.
 */
export function NotificationSettings() {
  const push = usePush();
  const sounds = useSyncExternalStore(subscribeSounds, soundsEnabled);
  const [test, setTest] = useState<TestPushResult | null>(null);
  const testAction = useAction();

  const iosNeedsInstall = isIOS && !isStandalone;
  const blocked = push.permission === 'denied';

  const switches = useApi(fetchSwitches, [], { key: SWITCHES_KEY, ttl: 60_000 });
  // Espejo local para el update optimista: el interruptor tiene que responder al instante y
  // revertirse solo si el backend rechaza el cambio.
  const [state, setState] = useState<NotificationSwitches | null>(null);
  // `busy` POR INTERRUPTOR: mover "mis correos" no bloquea los del equipo.
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
      // Revalidar SIEMPRE: el estado optimista vive solo aquí y la caché seguía con el valor viejo,
      // así que al volver a Configuración (dentro del TTL) el interruptor aparecía al revés.
      switches.reload();
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
    <div className="grid gap-3.5">
      {/* ---- Canal × alcance ---- */}
      <Card className={cn('overflow-hidden', anyOff && 'border-yellow')}>
        <div className={cn(MATRIX, 'min-h-[46px] border-b bg-sidebar px-4 py-2.5 sm:px-5')}>
          <span className="flex min-w-0 items-center gap-2 text-sm font-semibold tracking-[-0.01em]">
            Canales de aviso
            {anyOff && <Badge variant="human" dot>{allOff ? 'Todo apagado' : 'Parcialmente apagado'}</Badge>}
          </span>
          <CapsLabel className="flex items-center justify-center gap-1.5"><User className="size-3" /> Para ti</CapsLabel>
          <CapsLabel className="flex items-center justify-center gap-1.5 text-center"><Users className="size-3 shrink-0" /> Todo el equipo</CapsLabel>
        </div>

        {switches.loading && !state ? (
          <div className="divide-y">
            {[0, 1].map((i) => (
              <div key={i} className={cn(MATRIX, 'min-h-[60px] px-4 py-3 sm:px-5')}>
                <div className="flex items-center gap-3"><Skeleton className="size-[26px] rounded-md" /><Skeleton className="h-3.5 w-28" /></div>
                <Skeleton className="mx-auto h-[22px] w-10 rounded-full" />
                <Skeleton className="mx-auto h-[22px] w-10 rounded-full" />
              </div>
            ))}
          </div>
        ) : me && global ? (
          <div className="divide-y">
            <div className={cn(MATRIX, 'min-h-[60px] px-4 py-3 sm:px-5')}>
              <div className="flex min-w-0 items-center gap-3">
                <IntegrationIcon name="resend" size="sm" framed className={cn(!global.emailEnabled && 'opacity-60')} />
                <div className="grid min-w-0">
                  <span className="text-[13.5px] font-semibold">Correo</span>
                  <span className="hidden truncate text-xs text-muted-foreground sm:block">Asignaciones, caídas y trabajo documentado, vía Resend.</span>
                </div>
              </div>
              <SwitchCell
                label="Mis avisos por correo"
                checked={me.emailEnabled}
                blockedBy={me.emailEnabled && !global.emailEnabled}
                disabled={action.busy('me:email')}
                onChange={(next) =>
                  patch('me', { emailEnabled: next }, {
                    title: next ? 'Correos activados' : 'Correos silenciados',
                    description: next ? undefined : 'No recibirás correos de roz (el resto del equipo sí).',
                  })
                }
              />
              <SwitchCell
                label="Correo de todo el equipo"
                checked={global.emailEnabled}
                disabled={action.busy('global:email')}
                onChange={(next) =>
                  patch('global', { emailEnabled: next }, {
                    title: next ? 'Correo del equipo encendido' : 'Correo del equipo apagado',
                    description: next ? 'roz vuelve a enviar correos a todo el equipo.' : 'Ningún correo saldrá de roz hasta que lo reenciendas.',
                  })
                }
              />
            </div>
            <div className={cn(MATRIX, 'min-h-[60px] px-4 py-3 sm:px-5')}>
              <div className="flex min-w-0 items-center gap-3">
                <span className={cn('grid size-[26px] shrink-0 place-items-center rounded-md', global.pushEnabled ? 'bg-orange-soft text-orange-ink' : 'bg-panel text-faint')}>
                  <Bell className="size-3.5" />
                </span>
                <div className="grid min-w-0">
                  <span className="text-[13.5px] font-semibold">Push</span>
                  <span className="hidden truncate text-xs text-muted-foreground sm:block">En todos los dispositivos suscritos (teléfono y computadora).</span>
                </div>
              </div>
              <SwitchCell
                label="Mis avisos push"
                checked={me.pushEnabled}
                blockedBy={me.pushEnabled && !global.pushEnabled}
                disabled={action.busy('me:push')}
                onChange={(next) =>
                  patch('me', { pushEnabled: next }, {
                    title: next ? 'Push activado' : 'Push silenciado',
                    description: next ? undefined : 'No recibirás push en ningún dispositivo.',
                  })
                }
              />
              <SwitchCell
                label="Push de todo el equipo"
                checked={global.pushEnabled}
                disabled={action.busy('global:push')}
                onChange={(next) =>
                  patch('global', { pushEnabled: next }, {
                    title: next ? 'Push del equipo encendido' : 'Push del equipo apagado',
                    description: next ? undefined : 'Ningún push saldrá de roz hasta que lo reenciendas.',
                  })
                }
              />
            </div>

            {anyOff && (
              <div className="px-4 py-3 sm:px-5">
                <Notice tone="warn" icon={TriangleAlert} title="Los avisos apagados no se guardan para después">
                  Mientras el equipo esté apagado, roz omite el aviso y cierra el evento: al reencenderlo no se envía lo que quedó atrás.
                </Notice>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 bg-sidebar px-4 py-2.5 text-[11px] text-faint tabular-nums sm:px-5">
              <Power className="size-3" />
              {global.updatedAt ? (
                <span>Último cambio del equipo {relative(global.updatedAt)}{global.updatedBy ? ` · ${global.updatedBy}` : ''}</span>
              ) : (
                <span>Nadie ha movido los interruptores del equipo.</span>
              )}
              {!!state?.mutedDevs && (
                <span>· {state.mutedDevs} {state.mutedDevs === 1 ? 'persona silenció sus avisos' : 'personas silenciaron sus avisos'}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 px-4 py-4 text-xs text-muted-foreground sm:px-5">
            <span>No se pudieron cargar los interruptores.</span>
            <Button variant="secondary" size="sm" onClick={switches.reload}>Reintentar</Button>
          </div>
        )}
      </Card>

      {/* ---- Este dispositivo ---- */}
      <RowsCard title="Este dispositivo" icon={<Laptop className="size-4 text-faint" />}>
        {!push.supported ? (
          <div className="px-4 py-3 sm:px-5">
            <Notice tone="warn" icon={TriangleAlert} title="Sin push en este navegador">Este navegador no soporta notificaciones push.</Notice>
          </div>
        ) : (
          <>
            <Row
              icon={push.enabled ? Bell : BellOff}
              on={push.enabled}
              title="Notificaciones push aquí"
              hint={push.enabled ? 'Activadas — recibirás los avisos en este navegador.' : 'Desactivadas en este navegador.'}
            >
              <Button
                variant={push.enabled ? 'secondary' : 'default'}
                size="sm"
                onClick={push.toggle}
                disabled={push.busy || (iosNeedsInstall && !push.enabled) || (blocked && !push.enabled)}
              >
                {push.busy ? '…' : push.enabled ? 'Desactivar' : 'Activar'}
              </Button>
            </Row>
            {(iosNeedsInstall || (blocked && !push.enabled)) && (
              <div className="grid gap-2 px-4 py-3 sm:px-5">
                {iosNeedsInstall && (
                  <Notice tone="brand" icon={Smartphone} title="Instala la app primero">
                    En iPhone/iPad las notificaciones solo funcionan con la app instalada. Toca{' '}
                    <span className="font-semibold">Compartir</span> → <span className="font-semibold">Añadir a inicio</span>,
                    ábrela desde el ícono y vuelve aquí.
                  </Notice>
                )}
                {blocked && !push.enabled && (
                  <Notice tone="warn" icon={TriangleAlert} title="Notificaciones bloqueadas">
                    Las bloqueaste en el navegador. Actívalas desde los ajustes del sitio (permisos → notificaciones) y recarga.
                  </Notice>
                )}
              </div>
            )}
          </>
        )}

        {/* Sonidos: de ESTE dispositivo (localStorage), como el control de push. */}
        <Row
          icon={sounds ? Volume2 : VolumeX}
          on={sounds}
          title="Sonidos"
          hint={sounds ? 'Avisos, menciones, acciones y errores.' : 'Silenciados en este dispositivo.'}
        >
          <Switch
            checked={sounds}
            aria-label="Sonidos"
            onCheckedChange={(next) => {
              setSoundsEnabled(next);
              if (next) void playSound('notification');
            }}
          />
        </Row>

        {/* Prueba de punta a punta: llega a TODOS mis dispositivos suscritos (teléfono y compu). */}
        {push.supported && (
          <>
            <Row icon={Send} title="Probar en mis dispositivos" hint="Envía un aviso a tu teléfono y a tu computadora.">
              <Button
                variant="secondary"
                size="sm"
                disabled={testAction.busy('test')}
                onClick={() => testAction.run('test', sendTestPush, { error: 'No se pudo enviar la prueba', onDone: setTest })}
              >
                {testAction.busy('test') ? '…' : 'Probar'}
              </Button>
            </Row>
            {test && <div className="px-4 py-3 sm:px-5"><TestResult result={test} /></div>}
          </>
        )}
      </RowsCard>
    </div>
  );
}

