import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, FileText, Hash, Loader2, Lock, Paperclip, Reply, SendHorizontal, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useDiscord } from '@/discord/DiscordContext';
import { uploadDiscordFile } from '@/discord/upload';
import {
  DISCORD_MAX_CONTENT, DISCORD_MAX_FILES, DISCORD_MAX_TOTAL_BYTES, REPLY_PREFIX_RESERVE, emojiUrl, encodeComposer, isTextLike,
  triggerAt, type ComposerToken,
} from '@/discord/model';
import { FALLBACK_MENU, STATUS_MAX_TASKS, matchSlash } from '@/discord/commands';
import { fold, formatBytes, loadDraft, saveDraft, taskQueryAt, tooLargeMessage } from '@/lib/chat-text';
import { chatApi, type ChatTaskRef } from '@/lib/chat';
import { useChat } from '@/chat/ChatContext';
import { ApiError, discordApi, type DiscordCommandMenuItem, type DiscordMessageView, type DiscordUploadView } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { GithubAvatar } from '@/components/brand';
import { AvatarStack } from '@/components/bits';
import { StatusIcon } from '@/components/tasks/inline-cells';
import { StatusDialog } from '@/components/chat/StatusDialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { CommandDialog } from './CommandDialog';

interface PendingFile {
  key: string;
  file: File;
  progress: number;
  upload: DiscordUploadView | null;
  error: string | null;
  controller: AbortController;
}

type Suggestion =
  | { kind: '@'; id: string; label: string; hint: string; avatarUrl: string | null; devId: string | null }
  /** "@tarea": no menciona a nadie, abre la búsqueda de tareas. */
  | { kind: '@tarea'; id: '__tarea'; label: 'tarea'; hint: string }
  | { kind: '#'; id: string; label: string; hint: string }
  | { kind: ':'; id: string; label: string; animated: boolean };

export interface ComposerSend {
  content: string;
  replyToId?: string;
  uploadIds?: string[];
  attachmentNames: string[];
}

/**
 * Compositor del chat de Discord: Enter envía, Shift+Enter salta línea, `@` menciona personas del
 * servidor, `#` canales, `:` emojis del servidor, y adjuntos (clip, pegar o arrastrar). Lo que se ve
 * es `@Nombre`; lo que viaja a Discord es `<@id>` (contrato §B.4).
 *
 * Paridad con el chat interno (contrato de comandos §9): `@tarea <persona> <texto>` busca una tarea y
 * escribe su identificador (WAT-44), que el mensaje pinta como ficha; el botón "Status" publica el
 * daily; y `/` abre los subcomandos de /roz (mismo orden y descripciones que Discord), que corren en
 * roz y publican en el canal por el webhook como el resto.
 */
