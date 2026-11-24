// Matriz de acceso de la bóveda: filas = REPOS (agrupados por proyecto), columnas = llaves de equipo
// vigentes. Cada repo junta sus variantes Local y Prod (el CLI las nombra `<repo>-<etapa>`): en la
// celda va un punto por variante, en el mismo orden que sus chips. La gente del equipo que aún no
// registra su llave aparece como columna fantasma, y sin entornos la matriz se queda con filas
// fantasma: vacía conserva la misma geometría. El detalle de un repo (variables, accesos, dar acceso
// y comandos por variante) se abre en un modal.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, History, Laptop, Loader2, Search, ShieldAlert, UserPlus, X } from 'lucide-react';
import { PersonAvatar, ProjectIcon } from '@/components/avatars';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { invalidate } from '@/lib/store';
import { useAction } from '@/lib/useAction';
import { cn } from '@/lib/utils';
import {
  zeusApi, type ZeusMe, type ZeusOrgMember, type ZeusVaultEnvSummary, type ZeusVaultGrantIntent, type ZeusVaultKey, type ZeusVaultRevisionMeta,
} from '@/lib/zeus';
import type { Stage, VaultProjectGroup, VaultRepoGroup } from './vault-groups';
import { CmdLine } from './zeus-steps';
import { RailTitle, ago, dateTime } from './zeus-ui';

/** Llave de caché de la bóveda: aprobar o cancelar un acceso la revalida. */
export const VAULT_KEY = '/zeus/vault';

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

export type VaultProject = VaultProjectGroup<ZeusVaultEnvSummary>;
export type VaultRepo = VaultRepoGroup<ZeusVaultEnvSummary>;

const firstName = (s: string) => s.trim().split(/\s+/)[0] ?? s;

/** Lo que se hace con un entorno ya subido: [etiqueta, comando, para qué]. */
const DAILY_COMMANDS: Array<[string, string, string]> = [
  ['Bajar', 'zeus env pull <proyecto> [local|prod]', 'Dentro del repo: trae su entorno y lo descifra en tu máquina (local → .env, prod → .env.production).'],
  ['Ver qué te falta', 'zeus env status', 'Compara tus .env con la bóveda: qué falta, qué está viejo y qué cambiaste sin subir. Solo nombres.'],
  ['Rotar lo marcado', 'zeus env rotate --all', 'Llave nueva y todo vuelto a cifrar en cada entorno marcado. Hazlo después de quitar un acceso.'],
  ['Cifrar aprobados', 'zeus env grant --pending', 'Los accesos que se aprobaron aquí en la web: tu PC los cifra tras confirmar la huella de cada equipo.'],
];

// ---------------------------------------------------------------- etapas

/** Cómo se ve cada etapa: prod resalta (es la que duele), local es neutra-informativa. */
export const STAGE_META: Record<Stage, { label: string; variant: 'warn' | 'info' | 'human' | 'llm' | 'secondary'; dot: string }> = {
  production: { label: 'Prod', variant: 'warn', dot: 'bg-orange' },
  development: { label: 'Local', variant: 'info', dot: 'bg-blue' },
  staging: { label: 'Staging', variant: 'human', dot: 'bg-yellow' },
  preview: { label: 'Preview', variant: 'llm', dot: 'bg-purple' },
  test: { label: 'Test', variant: 'secondary', dot: 'bg-faint' },
};

const stageLabel = (s: Stage | null) => (s ? STAGE_META[s].label : 'Sin etapa');
const stageDot = (s: Stage | null) => (s ? STAGE_META[s].dot : 'bg-orange');

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

/** `<envId>:<devId>` de cada acceso aprobado que falta cifrar. */
function intentIndex(intents: ZeusVaultGrantIntent[]): Set<string> {
  return new Set(intents.map((i) => `${i.envId}:${i.toDevId}`));
}

function Legend() {
  return (
    <span className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full bg-blue" /> Local
        <span className="ml-1 size-2.5 rounded-full bg-orange" /> Prod: puede descifrar
      </span>
      <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full border border-orange bg-orange-soft" /> aprobado, falta cifrar</span>
      <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-toggle-off" /> sin acceso</span>
      <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full border border-dashed border-faint" /> sin llave</span>
    </span>
  );
}

