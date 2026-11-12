import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createAvatar } from '@dicebear/core';
// Solo los dos estilos que usa roz: el índice de la colección es `sideEffects: false`, así que
// Vite deja fuera los otros ~30 estilos.
import { micah, shapes } from '@dicebear/collection';
import { cn } from '@/lib/utils';
import { initials } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { useApi } from '@/lib/useApi';
import { DISCORD_STATUS_KEY, discordStatusOrOff } from '@/discord/status';

/**
 * Identidad visual de personas, proyectos y del bot. Reglas en `src/DESIGN.md` → "Avatares".
 *
 * Los hex de aquí son la ÚNICA excepción a "cero hex en componentes": DiceBear genera el SVG fuera
 * del DOM y no puede leer variables CSS, así que la paleta suave de roz va escrita a mano. Es la
 * misma en claro y oscuro a propósito (el avatar es un dibujo, no una superficie).
 */

/** Fondos suaves de roz (naranja, lavanda, amarillo, verde, panel). */
const SOFT_BG = ['ffe4d8', 'e7e4fa', 'fff1cc', 'dcf2e8', 'eeede8'];
/** Tintas de marca para las figuras de los íconos de proyecto. */
const SHAPE_INK = ['ff5b23', '8a7fdc', 'ffc84a', '2f9e74', 'ffa274', '5546c4'];

// El SVG de un seed nunca cambia: se cachea a nivel de módulo para que una lista de 50 filas con la
// misma persona no lo regenere 50 veces (useMemo solo cubre los re-renders de UNA instancia).
const micahCache = new Map<string, string>();
const shapesCache = new Map<string, string>();

export function micahDataUri(seed: string): string {
  let uri = micahCache.get(seed);
  if (!uri) {
    uri = createAvatar(micah, { seed, backgroundColor: SOFT_BG, radius: 50 }).toDataUri();
    micahCache.set(seed, uri);
  }
  return uri;
}

export function projectIconDataUri(seed: string): string {
  let uri = shapesCache.get(seed);
  if (!uri) {
    uri = createAvatar(shapes, {
      seed,
      backgroundColor: SOFT_BG,
      shape1Color: SHAPE_INK,
      shape2Color: SHAPE_INK,
      shape3Color: SHAPE_INK,
      radius: 22,
    }).toDataUri();
    shapesCache.set(seed, uri);
  }
  return uri;
}

/** Foto de GitHub de un login (mismo formato que `avatarFor` del backend). */
export function githubAvatarUrl(login: string | null | undefined): string | null {
  return login ? `https://github.com/${encodeURIComponent(login)}.png?size=96` : null;
}

/**
 * Semilla del avatar generado: el id del dev y, solo si no llega, el correo en minúsculas. El id va
 * primero porque es lo que TODAS las vistas tienen (el correo solo llega en algunas respuestas): así
 * una persona sin foto de GitHub se ve igual en el Pulso, el chat y su propio chip. NUNCA el nombre:
 * dos personas pueden llamarse igual y un nombre cambia; el avatar debe ser estable.
 */
export function avatarSeed(email?: string | null, id?: string | null): string | null {
  const i = id?.trim();
  if (i) return i;
  return email?.trim().toLowerCase() || null;
}

// ---------------------------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------------------------

/** Presencia del mock: en línea (verde), en junta (amarillo), fuera (gris). */
export type Presence = 'on' | 'meet' | 'off';

const PRESENCE_DOT: Record<Presence, string> = { on: 'bg-green', meet: 'bg-yellow', off: 'bg-toggle-off' };
const PRESENCE_LABEL: Record<Presence, string> = { on: 'En línea', meet: 'En junta', off: 'Fuera' };

export interface PersonAvatarProps {
  /** Nombre visible: va en `alt`/`title`, nunca como semilla. */
  name: string;
  /** Foto ya resuelta (lo que mande el backend: GitHub o, en Discord, el avatar del miembro). */
  url?: string | null;
  /** Login de GitHub: se usa si no vino `url`. */
  login?: string | null;
  /** Avatar de Discord de la cuenta ligada, si el front lo tiene. */
  discordUrl?: string | null;
  /** Semilla preferida del avatar generado. */
  email?: string | null;
  /** id del dev: semilla si no hay correo. */
  id?: string | null;
  presence?: Presence;
  /** Encima de todo (p. ej. el punto de presencia del calendario de `UserAvatar`). */
  badge?: ReactNode;
  className?: string;
  title?: string;
}

