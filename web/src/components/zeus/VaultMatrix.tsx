// Matriz de acceso de la bóveda: filas = entornos (agrupados por proyecto), columnas = llaves de
// equipo vigentes; un punto = esa llave puede descifrar ese entorno. La gente del equipo que aún no
// registra su llave aparece como columna fantasma, y sin entornos la matriz se queda con filas
// fantasma: vacía conserva la misma geometría. El detalle de un entorno (nombres de variables,
// equipos con acceso, comandos) se abre en un modal.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, History, Laptop, Loader2, Search, ShieldAlert, X } from 'lucide-react';
import { PersonAvatar, ProjectIcon } from '@/components/avatars';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { zeusApi, type ZeusMe, type ZeusOrgMember, type ZeusVaultEnvSummary, type ZeusVaultKey, type ZeusVaultRevisionMeta } from '@/lib/zeus';
import { CmdLine } from './zeus-steps';
import { RailTitle, ago, dateTime } from './zeus-ui';

const ROW_H = 41;
const GROUP_H = 30;
const GHOST_COLS = 6;

interface Column {
  id: string;
  devId: string | null;
  name: string;
  keyName: string | null;
  fingerprint: string | null;
  member: ZeusOrgMember | null;
  ghost: boolean;
}

export interface VaultProject {
  id: string;
  key: string;
  name: string;
  envs: ZeusVaultEnvSummary[];
}

const firstName = (s: string) => s.trim().split(/\s+/)[0] ?? s;

/** Lo que se hace con un entorno ya subido: [etiqueta, comando, para qué]. */
const DAILY_COMMANDS: Array<[string, string, string]> = [
  ['Bajar', 'zeus env pull <proyecto> [local|prod]', 'Dentro del repo: trae su entorno y lo descifra en tu máquina (local → .env, prod → .env.production).'],
  ['Ver qué te falta', 'zeus env status', 'Compara tus .env con la bóveda: qué falta, qué está viejo y qué cambiaste sin subir. Solo nombres.'],
  ['Rotar lo marcado', 'zeus env rotate --all', 'Llave nueva y todo vuelto a cifrar en cada entorno marcado. Hazlo después de quitar un acceso.'],
  ['Dar acceso a todo', 'zeus env grant --all --to <dev>', 'Una sola verificación de huella para todos los entornos a los que tienes acceso (--env para solo uno).'],
];

// ---------------------------------------------------------------- etapas

/** Etapas del estándar del CLI: un entorno se llama `<repo>-<etapa>` (o solo la etapa). */
const STAGES = ['development', 'production', 'staging', 'preview', 'test'] as const;
type Stage = (typeof STAGES)[number];

/** `api-hyperhub-production` → { repo: 'api-hyperhub', stage: 'production' }. */
export function envParts(name: string): { repo: string | null; stage: Stage | null } {
  const stage = STAGES.find((s) => name === s || name.endsWith(`-${s}`)) ?? null;
  if (!stage) return { repo: null, stage: null };
  return { repo: name === stage ? null : name.slice(0, -(stage.length + 1)), stage };
}

/** Cómo se ve cada etapa: prod resalta (es la que duele), local es neutra-informativa. */
export const STAGE_META: Record<Stage, { label: string; variant: 'warn' | 'info' | 'human' | 'llm' | 'secondary'; dot: string }> = {
  production: { label: 'Prod', variant: 'warn', dot: 'bg-orange' },
  development: { label: 'Local', variant: 'info', dot: 'bg-blue' },
  staging: { label: 'Staging', variant: 'human', dot: 'bg-yellow' },
  preview: { label: 'Preview', variant: 'llm', dot: 'bg-purple' },
  test: { label: 'Test', variant: 'secondary', dot: 'bg-faint' },
};

export function StageChip({ stage, className }: { stage: Stage | null; className?: string }) {
  if (!stage) return null;
  const m = STAGE_META[stage];
  return (
    <Badge variant={m.variant} className={cn('px-1.5 py-0 text-[10px] font-semibold uppercase tracking-[0.04em]', className)}>
      {m.label}
    </Badge>
  );
}