/** Un chip por variante en la fila del repo: etapa, nº de variables y si toca rotar. Abre su detalle. */
function VariantChip({ env, stage, hits, onOpen }: { env: ZeusVaultEnvSummary; stage: Stage | null; hits?: string[]; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-tip={`${env.name} · llave v${env.dekVersion} · ver variables y accesos`}
      className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[5px] border bg-card px-1.5 text-[11px] transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className={cn('size-1.5 rounded-full', stageDot(stage))} />
      <span className="font-semibold uppercase tracking-[0.04em]">{stageLabel(stage)}</span>
      {hits ? (
        <span className="max-w-[140px] truncate font-mono text-[10.5px] text-foreground">{hits.length === 1 ? hits[0] : `${hits[0]} +${hits.length - 1}`}</span>
      ) : (
        <span className="tabular-nums text-muted-foreground">{env.secrets.length}</span>
      )}
      {env.needsRotation && <ShieldAlert className="size-3 text-yellow-ink" aria-label="Conviene rotar" />}
    </button>
  );
}

export function VaultMatrix({
  projects,
  keys,
  members,
  me,
  intents,
  ready,
  onOpen,
  className,
}: {
  projects: VaultProject[];
  /** Llaves vigentes. */
  keys: ZeusVaultKey[];
  members: ZeusOrgMember[];
  me: ZeusMe | null;
  /** Accesos aprobados en la web que falta cifrar. */
  intents: ZeusVaultGrantIntent[];
  /** Ya llegó la bóveda (aunque esté vacía). */
  ready: boolean;
  onOpen: (repoId: string, envId: string) => void;
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
  const pending = useMemo(() => intentIndex(intents), [intents]);

  // Buscador: por proyecto, repo, etapa (local/prod) o NOMBRE de variable ("¿dónde está STRIPE_KEY?").
  const [q, setQ] = useState('');
  const [stageFilter, setStageFilter] = useState<StageFilter>('all');
  const needle = fold(q.trim());
  const filtered = useMemo(() => {
    return projects
      .map((p) => {
        const varHits = new Map<string, string[]>();
        const repos = p.repos
          .map((r) => {
            const variants = r.variants.filter((v) => {
              if (stageFilter !== 'all' && v.stage !== stageFilter) return false;
              if (!needle) return true;
              if (fold(`${p.name} ${p.key} ${r.repo} ${v.env.name} ${stageLabel(v.stage)}`).includes(needle)) return true;
              const vars = v.env.secrets.map((s) => s.name).filter((n) => fold(n).includes(needle));
              if (vars.length) varHits.set(v.env.id, vars);
              return vars.length > 0;
            });
            return { ...r, variants };
          })
          .filter((r) => r.variants.length > 0);
        return { ...p, repos, varHits };
      })
      .filter((p) => p.repos.length > 0);
  }, [projects, needle, stageFilter]);
  const totalRepos = projects.reduce((s, p) => s + p.repos.length, 0);
  const totalEnvs = projects.reduce((s, p) => s + p.repos.reduce((n, r) => n + r.variants.length, 0), 0);
  const repoCount = filtered.reduce((s, p) => s + p.repos.length, 0);
  const filtering = !!needle || stageFilter !== 'all';

  // Las filas fantasma rellenan justo el alto que sobra: la matriz siempre llega al pie del panel,
  // con dos repos o con ninguno, sin provocar scroll por sí mismas.
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
  const ghostRows = filtering ? 0 : Math.max(repoCount === 0 ? 4 : 0, Math.floor((room - filtered.length * GROUP_H - repoCount * ROW_H) / ROW_H));

  return (
    <Card className={cn('flex min-h-0 flex-col overflow-hidden', className)} aria-busy={!ready}>
      <div className="grid gap-2.5 border-b px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold tracking-[-0.01em]">Quién puede descifrar qué</h2>
            <span className="label-caps tabular-nums">
              {ready && totalRepos === 0
                ? 'aún sin entornos'
                : `${filtering ? `${repoCount} de ${totalRepos}` : repoCount} ${totalRepos === 1 ? 'repo' : 'repos'} · ${totalEnvs} ${totalEnvs === 1 ? 'variante' : 'variantes'} · ${keys.length} ${keys.length === 1 ? 'llave' : 'llaves'}`}
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
            aria-label="Buscar repos"
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
                {s === 'all' ? 'Todas' : STAGE_META[s].label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div ref={wrapRef} className="scroll-thin min-h-0 flex-1 overflow-auto max-lg:min-h-[330px]">
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead ref={headRef}>
            <tr>
              <th scope="col" className="sticky left-0 top-0 z-20 min-w-[280px] border-b bg-card px-4 pb-2 pt-3 align-bottom">
                <span className="label-caps">Repo · variantes</span>
              </th>
              {columns.map((c) => (
                <th
                  key={c.id}
                  scope="col"
                  className="sticky top-0 z-10 w-[64px] min-w-[64px] border-b bg-card px-1 pb-2 pt-3 text-center align-bottom font-normal"
                  data-tip={c.ghost ? (c.name ? `${c.name} aún no registra la llave de su equipo` : undefined) : `${c.name} · ${c.keyName} · ${c.fingerprint}`}
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
            {filtering && repoCount === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="px-4 py-8 text-center text-[12.5px] text-muted-foreground">
                  Ningún repo coincide{needle ? ` con "${q.trim()}"` : ''}{stageFilter !== 'all' ? ` en ${STAGE_META[stageFilter].label}` : ''}.
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
                {p.repos.map((r) => (
                  <tr key={r.id} className="vault-row group/row">
                    <th scope="row" className="vault-cell sticky left-0 z-[5] border-b bg-card p-0 font-normal">
                      <div className="flex h-10 w-full items-center gap-2 px-4">
                        <button
                          type="button"
                          onClick={() => onOpen(r.id, r.variants[0]!.env.id)}
                          className="min-w-0 truncate rounded-sm text-left font-mono text-[12px] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          data-tip="Ver variables y accesos"
                        >
                          {r.repo}
                        </button>
                        <span className="flex shrink-0 items-center gap-1">
                          {r.variants.map((v) => (
                            <VariantChip key={v.env.id} env={v.env} stage={v.stage} hits={p.varHits.get(v.env.id)} onOpen={() => onOpen(r.id, v.env.id)} />
                          ))}
                        </span>
                        <ChevronRight className="ml-auto size-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100" />
                      </div>
                    </th>
                    {columns.map((c) => {
                      const states = r.variants.map((v) => {
                        const g = c.ghost ? undefined : v.env.grants.find((x) => x.keyId === c.id);
                        const state = g ? 'granted' : c.ghost ? 'ghost' : c.devId && pending.has(`${v.env.id}:${c.devId}`) ? 'pending' : 'none';
                        return { v, state };
                      });
                      const tip = c.name
                        ? states
                            .map(({ v, state }) =>
                              `${stageLabel(v.stage)}: ${state === 'granted' ? 'puede descifrar' : state === 'pending' ? 'aprobado, falta cifrar' : state === 'ghost' ? 'sin llave' : 'sin acceso'}`,
                            )
                            .join(' · ')
                        : undefined;
                      return (
                        <td key={c.id} className="vault-cell border-b text-center" data-tip={tip}>
                          <span className="flex h-10 items-center justify-center gap-1">
                            {states.map(({ v, state }) =>
                              state === 'granted' ? (
                                <span key={v.env.id} className={cn('vault-dot size-2.5 rounded-full', stageDot(v.stage))} aria-label={`${stageLabel(v.stage)}: puede descifrar`} />
                              ) : state === 'pending' ? (
                                <span key={v.env.id} className="size-2.5 rounded-full border border-orange bg-orange-soft" aria-label={`${stageLabel(v.stage)}: aprobado, falta cifrar`} />
                              ) : state === 'ghost' ? (
                                <span key={v.env.id} className="size-2.5 rounded-full border border-dashed border-toggle-off" aria-label="Sin llave" />
                              ) : (
                                <span key={v.env.id} className="grid size-2.5 place-items-center" aria-label={`${stageLabel(v.stage)}: sin acceso`}>
                                  <span className="size-1.5 rounded-full bg-toggle-off" />
                                </span>
                              ),
                            )}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
            {Array.from({ length: ghostRows }, (_, i) => (
              <tr key={`ghost-${i}`} aria-hidden>
                <td className="sticky left-0 border-b border-dashed bg-card px-4">
                  <span className="flex h-10 items-center gap-2">
                    <span className="h-1.5 rounded-full bg-panel" style={{ width: 70 + ((i * 37) % 60) }} />
                    <span className="h-5 rounded-[4px] border border-dashed border-toggle-off" style={{ width: 48 + ((i * 23) % 20) }} />
                    <span className="h-5 rounded-[4px] border border-dashed border-toggle-off" style={{ width: 48 + ((i * 17) % 20) }} />
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
            <span className="label-caps text-foreground/80" data-tip={title}>{label}</span>
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
              data-tip={restorable(r) ? 'Ver el comando para volver a esta versión' : undefined}
            >
              <span className="w-7 shrink-0 tabular-nums text-faint">v{r.version}</span>
              <span className={cn('shrink-0', r.current ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                {r.current ? 'actual' : r.deleted ? 'borrada' : !r.readable ? 'ilegible' : 'anterior'}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" data-tip={dateTime(r.setAt)}>
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

// ---------------------------------------------------------------- dar acceso (aprobar en la web)

/**
 * Quién tiene acceso a una variante, agrupado por persona, y el botón "Dar acceso". La web solo
 * APRUEBA: el navegador no tiene la llave del entorno. Lo cifra después el CLI de alguien con acceso
 * (`zeus env grant --pending`), que antes muestra la huella de cada equipo y pide confirmar.
 */
function AccessSection({
  env,
  keys,
  members,
  me,
  intents,
}: {
  env: ZeusVaultEnvSummary;
  keys: ZeusVaultKey[];
  members: ZeusOrgMember[];
  me: ZeusMe | null;
  intents: ZeusVaultGrantIntent[];
}) {
  const act = useAction();
  const granted = useMemo(() => new Set(env.grants.map((g) => g.keyId)), [env]);
  const people = useMemo(() => {
    const m = new Map<string, { devId: string; devName: string; keys: typeof env.grants }>();
    for (const g of env.grants) {
      const p = m.get(g.devId) ?? { devId: g.devId, devName: g.devName, keys: [] };
      p.keys.push(g);
      m.set(g.devId, p);
    }
    return [...m.values()].sort((a, b) => a.devName.localeCompare(b.devName, 'es'));
  }, [env]);
  const open = intents.filter((i) => i.envId === env.id);
  const openFor = new Set(open.map((i) => i.toDevId));
  const keysOf = (devId: string) => keys.filter((k) => k.devId === devId && !k.revokedAt);
  const iCan = !!me && keysOf(me.devId).some((k) => granted.has(k.id));
  const byDev = new Map(members.map((m) => [m.devId, m]));

  const options = useMemo<ComboboxOption[]>(
    () =>
      members
        .filter((m) => m.active)
        .sort((a, b) => a.name.localeCompare(b.name, 'es'))
        .map((m) => {
          const theirs = keysOf(m.devId);
          const missing = theirs.filter((k) => !granted.has(k.id)).length;
          const hint = !theirs.length
            ? 'Sin llave registrada (zeus key init)'
            : openFor.has(m.devId)
              ? 'Aprobado, falta cifrar'
              : missing === 0
                ? 'Ya tiene acceso'
                : missing < theirs.length
                  ? `Le falta ${missing} de ${theirs.length} equipos`
                  : theirs.length === 1 ? '1 equipo' : `${theirs.length} equipos`;
          return {
            value: m.devId,
            label: m.name,
            hint,
            keywords: m.email ?? undefined,
            disabled: !theirs.length || missing === 0 || openFor.has(m.devId),
            icon: <PersonAvatar name={m.name} login={m.githubLogin} email={m.email} id={m.devId} title="" className="size-5" />,
          };
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [members, keys, granted, intents, env.id],
  );

  const approve = (devId: string) =>
    void act.run(`approve:${env.id}:${devId}`, () => zeusApi.approveVaultGrant({ envId: env.id, toDevId: devId }), {
      success: { title: 'Acceso aprobado', description: 'Falta que alguien con acceso lo cifre en su PC: zeus env grant --pending' },
      error: 'No se pudo aprobar',
      onSettled: () => invalidate(VAULT_KEY),
    });
  const cancel = (id: string) =>
    void act.run(`cancel:${id}`, () => zeusApi.cancelVaultGrant(id), {
      success: 'Aprobación cancelada',
      error: 'No se pudo cancelar',
      onSettled: () => invalidate(VAULT_KEY),
    });

  return (
    <section className="grid min-w-0 content-start gap-2">
      <RailTitle meta={<span className="label-caps tabular-nums">{people.length}</span>}>Quién tiene acceso</RailTitle>
      {people.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nadie tiene acceso vigente.</p>
      ) : (
        <ul className="scroll-thin grid max-h-56 gap-2 overflow-y-auto">
          {people.map((p) => {
            const m = byDev.get(p.devId);
            return (
              <li key={p.devId} className="flex items-start gap-2 text-xs">
                <PersonAvatar name={p.devName} login={m?.githubLogin} email={m?.email} id={p.devId} title="" className="size-5 shrink-0" />
                <span className="grid min-w-0 gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">{p.devName}{p.devId === me?.devId && ' (tú)'}</span>
                    {p.keys.length > 1 && <span className="label-caps shrink-0 tabular-nums">×{p.keys.length}</span>}
                  </span>
                  {p.keys.map((g) => (
                    <span key={g.keyId} className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-faint" data-tip={`Desde ${dateTime(g.grantedAt)}`}>
                      <Laptop className="size-3 shrink-0" />
                      <span className="truncate">{g.keyName}</span>
                      <span className="truncate font-mono">{g.fingerprint}</span>
                    </span>
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {open.length > 0 && (
        <div className="grid gap-2 rounded-md border border-orange/40 bg-orange-soft px-3 py-2.5 text-xs text-orange-ink">
          <ul className="grid gap-1.5">
            {open.map((i) => (
              <li key={i.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 leading-snug">
                  <span className="font-semibold">{i.toDevName}</span>
                  <span> · aprobó {i.approvedByName ?? 'alguien'} {ago(i.createdAt)}</span>
                  {i.pendingKeys === 0 && <span> · sin equipo por cifrar</span>}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-2 text-orange-ink hover:bg-card"
                  disabled={act.busy(`cancel:${i.id}`)}
                  onClick={() => cancel(i.id)}
                >
                  Cancelar
                </Button>
              </li>
            ))}
          </ul>
          <p className="leading-snug">
            Acceso aprobado, falta que alguien con acceso lo cifre en su PC (zeus no puede: no tiene la llave). Al abrir sesión, su Claude se lo recuerda.
          </p>
          <CmdLine command="zeus env grant --pending" />
        </div>
      )}

      {iCan ? (
        <Combobox
          value={null}
          onChange={approve}
          options={options}
          searchPlaceholder="Buscar persona…"
          emptyText="Nadie más en el equipo"
          searchFrom={6}
          contentClassName="w-72"
          trigger={
            <Button variant="outline" size="sm" className="w-fit gap-1.5">
              <UserPlus className="size-3.5" /> Dar acceso
            </Button>
          }
        />
      ) : (
        <p className="text-[11.5px] leading-snug text-muted-foreground">Solo quien ya tiene acceso a esta variante puede aprobar que alguien más entre.</p>
      )}
    </section>
  );
}

/**
 * Detalle de un repo: sus variantes (Local, Prod…) como pestañas; de la elegida, los nombres de sus
 * variables (nunca valores), quién tiene acceso, dar acceso y sus comandos.
 */
export function VaultRepoDialog({
  repo,
  envId,
  onSelect,
  onClose,
  keys,
  members,
  me,
  intents,
}: {
  repo: VaultRepo | null;
  envId: string | null;
  onSelect: (envId: string) => void;
  onClose: () => void;
  keys: ZeusVaultKey[];
  members: ZeusOrgMember[];
  me: ZeusMe | null;
  intents: ZeusVaultGrantIntent[];
}) {
  const variant = repo ? (repo.variants.find((v) => v.env.id === envId) ?? repo.variants[0] ?? null) : null;
  const env = variant?.env ?? null;
  const other = repo && variant ? repo.variants.find((v) => v !== variant) ?? null : null;
  const stale = env ? env.secrets.filter((s) => s.stale).length : 0;
  const [openVar, setOpenVar] = useState<string | null>(null);
  useEffect(() => setOpenVar(null), [env?.id]);
  return (
    <Dialog open={!!repo} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        {repo && env && variant && (
          <>
            <DialogHeader eyebrow={`Zeus · variables · ${env.projectName}`}>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                <span className="rounded-[4px] bg-panel px-1.5 py-0.5 font-mono text-[13px] font-medium">{repo.repo}</span>
                {env.needsRotation && <Badge variant="human"><ShieldAlert className="size-3" /> Conviene rotar</Badge>}
              </DialogTitle>
              <DialogDescription>Solo nombres: los valores viven cifrados y se leen con el CLI en tu máquina.</DialogDescription>
            </DialogHeader>

            <div role="tablist" aria-label="Variante" className="flex w-fit items-center gap-0.5 rounded-md bg-panel p-0.5">
              {repo.variants.map((v) => (
                <button
                  key={v.env.id}
                  type="button"
                  role="tab"
                  aria-selected={v === variant}
                  onClick={() => onSelect(v.env.id)}
                  className={cn(
                    'flex h-8 items-center gap-1.5 rounded-[5px] px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground',
                    v === variant && 'bg-card text-foreground shadow-sm',
                  )}
                >
                  <span className={cn('size-1.5 rounded-full', stageDot(v.stage))} />
                  {stageLabel(v.stage)}
                  <span className="tabular-nums text-faint">v{v.env.dekVersion} · {v.env.secrets.length}</span>
                  {v.env.needsRotation && <ShieldAlert className="size-3 text-yellow-ink" aria-label="Conviene rotar" />}
                </button>
              ))}
            </div>

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
                  <p className="text-xs text-muted-foreground">Variante vacía. Súbelas con <code className="font-mono">zeus env push</code>.</p>
                ) : (
                  <ul className="scroll-thin grid max-h-80 gap-px overflow-y-auto rounded-md border px-2.5 py-1.5">
                    {env.secrets.map((s) => (
                      <li key={s.name} className="grid">
                        <button
                          type="button"
                          className="flex items-baseline gap-2 rounded-sm py-1 text-left text-xs hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => setOpenVar(openVar === s.name ? null : s.name)}
                          aria-expanded={openVar === s.name}
                          data-tip="Ver sus versiones"
                        >
                          <History className={cn('size-3 shrink-0 self-center text-faint', openVar === s.name && 'text-foreground')} />
                          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{s.name}</span>
                          {s.stale && <Badge variant="human" className="px-1.5 py-0 text-[10px]" data-tip="Cifrada con una versión anterior de la llave del entorno">llave vieja</Badge>}
                          <span className="shrink-0 tabular-nums text-faint">v{s.version}</span>
                          <span className="hidden shrink-0 text-muted-foreground sm:inline" data-tip={dateTime(s.updatedAt)}>
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

              <AccessSection env={env} keys={keys} members={members} me={me} intents={intents} />
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
              {other ? (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="label-caps">Comparar con {stageLabel(other.stage)}</span>
                  <CmdLine wrap command={`zeus env diff ${env.projectKey} ${env.name} ${other.env.name}`} />
                </div>
              ) : (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="label-caps">Ver y editar valores en tu navegador</span>
                  <CmdLine command={`zeus env ui ${env.projectKey} ${env.name}`} />
                </div>
              )}
              {other && (
                <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
                  <span className="label-caps">Ver y editar valores en tu navegador (solo en tu PC)</span>
                  <CmdLine command={`zeus env ui ${env.projectKey} ${env.name}`} />
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

