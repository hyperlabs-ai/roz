// Pestaña "Acceso": los tokens personales con los que Claude Code (por MCP) y el CLI actúan como tú,
// y los repos de los que zeus ingiere ADRs, OpenSpec, diseño y reglas.
//
// Dos columnas que llenan el alto: a la izquierda el recorrido "Conecta tu Claude" (crear el token,
// agregarlo a Claude Code, iniciar sesión en el CLI) con tus tokens debajo; a la derecha los repos
// como mosaico agrupado por proyecto (`SourceMosaic`).
import { useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, KeyRound, Loader2, Plus, Server, ShieldAlert, Terminal, Trash2 } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ErrorCard, RefreshButton } from '@/components/bits';
import { IntegrationIcon } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { invalidate } from '@/lib/store';
import { toast } from '@/lib/toast';
import { useAction } from '@/lib/useAction';
import { useApi } from '@/lib/useApi';
import { usePoll } from '@/lib/usePoll';
import { cn } from '@/lib/utils';
import { zeusApi, type ZeusMe, type ZeusSource, type ZeusTokenSummary } from '@/lib/zeus';
import { GRAPH_KEY, NODES_KEY } from './hooks';
import { SourceMosaic } from './SourceMosaic';
import { CmdLine, Step, StepNote, Steps, type StepState } from './zeus-steps';
import { CLI_INSTALL, CommandBlock, CopyButton, ago, dateTime } from './zeus-ui';
import './access.css';

const TOKENS_KEY = '/zeus/tokens';
const SOURCES_KEY = '/zeus/sources';

export const mcpCommand = (mcpUrl: string, token: string): string =>
  `claude mcp add --transport http zeus ${mcpUrl} --header "Authorization: Bearer ${token}"`;
export const cliCommand = (apiUrl: string, token: string): string => `zeus login --url ${apiUrl} --token ${token}`;
/**
 * Crear un token y mostrarlo UNA vez. El secreto vive solo en el estado de este diálogo: no se
 * cachea ni se guarda, y al cerrarlo ya no hay forma de volver a verlo (el back solo guarda su hash).
 */
function CreateTokenDialog({ open, me, onClose }: { open: boolean; me: ZeusMe | null; onClose: () => void }) {
  const act = useAction();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ token: string; summary: ZeusTokenSummary } | null>(null);
  const busy = act.busy('create-token');
  const close = () => {
    if (busy) return;
    onClose();
    // Tras la animación de cierre, para que el secreto no se quede en memoria ni parpadee el formulario.
    window.setTimeout(() => {
      setCreated(null);
      setName('');
    }, 200);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent
        className="sm:max-w-xl"
        // Con el token a la vista, un clic fuera no debe llevárselo: se cierra con el botón.
        onInteractOutside={(e) => created && e.preventDefault()}
      >
        <DialogHeader eyebrow="Zeus · acceso">
          <DialogTitle>{created ? 'Guarda tu token' : 'Nuevo token'}</DialogTitle>
          <DialogDescription>
            {created
              ? 'Es la única vez que se muestra. Si lo pierdes, revócalo y crea otro.'
              : 'Un token por herramienta o por equipo: así puedes revocar uno sin tumbar los demás. Todo lo que haga queda a tu nombre.'}
          </DialogDescription>
        </DialogHeader>

        {!created ? (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || busy) return;
              void act.run('create-token', () => zeusApi.createToken(name.trim()), {
                success: false,
                error: 'No se pudo crear el token',
                onDone: (r) => {
                  setCreated(r);
                  invalidate(TOKENS_KEY);
                },
              });
            }}
          >
            <Field label="Nombre" htmlFor="zt-name" hint="Para reconocerlo después: dónde lo vas a usar." required>
              <Input id="zt-name" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Claude Code · laptop" />
            </Field>
            <DialogFooter className="gap-2">
              <Button type="button" variant="secondary" onClick={close} disabled={busy}>Cancelar</Button>
              <Button type="submit" disabled={!name.trim() || busy}>
                {busy && <Loader2 className="animate-spin" />}
                Crear token
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <span className="text-[12.5px] font-medium text-foreground/80">Token</span>
              <div className="flex items-center gap-2 rounded-md border bg-sidebar py-1.5 pl-3 pr-1.5">
                <code className="min-w-0 flex-1 select-all break-all font-mono text-[12px]">{created.token}</code>
                <CopyButton text={created.token} />
              </div>
            </div>

            <div className="grid gap-1.5">
              <span className="text-[12.5px] font-medium text-foreground/80">Conectar Claude Code</span>
              {me?.mcpUrl ? (
                <CommandBlock label="Pégalo en tu terminal" command={mcpCommand(me.mcpUrl, created.token)} />
              ) : (
                <p className="text-xs text-muted-foreground">No se pudo leer la URL del MCP de zeus; recarga la página y usa la plantilla de abajo con este token.</p>
              )}
            </div>

            <div className="grid gap-1.5">
              <span className="text-[12.5px] font-medium text-foreground/80">Iniciar sesión en el CLI</span>
              <CommandBlock label="Instálalo (Node 20+)" command={CLI_INSTALL} />
              {me?.apiUrl ? (
                <CommandBlock label="Y entra con tu token" command={cliCommand(me.apiUrl, created.token)} />
              ) : (
                <p className="text-xs text-muted-foreground">No se pudo leer la URL de zeus para el CLI.</p>
              )}
            </div>

            <p className="flex items-start gap-2 rounded-md bg-yellow-soft px-3 py-2 text-xs text-yellow-ink">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
              Trátalo como una contraseña: quien lo tenga actúa como tú en zeus. No lo pegues en un chat ni lo subas a un repo.
            </p>

            <DialogFooter>
              <Button onClick={close}>Ya lo guardé</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Diagrama de cabecera: tus dos clientes (Claude Code por MCP y el CLI) hablan con zeus usando tu token. */