export function DiscordComposer({
  channelId,
  channelName,
  canSend,
  canAttach,
  blockedReason,
  replyTo,
  onCancelReply,
  onSend,
}: {
  channelId: string;
  channelName: string;
  canSend: boolean;
  canAttach: boolean;
  /** Por qué no se puede escribir (sin permiso, hilo cerrado…). */
  blockedReason: string | null;
  replyTo: DiscordMessageView | null;
  onCancelReply: () => void;
  onSend: (payload: ComposerSend) => void;
}) {
  const { status, channels, emojis, searchMembers } = useDiscord();
  const draftKey = `discord:${channelId}`;
  const [text, setText] = useState(() => loadDraft(draftKey));
  const [tokens, setTokens] = useState<ComposerToken[]>([]);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [menu, setMenu] = useState<{ start: number; items: Suggestion[]; index: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // `@tarea …`: búsqueda de tareas (la misma del chat interno: persona y/o texto).
  const [taskQuery, setTaskQuery] = useState<{ start: number; query: string } | null>(null);
  const [taskResults, setTaskResults] = useState<ChatTaskRef[]>([]);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskIndex, setTaskIndex] = useState(0);
  const dismissedTaskAt = useRef<number | null>(null);
  // `/`: subcomandos de /roz.
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [command, setCommand] = useState<{ item: DiscordCommandMenuItem; prefill: string } | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const { devOf } = useChat();
  const menuApi = useApi(() => discordApi.commands(), [], { key: '/discord/commands', ttl: 3_600_000 });
  const commandItems = menuApi.data?.items?.length ? menuApi.data.items : FALLBACK_MENU;
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const query = useRef(0);
  const taskSeq = useRef(0);

  const slash = useMemo(() => (slashDismissed || taskQuery ? null : matchSlash(text, commandItems)), [text, commandItems, slashDismissed, taskQuery]);
  useEffect(() => setSlashIndex(0), [slash?.items.length]);
  useEffect(() => {
    if (!text.startsWith('/')) setSlashDismissed(false);
  }, [text]);

  // Búsqueda de `@tarea`, con un respiro entre teclas; `taskSeq` descarta respuestas tardías.
  const taskQ = taskQuery?.query;
  useEffect(() => {
    if (taskQ === undefined) {
      setTaskResults([]);
      setTaskLoading(false);
      return;
    }
    const mine = ++taskSeq.current;
    setTaskLoading(true);
    const t = setTimeout(() => {
      chatApi
        .searchTasks(taskQ)
        .then(({ tasks }) => {
          if (mine !== taskSeq.current) return;
          setTaskResults(tasks);
          setTaskIndex(0);
        })
        .catch(() => mine === taskSeq.current && setTaskResults([]))
        .finally(() => mine === taskSeq.current && setTaskLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [taskQ]);

  const limit = DISCORD_MAX_CONTENT - (replyTo ? REPLY_PREFIX_RESERVE : 0);
  const maxBytes = status.maxUploadBytes;

  useEffect(() => saveDraft(draftKey, text), [draftKey, text]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);
  useEffect(() => {
    if (replyTo) ref.current?.focus();
  }, [replyTo]);
  // Al desmontar (cambio de canal) se cancelan las subidas en vuelo.
  useEffect(() => () => files.forEach((f) => f.controller.abort()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const channelOptions = useMemo(
    () => [...channels.values()].filter((c) => isTextLike(c.type) || c.isThread),
    [channels],
  );

  // ---- Autocompletado ----
  async function refreshMenu(value: string, caret: number) {
    // `@tarea …` gana a `@persona` (como en el chat interno). Esc la cierra hasta salir de ese `@tarea`.
    const tq = taskQueryAt(value, caret);
    if (!tq) dismissedTaskAt.current = null;
    if (tq && tq.start !== dismissedTaskAt.current) {
      ++query.current;
      setMenu(null);
      setTaskQuery(tq);
      return;
    }
    setTaskQuery(null);
    const t = triggerAt(value, caret);
    if (!t) return setMenu(null);
    const q = fold(t.query);
    const n = ++query.current;
    let items: Suggestion[] = [];
    if (t.kind === '#') {
      items = channelOptions
        .filter((c) => fold(c.name).includes(q))
        .slice(0, 8)
        .map((c) => ({
          kind: '#' as const,
          id: c.id,
          label: c.name,
          hint: c.isThread ? `hilo de #${channels.get(c.parentId ?? '')?.name ?? 'canal'}` : 'canal',
        }));
    } else if (t.kind === ':') {
      items = emojis
        .filter((e) => fold(e.name).includes(q))
        .slice(0, 8)
        .map((e) => ({ kind: ':' as const, id: e.id, label: e.name, animated: e.animated }));
    } else {
      try {
        const list = await searchMembers(t.query);
        if (n !== query.current) return;
        items = list
          .filter((m) => !m.bot)
          .slice(0, 8)
          .map((m) => ({ kind: '@' as const, id: m.discordUserId, label: m.displayName, hint: m.username, avatarUrl: m.avatarUrl, devId: m.devId }));
      } catch {
        items = [];
      }
      if (q && 'tarea'.startsWith(q)) items = [{ kind: '@tarea', id: '__tarea', label: 'tarea', hint: 'citar una tarea' }, ...items];
    }
    if (n !== query.current) return;
    setMenu(items.length ? { start: t.start, items, index: 0 } : null);
  }

  function pick(s: Suggestion) {
    const el = ref.current;
    if (!el || !menu) return;
    const caret = el.selectionStart;
    const insert = s.kind === '@' || s.kind === '@tarea' ? `@${s.label} ` : s.kind === '#' ? `#${s.label} ` : `:${s.label}: `;
    const next = text.slice(0, menu.start) + insert + text.slice(caret);
    setText(next);
    if (s.kind === '@') setTokens((t) => [...t.filter((x) => x.label !== `@${s.label}`), { label: `@${s.label}`, token: `<@${s.id}>` }]);
    if (s.kind === '#') setTokens((t) => [...t.filter((x) => x.label !== `#${s.label}`), { label: `#${s.label}`, token: `<#${s.id}>` }]);
    setMenu(null);
    const pos = menu.start + insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
      // "@tarea " abre la búsqueda de tareas.
      if (s.kind === '@tarea') void refreshMenu(next, pos);
    });
  }

  /** Cambia `@tarea …` por el identificador: el mensaje lo pinta como la ficha de la tarea. */
  function pickTask(t: ChatTaskRef) {
    const el = ref.current;
    if (!el || !taskQuery) return;
    const caret = el.selectionStart;
    const insert = `${t.identifier} `;
    const next = text.slice(0, taskQuery.start) + insert + text.slice(caret);
    setText(next);
    setTaskQuery(null);
    const pos = taskQuery.start + insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  /** Elegir un subcomando: se limpia el compositor y se abre su diálogo (o el del status). */
  function openCommand(item: DiscordCommandMenuItem, prefill: string) {
    setText('');
    setMenu(null);
    if (item.subcommand === 'status') setStatusOpen(true);
    else setCommand({ item, prefill });
  }

  /** El daily: las tareas elegidas en el mismo selector del chat interno, publicadas por /roz status. */
  async function publishStatus(note: string, tasks: ChatTaskRef[]) {
    let list = tasks;
    if (list.length > STATUS_MAX_TASKS) {
      toast(`Discord muestra hasta ${STATUS_MAX_TASKS} tareas: se publican las primeras ${STATUS_MAX_TASKS}.`);
      list = list.slice(0, STATUS_MAX_TASKS);
    }
    try {
      const res = await discordApi.runCommand(channelId, {
        subcommand: 'status',
        fields: { tareas: list.map((t) => t.id), nota: encodeComposer(note.trim(), [], emojis) },
      });
      if (res.published.length) toast.success(`Status publicado en #${channelName}`);
      else toast(res.ephemeral.map((e) => e.content).filter(Boolean).join('\n') || 'No se publicó nada.');
    } catch (e) {
      toast.error('No se publicó el status', { description: e instanceof ApiError ? e.message : 'No se pudo conectar con roz.' });
    }
  }

  // ---- Adjuntos ----
  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list);
    if (!incoming.length) return;
    if (!canAttach) {
      toast.error('No puedes adjuntar archivos en este canal');
      return;
    }
    let total = files.reduce((s, f) => s + f.file.size, 0);
    const accepted: PendingFile[] = [];
    for (const file of incoming) {
      if (files.length + accepted.length >= DISCORD_MAX_FILES) {
        toast.error(`Máximo ${DISCORD_MAX_FILES} archivos por mensaje`);
        break;
      }
      if (file.size > maxBytes) {
        toast.error('Archivo demasiado grande', { description: tooLargeMessage(file.name, file.size, maxBytes) });
        continue;
      }
      if (total + file.size > DISCORD_MAX_TOTAL_BYTES) {
        toast.error('Los adjuntos de un mensaje no pueden pasar de 25 MB en total');
        break;
      }
      total += file.size;
      accepted.push({ key: `${Date.now()}-${Math.random()}`, file, progress: 0, upload: null, error: null, controller: new AbortController() });
    }
    if (!accepted.length) return;
    setFiles((f) => [...f, ...accepted]);
    for (const p of accepted) {
      uploadDiscordFile(channelId, p.file, {
        signal: p.controller.signal,
        onProgress: (fraction) => setFiles((f) => f.map((x) => (x.key === p.key ? { ...x, progress: fraction } : x))),
      })
        .then((upload) => setFiles((f) => f.map((x) => (x.key === p.key ? { ...x, upload, progress: 1 } : x))))
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          setFiles((f) => f.map((x) => (x.key === p.key ? { ...x, error: e instanceof Error ? e.message : String(e) } : x)));
        });
    }
  }

  function removeFile(key: string) {
    setFiles((f) => {
      f.find((x) => x.key === key)?.controller.abort();
      return f.filter((x) => x.key !== key);
    });
  }

  const uploading = files.some((f) => !f.upload && !f.error);
  const failed = files.some((f) => f.error);

  // ---- Envío ----
  function submit() {
    if (!canSend) return;
    // Un comando de /roz no se manda como texto: se abre su diálogo.
    if (slash) {
      openCommand(slash.items[slashIndex] ?? slash.items[0]!, slash.rest);
      return;
    }
    const content = encodeComposer(text.trim(), tokens, emojis);
    const ready = files.filter((f) => f.upload);
    if (!content && !ready.length) return;
    if (uploading) {
      toast('Espera a que terminen de subir los archivos');
      return;
    }
    if (failed) {
      toast.error('Quita los archivos que no se subieron');
      return;
    }
    if (content.length > limit) {
      toast.error('Mensaje demasiado largo', { description: `Discord acepta hasta ${limit} caracteres${replyTo ? ' en una respuesta' : ''}.` });
      return;
    }
    onSend({
      content,
      replyToId: replyTo?.id,
      uploadIds: ready.length ? ready.map((f) => f.upload!.id) : undefined,
      attachmentNames: ready.map((f) => f.file.name),
    });
    setText('');
    setTokens([]);
    setFiles([]);
    setMenu(null);
  }

  if (!canSend) {
    return (
      <div className="shrink-0 border-t bg-card px-4 py-3 md:px-5">
        <p className="flex items-center gap-2 rounded-md bg-panel px-3 py-2.5 text-sm text-muted-foreground">
          <Lock className="size-4 shrink-0" />
          {blockedReason ?? 'No tienes permiso para escribir en este canal.'}
        </p>
      </div>
    );
  }

  const over = text.length > limit - 200;

  return (
    <div className="shrink-0 px-3 pb-3 md:px-4">
      <div
        onDragOver={(e) => {
          if (!canAttach || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!canAttach) return;
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        className={cn(
          'relative rounded-lg border bg-card shadow-sm transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring',
          dragging && 'border-orange bg-orange-soft/40',
        )}
      >
        {menu && (
          <div className="absolute inset-x-2 bottom-full z-20 mb-2 overflow-hidden rounded-lg border bg-card shadow-lg">
            <div className="border-b bg-panel/60 px-3 py-1.5 label-caps text-faint">
              {menu.items[0]!.kind === '@' || menu.items[0]!.kind === '@tarea' ? 'Personas del servidor' : menu.items[0]!.kind === '#' ? 'Canales' : 'Emojis del servidor'}
            </div>
            <ul role="listbox" className="max-h-64 overflow-y-auto py-1">
              {menu.items.map((s, i) => (
                <li key={`${s.kind}${s.id}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === menu.index}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(s);
                    }}
                    onMouseEnter={() => setMenu((m) => (m ? { ...m, index: i } : m))}
                    className={cn('flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm', i === menu.index && 'bg-orange-soft text-orange-ink')}
                  >
                    {s.kind === '@' && <GithubAvatar url={s.avatarUrl} id={s.devId} name={s.label} className="size-5" color="chart-2" />}
                    {s.kind === '@tarea' && <ClipboardList className="size-4 text-faint" />}
                    {s.kind === '#' && <Hash className="size-4 text-faint" />}
                    {s.kind === ':' && <img src={emojiUrl(s.id, s.animated, 32)} alt="" className="size-5 object-contain" />}
                    <span className="truncate font-medium">{s.kind === ':' ? `:${s.label}:` : s.kind === '@tarea' ? '@tarea' : s.label}</span>
                    {s.kind !== ':' && <span className="ml-auto truncate text-[11px] text-faint">{s.hint}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {taskQuery && (
          <div className="absolute inset-x-2 bottom-full z-20 mb-2 overflow-hidden rounded-lg border bg-card shadow-lg md:right-auto md:w-[30rem]">
            <div className="flex items-center gap-2 border-b bg-panel/60 px-3 py-1.5">
              <span className="label-caps text-faint">Citar tarea</span>
              <span className="truncate text-[11px] text-faint">· persona y/o palabras, p. ej. @tarea @Fer login</span>
              {taskLoading && <Loader2 className="ml-auto size-3 animate-spin text-faint" />}
            </div>
            {taskResults.length === 0 ? (
              <p className="px-3 py-3 text-sm text-muted-foreground">
                {taskLoading
                  ? 'Buscando…'
                  : taskQuery.query
                    ? 'Ninguna tarea coincide.'
                    : 'No tienes tareas abiertas. Escribe una persona o palabras para buscar las de otros.'}
              </p>
            ) : (
              <ul role="listbox" className="max-h-64 overflow-y-auto py-1">
                {taskResults.map((t, i) => {
                  const people = t.assigneeDevIds
                    .map((id) => devOf(id))
                    .filter((d): d is NonNullable<typeof d> => !!d)
                    .map((d) => ({ name: d.name, avatarUrl: d.avatarUrl, id: d.id, email: d.email }));
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === taskIndex}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          pickTask(t);
                        }}
                        onMouseEnter={() => setTaskIndex(i)}
                        className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm', i === taskIndex && 'bg-orange-soft')}
                      >
                        <StatusIcon state={t.status} className="size-4" />
                        <span className="shrink-0 font-mono text-[11px] font-medium text-faint">{t.identifier}</span>
                        <span className="min-w-0 flex-1 truncate">{t.name}</span>
                        {t.projectName && <span className="hidden max-w-[7rem] truncate text-xs text-muted-foreground sm:inline">{t.projectName}</span>}
                        <AvatarStack people={people} size="size-5" max={2} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {slash && !menu && (
          <div className="absolute inset-x-2 bottom-full z-20 mb-2 overflow-hidden rounded-lg border bg-card shadow-lg md:right-auto md:w-[30rem]">
            <div className="border-b bg-panel/60 px-3 py-1.5 label-caps text-faint">Comandos de roz</div>
            <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
              {slash.items.map((it, i) => (
                <li key={it.subcommand}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === slashIndex}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      openCommand(it, slash.rest);
                    }}
                    onMouseEnter={() => setSlashIndex(i)}
                    className={cn('flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm', i === slashIndex && 'bg-orange-soft')}
                  >
                    <span className="shrink-0 font-semibold">{it.command}</span>
                    {it.options.length > 0 && (
                      <span className="hidden shrink-0 text-[11px] text-faint sm:inline">
                        {it.options.map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`)).join(' ')}
                      </span>
                    )}
                    <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">{it.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {replyTo && (
          <div className="flex items-center gap-2 border-b bg-panel/60 px-3 py-1.5 text-xs text-muted-foreground">
            <Reply className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              Respondiendo a <span className="font-semibold text-foreground">{replyTo.author.displayName}</span>
            </span>
            <button type="button" onClick={onCancelReply} className="ml-auto grid size-5 place-items-center rounded hover:bg-toggle-off/60" aria-label="Cancelar respuesta">
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b px-3 py-2">
            {files.map((f) => (
              <div
                key={f.key}
                className={cn('relative flex max-w-[14rem] items-center gap-2 overflow-hidden rounded-md border bg-panel/50 py-1.5 pl-2 pr-7', f.error && 'border-red/50 bg-red-soft')}
                title={f.error ?? f.file.name}
              >
                {f.upload ? <FileText className="size-4 shrink-0 text-muted-foreground" /> : f.error ? <X className="size-4 shrink-0 text-red" /> : <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{f.file.name}</span>
                  <span className={cn('block text-[10px] text-faint tabular-nums', f.error && 'text-red')}>
                    {f.error ? 'No se subió' : f.upload ? formatBytes(f.file.size) : `${Math.round(f.progress * 100)}%`}
                  </span>
                </span>
                <button type="button" onClick={() => removeFile(f.key)} className="absolute right-1 top-1 grid size-5 place-items-center rounded text-muted-foreground hover:bg-toggle-off/60" aria-label={`Quitar ${f.file.name}`}>
                  <X className="size-3" />
                </button>
                {!f.upload && !f.error && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-orange" style={{ width: `${f.progress * 100}%` }} />}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-1.5 p-1.5">
          {canAttach && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="mb-0.5 text-muted-foreground" onClick={() => fileInput.current?.click()} aria-label="Adjuntar archivos">
                  <Paperclip />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Adjuntar (hasta {formatBytes(maxBytes)} por archivo)</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="mb-0.5 h-8 gap-1.5 px-2 text-muted-foreground"
                onClick={() => setStatusOpen(true)}
                aria-label="Compartir status"
              >
                <ClipboardList className="size-4" /> <span className="hidden sm:inline">Status</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Tu daily: elige tareas y publica su estado (/roz status)</TooltipContent>
          </Tooltip>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <textarea
            ref={ref}
            value={text}
            rows={1}
            placeholder={`Escribe en #${channelName}`}
            onChange={(e) => {
              setText(e.target.value);
              void refreshMenu(e.target.value, e.target.selectionStart);
            }}
            onClick={(e) => void refreshMenu(text, e.currentTarget.selectionStart)}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (taskQuery) {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  dismissedTaskAt.current = taskQuery.start;
                  setTaskQuery(null);
                  return;
                }
                if (taskResults.length) {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const d = e.key === 'ArrowDown' ? 1 : -1;
                    setTaskIndex((i) => (i + d + taskResults.length) % taskResults.length);
                    return;
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    pickTask(taskResults[taskIndex] ?? taskResults[0]!);
                    return;
                  }
                } else if (e.key === 'Enter' && !e.shiftKey) {
                  // Sin resultados todavía: Enter no manda el "@tarea …" a medio escribir.
                  e.preventDefault();
                  return;
                }
              }
              if (slash && !menu) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const d = e.key === 'ArrowDown' ? 1 : -1;
                  setSlashIndex((i) => (i + d + slash.items.length) % slash.items.length);
                  return;
                }
                if ((e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === 'Tab') {
                  e.preventDefault();
                  const it = slash.items[slashIndex] ?? slash.items[0]!;
                  // Tab completa el comando en el texto; Enter lo abre.
                  if (e.key === 'Tab') setText(`${it.command} ${slash.rest}`);
                  else openCommand(it, slash.rest);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setSlashDismissed(true);
                  return;
                }
              }
              if (menu) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const d = e.key === 'ArrowDown' ? 1 : -1;
                  setMenu({ ...menu, index: (menu.index + d + menu.items.length) % menu.items.length });
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  pick(menu.items[menu.index]!);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setMenu(null);
                  return;
                }
              }
              if (e.key === 'Escape' && replyTo) {
                e.preventDefault();
                onCancelReply();
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            className="scroll-thin max-h-[280px] min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-2 text-[14.5px] outline-none placeholder:text-faint"
          />
          {over && (
            <span className={cn('mb-2.5 text-[10.5px] tabular-nums', text.length > limit ? 'text-red' : 'text-faint')}>
              {limit - text.length}
            </span>
          )}
          <Button
            size="icon-sm"
            variant="brand"
            className="mb-0.5"
            onClick={submit}
            disabled={uploading || (!text.trim() && !files.some((f) => f.upload))}
            aria-label="Enviar"
          >
            {uploading ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
          </Button>
        </div>
      </div>
      <p className="mt-1 hidden px-1 text-[10px] text-faint md:block tabular-nums">
        Enter envía · Shift+Enter salto de línea · @ personas · @tarea citar tarea · # canales · : emojis · / comandos de roz. Sale en Discord con tu nombre y tu foto.
      </p>

      <CommandDialog
        channelId={channelId}
        channelName={channelName}
        item={command?.item ?? null}
        prefill={command?.prefill ?? ''}
        onOpenChange={(open) => {
          if (!open) {
            setCommand(null);
            requestAnimationFrame(() => ref.current?.focus());
          }
        }}
      />
      <StatusDialog open={statusOpen} onOpenChange={setStatusOpen} onSend={(note, tasks) => void publishStatus(note, tasks)} />
    </div>
  );
}
