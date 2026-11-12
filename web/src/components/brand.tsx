import type { CSSProperties, ReactNode } from 'react';
import { useTheme } from '@/components/theme';
import { cn } from '@/lib/utils';
import { initials } from '@/lib/format';
import { PersonAvatar, avatarSeed, type Presence } from '@/components/avatars';

/**
 * Piezas de identidad de roz v2 (mock "plano de control", estilo Stape). Reglas y ejemplos en
 * `src/DESIGN.md`. Todo color sale de tokens: cuando un componente recibe un color, recibe el
 * NOMBRE del token (`'purple-deep'`), nunca un hex.
 */

/** Tokens de marca que se pueden pasar como color a las piezas de abajo. */
export type BrandColor =
  | 'orange'
  | 'salmon'
  | 'purple'
  | 'purple-deep'
  | 'yellow'
  | 'green'
  | 'red'
  | 'blue'
  | 'ink'
  | 'faint'
  | 'chart-1'
  | 'chart-2'
  | 'chart-3'
  | 'chart-4'
  | 'chart-5';

/** `hsl(var(--token))` para usar en `style` (SVG, barras con ancho dinámico). */
export function tokenColor(token: BrandColor | string, alpha?: number): string {
  return alpha == null ? `hsl(var(--${token}))` : `hsl(var(--${token}) / ${alpha})`;
}

// ---------------------------------------------------------------------------------------------
// Tipografía
// ---------------------------------------------------------------------------------------------

/**
 * Eyebrow del mock: cuadrito de color (radio 2px) + etiqueta `label-caps`. Va encima de títulos de pantalla, de
 * sección y de modal. El cuadrito es naranja salvo que se pida otro token.
 */
export function Eyebrow({
  children,
  color = 'orange',
  className,
}: {
  children: ReactNode;
  color?: BrandColor;
  className?: string;
}) {
  return (
    <span className={cn('eyebrow', className)} style={{ '--sq': `var(--${color})` } as CSSProperties}>
      {children}
    </span>
  );
}

/** Etiqueta de interfaz `label-caps`: Inter Tight 600 MAYÚSCULAS (KPI, número de columna, metadatos). */
export function CapsLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('label-caps', className)}>{children}</span>;
}

/**
 * Encabezado de sección: eyebrow + título grande y apretado + lede. `actions` se alinea abajo a la
 * derecha (como `.shead` del mock). `size="lg"` para la cabecera de una pantalla entera.
 */