function ConnectDiagram({ tokens, ready }: { tokens: ZeusTokenSummary[]; ready: boolean }) {
  const lastUsed = tokens.reduce<string | null>((best, t) => (t.lastUsedAt && (!best || t.lastUsedAt > best) ? t.lastUsedAt : best), null);
  const live = !!lastUsed;
  const wire = (label: string) => (
    <div className="flex min-w-0 flex-col items-center justify-center gap-1">
      <span className="label-caps text-[9.5px] text-foreground/80">{label}</span>
      <div className="flex w-full items-center text-foreground/60">
        <ChevronLeft className="-mr-1.5 size-3.5 shrink-0" />
        <span className="access-wire flex-1" data-live={live ? '1' : undefined} />
        <ChevronRight className="-ml-1.5 size-3.5 shrink-0" />
      </div>
    </div>
  );
  const client = (icon: ReactNode, title: string, sub: string) => (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-card px-2.5 py-2">
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-panel [&_svg]:size-3.5">{icon}</span>
      <span className="grid min-w-0">
        <span className="truncate text-[12.5px] font-semibold leading-tight">{title}</span>
        <span className="truncate text-[10.5px] leading-tight text-muted-foreground">{sub}</span>
      </span>
    </div>
  );
  return (
    <div className="dark zeus-stage relative shrink-0 border-b bg-background px-4 pb-4 pt-3 text-foreground">
      <div className="flex items-center justify-between gap-3">
        <h2 className="label-caps text-foreground/85">Conecta tu Claude</h2>
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span className={cn('size-2 shrink-0 rounded-full', live ? 'bg-green' : tokens.length > 0 ? 'bg-yellow' : 'border border-faint')} />
          <span className="truncate">{!ready ? 'Leyendo…' : live ? `Último uso ${ago(lastUsed)}` : tokens.length > 0 ? 'Token creado, aún sin usar' : 'Sin conectar'}</span>
        </span>
      </div>
      <div className="mt-3 grid grid-cols-[minmax(0,1.15fr)_minmax(56px,0.6fr)_minmax(0,0.85fr)] items-stretch gap-2">
        <div className="grid gap-2">
          {client(<IntegrationIcon name="claude" size="sm" />, 'Claude Code', 'Contexto del equipo')}
          {client(<Terminal />, 'CLI zeus', 'Maneja la bóveda')}
        </div>
        <div className="grid grid-rows-2 gap-2">
          {wire('MCP')}
          {wire('API')}
        </div>
        <div className="access-core grid place-content-center justify-items-center gap-1 rounded-lg bg-card px-2 py-2 text-center">
          <span className="grid size-7 place-items-center rounded-md bg-orange text-white"><Server className="size-3.5" /></span>
          <span className="text-[13px] font-semibold leading-tight">zeus</span>
          <span className="label-caps text-[9.5px] text-orange">Actúa como tú</span>
          <span className="text-[10.5px] tabular-nums text-muted-foreground">{ready ? `${tokens.length} ${tokens.length === 1 ? 'token' : 'tokens'}` : '– tokens'}</span>
        </div>
      </div>
    </div>
  );
}

