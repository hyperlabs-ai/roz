// Pestaña "Variables": la bóveda de variables de entorno. Aquí solo hay NOMBRES: los valores se cifran
// en la PC de cada dev y el servidor guarda texto cifrado que no puede leer. Leer, subir y rotar se
// hace con el CLI `zeus`; la web muestra el estado por repo (variantes Local y Prod), permite revocar
// una llave de equipo y APROBAR accesos, que luego cifra el CLI de alguien con acceso.
//
// La pantalla es un tablero: arriba el diagrama de cómo viaja un secreto (con las cifras vivas), y
// debajo la puesta en marcha con estado real, la matriz de quién puede descifrar qué, las llaves de
// equipo y la auditoría.
import { useMemo, useState } from 'react';
import { Laptop, Loader2, Plug } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ErrorCard } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { invalidate } from '@/lib/store';
import { useAction } from '@/lib/useAction';
import { useApi } from '@/lib/useApi';
import { cn } from '@/lib/utils';
import { zeusApi, type ZeusMe, type ZeusVaultKey, type ZeusVaultOverview } from '@/lib/zeus';
import { useZeusOrg } from './hooks';
import { VaultDiagram } from './VaultDiagram';
import { StageChip, VAULT_KEY, VaultMatrix, VaultRepoDialog, type VaultProject } from './VaultMatrix';
import { auditEnvParts, groupVaultEnvs } from './vault-groups';
import { CmdLine, Step, StepNote, Steps, type StepState } from './zeus-steps';
import { CLI_INSTALL, ago, dateTime } from './zeus-ui';
import './vault.css';

const AUDIT_LABEL: Array<[RegExp, string]> = [
  [/grant\.approve/, 'aprobó un acceso a'],
  [/grant\.cancel/, 'canceló un acceso aprobado de'],
  [/rotate/, 'rotó la llave de'],
  [/grant.*(revoke|delete|remove)|ungrant/, 'quitó un acceso a'],
  [/grant/, 'dio acceso a'],
  [/key.*revoke|revoke.*key/, 'revocó una llave de equipo'],
  [/key.*(create|register|init)|register/, 'registró una llave de equipo'],
  [/(secret|env).*(write|set|push|put)|push/, 'subió variables a'],
  [/(secret|env).*(delete|remove)/, 'borró variables de'],
  [/(secret|env).*(read|get|pull)|pull|read/, 'bajó las variables de'],
  [/env.*create|create/, 'creó el entorno'],
];
function auditVerb(action: string): string {
  const a = action.toLowerCase();
  for (const [re, label] of AUDIT_LABEL) if (re.test(a)) return label;
  return action.replace(/[._]/g, ' ');
}
/** Punto de la línea de tiempo: quitar va en rojo, rotar en amarillo, dar o subir en naranja. */
function auditDot(action: string): string {
  const a = action.toLowerCase();
  if (/revoke|ungrant|delete|remove|cancel/.test(a)) return 'bg-red';
  if (/rotate/.test(a)) return 'bg-yellow';
  if (/grant|push|write|set|put|create|register|init/.test(a)) return 'bg-orange';
  return 'bg-faint';
}

/** Fila fantasma de una lista vacía: misma altura y huesos que una fila real, sin animación. */
function GhostRow({ wide = 96 }: { wide?: number }) {
  return (
    <li aria-hidden className="flex items-center gap-2.5 px-3.5 py-2.5">
      <span className="size-7 shrink-0 rounded-full border border-dashed border-toggle-off" />
      <span className="grid flex-1 gap-1.5">
        <span className="h-2 rounded-full bg-panel" style={{ width: wide }} />
        <span className="h-1.5 w-2/3 rounded-full border border-dashed border-toggle-off" />
      </span>
    </li>
  );
}

/** `HUB · api-hyperhub-production` en la auditoría: el repo y su variante, como en la matriz. */
function AuditEnv({ label }: { label: string }) {
  const { repo, stage } = auditEnvParts(label);
  return (
    <span className="inline-flex items-center gap-1 align-baseline" data-tip={label}>
      <span className="font-mono text-[11px]">{repo}</span>
      <StageChip stage={stage} className="px-1 text-[9px]" />
    </span>
  );
}

