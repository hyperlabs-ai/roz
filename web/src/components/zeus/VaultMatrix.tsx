// Matriz de acceso de la bóveda: filas = entornos (agrupados por proyecto), columnas = llaves de
// equipo vigentes; un punto = esa llave puede descifrar ese entorno. La gente del equipo que aún no
// registra su llave aparece como columna fantasma, y sin entornos la matriz se queda con filas
// fantasma: vacía conserva la misma geometría. El detalle de un entorno (nombres de variables,
// equipos con acceso, comandos) se abre en un modal.
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Laptop, ShieldAlert } from 'lucide-react';
import { PersonAvatar, ProjectIcon } from '@/components/avatars';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { ZeusMe, ZeusOrgMember, ZeusVaultEnvSummary, ZeusVaultKey } from '@/lib/zeus';
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

  const envCount = projects.reduce((s, p) => s + p.envs.length, 0);

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
  const ghostRows = Math.max(envCount === 0 ? 4 : 0, Math.floor((room - projects.length * GROUP_H - envCount * ROW_H) / ROW_H));

  return (
    <Card className={cn('flex min-h-0 flex-col overflow-hidden', className)} aria-busy={!ready}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold tracking-[-0.01em]">Quién puede descifrar qué</h2>
          <span className="label-caps tabular-nums">{ready && envCount === 0 ? 'aún sin entornos' : `${envCount} ${envCount === 1 ? 'entorno' : 'entornos'} · ${keys.length} ${keys.length === 1 ? 'llave' : 'llaves'}`}</span>
        </div>
        <Legend />
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
            {projects.map((p) => (
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
                  return (
                    <tr key={e.id} className="vault-row group/row">
                      <th scope="row" className="vault-cell sticky left-0 z-[5] border-b bg-card p-0 font-normal">
                        <button
                          type="button"
                          onClick={() => onOpenEnv(e.id)}
                          className="flex h-10 w-full items-center gap-2 px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          title="Ver variables y accesos"
                        >
                          <span className="rounded-[4px] bg-panel px-1.5 py-0.5 font-mono text-[11.5px] font-medium">{e.name}</span>
                          <span className="whitespace-nowrap text-[11.5px] tabular-nums text-muted-foreground">v{e.dekVersion} · {e.secrets.length} {e.secrets.length === 1 ? 'variable' : 'variables'}</span>
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
      <div className="grid gap-x-5 gap-y-2 border-t bg-sidebar px-4 py-2.5 2xl:grid-cols-2">
        <div className="flex min-w-0 items-center gap-2.5" title="Trae un entorno y lo descifra en tu máquina.">
          <span className="label-caps shrink-0 text-foreground/80">Bajar</span>
          <CmdLine className="min-w-0 flex-1" command="zeus env pull <proyecto> [entorno]" />
        </div>
        <div className="flex min-w-0 items-center gap-2.5" title="Llave nueva y todo vuelto a cifrar. Hazlo después de quitar un acceso: lo ya visto no se des-enseña.">
          <span className="label-caps shrink-0 text-foreground/80">Rotar tras quitar un acceso</span>
          <CmdLine className="min-w-0 flex-1" command="zeus env rotate" />
        </div>
      </div>
    </Card>
  );
}

/** Detalle de un entorno: nombres de variables (nunca valores), equipos con acceso y sus comandos. */
export function VaultEnvDialog({ env, onClose }: { env: ZeusVaultEnvSummary | null; onClose: () => void }) {
  const stale = env ? env.secrets.filter((s) => s.stale).length : 0;
  return (
    <Dialog open={!!env} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        {env && (
          <>
            <DialogHeader eyebrow={`Zeus · llaves · ${env.projectName}`}>
              <DialogTitle className="flex flex-wrap items-center gap-2">
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
                  <ul className="scroll-thin grid max-h-72 gap-px overflow-y-auto rounded-md border px-2.5 py-1.5">
                    {env.secrets.map((s) => (
                      <li key={s.name} className="flex items-baseline gap-2 py-1 text-xs">
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={s.name}>{s.name}</span>
                        {s.stale && <Badge variant="human" className="px-1.5 py-0 text-[10px]" title="Cifrada con una versión anterior de la llave del entorno">llave vieja</Badge>}
                        <span className="shrink-0 tabular-nums text-faint">v{s.version}</span>
                        <span className="hidden shrink-0 text-muted-foreground sm:inline" title={dateTime(s.updatedAt)}>
                          {s.updatedByName ? `${s.updatedByName} · ` : ''}{ago(s.updatedAt)}
                        </span>
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

            <div className="grid gap-1.5">
              <span className="label-caps">Bajar estas variables a tu máquina</span>
              <CmdLine command={`zeus env pull ${env.projectKey} ${env.name}`} />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
