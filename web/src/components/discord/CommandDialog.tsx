import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { COMMAND_FIELDS, OPTION_LABEL, PRIVATE_COMMANDS } from '@/discord/commands';
import { ApiError, discordApi, type DiscordCommandChoice, type DiscordCommandEphemeral, type DiscordCommandMenuItem } from '@/lib/api';
import { TEXTAREA_CLS } from '@/components/meetings/meeting-ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { DiscordMarkdown } from './DiscordMarkdown';
import { DiscordEmbeds } from './MessageParts';

/** Los errores de la API de comandos ya vienen en palabras de la persona (AppError del handler). */
function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return 'No se pudo conectar con roz. Intenta de nuevo.';
}

/** Valor de una opción: lo que viaja (id/identificador elegido, o el texto libre) y lo que se ve. */
interface OptionState {
  value: string;
  label: string;
}

/**
 * Un subcomando de /roz ejecutado desde roz (contrato de comandos §9). Las opciones usan el MISMO
 * autocompletado que Discord (POST …/commands/autocomplete) y admiten texto libre (el handler lo
 * resuelve, como cuando en Discord se da Enter sin elegir). Lo que en Discord es un modal (ticket,
 * junta) aquí son campos del diálogo. Lo público sale en el canal por el webhook con tu nombre; lo
 * privado (pulso, infra, errores) se muestra aquí mismo y no se publica.
 */