export function VaultTab({ me }: { me: ZeusMe | null }) {
  const vault = useApi<ZeusVaultOverview>(() => zeusApi.vault(), [], { key: VAULT_KEY, ttl: 30_000 });
  const org = useZeusOrg();
  const act = useAction();
  const [revoking, setRevoking] = useState<ZeusVaultKey | null>(null);
  const [open, setOpen] = useState<{ repoId: string; envId: string } | null>(null);
  const data = vault.data;

  // Un repo por fila con sus variantes (`api-hyperhub-development` + `-production`).
  const projects = useMemo<VaultProject[]>(() => groupVaultEnvs(data?.envs ?? []), [data]);
  const keys = useMemo(
    () => [...(data?.keys ?? [])].sort((a, b) => Number(!!a.revokedAt) - Number(!!b.revokedAt) || a.devName.localeCompare(b.devName, 'es')),
    [data],
  );
  const activeKeys = useMemo(() => keys.filter((k) => !k.revokedAt), [keys]);
  const revokeBusy = revoking ? act.busy(`revoke-key:${revoking.id}`) : false;
  const openRepo = open ? (projects.flatMap((p) => p.repos).find((r) => r.id === open.repoId) ?? null) : null;
  const intents = data?.intents ?? [];

  // Puesta en marcha: cada paso se da por hecho con lo que la bóveda ya sabe.
  const myKey = activeKeys.find((k) => k.devId === me?.devId) ?? null;
  const hasEnv = (data?.envs.length ?? 0) > 0;
  const shared = (data?.envs ?? []).some((e) => new Set(e.grants.map((g) => g.devId)).size > 1);
  const done = [!!myKey, hasEnv, shared];
  const firstOpen = done.indexOf(false);
  const stepState = (i: number): StepState => (done[i] ? 'done' : i === firstOpen ? 'current' : 'todo');
  const doneCount = done.filter(Boolean).length;

  return (
    <div className="flex flex-col gap-3 lg:h-[calc(100dvh-var(--shell-top,196px)-var(--shell-pad-b,0px))] lg:min-h-[800px]">
      {vault.error && <ErrorCard message={vault.error} className="shrink-0" />}

      <VaultDiagram data={data ?? null} me={me} refetching={vault.refetching} onRefresh={vault.reload} className="shrink-0" />

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[296px_minmax(0,1fr)_280px] 2xl:grid-cols-[336px_minmax(0,1fr)_312px]">
        {/* Cómo funciona: los pasos con estado real y las dudas que siempre salen. */}
        <Card className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <h2 className="text-sm font-semibold tracking-[-0.01em]">Cómo funciona</h2>
            <span className="label-caps tabular-nums">{data ? `${doneCount} de 3` : '– de 3'}</span>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
            <Steps>
              <Step n={1} state={stepState(0)} title="Crea tu llave (una vez por PC)" stateLabel={myKey ? `Hecho · ${myKey.name}` : undefined}>
                <StepNote>Se genera en tu PC y ahí se queda. zeus solo recibe la parte pública: ni la web ni la base pueden descifrar nada.</StepNote>
                <CmdLine wrap command={CLI_INSTALL} />
                <CmdLine command="zeus key init" />
              </Step>
              <Step n={2} state={stepState(1)} title="Sube las variables de tu repo">
                <StepNote>Dentro del repo, solo dices la etapa: zeus arma el nombre (api-hyperhub-production).</StepNote>
                <CmdLine wrap command="zeus env push <proyecto> local" />
                <CmdLine wrap command="zeus env push <proyecto> prod" />
              </Step>
              <Step n={3} state={stepState(2)} title="Comparte con alguien" last>
                <StepNote>
                  Abre el repo en la matriz y usa «Dar acceso» (lo aprueba quien ya tiene acceso). Como la web no tiene la llave, falta que alguien con acceso lo
                  cifre en su PC confirmando la huella; su Claude se lo recuerda al abrir sesión.
                </StepNote>
                <CmdLine wrap command="zeus env grant --pending" />
              </Step>
            </Steps>

            <div className="mt-4 grid gap-2.5 border-t pt-3.5">
              <span className="label-caps">Dos llaves distintas</span>
              <dl className="grid gap-2 text-[12px] leading-snug">
                <div className="grid gap-0.5 rounded-md bg-panel px-3 py-2">
                  <dt className="flex items-center gap-1.5 font-semibold"><Laptop className="size-3.5 text-orange" /> Llave de tu PC</dt>
                  <dd className="text-muted-foreground">Cifra y descifra las variables. La crea <code className="font-mono text-[11px] text-foreground">zeus key init</code> en <code className="font-mono text-[11px] text-foreground">~/.zeus/key.json</code> y nunca sale de tu PC.</dd>
                </div>
                <div className="grid gap-0.5 rounded-md bg-panel px-3 py-2">
                  <dt className="flex items-center gap-1.5 font-semibold"><Plug className="size-3.5 text-muted-foreground" /> Token del MCP</dt>
                  <dd className="text-muted-foreground">Te identifica ante zeus (Claude y el CLI). Se crea en MCP. Solo con él no se descifra ninguna variable.</dd>
                </div>
              </dl>
              <span className="label-caps pt-1">Si se compromete</span>
              <ul className="grid gap-1 text-[12px] leading-snug text-muted-foreground">
                <li><span className="font-medium text-foreground">Token:</span> revócalo en MCP y crea otro.</li>
                <li><span className="font-medium text-foreground">PC o llave:</span> desde otra PC, <code className="font-mono text-[11px] text-foreground">zeus key rotate --compromised</code> y luego <code className="font-mono text-[11px] text-foreground">zeus env rotate --all</code>. Cambia en el proveedor los secretos que importen.</li>
              </ul>
            </div>
          </div>
        </Card>

        {/* Matriz de acceso */}
        <VaultMatrix
          className="max-lg:max-h-[70dvh]"
          projects={projects}
          keys={activeKeys}
          members={org.data?.members ?? []}
          me={me}
          intents={intents}
          ready={!!data}
          onOpen={(repoId, envId) => setOpen({ repoId, envId })}
        />

        {/* Llaves de equipo + auditoría */}
        <div className="flex min-h-0 flex-col gap-3">
          <Card className="flex max-h-[46%] min-h-0 shrink-0 flex-col overflow-hidden max-lg:max-h-80">
            <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
              <h2 className="text-sm font-semibold tracking-[-0.01em]">Llaves de equipo</h2>
              <span className="label-caps tabular-nums">{data ? `${activeKeys.length} ${activeKeys.length === 1 ? 'vigente' : 'vigentes'}` : '–'}</span>
            </div>
            {keys.length === 0 ? (
              <>
                <ul className="divide-y divide-dashed">
                  <GhostRow wide={104} />
                  <GhostRow wide={72} />
                </ul>
                {data && <p className="border-t px-3.5 py-2.5 text-[12px] leading-snug text-muted-foreground">Nadie ha registrado la llave de su equipo todavía.</p>}
              </>
            ) : (
              <ul className="scroll-thin min-h-0 flex-1 divide-y overflow-y-auto">
                {keys.map((k) => {
                  const mine = k.devId === me?.devId;
                  const revoked = !!k.revokedAt;
                  return (
                    <li key={k.id} className={cn('group/key flex items-center gap-2.5 px-3.5 py-2.5', revoked && 'opacity-60')}>
                      <span className={cn('grid size-7 shrink-0 place-items-center rounded-full bg-panel text-muted-foreground', mine && !revoked && 'bg-orange-soft text-orange-ink')}>
                        <Laptop className="size-3.5" />
                      </span>
                      <div className="grid min-w-0 flex-1 gap-0.5">
                        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
                          <span className="truncate font-semibold">{k.name}</span>
                          <span className="shrink-0 truncate text-muted-foreground">{k.devName}{mine && ' (tú)'}</span>
                          {revoked && <Badge variant="bad" className="px-1.5 py-0 text-[10px]">Revocada</Badge>}
                        </span>
                        <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-faint">
                          <span className="truncate font-mono" title={k.fingerprint}>{k.fingerprint}</span>
                          <span className="shrink-0" title={dateTime(revoked ? k.revokedAt : k.lastUsedAt)}>
                            · {revoked ? `revocada ${ago(k.revokedAt)}` : k.lastUsedAt ? `usada ${ago(k.lastUsedAt)}` : 'sin usar'}
                          </span>
                        </span>
                      </div>
                      {!revoked && (mine || me?.zeusAdmin) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 shrink-0 px-2 text-muted-foreground hover:bg-red-soft hover:text-red"
                          disabled={act.busy(`revoke-key:${k.id}`)}
                          onClick={() => setRevoking(k)}
                        >
                          Revocar
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden max-lg:max-h-96">
            <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
              <h2 className="text-sm font-semibold tracking-[-0.01em]">Auditoría</h2>
              <span className="label-caps tabular-nums">{data ? `${data.audit.length} ${data.audit.length === 1 ? 'movimiento' : 'movimientos'}` : '–'}</span>
            </div>
            {!data || data.audit.length === 0 ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <ol aria-hidden className="relative grid gap-4 px-4 py-4 before:absolute before:bottom-4 before:left-[19.5px] before:top-4 before:border-l before:border-dashed before:border-toggle-off">
                  {[88, 124, 64, 104].map((w, i) => (
                    <li key={i} className="relative grid grid-cols-[8px_minmax(0,1fr)] items-center gap-3">
                      <span className="size-2 rounded-full border border-dashed border-faint bg-card" />
                      <span className="h-2 rounded-full bg-panel" style={{ width: w }} />
                    </li>
                  ))}
                </ol>
                {data && <p className="mt-auto border-t px-4 py-2.5 text-[12px] leading-snug text-muted-foreground">Sin movimientos todavía. Cada subida, acceso y rotación queda anotada aquí.</p>}
              </div>
            ) : (
              <ol className="scroll-thin relative min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {data.audit.map((a, i) => (
                  <li key={a.id} className="relative grid grid-cols-[8px_minmax(0,1fr)] gap-3 pb-3 last:pb-0">
                    {i < data.audit.length - 1 && <span aria-hidden className="absolute bottom-0 left-[3.5px] top-3 w-px bg-border" />}
                    <span className={cn('relative mt-[5px] size-2 rounded-full ring-2 ring-card', auditDot(a.action))} />
                    <span className="grid min-w-0 gap-0.5">
                      <span className="text-[12px] leading-snug">
                        <span className="font-semibold">{a.devName ?? 'zeus'}</span>{' '}
                        <span className="text-muted-foreground">{auditVerb(a.action)}</span>
                        {a.envLabel && <> <AuditEnv label={a.envLabel} /></>}
                      </span>
                      <span className="text-[10.5px] tabular-nums text-faint" title={dateTime(a.at)}>{ago(a.at)}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>

      <VaultRepoDialog
        repo={openRepo}
        envId={open?.envId ?? null}
        onSelect={(envId) => setOpen((o) => (o ? { ...o, envId } : o))}
        onClose={() => setOpen(null)}
        keys={activeKeys}
        members={org.data?.members ?? []}
        me={me}
        intents={intents}
      />

      <AlertDialog open={!!revoking} onOpenChange={(v) => !v && !revokeBusy && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revocar la llave "{revoking?.name}"</AlertDialogTitle>
            <AlertDialogDescription>
              Ese equipo ({revoking?.devName}) ya no podrá bajar ni subir variables. Lo que ya descifró lo conserva, así que conviene rotar los
              entornos donde tenía acceso. No se puede deshacer: para volver a entrar hay que registrar una llave nueva.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeBusy}>Volver</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={revokeBusy}
              onClick={(e) => {
                e.preventDefault();
                if (!revoking) return;
                void act.run(`revoke-key:${revoking.id}`, () => zeusApi.revokeVaultKey(revoking.id), {
                  success: 'Llave revocada',
                  error: 'No se pudo revocar',
                  onDone: () => setRevoking(null),
                  onSettled: () => invalidate(VAULT_KEY),
                });
              }}
            >
              {revokeBusy && <Loader2 className="animate-spin" />}
              Revocar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
