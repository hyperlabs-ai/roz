import { useEffect, useState, type ReactNode } from 'react';
import { Bell, Check, LogOut, Monitor, Moon, Palette, Sun, UserRound } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { useAuth } from '@/auth/AuthContext';
import { useTheme } from '@/components/theme';
import { CalendarConnectCard } from '@/components/CalendarConnectCard';
import { DiscordSettings, useDiscordStatus } from '@/components/discord/DiscordSettings';
import { RunnersCard } from '@/components/plans/RunnersCard';
import { useRozV2 } from '@/components/pulse/roz-v2';
import { CapsLabel, IntegrationIcon, type IntegrationName } from '@/components/brand';
import { MeAvatar } from '@/components/avatars';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { NotificationSettings, SWITCHES_KEY, fetchSwitches } from '@/components/settings/NotificationSettings';
import { Row, RowsCard, SettingsHeader } from '@/components/settings/parts';
import { cn } from '@/lib/utils';
import { useApi } from '@/lib/useApi';
import { apiGet, type CalendarConnection } from '@/lib/api';

type SectionId = 'notifications' | 'calendar' | 'discord' | 'runner' | 'appearance' | 'account';

/** Punto de estado junto a cada sección del menú (ok / aviso / problema). */
type Status = 'ok' | 'warn' | 'bad' | null;
const STATUS_DOT: Record<Exclude<Status, null>, string> = { ok: 'bg-green', warn: 'bg-yellow', bad: 'bg-red' };

const THEMES = [
  { key: 'light' as const, label: 'Claro', hint: 'Fondo hueso', icon: Sun },
  { key: 'dark' as const, label: 'Oscuro', hint: 'Negro cálido', icon: Moon },
  { key: 'system' as const, label: 'Sistema', hint: 'Sigue a tu equipo', icon: Monitor },
];

const ALL: SectionId[] = ['notifications', 'calendar', 'discord', 'runner', 'appearance', 'account'];

/** Sección inicial: la del hash (`#discord`) o la que pide el regreso de un OAuth (`?discord=ok`). */
function initialSection(): SectionId {
  const hash = window.location.hash.slice(1) as SectionId;
  if (ALL.includes(hash)) return hash;
  const p = new URLSearchParams(window.location.search);
  if (p.has('discord')) return 'discord';
  if (p.has('calendar')) return 'calendar';
  return 'notifications';
}

/** Bloque de terminal oscuro: cómo se conecta un equipo a roz-runner. */
function RunnerTerminal() {
  return (
    <Card className="grid gap-4 p-4 sm:p-5 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] md:items-center">
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-terminal px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-terminal-foreground">
        <span className="text-terminal-muted">$</span> npx roz-runner login{'\n'}
        <span className="text-green">✓</span> pega la URL de roz y tu token{'\n'}
        <span className="text-terminal-muted">$</span> roz-runner start --max 2 --horario 9-19{'\n'}
        <span className="text-orange">●</span> esperando trabajo…
      </pre>
      <div className="grid gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <IntegrationIcon name="claude" size="sm" /> En la PC de cada dev
        </span>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Hace polling hacia roz, sin abrir puertos. Cada trabajo corre en un git worktree aislado con{' '}
          <span className="font-mono text-foreground">claude -p</span>, el MCP de roz y una lista blanca de herramientas.
        </p>
      </div>
    </Card>
  );
}

