import { Link } from 'react-router-dom';
import { useDevPresence } from '@/presence/PresenceContext';
import { useAuth } from '@/auth/AuthContext';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip';
import { PresenceSchedule } from '@/components/PresenceSchedule';
import { cn } from '@/lib/utils';
import type { DevPresence } from '@/lib/api';
import { IntegrationIcon, type Presence } from '@/components/brand';

/**
 * Hora local en 24h ("01:00", "14:30").
 *
 * `hour12: false` explícito: con el locale del navegador salía "12:00 AM" para la medianoche, que
 * en un dashboard en español se lee peor y encima es ambiguo. La zona horaria SÍ es la del
 * navegador, a propósito: cada quien ve la agenda en su propia hora.
 */
export function clockTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Marca de Google Calendar (ícono oficial de `public/integrations/`). Dice de DÓNDE sale el dato:
 * sin ella, un título como "Toy Dormido" podría parecer algo que roz infiere en vez de leer de tu
 * agenda.
 */
function GoogleCalendarMark({ className }: { className?: string }) {
  return <IntegrationIcon name="googlecalendar" size="sm" title="Google Calendar" className={className} />;
}

/**
 * Presencia del calendario → presencia del avatar del mock (`GithubAvatar`): en un evento = "en
 * junta" (amarillo), sin actividad = en línea (verde), sin calendario = fuera (gris).
 */
export function avatarPresence(status: DevPresence['status'] | undefined | null): Presence | undefined {
  if (!status) return undefined;
  return status === 'busy' ? 'meet' : status === 'free' ? 'on' : 'off';
}

interface Content {
  /** Qué está haciendo. Es el dato principal y el único que puede ser largo. */
  head: string;
  /** Hasta cuándo. */
  when: string | null;
  /** Lo que viene después, cuando aporta algo que el resto no dice ya. */
  foot: string | null;
}

function content(p: DevPresence): Content {
  const next = clockTime(p.nextStartsAt);

  if (p.status === 'busy') {
    return {
      // El título manda. "Ocupado" era un juicio que además repetía lo que el título ya decía, y
      // para una "Sesión de trabajo" se leía como inalcanzable. Diciendo QUÉ está haciendo, quien
      // mira decide solo si interrumpe — y no hay que clasificar ningún evento.
      head: p.title ?? 'En un evento',
      when: p.busyUntil ? `hasta ${clockTime(p.busyUntil)}` : null,
      foot: next ? `Sigue ${next}${p.nextTitle ? ` · ${p.nextTitle}` : ''}` : null,
    };
  }
  return {
    // "Sin actividad" y no "Libre": el panel reporta lo que dice el calendario, no si la persona
    // está disponible. Alguien puede estar a tope y con la agenda vacía, y afirmar "Libre" sería
    // justo el tipo de juicio que este panel dejó de hacer. El logo ya dice de qué calendario habla.
    head: 'Sin actividad',
    // No hay actividad que nombrar; el dato útil es hasta cuándo dura el hueco.
    when: next ? `hasta ${next}` : null,
    foot: next && p.nextTitle ? `Sigue ${p.nextTitle}` : null,
  };
}

/**
 * Estado del dev según su calendario, como módulo con su propio espacio.
 *
 * Empezó siendo una etiqueta de una línea y no funcionaba: el motivo es un título de calendario
 * ("Diseño de Sistemas Interactivos - Remoto") y en una línea se recortaba a nada, que es justo el
 * dato que explica el estado. Aquí el título tiene dos renglones propios (`line-clamp-2`), así que
 * un título largo se lee completo en vez de desaparecer.
 *
 * Los cuatro datos quedan visibles de un vistazo y en orden de importancia: qué estado, hasta
 * cuándo, por qué, y qué sigue.
 *
 * No renderiza nada si el dev no tiene calendario conectado: un hueco es más honesto que un "Libre"
 * que en realidad significa "no sé".
 */