function GhostToken() {
  return (
    <li aria-hidden className="flex items-center gap-2.5 px-4 py-2.5">
      <span className="size-7 shrink-0 rounded-md border border-dashed border-toggle-off" />
      <span className="grid flex-1 gap-1.5">
        <span className="h-2 w-28 rounded-full bg-panel" />
        <span className="h-1.5 w-20 rounded-full border border-dashed border-toggle-off" />
      </span>
      <span className="h-1.5 w-14 rounded-full bg-panel" />
    </li>
  );
}

export function AccessTab({ me }: { me: ZeusMe | null }) {
  const tokens = useApi<{ tokens: ZeusTokenSummary[] }>(() => zeusApi.tokens(), [], { key: TOKENS_KEY, ttl: 30_000 });
  const sources = useApi<{ sources: ZeusSource[] }>(() => zeusApi.sources(), [], { key: SOURCES_KEY, ttl: 20_000 });
  const act = useAction();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ZeusTokenSummary | null>(null);
  const revokeBusy = revoking ? act.busy(`revoke-token:${revoking.id}`) : false;

  // Con una ingesta en cola el estado cambia solo (la barrida corre cada ~10 min): se sondea más
  // seguido hasta que deje de estar pendiente.
  const anyPending = (sources.data?.sources ?? []).some((s) => s.pending);
  usePoll(sources.reload, sources.data ? (anyPending ? 10_000 : 60_000) : null);

  const invalidateSources = () => {
    invalidate(SOURCES_KEY);
    // Lo que traiga la ingesta cambia el mapa y los documentos.
    invalidate(GRAPH_KEY);
    invalidate(NODES_KEY);
  };
  const sync = (repo: string) =>
    void act.run(`sync:${repo}`, () => zeusApi.syncSource(repo), {
      success: { title: 'Sincronización en cola', description: 'zeus la atiende en su siguiente barrida.' },
      error: 'No se pudo pedir la sincronización',
      onSettled: invalidateSources,
    });
  // Varios a la vez: la misma petición de siempre, repo por repo y en fila, con un solo aviso al final.
  const syncMany = (repos: string[]) =>
    void act.run(
      'sync-many',
      async () => {
        let ok = 0;
        for (const repo of repos) {
          const res = await act.run(`sync:${repo}`, () => zeusApi.syncSource(repo), { error: `No se pudo pedir la sincronización de ${repo}` });
          if (res !== undefined) ok++;
        }
        return ok;
      },
      {
        success: false,
        onDone: (ok) => {
          if (ok > 0) toast.success(`${ok} ${ok === 1 ? 'sincronización en cola' : 'sincronizaciones en cola'}`, { description: 'zeus las atiende en su siguiente barrida.' });
        },
        onSettled: invalidateSources,
      },
    );

  const tokenList = tokens.data?.tokens ?? [];
  const hasToken = tokenList.length > 0;
  const next: StepState = hasToken ? 'current' : 'todo';

  return (
    <div className="grid gap-3 lg:h-[calc(100dvh-var(--shell-top,196px)-var(--shell-pad-b,0px))] lg:min-h-[720px] lg:grid-cols-[430px_minmax(0,1fr)]">
      {/* Conecta tu Claude */}
      <Card className="flex min-h-0 flex-col overflow-hidden">
        <ConnectDiagram tokens={tokenList} ready={!!tokens.data} />

        <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="shrink-0 px-4 pb-1 pt-4">
            <Steps>
              <Step n={1} state={hasToken ? 'done' : 'current'} title="Crea tu token" stateLabel={hasToken ? `Hecho · ${tokenList.length} ${tokenList.length === 1 ? 'token' : 'tokens'}` : undefined}>
                <StepNote>
                  Un token <code className="rounded bg-panel px-1 py-0.5 font-mono text-[11px] text-foreground">zeus_…</code> actúa como tú y todo queda a tu nombre. Se muestra una sola vez.
                </StepNote>
                <div>
                  <Button variant="brand" size="sm" onClick={() => setCreating(true)}><Plus /> Nuevo token</Button>
                </div>
              </Step>
              <Step n={2} state={next} title="Agrégalo a Claude Code" stateLabel={hasToken ? 'Con tu token' : undefined}>
                {me?.mcpUrl ? (
                  <CmdLine wrap command={mcpCommand(me.mcpUrl, '<token>')} />
                ) : (
                  <StepNote>{me ? 'No se pudo leer la URL del MCP de zeus; recarga la página.' : 'Leyendo la URL del MCP de zeus…'}</StepNote>
                )}
              </Step>
              <Step n={3} state={next} title="Instala el CLI e inicia sesión" stateLabel={hasToken ? 'Con tu token' : undefined} last>
                <StepNote>Una vez por máquina. Requiere Node 20 o superior.</StepNote>
                <CmdLine wrap command={CLI_INSTALL} />
                {me?.apiUrl ? (
                  <CmdLine wrap command={cliCommand(me.apiUrl, '<token>')} />
                ) : (
                  <StepNote>{me ? 'No se pudo leer la URL de zeus para el CLI.' : 'Leyendo la URL de zeus…'}</StepNote>
                )}
              </Step>
            </Steps>
          </div>

          {/* Tus tokens */}
          <div className="mt-4 flex min-h-[150px] flex-1 flex-col border-t">
            <div className="flex shrink-0 items-center justify-between gap-2 py-1.5 pl-4 pr-2">
              <div className="flex items-baseline gap-2">
                <h3 className="text-[13px] font-semibold tracking-[-0.01em]">Tus tokens</h3>
                <span className="label-caps tabular-nums">{tokens.data ? tokenList.length : '–'}</span>
              </div>
              <RefreshButton busy={tokens.refetching} onClick={tokens.reload} />
            </div>
            {tokens.error && <ErrorCard message={tokens.error} className="mx-4 mb-2 px-3 py-2 text-xs" />}
            {tokenList.length === 0 ? (
              <>
                <ul className="divide-y divide-dashed border-t border-dashed">
                  <GhostToken />
                  <GhostToken />
                  <GhostToken />
                </ul>
                {!tokens.loading && (
                  <p className="mt-auto border-t px-4 py-2.5 text-[12px] leading-snug text-muted-foreground">
                    {tokens.error && !tokens.data ? 'No se pudieron cargar tus tokens.' : 'Aún no tienes tokens. Crea uno por herramienta o por equipo: así revocas uno sin tumbar los demás.'}
                  </p>
                )}
              </>
            ) : (
              <ul className="divide-y border-t">
                {tokenList.map((t) => (
                  <li key={t.id} className="flex items-center gap-2.5 py-2 pl-4 pr-2">
                    <span className={cn('grid size-7 shrink-0 place-items-center rounded-md', t.lastUsedAt ? 'bg-green-soft text-green' : 'bg-panel text-muted-foreground')}>
                      <KeyRound className="size-3.5" />
                    </span>
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate text-[12.5px] font-semibold" title={t.name}>{t.name}</span>
                      <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-faint">
                        <span className="shrink-0 font-mono">{t.prefix}…</span>
                        <span className="truncate" title={dateTime(t.createdAt)}>· creado {ago(t.createdAt)}</span>
                      </span>
                    </div>
                    <span className={cn('shrink-0 text-[11.5px] tabular-nums', t.lastUsedAt ? 'text-muted-foreground' : 'text-faint')} title={dateTime(t.lastUsedAt)}>
                      {t.lastUsedAt ? `Usado ${ago(t.lastUsedAt)}` : 'Sin usar'}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-8 shrink-0 text-muted-foreground hover:bg-red-soft hover:text-red"
                      disabled={act.busy(`revoke-token:${t.id}`)}
                      onClick={() => setRevoking(t)}
                      aria-label={`Revocar el token ${t.name}`}
                      title="Revocar"
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>

      {/* Repos que zeus indexa */}
      <SourceMosaic
        sources={sources.data?.sources ?? null}
        loading={sources.loading}
        error={sources.error}
        refetching={sources.refetching}
        onReload={sources.reload}
        isBusy={(repo) => act.busy(`sync:${repo}`)}
        bulkBusy={act.busy('sync-many')}
        onSync={sync}
        onSyncMany={syncMany}
      />

      <CreateTokenDialog open={creating} me={me} onClose={() => setCreating(false)} />

      <AlertDialog open={!!revoking} onOpenChange={(v) => !v && !revokeBusy && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revocar "{revoking?.name}"</AlertDialogTitle>
            <AlertDialogDescription>
              Lo que esté conectado con este token (Claude Code, el CLI) deja de funcionar de inmediato. No se puede deshacer; crea otro si lo necesitas.
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
                void act.run(`revoke-token:${revoking.id}`, () => zeusApi.revokeToken(revoking.id), {
                  success: 'Token revocado',
                  error: 'No se pudo revocar',
                  onDone: () => setRevoking(null),
                  onSettled: () => invalidate(TOKENS_KEY),
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