/** Vista previa de lo que el equipo ve de ti según tu calendario (los tres estados posibles). */
function PresencePreview() {
  const states = [
    { dot: 'bg-green', label: 'Disponible', hint: 'Sin eventos en curso' },
    { dot: 'bg-yellow', label: 'En junta', hint: '«Daily» · hasta 10:30' },
    { dot: 'bg-toggle-off', label: 'Sin calendario', hint: 'Tu estado no aparece' },
  ];
  return (
    <RowsCard title="Qué ve el equipo">
      {states.map((s) => (
        <div key={s.label} className="flex min-h-[56px] items-center gap-3 px-4 py-2.5 sm:px-5">
          <span className="relative shrink-0">
            <MeAvatar className="size-8" />
            <span className={cn('absolute -bottom-px -right-px size-2.5 rounded-full ring-2 ring-card', s.dot)} />
          </span>
          <div className="grid min-w-0">
            <span className="text-[13px] font-semibold">{s.label}</span>
            <span className="truncate text-xs text-muted-foreground">{s.hint}</span>
          </div>
        </div>
      ))}
    </RowsCard>
  );
}

export default function Settings() {
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  // roz-runner solo existe con Linear como fuente de verdad (sus endpoints responden 409 sin él).
  const v2 = useRozV2();
  const discord = useDiscordStatus();
  // Misma clave que sus tarjetas: la caché se comparte y el menú no agrega peticiones.
  const calendar = useApi<CalendarConnection>(() => apiGet('/calendar/status'), [], { key: '/calendar/status', ttl: 60_000 });
  const switches = useApi(fetchSwitches, [], { key: SWITCHES_KEY, ttl: 60_000 });

  const [section, setSection] = useState<SectionId>(initialSection);

  const g = switches.data?.global;
  const me = switches.data?.me;
  const cal = calendar.data;
  const dl = discord.data;

  const nav: { id: SectionId; label: string; icon: ReactNode; status: Status; hidden?: boolean }[] = [
    {
      id: 'notifications',
      label: 'Notificaciones',
      icon: <Bell className="size-4" />,
      status: !g ? null : !g.emailEnabled || !g.pushEnabled ? 'warn' : me && (!me.emailEnabled || !me.pushEnabled) ? null : 'ok',
    },
    {
      id: 'calendar',
      label: 'Calendario',
      icon: <NavLogo name="googlecalendar" />,
      status: !cal?.connected ? null : cal.status === 'revoked' || cal.status === 'error' ? 'bad' : 'ok',
      hidden: !!cal && !cal.available,
    },
    {
      id: 'discord',
      label: 'Discord',
      icon: <NavLogo name="discord" />,
      status: !dl?.link ? null : dl.unavailable ? 'warn' : 'ok',
      hidden: !dl?.enabled,
    },
    { id: 'runner', label: 'roz-runner', icon: <NavLogo name="claude" />, status: null, hidden: !v2.linearSourceOfTruth },
    { id: 'appearance', label: 'Apariencia', icon: <Palette className="size-4" />, status: null },
    { id: 'account', label: 'Cuenta', icon: <UserRound className="size-4" />, status: null },
  ];
  const visible = nav.filter((n) => !n.hidden);
  // Si la sección elegida se oculta (flag apagado, deploy sin Google), cae a la primera.
  const current = visible.some((n) => n.id === section) ? section : visible[0].id;

  useEffect(() => {
    // El hash recuerda la sección al recargar sin pasar por el router (no re-renderiza nada).
    const url = `${window.location.pathname}${window.location.search}#${current}`;
    window.history.replaceState(window.history.state, '', url);
  }, [current]);

  return (
    <Layout title="Configuración">
      <div className="grid items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8">
        {/* Menú de secciones: columna fija en escritorio, carril horizontal en móvil. */}
        <nav aria-label="Secciones de configuración" className="lg:sticky lg:top-4">
          <ul className="scroll-none -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:grid lg:overflow-visible lg:px-0">
            {visible.map((n) => {
              const active = n.id === current;
              return (
                <li key={n.id} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => setSection(n.id)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-9 w-full items-center gap-2.5 whitespace-nowrap rounded-md px-3 text-[13.5px] transition-colors',
                      active ? 'bg-orange-soft font-semibold text-orange-ink' : 'text-muted-foreground hover:bg-sidebar hover:text-foreground',
                    )}
                  >
                    <span className={cn('grid size-4 place-items-center', !active && 'opacity-80')}>{n.icon}</span>
                    <span className="flex-1 text-left">{n.label}</span>
                    {n.status && <span className={cn('size-1.5 rounded-full', STATUS_DOT[n.status])} />}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div key={current} className="grid min-w-0 gap-5">
          {current === 'notifications' && (
            <>
              <SettingsHeader
                eyebrow="Avisos"
                title="Notificaciones"
                lede="Un aviso cuando un servicio se cae, te asignan una tarea o se documenta tu trabajo."
              />
              <NotificationSettings />
            </>
          )}

          {current === 'calendar' && (
            <>
              <SettingsHeader
                eyebrow="Fuentes"
                color="yellow"
                title="Calendario"
                lede="Tu disponibilidad alimenta la presencia del equipo y la capacidad de la semana."
              />
              <div className="grid items-stretch gap-3.5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
                <CalendarConnectCard />
                <PresencePreview />
              </div>
            </>
          )}

          {current === 'discord' && (
            <>
              <SettingsHeader
                eyebrow="Fuentes"
                color="blue"
                title="Discord"
                lede="El chat del equipo son los canales del servidor de Discord. Liga tu cuenta para ver los que tienes permitidos."
              />
              <DiscordSettings />
            </>
          )}

          {current === 'runner' && (
            <>
              <SettingsHeader
                eyebrow="Agentes"
                color="purple-deep"
                title="roz-runner"
                lede="Un token por equipo, revocable. El runner toma los planes de tu cola y los corre en tu PC con tu cuenta de Claude."
              />
              <RunnerTerminal />
              <RunnersCard />
            </>
          )}

          {current === 'appearance' && (
            <>
              <SettingsHeader eyebrow="Tú" color="ink" title="Apariencia" lede="El botón del encabezado alterna claro y oscuro; aquí también puedes seguir al sistema." />
              <RowsCard title="Tema de la interfaz">
                <div className="grid grid-cols-3 gap-2.5 p-4 sm:p-5">
                  {THEMES.map(({ key, label, hint, icon: Icon }) => {
                    const active = theme === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setTheme(key)}
                        aria-pressed={active}
                        className={cn(
                          'press relative grid justify-items-center gap-1.5 rounded-lg border-[1.5px] px-3 py-5 text-sm transition-colors',
                          active ? 'border-orange bg-orange-soft text-orange-ink' : 'border-border text-muted-foreground hover:bg-sidebar',
                        )}
                      >
                        <Icon className="size-5" />
                        <span className="font-semibold">{label}</span>
                        <span className={cn('hidden text-[11.5px] sm:block', active ? 'text-orange-ink/80' : 'text-faint')}>{hint}</span>
                        {active && <Check className="absolute right-2 top-2 size-3.5" />}
                      </button>
                    );
                  })}
                </div>
              </RowsCard>
            </>
          )}

          {current === 'account' && (
            <>
              <SettingsHeader eyebrow="Tú" color="ink" title="Cuenta" />
              <RowsCard title="Perfil">
                <div className="flex min-h-[72px] items-center gap-3.5 px-4 py-3.5 sm:px-5">
                  <MeAvatar className="size-12" />
                  <div className="grid min-w-0 gap-0.5">
                    <span className="truncate text-[15px] font-semibold">{user?.name ?? user?.email}</span>
                    <span className="truncate text-xs text-muted-foreground">{user?.email}</span>
                    {user?.role && <CapsLabel>{user.role}</CapsLabel>}
                  </div>
                </div>
                <Row icon={LogOut} title="Cerrar sesión" hint="Sales de roz en este navegador.">
                  <Button variant="secondary" size="sm" onClick={signOut} className="text-red">
                    <LogOut /> Cerrar sesión
                  </Button>
                </Row>
              </RowsCard>
            </>
          )}

        </div>
      </div>
    </Layout>
  );
}

function NavLogo({ name }: { name: IntegrationName }) {
  return <IntegrationIcon name={name} size="sm" title="" />;
}