export function PresencePanel({
  devId,
  variant = 'panel',
  className,
}: {
  devId: string;
  /**
   * `panel` = el módulo de tres renglones (perfil del dev, donde tiene su propio espacio).
   * `inline` = un renglón que se cuelga del bloque de identidad, para la lista de developers.
   *
   * El recorrido de esta decisión, porque explica por qué NO es una columna:
   *  1. Panel completo en columna propia → 90px de alto reservados para todos, y un hueco enorme en
   *     los devs sin calendario conectado.
   *  2. Globo de una línea en columna propia → seguía habiendo columna, así que seguía habiendo
   *     hueco, y encima 12rem no alcanzaban: el título se recortaba a "Chamb…" y no se leía nada.
   *  3. Renglón dentro de la identidad → **no hay columna**. Usa el espacio VERTICAL que ya sobraba
   *     bajo el @handle (nombre + handle son 40px de una fila de ~110), no le quita ancho a nada de
   *     la derecha, y si el dev no tiene calendario simplemente no aparece: no hay pista vacía que
   *     delate su ausencia, y las filas siguen alineadas porque su altura la fijan las métricas.
   */
  variant?: 'panel' | 'inline';
  className?: string;
}) {
  const presence = useDevPresence(devId);
  const { user } = useAuth();
  if (!presence) return null;

  const busy = presence.status === 'busy';
  const { head, when, foot } = content(presence);
  // Solo el panel PROPIO lleva enlace: en la fila de otro dev, mandar a "tus" ajustes de calendario
  // sería desconcertante — no es su conexión la que se administra ahí.
  const mine = !!user && user.devId === devId;

  if (variant === 'inline') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Sin borde ni fondo: es un renglón de la identidad, no una tarjeta dentro de otra. Lo
              que lo ata al calendario es el logo, y el estado lo dice el punto.

              CÓMO AGUANTA UN TÍTULO LARGO (los de calendario lo son: "Diseño de Sistemas
              Interactivos - Remoto"): el título es el ÚNICO elemento que puede encogerse — lleva
              `min-w-0 truncate` — y todo lo demás es `shrink-0`. `min-w-0` en la fila y en cada
              ancestro es lo que permite que la cadena baje de su ancho de contenido; sin uno solo
              de esos, el texto empujaría la fila y desbordaría la tarjeta en vez de recortarse.
              El texto completo queda en el `title` nativo y en el tooltip con la agenda. */}
          <span className={cn('flex min-w-0 cursor-default items-center gap-2', className)}>
            <GoogleCalendarMark className="size-3.5" />
            <span
              className={cn('size-1.5 shrink-0 rounded-full', busy ? 'bg-yellow' : 'bg-green')}
              aria-hidden
            />
            <span className="min-w-0 truncate text-xs font-medium" title={head}>{head}</span>
            {when && (
              <span className="shrink-0 text-[11px] tabular-nums text-faint">{when}</span>
            )}
          </span>
        </TooltipTrigger>
        <PresenceSchedule presence={presence} />
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      {/* El panel entero es el disparador. `asChild` para no meter un wrapper que rompa el ancho
          que le fija cada vista. */}
      <TooltipTrigger asChild>
        <div
          className={cn(
            // Superficie NEUTRA (`bg-muted/40 border`), la misma que los recuadros de métricas que
            // van a su lado en la fila de developers. Antes el borde y el fondo iban tintados del
            // color del estado y el título en ámbar o verde: dos señales de color para un dato
            // secundario, que hacían de esta tarjeta lo más llamativo de la fila cuando lo
            // importante son las cifras. El estado ahora lo dice un punto junto al rótulo.
            //
            // `h-full` + `flex-col`: la tarjeta se estira a la altura de la fila (el llamador le da
            // `self-stretch`) y reparte su contenido, así que ya no queda flotando más corta que el
            // bloque de métricas de al lado.
            'flex h-full min-w-0 cursor-default flex-col gap-1.5 rounded-lg border bg-sidebar p-3',
            className,
          )}
        >
          {/* Encabezado: SOLO la procedencia y la hora van junto al logo. La actividad no —metida
              aquí quedaba indentada bajo el logo y perdía ancho justo el texto que más lo necesita. */}
          <div className="flex items-center gap-2">
            {/* El logo va suelto, sin caja. Un contenedor con fondo y borde le dibujaba una
                silueta oscura alrededor —el logo ya es una forma cerrada y se define solo—. El
                estado lo comunican el borde de la tarjeta, el color del título y el punto del
                avatar; no hacía falta tintar nada aquí. */}
            {mine ? (
              <Link
                to="/app/settings"
                title="Gestionar tu conexión con Google Calendar"
                // La fila de developers es clicable entera (lleva al perfil). Sin frenar la
                // propagación, este enlace nunca se alcanzaría: ganaría el onClick de la tarjeta.
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 rounded transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <GoogleCalendarMark />
              </Link>
            ) : (
              <GoogleCalendarMark />
            )}
            {/* El nombre de la marca junto al logo. El ícono solo no comunicaba de dónde sale el
                dato —un cuadrito de colores no dice "Calendar"—; con el texto se entiende de un
                golpe, y de paso este rótulo da contexto al título de abajo, que si no queda como
                texto suelto ("Toy Dormido"). */}
            <span className="label-caps truncate">
              Google Calendar
            </span>
            {/* La única señal de color del panel, y del tamaño de una señal. */}
            <span
              className={cn('size-1.5 shrink-0 rounded-full', busy ? 'bg-yellow' : 'bg-green')}
              title={busy ? 'En un evento' : 'Sin actividad en el calendario'}
            />
            {when && (
              <span className="ml-auto shrink-0 text-[11px] tabular-nums text-faint">
                {when}
              </span>
            )}
          </div>

          {/* A ras del borde de la tarjeta, con todo el ancho disponible. `break-words` además del
              clamp: un título sin espacios (una URL pegada) se desbordaría en lugar de partirse. */}
          <p className="line-clamp-2 break-words text-sm font-semibold leading-snug text-foreground">
            {head}
          </p>

          {/* `mt-auto`: el pie se va al fondo de la tarjeta estirada en vez de dejar el hueco
              abajo, que es lo que hacía que la caja se viera desalineada con sus vecinas. */}
          {foot && <p className="mt-auto line-clamp-1 break-words text-[11px] text-muted-foreground">{foot}</p>}
        </div>
      </TooltipTrigger>
      <PresenceSchedule presence={presence} />
    </Tooltip>
  );
}