export function CommandDialog({
  channelId,
  channelName,
  item,
  prefill,
  onOpenChange,
}: {
  channelId: string;
  channelName: string;
  /** null = cerrado. */
  item: DiscordCommandMenuItem | null;
  /** Texto escrito después del subcomando ("/roz tarea login" → "login"). */
  prefill: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [options, setOptions] = useState<Record<string, OptionState>>({});
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DiscordCommandEphemeral[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sub = item?.subcommand ?? null;
  const extra = sub ? (COMMAND_FIELDS[sub] ?? []) : [];

  // Al abrir: lo escrito tras el subcomando prellena la primera opción (o el título si no tiene).
  useEffect(() => {
    if (!item) return;
    const first = item.options[0];
    const fieldsInit: Record<string, string> = {};
    const optsInit: Record<string, OptionState> = {};
    if (prefill) {
      if (first && item.subcommand !== 'ticket' && item.subcommand !== 'junta') optsInit[first.name] = { value: prefill, label: prefill };
      else if ((COMMAND_FIELDS[item.subcommand] ?? []).some((f) => f.name === 'titulo')) fieldsInit.titulo = prefill;
    }
    setOptions(optsInit);
    setFields(fieldsInit);
    setResult(null);
    setError(null);
    setBusy(false);
  }, [item?.subcommand]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return null;

  const missing =
    item.options.some((o) => o.required && !options[o.name]?.value.trim()) ||
    extra.some((f) => f.required && !fields[f.name]?.trim()) ||
    extra.some((f) => (fields[f.name]?.length ?? 0) > f.max);
  const isPrivate = PRIVATE_COMMANDS.has(item.subcommand) || (item.subcommand === 'plan' && !options.issue?.value.trim());

  async function run() {
    if (!item || missing || busy) return;
    setBusy(true);
    setError(null);
    try {
      const opts: Record<string, string> = {};
      for (const [k, v] of Object.entries(options)) if (v.value.trim()) opts[k] = v.value.trim();
      const res = await discordApi.runCommand(channelId, {
        subcommand: item.subcommand,
        options: opts,
        fields: extra.length ? Object.fromEntries(extra.map((f) => [f.name, (fields[f.name] ?? '').trim()])) : undefined,
      });
      const showable = res.ephemeral.filter((e) => e.content.trim() || e.embeds.length || e.links.length);
      // Publicado y sin nada privado que leer (solo "listo"): aviso y se cierra, como en Discord.
      if (res.published.length && !showable.some((e) => e.embeds.length || e.links.length)) {
        toast.success(`Publicado en #${channelName}`);
        onOpenChange(false);
        return;
      }
      setResult(showable.length ? showable : [{ content: 'Listo.', embeds: [], links: [] }]);
      if (res.published.length) toast.success(`Publicado en #${channelName}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-xl">
        <DialogHeader eyebrow={`Comando · #${channelName}`}>
          <DialogTitle>{item.command}</DialogTitle>
          <DialogDescription>
            {item.description}
            {!isPrivate && !result && ' Se publica en el canal con tu nombre.'}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1">
            {result.map((r, i) => (
              <div key={i} className="space-y-1.5">
                {r.content.trim() && <DiscordMarkdown content={r.content} className="text-sm" />}
                <DiscordEmbeds items={r.embeds} />
                {r.links.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {r.links.map((l) => (
                      <Button key={l.url} variant="outline" size="sm" asChild>
                        <a href={l.url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink /> {l.label}
                        </a>
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <form
            className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            {item.options.map((o, idx) => (
              <OptionField
                key={o.name}
                channelId={channelId}
                subcommand={item.subcommand}
                name={o.name}
                description={o.description}
                required={o.required}
                autoFocus={idx === 0 && !extra.length}
                state={options[o.name] ?? { value: '', label: '' }}
                others={options}
                onChange={(s) => setOptions((prev) => ({ ...prev, [o.name]: s }))}
              />
            ))}
            {extra.map((f, idx) => (
              <div key={f.name} className="grid gap-1.5">
                <Label htmlFor={`cmd-${f.name}`}>
                  {f.label}
                  {!f.required && <span className="font-normal text-muted-foreground"> (opcional)</span>}
                </Label>
                {f.multiline ? (
                  <textarea
                    id={`cmd-${f.name}`}
                    value={fields[f.name] ?? ''}
                    onChange={(e) => setFields((p) => ({ ...p, [f.name]: e.target.value }))}
                    rows={f.name === 'notas' ? 8 : 4}
                    maxLength={f.max}
                    placeholder={f.placeholder}
                    className={TEXTAREA_CLS}
                  />
                ) : (
                  <Input
                    id={`cmd-${f.name}`}
                    value={fields[f.name] ?? ''}
                    onChange={(e) => setFields((p) => ({ ...p, [f.name]: e.target.value }))}
                    maxLength={f.max}
                    placeholder={f.placeholder}
                    autoFocus={idx === 0}
                  />
                )}
                {f.multiline && (fields[f.name]?.length ?? 0) > f.max * 0.9 && (
                  <span className="text-right text-[11px] text-faint tabular-nums">
                    {fields[f.name]?.length ?? 0}/{f.max}
                  </span>
                )}
              </div>
            ))}
            {item.options.length === 0 && extra.length === 0 && <p className="text-sm text-muted-foreground">Este comando no lleva opciones.</p>}
            {error && <p className="rounded-md bg-red-soft px-3 py-2 text-sm text-red">{error}</p>}
            <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
          </form>
        )}

        <DialogFooter className="gap-2">
          {result ? (
            <Button onClick={() => onOpenChange(false)}>Cerrar</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancelar
              </Button>
              <Button onClick={() => void run()} disabled={missing || busy}>
                {busy && <Loader2 className="animate-spin" />}
                {isPrivate ? 'Ver' : item.subcommand === 'ticket' ? 'Crear ticket' : item.subcommand === 'junta' ? 'Enviar a Juntas' : 'Publicar'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Opción con el autocompletado de Discord (mismo handler) y texto libre. */
function OptionField({
  channelId,
  subcommand,
  name,
  description,
  required,
  autoFocus,
  state,
  others,
  onChange,
}: {
  channelId: string;
  subcommand: DiscordCommandMenuItem['subcommand'];
  name: string;
  description: string;
  required: boolean;
  autoFocus: boolean;
  state: OptionState;
  others: Record<string, OptionState>;
  onChange: (s: OptionState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<DiscordCommandChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const othersKey = JSON.stringify(Object.fromEntries(Object.entries(others).filter(([k]) => k !== name).map(([k, v]) => [k, v.value])));

  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      const rest = JSON.parse(othersKey) as Record<string, string>;
      discordApi
        .commandChoices(channelId, { subcommand, option: name, value: state.label, options: rest })
        .then(({ choices }) => {
          if (mine !== seq.current) return;
          setChoices(choices);
          setActive(0);
        })
        .catch(() => mine === seq.current && setChoices([]))
        .finally(() => mine === seq.current && setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [open, state.label, othersKey, channelId, subcommand, name]);

  function pick(c: DiscordCommandChoice) {
    onChange({ value: c.value, label: c.name });
    setOpen(false);
  }

  return (
    <div className="relative grid gap-1.5">
      <Label htmlFor={`opt-${name}`}>
        {OPTION_LABEL[name] ?? name}
        {!required && <span className="font-normal text-muted-foreground"> (opcional)</span>}
      </Label>
      <Input
        id={`opt-${name}`}
        value={state.label}
        autoFocus={autoFocus}
        autoComplete="off"
        placeholder={description}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          // Escribir descarta lo elegido: viaja el texto libre hasta que se elija otra opción.
          onChange({ value: e.target.value, label: e.target.value });
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (!open || !choices.length) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const d = e.key === 'ArrowDown' ? 1 : -1;
            setActive((i) => (i + d + choices.length) % choices.length);
          } else if (e.key === 'Enter' && state.value === state.label) {
            // Enter con la lista abierta elige; si ya eligió, el Enter envía el formulario.
            e.preventDefault();
            pick(choices[active] ?? choices[0]!);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {open && (loading || choices.length > 0) && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md" role="listbox">
          {choices.length === 0 ? (
            <p className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Buscando…
            </p>
          ) : (
            choices.map((c, i) => (
              <button
                key={c.value}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn('block w-full truncate rounded-md px-2 py-1.5 text-left text-sm', i === active && 'bg-orange-soft')}
              >
                {c.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