type StageFilter = 'all' | 'development' | 'production';

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function Legend() {
  return (
    <span className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-orange" /> puede descifrar</span>
      <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-toggle-off" /> sin acceso</span>
      <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full border border-dashed border-faint" /> sin llave</span>
    </span>
  );
}

export function VaultMatrix({
  projects,
  keys,
  members,
  me,
  ready,
  onOpenEnv,
  className,
}: {
  projects: VaultProject[];
  /** Llaves vigentes. */
  keys: ZeusVaultKey[];
  members: ZeusOrgMember[];
  me: ZeusMe | null;
  /** Ya llegó la bóveda (aunque esté vacía). */
  ready: boolean;
  onOpenEnv: (envId: string) => void;
  className?: string;
}) {
  const columns = useMemo<Column[]>(() => {
    const byDev = new Map(members.map((m) => [m.devId, m]));
    const withKey = new Set(keys.map((k) => k.devId));
    const real: Column[] = keys.map((k) => ({
      id: k.id, devId: k.devId, name: k.devName, keyName: k.name, fingerprint: k.fingerprint, member: byDev.get(k.devId) ?? null, ghost: false,
    }));
    const waiting: Column[] = members
      .filter((m) => m.active && !withKey.has(m.devId))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
      .map((m) => ({ id: `dev:${m.devId}`, devId: m.devId, name: m.name, keyName: null, fingerprint: null, member: m, ghost: true }));
    const cols = [...real, ...waiting];
    if (cols.length > 0) return cols;
    return Array.from({ length: GHOST_COLS }, (_, i) => ({ id: `ghost:${i}`, devId: null, name: '', keyName: null, fingerprint: null, member: null, ghost: true }));
  }, [keys, members]);

  // Buscador: por proyecto, repo, etapa (local/prod) o NOMBRE de variable ("¿dónde está STRIPE_KEY?").
  const [q, setQ] = useState('');
  const [stageFilter, setStageFilter] = useState<StageFilter>('all');
  const needle = fold(q.trim());
  const filtered = useMemo<Array<VaultProject & { varHits: Map<string, string[]> }>>(() => {
    return projects
      .map((p) => {
        const varHits = new Map<string, string[]>();
        const envs = p.envs.filter((e) => {
          const { stage } = envParts(e.name);
          if (stageFilter !== 'all' && stage !== stageFilter) return false;
          if (!needle) return true;
          const label = stage ? STAGE_META[stage].label : '';
          if (fold(`${p.name} ${p.key} ${e.name} ${label}`).includes(needle)) return true;
          const vars = e.secrets.map((s) => s.name).filter((n) => fold(n).includes(needle));
          if (vars.length) varHits.set(e.id, vars);
          return vars.length > 0;
        });
        return { ...p, envs, varHits };
      })
      .filter((p) => p.envs.length > 0);
  }, [projects, needle, stageFilter]);
  const totalEnvs = projects.reduce((s, p) => s + p.envs.length, 0);
  const envCount = filtered.reduce((s, p) => s + p.envs.length, 0);
  const filtering = !!needle || stageFilter !== 'all';

  // Las filas fantasma rellenan justo el alto que sobra: la matriz siempre llega al pie del panel,
  // con dos entornos o con ninguno, sin provocar scroll por sí mismas.
  const wrapRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLTableSectionElement>(null);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setRoom(el.clientHeight - (headRef.current?.offsetHeight ?? 0));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ghostRows = filtering ? 0 : Math.max(envCount === 0 ? 4 : 0, Math.floor((room - filtered.length * GROUP_H - envCount * ROW_H) / ROW_H));

  return (
    <Card className={cn('flex min-h-0 flex-col overflow-hidden', className)} aria-busy={!ready}>
      <div className="grid gap-2.5 border-b px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold tracking-[-0.01em]">Quién puede descifrar qué</h2>
            <span className="label-caps tabular-nums">
              {ready && totalEnvs === 0
                ? 'aún sin entornos'
                : `${filtering ? `${envCount} de ${totalEnvs}` : envCount} ${totalEnvs === 1 ? 'entorno' : 'entornos'} · ${keys.length} ${keys.length === 1 ? 'llave' : 'llaves'}`}
            </span>
          </div>
          <Legend />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            fieldSize="sm"
            value={q}
            onChange={(ev) => setQ(ev.target.value)}
            onKeyDown={(ev) => ev.key === 'Escape' && setQ('')}
            placeholder="Buscar proyecto, repo o variable…"
            aria-label="Buscar entornos"
            leading={<Search />}
            trailing={
              q ? (
                <button type="button" onClick={() => setQ('')} aria-label="Limpiar búsqueda" className="grid size-6 place-items-center rounded-sm text-faint hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              ) : undefined
            }
            wrapperClassName="min-w-[200px] flex-1"
          />
          <div role="radiogroup" aria-label="Etapa" className="flex shrink-0 items-center gap-0.5 rounded-md bg-panel p-0.5">
            {(['all', 'development', 'production'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={stageFilter === s}
                onClick={() => setStageFilter(s)}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground',
                  stageFilter === s && 'bg-card text-foreground shadow-sm',
                )}
              >
                {s !== 'all' && <span className={cn('size-1.5 rounded-full', STAGE_META[s].dot)} />}
                {s === 'all' ? 'Todos' : STAGE_META[s].label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div ref={wrapRef} className="scroll-thin min-h-0 flex-1 overflow-auto max-lg:min-h-[330px]">
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead ref={headRef}>
            <tr>
              <th scope="col" className="sticky left-0 top-0 z-20 min-w-[212px] border-b bg-card px-4 pb-2 pt-3 align-bottom">
                <span className="label-caps">Proyecto · entorno</span>
              </th>
              {columns.map((c) => (
                <th
                  key={c.id}
                  scope="col"
                  className="sticky top-0 z-10 w-[64px] min-w-[64px] border-b bg-card px-1 pb-2 pt-3 text-center align-bottom font-normal"
                  title={c.ghost ? (c.name ? `${c.name} aún no registra la llave de su equipo` : undefined) : `${c.name} · ${c.keyName}\n${c.fingerprint}`}
                >
                  <span className="grid justify-items-center gap-1">
                    {c.devId ? (
                      <PersonAvatar
                        name={c.name}
                        login={c.member?.githubLogin}
                        email={c.member?.email}
                        id={c.devId}
                        title=""
                        className={cn('size-7', c.ghost && 'opacity-40 grayscale', !c.ghost && c.devId === me?.devId && 'ring-2 ring-orange ring-offset-2 ring-offset-card')}
                      />
                    ) : (
                      <span className="size-7 rounded-full border border-dashed border-toggle-off" />
                    )}
                    <span className={cn('block w-full truncate text-[11px] font-medium leading-tight', c.ghost && 'text-faint')}>{c.name ? firstName(c.name) : ' '}</span>
                    <span className="block w-full truncate text-[9.5px] leading-tight text-faint">{c.ghost ? 'sin llave' : c.keyName}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtering && envCount === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="px-4 py-8 text-center text-[12.5px] text-muted-foreground">
                  Ningún entorno coincide{needle ? ` con "${q.trim()}"` : ''}{stageFilter !== 'all' ? ` en ${STAGE_META[stageFilter].label}` : ''}.
                </td>
              </tr>
            )}
            {filtered.map((p) => (
              <Fragment key={p.id}>
                <tr>
                  <th scope="rowgroup" colSpan={columns.length + 1} className="h-[30px] border-b bg-sidebar px-4 py-0 font-normal">
                    <span className="sticky left-4 inline-flex items-center gap-2">
                      <ProjectIcon id={p.id} size="xs" />
                      <span className="text-[12px] font-semibold">{p.name}</span>
                      <span className="font-mono text-[10.5px] text-faint">{p.key}</span>
                    </span>
                  </th>
                </tr>
                {p.envs.map((e) => {
                  const granted = new Map(e.grants.map((g) => [g.keyId, g]));
                  const { repo, stage } = envParts(e.name);
                  const hits = p.varHits.get(e.id);
                  return (
                    <tr key={e.id} className="vault-row group/row">
                      <th scope="row" className="vault-cell sticky left-0 z-[5] border-b bg-card p-0 font-normal">
                        <button
                          type="button"
                          onClick={() => onOpenEnv(e.id)}
                          className={cn(
                            'relative flex h-10 w-full items-center gap-2 px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                            // Prod lleva un filo naranja: se distingue de local de un vistazo.
                            stage === 'production' && 'before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-orange',
                          )}
                          title={`${e.name} · ver variables y accesos`}
                        >
                          <StageChip stage={stage} className="w-[52px] shrink-0 justify-center" />
                          <span className="truncate font-mono text-[12px] font-medium">{repo ?? (stage ? p.key.toLowerCase() : e.name)}</span>
                          <span className="whitespace-nowrap text-[11.5px] tabular-nums text-muted-foreground">
                            {hits ? (
                              <span className="font-mono text-foreground" title={hits.join(', ')}>{hits.length === 1 ? hits[0] : `${hits[0]} +${hits.length - 1}`}</span>
                            ) : (
                              <>v{e.dekVersion} · {e.secrets.length} {e.secrets.length === 1 ? 'variable' : 'variables'}</>
                            )}
                          </span>
                          {e.needsRotation && (
                            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-yellow-soft px-1.5 py-0.5 text-[10.5px] font-medium text-yellow-ink">
                              <ShieldAlert className="size-3" /> Rotar
                            </span>
                          )}
                          <ChevronRight className="ml-auto size-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100" />
                        </button>
                      </th>
                      {columns.map((c) => {
                        const g = c.ghost ? undefined : granted.get(c.id);
                        return (
                          <td key={c.id} className="vault-cell border-b text-center" title={g ? `${g.devName} · ${g.keyName} · desde ${dateTime(g.grantedAt)}` : undefined}>
                            <span className="grid h-10 place-items-center">
                              {g ? (
                                <span className="vault-dot size-2.5 rounded-full bg-orange" aria-label="Puede descifrar" />
                              ) : c.ghost ? (
                                <span className="size-2.5 rounded-full border border-dashed border-toggle-off" aria-label="Sin llave" />
                              ) : (
                                <span className="size-1.5 rounded-full bg-toggle-off" aria-label="Sin acceso" />
                              )}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </Fragment>
            ))}
            {Array.from({ length: ghostRows }, (_, i) => (
              <tr key={`ghost-${i}`} aria-hidden>
                <td className="sticky left-0 border-b border-dashed bg-card px-4">
                  <span className="flex h-10 items-center gap-2">
                    <span className="h-5 rounded-[4px] border border-dashed border-toggle-off" style={{ width: 54 + ((i * 23) % 40) }} />
                    <span className="h-1.5 rounded-full bg-panel" style={{ width: 70 + ((i * 37) % 60) }} />
                  </span>
                </td>
                {columns.map((c) => (
                  <td key={c.id} className="border-b border-dashed text-center">
                    <span className="grid h-10 place-items-center"><span className="size-2.5 rounded-full border border-dashed border-toggle-off/80" /></span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Día a día: lo que se hace con un entorno ya subido. */}
      <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 border-t bg-sidebar px-4 py-2.5 min-[1800px]:grid-cols-[max-content_minmax(0,1fr)_max-content_minmax(0,1fr)]">
        {DAILY_COMMANDS.map(([label, command, title]) => (
          <Fragment key={label}>
            <span className="label-caps text-foreground/80" title={title}>{label}</span>
            <CmdLine className="min-w-0" command={command} />
          </Fragment>
        ))}
      </div>
    </Card>
  );
}

/** Versiones de una variable: quién y cuándo, cuáles se borraron, y el comando para volver a una. */
function VarHistory({ projectKey, env, name }: { projectKey: string; env: string; name: string }) {
  const [rows, setRows] = useState<ZeusVaultRevisionMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    zeusApi
      .vaultHistory(projectKey, env, name)
      .then((r) => live && setRows(r.revisions))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'No se pudo cargar el historial'));
    return () => {
      live = false;
    };
  }, [projectKey, env, name]);
  if (error) return <p className="px-1 pb-1.5 text-[11.5px] text-red">{error}</p>;
  if (!rows) return <p className="flex items-center gap-1.5 px-1 pb-1.5 text-[11.5px] text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Cargando versiones…</p>;
  const restorable = (r: ZeusVaultRevisionMeta) => !r.current && !r.deleted && r.readable;
  return (
    <div className="grid gap-1.5 pb-2 pl-1">
      <ol className="grid gap-0.5 border-l pl-2.5">
        {rows.map((r) => (
          <li key={r.version}>
            <button
              type="button"
              disabled={!restorable(r)}
              onClick={() => setPick(pick === r.version ? null : r.version)}
              className={cn(
                'flex w-full items-baseline gap-2 rounded-sm px-1 py-0.5 text-left text-[11.5px]',
                restorable(r) ? 'hover:bg-panel' : 'cursor-default',
                pick === r.version && 'bg-panel',
              )}
              title={restorable(r) ? 'Ver el comando para volver a esta versión' : undefined}
            >
              <span className="w-7 shrink-0 tabular-nums text-faint">v{r.version}</span>
              <span className={cn('shrink-0', r.current ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                {r.current ? 'actual' : r.deleted ? 'borrada' : !r.readable ? 'ilegible' : 'anterior'}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={dateTime(r.setAt)}>
                {r.setByName ?? 'alguien'} · {ago(r.setAt)}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {rows.length === 1 && <p className="text-[11px] text-faint">Sin versiones anteriores todavía.</p>}
      {pick != null && <CmdLine wrap className="mr-1" command={`zeus env restore ${projectKey} ${env} ${name} --version ${pick}`} />}
    </div>
  );
}

/** Detalle de un entorno: nombres de variables (nunca valores), equipos con acceso y sus comandos. */
export function VaultEnvDialog({ env, onClose }: { env: ZeusVaultEnvSummary | null; onClose: () => void }) {
  const stale = env ? env.secrets.filter((s) => s.stale).length : 0;
  const [openVar, setOpenVar] = useState<string | null>(null);
  useEffect(() => setOpenVar(null), [env?.id]);
  return (
    <Dialog open={!!env} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        {env && (
          <>
            <DialogHeader eyebrow={`Zeus · llaves · ${env.projectName}`}>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                <StageChip stage={envParts(env.name).stage} />
                <span className="rounded-[4px] bg-panel px-1.5 py-0.5 font-mono text-[13px] font-medium">{env.name}</span>
                <span className="label-caps tabular-nums">llave v{env.dekVersion}</span>
                {env.needsRotation && <Badge variant="human"><ShieldAlert className="size-3" /> Conviene rotar</Badge>}
              </DialogTitle>
              <DialogDescription>Solo nombres: los valores viven cifrados y se leen con el CLI en tu máquina.</DialogDescription>
            </DialogHeader>

            {env.needsRotation && (
              <div className="grid gap-2 rounded-md border border-yellow/40 bg-yellow-soft px-3 py-2.5 text-xs text-yellow-ink">
                <p className="flex items-start gap-2">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    <span className="font-semibold">Se quitó un acceso desde la última rotación.</span> Esa persona ya vio los valores: rota la llave del entorno y cambia
                    en el proveedor los secretos que importen.
                  </span>
                </p>
                <CmdLine command={`zeus env rotate ${env.projectKey} ${env.name}`} />
              </div>
            )}

            <div className="grid gap-5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <section className="grid min-w-0 content-start gap-2">
                <RailTitle meta={<span className="label-caps tabular-nums">{env.secrets.length}</span>}>Variables (solo nombres)</RailTitle>
                {env.secrets.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Entorno vacío. Súbelas con <code className="font-mono">zeus env push</code>.</p>
                ) : (
                  <ul className="scroll-thin grid max-h-80 gap-px overflow-y-auto rounded-md border px-2.5 py-1.5">
                    {env.secrets.map((s) => (
                      <li key={s.name} className="grid">
                        <button
                          type="button"
                          className="flex items-baseline gap-2 rounded-sm py-1 text-left text-xs hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => setOpenVar(openVar === s.name ? null : s.name)}
                          aria-expanded={openVar === s.name}
                          title="Ver sus versiones"
                        >
                          <History className={cn('size-3 shrink-0 self-center text-faint', openVar === s.name && 'text-foreground')} />
                          <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={s.name}>{s.name}</span>
                          {s.stale && <Badge variant="human" className="px-1.5 py-0 text-[10px]" title="Cifrada con una versión anterior de la llave del entorno">llave vieja</Badge>}
                          <span className="shrink-0 tabular-nums text-faint">v{s.version}</span>
                          <span className="hidden shrink-0 text-muted-foreground sm:inline" title={dateTime(s.updatedAt)}>
                            {s.updatedByName ? `${s.updatedByName} · ` : ''}{ago(s.updatedAt)}
                          </span>
                        </button>
                        {openVar === s.name && <VarHistory projectKey={env.projectKey} env={env.name} name={s.name} />}
                      </li>
                    ))}
                  </ul>
                )}
                {stale > 0 && (
                  <p className="text-[11.5px] text-yellow-ink">
                    {stale} {stale === 1 ? 'variable sigue cifrada' : 'variables siguen cifradas'} con una llave anterior: una rotación las pone al día.
                  </p>
                )}
              </section>

              <section className="grid min-w-0 content-start gap-2">
                <RailTitle meta={<span className="label-caps tabular-nums">{env.grants.length}</span>}>Equipos con acceso</RailTitle>
                {env.grants.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nadie tiene acceso vigente. Un admin lo da con <code className="font-mono">zeus env grant</code>.</p>
                ) : (
                  <ul className="scroll-thin grid max-h-72 gap-2 overflow-y-auto">
                    {env.grants.map((g) => (
                      <li key={g.keyId} className="flex items-start gap-2 text-xs">
                        <Laptop className="mt-0.5 size-3.5 shrink-0 text-faint" />
                        <span className="grid min-w-0 gap-0.5">
                          <span className="truncate"><span className="font-medium">{g.devName}</span> <span className="text-muted-foreground">· {g.keyName}</span></span>
                          <span className="truncate font-mono text-[10.5px] text-faint" title={`Desde ${dateTime(g.grantedAt)}`}>{g.fingerprint}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <div className="grid gap-x-4 gap-y-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="label-caps">Bajar a tu máquina</span>
                <CmdLine command={`zeus env pull ${env.projectKey} ${env.name}`} />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="label-caps">Ver qué te falta</span>
                <CmdLine command={`zeus env status ${env.projectKey} ${env.name}`} />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="label-caps">Cambiar una (copia el valor antes)</span>
                <CmdLine wrap command={`zeus env set ${env.projectKey} ${env.name} NOMBRE --from-clipboard`} />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="label-caps">Comparar con {env.name === 'production' ? 'development' : 'production'}</span>
                <CmdLine wrap command={`zeus env diff ${env.projectKey} ${env.name} ${env.name === 'production' ? 'development' : 'production'}`} />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
                <span className="label-caps">Ver y editar valores en tu navegador (solo en tu PC)</span>
                <CmdLine command={`zeus env ui ${env.projectKey} ${env.name}`} />
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