/**
 * Avatar único de persona. Prioridad: foto de GitHub (`url` o `login`) → avatar de Discord →
 * DiceBear `micah` con semilla = correo (o id). Si una foto falla al cargar (login sin foto, CDN de
 * Discord caído) cae a la siguiente. Solo sin semilla alguna (autor externo sin id) quedan iniciales.
 */
export function PersonAvatar({ name, url, login, discordUrl, email, id, presence, badge, className = 'size-[34px]', title }: PersonAvatarProps) {
  const photos = useMemo(
    () => [...new Set([url, githubAvatarUrl(login), discordUrl].filter((s): s is string => !!s))],
    [url, login, discordUrl],
  );
  const [failed, setFailed] = useState(0);
  useEffect(() => setFailed(0), [photos]);

  const seed = avatarSeed(email, id);
  const generated = useMemo(() => (seed ? micahDataUri(seed) : null), [seed]);
  const photo = photos[failed];
  const src = photo ?? generated;

  return (
    <span className={cn('relative inline-grid shrink-0 place-items-center rounded-full', className)} title={title ?? name}>
      {src ? (
        <img
          key={src}
          src={src}
          alt={name}
          draggable={false}
          loading="lazy"
          onError={photo ? () => setFailed((n) => n + 1) : undefined}
          className={cn('size-full rounded-full object-cover', !photo && 'bg-panel')}
        />
      ) : (
        <span className="grid size-full place-items-center rounded-full bg-ink text-xs font-semibold text-ink-foreground">
          {initials(name)}
        </span>
      )}
      {presence && (
        <span
          title={PRESENCE_LABEL[presence]}
          className={cn('absolute -bottom-px -right-px size-[30%] min-h-2 min-w-2 rounded-full ring-2 ring-card', PRESENCE_DOT[presence])}
        />
      )}
      {badge}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Proyectos
// ---------------------------------------------------------------------------------------------

const PROJECT_SIZE = { xs: 'size-3.5 rounded-[4px]', sm: 'size-[18px] rounded-[5px]', md: 'size-7 rounded-md', lg: 'size-11 rounded-[10px]' } as const;

/**
 * Ícono de proyecto: DiceBear `shapes` con semilla = id del proyecto (sobrevive a un renombre).
 * Es ADICIONAL al color propio del proyecto (`project.color`, 0012): no lo reemplaza.
 */
export function ProjectIcon({
  id,
  name,
  size = 'sm',
  className,
}: {
  id: string | null | undefined;
  name?: string;
  size?: keyof typeof PROJECT_SIZE;
  className?: string;
}) {
  const src = useMemo(() => (id ? projectIconDataUri(id) : null), [id]);
  if (!src) return <span aria-hidden className={cn('inline-block shrink-0 bg-panel', PROJECT_SIZE[size], className)} />;
  return (
    <img
      src={src}
      alt=""
      aria-hidden={!name}
      title={name}
      draggable={false}
      className={cn('inline-block shrink-0 object-cover', PROJECT_SIZE[size], className)}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Roz-bot
// ---------------------------------------------------------------------------------------------

export type RozBotMood = 'normal' | 'happy' | 'thinking' | 'alert';

export function rozBotSrc(mood: RozBotMood = 'normal'): string {
  return mood === 'normal' ? '/brand/roz-bot.svg' : `/brand/roz-bot-${mood}.svg`;
}

/**
 * Roz-bot, el personaje del bot de Discord y de los avisos del sistema. Expresiones: `happy` (PR
 * mergeado, éxito), `thinking` (planeando, en proceso), `alert` (incidente, error).
 */
export function RozBotAvatar({ mood = 'normal', className = 'size-9', title = 'Roz-bot' }: { mood?: RozBotMood; className?: string; title?: string }) {
  return (
    <img
      src={rozBotSrc(mood)}
      alt={title}
      title={title}
      draggable={false}
      className={cn('inline-block shrink-0 rounded-full', className)}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Yo (usuario de la sesión)
// ---------------------------------------------------------------------------------------------

/**
 * Avatar del usuario de la sesión (chip del AppShell, Configuración). GitHub sale de `/me`; el
 * avatar de Discord, de la caché compartida de `/discord/status` (la misma que usan Chat y
 * Configuración, así que no duplica la petición); la semilla es su correo.
 */
export function MeAvatar({ className }: { className?: string }) {
  const { user } = useAuth();
  const discord = useApi(() => discordStatusOrOff(), [], { key: DISCORD_STATUS_KEY, ttl: 60_000 });
  return (
    <PersonAvatar
      name={user?.name ?? user?.email ?? '?'}
      login={user?.githubLogin}
      discordUrl={discord.data?.link?.avatarUrl}
      email={user?.email}
      id={user?.devId}
      className={className}
    />
  );
}
