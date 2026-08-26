import { Link } from 'react-router-dom';
import { useDevPresence } from '@/presence/PresenceContext';
import { useAuth } from '@/auth/AuthContext';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip';
import { PresenceSchedule } from '@/components/PresenceSchedule';
import { cn } from '@/lib/utils';
import type { DevPresence } from '@/lib/api';

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
 * Marca de Google Calendar. Va en el panel para dejar claro de DÓNDE sale el dato: sin ella, un
 * título como "Toy Dormido" podría parecer algo que roz infiere en vez de leer de tu agenda.
 *
 * SVG inline (no un archivo ni un CDN): son cuatro rectángulos y un número, y así hereda el tamaño
 * del contenedor y no agrega una petición de red.
 */
function GoogleCalendarMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} role="img" aria-label="Google Calendar">
      <rect x="4" y="4" width="16" height="16" rx="1.5" fill="#fff" />
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H20v1.9H4z" fill="#4285F4" />
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H5.9v16H5.5A1.5 1.5 0 0 1 4 18.5z" fill="#34A853" />
      <path d="M4 18.1h16v.4A1.5 1.5 0 0 1 18.5 20H5.5A1.5 1.5 0 0 1 4 18.5z" fill="#FBBC04" />
      <path d="M18.1 4h.4A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-.4z" fill="#EA4335" />
      <text
        x="12"
        y="15.6"
        textAnchor="middle"
        fill="#4285F4"
        fontSize="8.5"
        fontWeight="700"
        fontFamily="Geist Variable, system-ui, sans-serif"
      >
        31
      </text>
    </svg>
  );
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
export function PresencePanel({ devId, className }: { devId: string; className?: string }) {
  const presence = useDevPresence(devId);
  const { user } = useAuth();
  if (!presence) return null;

  const busy = presence.status === 'busy';
  const { head, when, foot } = content(presence);
  // Solo el panel PROPIO lleva enlace: en la fila de otro dev, mandar a "tus" ajustes de calendario
  // sería desconcertante — no es su conexión la que se administra ahí.
  const mine = !!user && user.devId === devId;

  return (
    <Tooltip>
      {/* El panel entero es el disparador. `asChild` para no meter un wrapper que rompa el ancho
          que le fija cada vista. */}
      <TooltipTrigger asChild>
        <div
          className={cn(
            // Misma familia visual que el panel de hyper points del perfil: caja redondeada, borde
            // tenue del color del estado y fondo apenas tintado. Se integra en vez de competir.
            'min-w-0 cursor-default rounded-xl border p-3',
            busy ? 'border-warning/25 bg-warning/[0.06]' : 'border-success/25 bg-success/[0.06]',
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
                <GoogleCalendarMark className="size-5" />
              </Link>
            ) : (
              <GoogleCalendarMark className="size-5 shrink-0" />
            )}
            {/* El nombre de la marca junto al logo. El ícono solo no comunicaba de dónde sale el
                dato —un cuadrito de colores no dice "Calendar"—; con el texto se entiende de un
                golpe, y de paso este rótulo da contexto al título de abajo, que si no queda como
                texto suelto ("Toy Dormido"). */}
            <span className="truncate text-[10px] font-medium tracking-wide text-muted-foreground">
              Google Calendar
            </span>
            {when && (
              <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                {when}
              </span>
            )}
          </div>

          {/* A ras del borde de la tarjeta, con todo el ancho disponible. `break-words` además del
              clamp: un título sin espacios (una URL pegada) se desbordaría en lugar de partirse. */}
          <p
            className={cn(
              'mt-1.5 line-clamp-2 break-words text-sm font-semibold leading-snug',
              busy ? 'text-warning' : 'text-success',
            )}
          >
            {head}
          </p>

          {foot && <p className="mt-1.5 line-clamp-1 break-words text-[11px] text-muted-foreground">{foot}</p>}
        </div>
      </TooltipTrigger>
      <PresenceSchedule presence={presence} />
    </Tooltip>
  );
}
