import { useState } from 'react';
import { ExternalLink, Info, Link2, Loader2, PlugZap, Radio, TriangleAlert } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useDiscord } from '@/discord/DiscordContext';
import { discordUrl } from '@/discord/model';
import { discordApi, type DiscordStatusView } from '@/lib/api';
import { Eyebrow, IntegrationIcon } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Estado de la conexión en el aside: socket de roz + puente con Discord. */
export function ConnectionPill() {
  const { realtime, bridge } = useDiscord();
  const down = !!bridge && !bridge.healthy;
  const syncing = bridge?.status === 'backfilling';
  const live = realtime === 'live' && !down;
  // Conectado y al día no se anuncia: el indicador solo aparece cuando algo NO va bien.
  if (live && !syncing) return null;
  const label = down ? 'Sin Discord' : syncing ? 'Sincronizando' : realtime === 'connecting' ? 'Conectando' : 'Sin conexión';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1.5 label-caps',
            down ? 'text-red' : live ? 'text-green' : 'text-chat-sidebar-muted',
          )}
        >
          {live && !syncing ? (
            <span className="relative grid size-2 place-items-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-green opacity-60" />
              <span className="size-2 rounded-full bg-green" />
            </span>
          ) : down ? (
            <PlugZap className="size-3.5" />
          ) : (
            <Radio className="size-3.5" />
          )}
          <span className="hidden lg:inline">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {down
          ? 'roz perdió la conexión con Discord: lo que se escriba allá llegará cuando vuelva.'
          : syncing
            ? 'roz está trayendo el historial de Discord.'
            : live
              ? 'Conectado a Discord: los mensajes llegan al instante.'
              : 'Sin conexión en vivo: vuelve a la pestaña o recarga para ponerte al día.'}
      </TooltipContent>
    </Tooltip>
  );
}

/** Banner sobre la conversación cuando el puente está caído o sincronizando. */
export function BridgeBanner() {
  const { bridge } = useDiscord();
  if (!bridge) return null;
  if (!bridge.healthy) {
    return (
      <div className="flex items-start gap-2 border-b border-red/30 bg-red-soft px-4 py-2 text-[13px] text-red md:px-5">
        <PlugZap className="mt-0.5 size-4 shrink-0" />
        <span>
          <span className="font-semibold">Discord sin conexión.</span> Puedes seguir escribiendo; lo nuevo de Discord aparecerá en cuanto
          roz se reconecte.
        </span>
      </div>
    );
  }
  if (bridge.status === 'backfilling') {
    return (
      <div className="flex items-center gap-2 border-b bg-blue-soft px-4 py-1.5 text-[12.5px] text-blue-ink md:px-5">
        <Loader2 className="size-3.5 animate-spin" /> Sincronizando el historial de Discord…
      </div>
    );
  }
  return null;
}

/** Nota discreta de lo que Discord no permite desde roz (texto fijo de /status, contrato §B.1). */
export function LimitsNote({ channelId, compact = false }: { channelId?: string | null; compact?: boolean }) {
  const { status, guildId } = useDiscord();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md text-muted-foreground transition-colors hover:text-foreground',
            compact ? 'size-8 justify-center hover:bg-sidebar' : 'px-1 label-caps',
          )}
          aria-label="Qué no se puede desde roz"
        >
          <Info className="size-4" />
          {!compact && 'Qué no se puede'}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="grid gap-2 border-b p-4">
          <Eyebrow color="blue">Límites de Discord</Eyebrow>
          <p className="text-sm font-semibold">Qué no se puede desde roz</p>
        </div>
        <ul className="grid gap-2 p-4 text-[13px] text-muted-foreground">
          {status.limits.map((l) => (
            <li key={l} className="flex gap-2">
              <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-toggle-off" />
              {l}
            </li>
          ))}
        </ul>
        {guildId && (
          <div className="border-t bg-sidebar p-3">
            <Button asChild variant="secondary" size="sm" className="w-full">
              <a href={discordUrl(guildId, channelId)} target="_blank" rel="noopener noreferrer">
                <IntegrationIcon name="discord" size="xs" title="" /> Abrir en Discord <ExternalLink />
              </a>
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Inicia OAuth2 (scope identify) y navega a Discord. */
export async function startDiscordLink(setBusy?: (v: boolean) => void) {
  setBusy?.(true);
  try {
    const { url } = await discordApi.linkStart();
    window.location.assign(url);
  } catch (e) {
    setBusy?.(false);
    toast.error('No se pudo iniciar la conexión con Discord', { description: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Pantalla del chat cuando falta la cuenta ligada o no está en el servidor: sin cuenta no se piden
 * canales (contrato §B.9).
 */
export function LinkPrompt({ status }: { status: DiscordStatusView }) {
  const [busy, setBusy] = useState(false);
  const notMember = status.unavailable === 'not_member';
  const notConfigured = status.unavailable === 'not_configured';
  return (
    <div className="flex h-full items-center justify-center bg-background p-6">
      <div className="grid w-full max-w-md gap-5 rounded-xl bg-panel p-6 sm:p-7">
        <IntegrationIcon name="discord" size="lg" framed />
        <div className="grid gap-2">
          <Eyebrow color={notMember || notConfigured ? 'red' : 'orange'}>
            {notConfigured ? 'Discord sin configurar' : notMember ? 'Fuera del servidor' : 'Chat del equipo · Discord'}
          </Eyebrow>
          <h2 className="text-[22px] leading-tight tracking-[-0.03em]">
            {notConfigured
              ? 'El chat de Discord no está configurado.'
              : notMember
                ? 'Tu cuenta de Discord no está en el servidor.'
                : 'Liga tu cuenta de Discord para ver los canales.'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {notConfigured
              ? 'Faltan las llaves del bot en el servidor de roz. Avísale a quien administre roz.'
              : notMember
                ? `Ligaste ${status.link?.globalName ?? status.link?.username ?? 'una cuenta'}, pero no aparece en ${status.guild?.name ?? 'el servidor'}. Entra al servidor con esa cuenta o liga otra.`
                : 'roz te muestra exactamente los canales que tu cuenta puede ver en Discord, y lo que escribas sale con tu nombre y tu foto.'}
          </p>
        </div>
        {!notConfigured && (
          <div className="flex flex-wrap gap-2">
            <Button variant="brand" size="sm" onClick={() => void startDiscordLink(setBusy)} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Link2 />}
              {busy ? 'Abriendo Discord…' : notMember ? 'Ligar otra cuenta' : 'Ligar cuenta de Discord'}
            </Button>
            {notMember && status.guild && (
              <Button asChild variant="secondary" size="sm">
                <a href={discordUrl(status.guild.id)} target="_blank" rel="noopener noreferrer">
                  Abrir el servidor <ExternalLink />
                </a>
              </Button>
            )}
          </div>
        )}
        {!notConfigured && (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            roz solo pide tu identidad (nombre y foto). No lee tus mensajes directos ni puede escribir como tu cuenta.
          </p>
        )}
      </div>
    </div>
  );
}
