// Conectar tu Claude a zeus, en compacto: el único comando que hace falta, qué es (y qué NO es) el
// token del MCP, y tus tokens con crear/revocar.
import { useState } from 'react';
import { ChevronRight, KeyRound, Loader2, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { invalidate } from '@/lib/store';
import { useAction } from '@/lib/useAction';
import { useApi } from '@/lib/useApi';
import { cn } from '@/lib/utils';
import { zeusApi, type ZeusMe, type ZeusTokenSummary } from '@/lib/zeus';
import { CmdLine } from './zeus-steps';
import { CLI_INSTALL, CommandBlock, CopyButton, RailTitle, ago, dateTime } from './zeus-ui';

export const TOKENS_KEY = '/zeus/tokens';

export const mcpCommand = (mcpUrl: string, token: string): string =>
  `claude mcp add --transport http zeus ${mcpUrl} --header "Authorization: Bearer ${token}"`;
export const cliCommand = (apiUrl: string, token: string): string => `zeus login --url ${apiUrl} --token ${token}`;
/** Conecta Claude Code de una vez: MCP + hooks de `zeus guard` (ver cli/README.md). */
export const SETUP_COMMAND = 'zeus setup claude';

/** Crear un token y mostrarlo UNA vez. El secreto vive solo en el estado de este diálogo. */
function CreateTokenDialog({ open, me, onClose }: { open: boolean; me: ZeusMe | null; onClose: () => void }) {
  const act = useAction();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ token: string; summary: ZeusTokenSummary } | null>(null);
  const busy = act.busy('create-token');
  const close = () => {
    if (busy) return;
    onClose();
    window.setTimeout(() => {
      setCreated(null);
      setName('');
    }, 200);
  };
  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-xl" onInteractOutside={(e) => created && e.preventDefault()}>
        <DialogHeader eyebrow="Zeus · MCP">
          <DialogTitle>{created ? 'Guarda tu token' : 'Nuevo token'}</DialogTitle>
          <DialogDescription>
            {created
              ? 'Es la única vez que se muestra. Si lo pierdes, revócalo y crea otro.'
              : 'Un token por equipo o herramienta: así revocas uno sin tumbar los demás. Todo lo que haga queda a tu nombre.'}
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
            <Field label="Nombre" htmlFor="zt-name" hint="Dónde lo vas a usar." required>
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
            <div className="flex items-center gap-2 rounded-md border bg-sidebar py-1.5 pl-3 pr-1.5">
              <code className="min-w-0 flex-1 select-all break-all font-mono text-[12px]">{created.token}</code>
              <CopyButton text={created.token} />
            </div>
            <CommandBlock label="1 · Instala el CLI (Node 20+)" command={CLI_INSTALL} />
            {me?.apiUrl && <CommandBlock label="2 · Entra con tu token" command={cliCommand(me.apiUrl, created.token)} />}
            <CommandBlock label="3 · Conecta Claude Code (MCP + protector de secretos)" command={SETUP_COMMAND} />
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

/** Tus tokens del MCP: lista compacta con crear y revocar. El comando y el porqué van en la página. */
export function McpTokenList({ me }: { me: ZeusMe | null }) {
  const tokens = useApi<{ tokens: ZeusTokenSummary[] }>(() => zeusApi.tokens(), [], { key: TOKENS_KEY, ttl: 30_000 });
  const act = useAction();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ZeusTokenSummary | null>(null);
  const [manual, setManual] = useState(false);
  const list = tokens.data?.tokens ?? [];
  const revokeBusy = revoking ? act.busy(`revoke-token:${revoking.id}`) : false;

  return (
    <div className="grid gap-2">
      <RailTitle meta={<Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setCreating(true)}><Plus /> Nuevo</Button>}>
        Tus tokens
      </RailTitle>

      <ul className="grid gap-0.5">
        {list.length === 0 && !tokens.loading && (
          <li className="flex items-center gap-2.5 rounded-md border border-dashed px-2.5 py-2 text-[12px] text-muted-foreground">
            <span className="size-6 shrink-0 rounded-md border border-dashed border-toggle-off" />
            Aún no tienes. Crea uno por equipo.
          </li>
        )}
        {list.map((t) => (
          <li key={t.id} className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-panel">
            <span className={cn('grid size-6 shrink-0 place-items-center rounded-md', t.lastUsedAt ? 'bg-green-soft text-green' : 'bg-panel text-muted-foreground')}>
              <KeyRound className="size-3" />
            </span>
            <span className="grid min-w-0 flex-1">
              <span className="truncate text-[12.5px] font-medium" title={t.name}>{t.name}</span>
              <span className="truncate font-mono text-[10.5px] text-faint" title={`Creado ${dateTime(t.createdAt)}`}>{t.prefix}…</span>
            </span>
            <span className={cn('shrink-0 text-[11px] tabular-nums', t.lastUsedAt ? 'text-muted-foreground' : 'text-faint')} title={dateTime(t.lastUsedAt)}>
              {t.lastUsedAt ? `usado ${ago(t.lastUsedAt)}` : 'sin usar'}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 shrink-0 text-muted-foreground hover:bg-red-soft hover:text-red"
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

      <button type="button" className="flex w-fit items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground" onClick={() => setManual((v) => !v)} aria-expanded={manual}>
        <ChevronRight className={cn('size-3 transition-transform', manual && 'rotate-90')} />
        Conectar solo el MCP, a mano (sin protector)
      </button>
      {manual && (me?.mcpUrl ? <CmdLine wrap command={mcpCommand(me.mcpUrl, '<token>')} /> : <p className="text-[11.5px] text-muted-foreground">Leyendo la URL del MCP…</p>)}

      <CreateTokenDialog open={creating} me={me} onClose={() => setCreating(false)} />
      <AlertDialog open={!!revoking} onOpenChange={(v) => !v && !revokeBusy && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revocar "{revoking?.name}"</AlertDialogTitle>
            <AlertDialogDescription>
              Lo que esté conectado con este token (Claude Code, el CLI) deja de funcionar de inmediato. Tu llave de la bóveda no cambia.
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