export function SectionHeader({
  eyebrow,
  eyebrowColor,
  title,
  lede,
  actions,
  size = 'md',
  className,
}: {
  eyebrow?: ReactNode;
  eyebrowColor?: BrandColor;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="grid min-w-0 gap-2">
        {eyebrow && <Eyebrow color={eyebrowColor}>{eyebrow}</Eyebrow>}
        <h2
          className={cn(
            'font-semibold text-foreground',
            size === 'sm' && 'text-lg tracking-[-0.025em]',
            size === 'md' && 'text-[22px] leading-tight tracking-[-0.03em]',
            size === 'lg' && 'text-[28px] leading-[1.08] tracking-[-0.04em] sm:text-[34px]',
          )}
        >
          {title}
        </h2>
        {lede && <p className="max-w-[58ch] text-sm text-muted-foreground sm:text-[15px]">{lede}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Superficies
// ---------------------------------------------------------------------------------------------

/**
 * Panel gris numerado del mock (`.pc`): radio 14px, sin borde, número "001" arriba. Para
 * secuencias (pasos de un flujo, fases) o para agrupar tarjetas blancas encima de él.
 */
export function Panel({
  n,
  title,
  description,
  children,
  className,
}: {
  /** Número de la secuencia: `1` → "001". Texto se pinta tal cual. */
  n?: number | string;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const num = typeof n === 'number' ? String(n).padStart(3, '0') : n;
  return (
    <div className={cn('grid min-w-0 content-start gap-4 rounded-xl bg-panel p-5 sm:p-7', className)}>
      {(num != null || title || description) && (
        <div className="grid gap-2">
          {num != null && <span className="text-[13px] text-faint tabular-nums">{num}</span>}
          {title && <h3 className="text-xl leading-tight tracking-[-0.03em] sm:text-2xl">{title}</h3>}
          {description && <p className="text-sm text-muted-foreground sm:text-[15px]">{description}</p>}
        </div>
      )}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Integraciones
// ---------------------------------------------------------------------------------------------

/**
 * Íconos oficiales (simple-icons + logos propios) servidos desde `public/integrations/`. Los que
 * son negros tienen versión `-light` para modo oscuro.
 */
const INTEGRATIONS = {
  linear: { label: 'Linear', dark: false },
  github: { label: 'GitHub', dark: true },
  claude: { label: 'Claude', dark: false },
  anthropic: { label: 'Anthropic', dark: true },
  vercel: { label: 'Vercel', dark: true },
  railway: { label: 'Railway', dark: true },
  supabase: { label: 'Supabase', dark: false },
  posthog: { label: 'PostHog', dark: false },
  googlecalendar: { label: 'Google Calendar', dark: false },
  googlemeet: { label: 'Google Meet', dark: false },
  resend: { label: 'Resend', dark: true },
  granola: { label: 'Granola', dark: false, ext: 'png' },
  orwel: { label: 'Orwel', dark: true },
  hyperops: { label: 'HyperOps', dark: true },
  discord: { label: 'Discord', dark: false },
} as const satisfies Record<string, { label: string; dark: boolean; ext?: string }>;

export type IntegrationName = keyof typeof INTEGRATIONS;

export function integrationLabel(name: IntegrationName): string {
  return INTEGRATIONS[name].label;
}

const ICON_SIZE = { xs: 'size-3', sm: 'size-[15px]', md: 'size-[22px]', lg: 'size-7' } as const;
const FRAME_SIZE = { xs: 'size-5 rounded', sm: 'size-[26px] rounded-md', md: 'size-[38px] rounded-[9px]', lg: 'size-12 rounded-[10px]' } as const;

/**
 * Ícono oficial de una integración. `framed` lo mete en la cajita blanca con hairline del mock
 * (`.lg`), que es como se ve en listas y en el feed. Elige la versión clara en modo oscuro.
 */
export function IntegrationIcon({
  name,
  size = 'md',
  framed = false,
  className,
  title,
}: {
  name: IntegrationName;
  size?: keyof typeof ICON_SIZE;
  framed?: boolean;
  className?: string;
  title?: string;
}) {
  const { resolved } = useTheme();
  const meta = INTEGRATIONS[name];
  const ext = 'ext' in meta ? meta.ext : 'svg';
  const file = meta.dark && resolved === 'dark' ? `${name}-light` : name;
  const img = (
    <img
      src={`/integrations/${file}.${ext}`}
      alt={framed ? '' : title ?? meta.label}
      title={framed ? undefined : title ?? meta.label}
      draggable={false}
      className={cn('block shrink-0 object-contain', ICON_SIZE[size], !framed && className)}
    />
  );
  if (!framed) return img;
  return (
    <span
      title={title ?? meta.label}
      className={cn('grid shrink-0 place-items-center border bg-card shadow-sm', FRAME_SIZE[size], className)}
    >
      {img}
    </span>
  );
}

/** Login de GitHub con su ícono, enlazado al perfil (11px, como `.gh` del mock). */
export function GithubHandle({ login, className }: { login: string; className?: string }) {
  return (
    <a
      href={`https://github.com/${encodeURIComponent(login)}`}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground tabular-nums',
        className,
      )}
    >
      <IntegrationIcon name="github" size="xs" title="" />
      <span className="truncate">{login}</span>
    </a>
  );
}

// ---------------------------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------------------------

export type { Presence } from '@/components/avatars';
export { PersonAvatar, ProjectIcon, RozBotAvatar } from '@/components/avatars';

const PRESENCE_DOT: Record<Presence, string> = { on: 'bg-green', meet: 'bg-yellow', off: 'bg-toggle-off' };
const PRESENCE_LABEL: Record<Presence, string> = { on: 'En línea', meet: 'En junta', off: 'Fuera' };

/**
 * Avatar de persona del mock (con punto de presencia opcional). Delega en `PersonAvatar`: foto de
 * GitHub → Discord → DiceBear `micah` sembrado con `email` (o `id`). Solo cuando no hay ni foto ni
 * semilla (personas de demo de la landing) pinta las iniciales sobre el color de marca de `color`.
 */
export function GithubAvatar({
  login,
  url,
  discordUrl,
  email,
  id,
  name,
  presence,
  color = 'ink',
  className = 'size-[34px]',
}: {
  login?: string | null;
  url?: string | null;
  discordUrl?: string | null;
  /** Semilla del avatar generado (preferida). */
  email?: string | null;
  /** id del dev: semilla si no hay correo. */
  id?: string | null;
  name: string;
  presence?: Presence;
  /** Fondo de las iniciales cuando no hay foto ni semilla. */
  color?: BrandColor;
  className?: string;
}) {
  if (url || login || discordUrl || avatarSeed(email, id)) {
    return (
      <PersonAvatar login={login} url={url} discordUrl={discordUrl} email={email} id={id} name={name} presence={presence} className={className} />
    );
  }
  return (
    <span className={cn('relative inline-grid shrink-0 place-items-center rounded-full', className)} title={name}>
      <span
        className={cn(
          'grid size-full place-items-center rounded-full text-xs font-semibold',
          color === 'ink' ? 'text-ink-foreground' : 'text-white',
        )}
        style={{ background: tokenColor(color) }}
      >
        {initials(name)}
      </span>
      {presence && (
        <span
          title={PRESENCE_LABEL[presence]}
          className={cn('absolute -bottom-px -right-px size-[30%] min-h-2 min-w-2 rounded-full ring-2 ring-card', PRESENCE_DOT[presence])}
        />
      )}
    </span>
  );
}
