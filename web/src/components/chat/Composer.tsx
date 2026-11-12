import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { toast } from '@/lib/toast';
import { ClipboardList, FileText, Loader2, Play, Plus, SendHorizonal, TicketPlus, X } from 'lucide-react';
import { useChat } from '@/chat/ChatContext';
import { AvatarStack, UserAvatar } from '@/components/bits';
import { StatusIcon } from '@/components/tasks/inline-cells';
import { Button } from '@/components/ui/button';
import { TicketDialog } from '@/components/tickets/TicketDialog';
import { StatusDialog } from './StatusDialog';
import {
  MAX_ATTACHMENT_BYTES, MAX_MESSAGE_LENGTH, attachmentKind, chatApi, encodeMentions, fold, loadDraft, mentionQueryAt,
  saveDraft, slashHint, taskQueryAt, ticketCommand, tooLargeMessage, type ChatAttachment, type ChatTaskRef,
} from '@/lib/chat';
import { cn } from '@/lib/utils';

/** Tecla en la ayuda del compositor: cajita mono gris, como las etiquetas del mock. */
const KBD = 'rounded-sm bg-panel px-1 py-px font-sans text-[10px] font-semibold text-muted-foreground';

interface Upload {
  key: string;
  file: File;
  /** Object URL para la miniatura (imagen o video); null para otros archivos. */
  preview: string | null;
  isVideo: boolean;
  /** 0..1 mientras sube directo a Storage. */
  progress: number;
  attachment: ChatAttachment | null;
  error: string | null;
  abort: AbortController;
}

/** Suelta miniaturas y corta las subidas que siguen en vuelo (cambio de conversación, quitar, enviar). */
function discard(list: Upload[]) {
  for (const u of list) {
    if (u.preview) URL.revokeObjectURL(u.preview);
    if (!u.attachment && !u.error) u.abort.abort();
  }
}

interface Suggestion {
  id: string;
  name: string;
  avatarUrl: string | null;
  email?: string | null;
  hint?: string;
}

/**
 * Compositor del chat (conversación o hilo). Enter envía, Shift+Enter hace salto de línea; `@` abre
 * el autocompletado de personas y `@canal`, y `@tarea <persona> <texto>` busca una tarea para
 * citarla (se inserta como `#ROZ-12` y el mensaje la muestra con su tarjeta del kanban). Los archivos
 * se suben al elegirlos (con progreso por archivo) y el mensaje viaja con sus ids. El borrador
 * sobrevive a cambiar de conversación.
 */
export function Composer({
  conversationId,
  draftKey,
  memberIds,
  placeholder,
  onSend,
  autoFocus,
  compact,
}: {
  conversationId: string;
  draftKey: string;
  memberIds: string[];
  placeholder: string;
  onSend: (body: string, attachments: ChatAttachment[], statusTasks?: ChatTaskRef[]) => void;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const { devs, devOf } = useChat();
  const [text, setText] = useState(() => loadDraft(draftKey));
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [taskQuery, setTaskQuery] = useState<{ start: number; query: string } | null>(null);
  const [taskResults, setTaskResults] = useState<ChatTaskRef[]>([]);
  const [taskLoading, setTaskLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  // `/ticket [nombre]`: abre el formulario de ticket inteligente en vez de enviar.
  const [ticket, setTicket] = useState<{ open: boolean; title: string }>({ open: false, title: '' });
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Cambiar de conversación: se guarda el borrador de la anterior y se carga el de la nueva.
  const keyRef = useRef(draftKey);
  useEffect(() => {
    if (keyRef.current === draftKey) return;
    keyRef.current = draftKey;
    setText(loadDraft(draftKey));
    setUploads((prev) => {
      discard(prev);
      return [];
    });
    setMention(null);
    setTaskQuery(null);
  }, [draftKey]);

  useEffect(() => {
    const t = setTimeout(() => saveDraft(keyRef.current, text), 300);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus, draftKey]);

  // Alto automático hasta un tope; después, scroll interno.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, compact ? 160 : 240)}px`;
  }, [text, compact]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!mention) return [];
    const q = fold(mention.query.trim());
    const members = new Set(memberIds);
    const people = devs
      .filter((d) => d.active)
      .filter((d) => !q || fold(d.name).split(/\s+/).some((w) => w.startsWith(q)) || fold(d.name).startsWith(q))
      .sort((a, b) => Number(members.has(b.id)) - Number(members.has(a.id)) || a.name.localeCompare(b.name))
      .slice(0, 7)
      .map((d) => ({ id: d.id, name: d.name, avatarUrl: d.avatarUrl, email: d.email, hint: members.has(d.id) ? undefined : 'no está en la conversación' }));
    const canal = 'canal'.startsWith(q) ? [{ id: '__canal', name: 'canal', avatarUrl: null, hint: 'avisa a todos los miembros' }] : [];
    const tarea = 'tarea'.startsWith(q) ? [{ id: '__tarea', name: 'tarea', avatarUrl: null, hint: 'citar una tarea' }] : [];
    return [...canal, ...tarea, ...people];
  }, [mention, devs, memberIds]);

  useEffect(() => setActive(0), [mention?.query, taskQuery?.query]);

  // Búsqueda de tareas para `@tarea …`, con un respiro entre teclas. `seq` descarta respuestas que
  // llegan tarde (escribir rápido dispara varias búsquedas en vuelo).
  const seq = useRef(0);
  const taskQ = taskQuery?.query;
  useEffect(() => {
    if (taskQ === undefined) {
      setTaskResults([]);
      setTaskLoading(false);
      return;
    }
    const mine = ++seq.current;
    setTaskLoading(true);
    const t = setTimeout(() => {
      chatApi
        .searchTasks(taskQ)
        .then(({ tasks }) => {
          if (mine === seq.current) setTaskResults(tasks);
        })
        .catch(() => {
          if (mine === seq.current) setTaskResults([]);
        })
        .finally(() => {
          if (mine === seq.current) setTaskLoading(false);
        });
    }, 200);
    return () => clearTimeout(t);
  }, [taskQ]);

  // Si la persona cerró la búsqueda con Esc, no se reabre al seguir escribiendo después del mismo
  // `@tarea` (la consulta ahora admite `@` y espacios, así que si no se recordara volvería sola).
  const dismissedTaskAt = useRef<number | null>(null);

  /** Decide qué autocompletado va abierto según el texto antes del cursor (`@tarea` gana a `@persona`). */
  const updateTriggers = useCallback((value: string, caret: number) => {
    const found = taskQueryAt(value, caret);
    if (!found) dismissedTaskAt.current = null;
    const tq = found && found.start !== dismissedTaskAt.current ? found : null;
    setTaskQuery(tq);
    setMention(tq ? null : mentionQueryAt(value, caret));
  }, []);

  const updateMention = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    updateTriggers(el.value, el.selectionStart ?? el.value.length);
  }, [updateTriggers]);

  /** Reemplaza `text[start, cursor)` por `insert` y deja el cursor después. */
  function replaceAtCaret(start: number, insert: string) {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? text.length;
    const next = text.slice(0, start) + insert + text.slice(caret);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + insert.length;
      el.setSelectionRange(pos, pos);
      updateTriggers(next, pos);
    });
  }

  function pick(s: Suggestion) {
    if (!mention) return;
    setMention(null);
    // "@tarea " abre la búsqueda de tareas en vez de insertar una mención.
    replaceAtCaret(mention.start, s.id === '__tarea' ? '@tarea ' : `@${s.name} `);
  }

  function pickTask(t: ChatTaskRef) {
    if (!taskQuery) return;
    setTaskQuery(null);
    replaceAtCaret(taskQuery.start, `#${t.identifier} `);
  }

  function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    for (const file of list) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        // toast.error también hace sonar el aviso de error.
        toast.error(tooLargeMessage(file.name, file.size, MAX_ATTACHMENT_BYTES), {
          description: 'Comprímelo o compártelo con un link (Drive, YouTube…).',
        });
        continue;
      }
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
      const kind = attachmentKind({ name: file.name, contentType: file.type || null });
      const preview = kind === 'image' || kind === 'video' ? URL.createObjectURL(file) : null;
      const abort = new AbortController();
      const patch = (p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));
      setUploads((u) => [...u, { key, file, preview, isVideo: kind === 'video', progress: 0, attachment: null, error: null, abort }]);
      let shown = 0;
      chatApi
        .upload(conversationId, file, {
          signal: abort.signal,
          // Un re-render por cada 2 %: el evento de progreso dispara decenas de veces por segundo.
          onProgress: (f) => {
            if (f - shown >= 0.02 || f === 1) {
              shown = f;
              patch({ progress: f });
            }
          },
        })
        .then(({ attachment }) => patch({ attachment, progress: 1 }))
        .catch((e) => {
          if (abort.signal.aborted) return; // se quitó a propósito
          patch({ error: e instanceof Error ? e.message : String(e) });
        });
    }
  }

  function removeUpload(key: string) {
    setUploads((u) => {
      discard(u.filter((x) => x.key === key));
      return u.filter((x) => x.key !== key);
    });
  }

  const uploading = uploads.some((u) => !u.attachment && !u.error);
  const ready = uploads.filter((u) => u.attachment).map((u) => u.attachment!);
  const canSend = !uploading && (text.trim().length > 0 || ready.length > 0) && text.length <= MAX_MESSAGE_LENGTH;
  const showSlash = !mention && !taskQuery && slashHint(text);

  /** `/ticket …` no es un mensaje: abre el formulario y limpia el compositor (los adjuntos se quedan). */
  function openTicket(title: string) {
    setTicket({ open: true, title });
    setText('');
    saveDraft(keyRef.current, '');
    setMention(null);
    setTaskQuery(null);
  }

  function send() {
    const cmd = ticketCommand(text);
    if (cmd) {
      openTicket(cmd.title);
      return;
    }
    if (!canSend) return;
    const body = encodeMentions(text.trim(), devs);
    onSend(body, ready);
    setText('');
    saveDraft(keyRef.current, '');
    setUploads((prev) => {
      discard(prev);
      return [];
    });
    setMention(null);
    setTaskQuery(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (taskQuery) {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissedTaskAt.current = taskQuery.start;
        setTaskQuery(null);
        return;
      }
      if (taskResults.length) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActive((i) => (i + 1) % taskResults.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActive((i) => (i - 1 + taskResults.length) % taskResults.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          pickTask(taskResults[active] ?? taskResults[0]!);
          return;
        }
      } else if (e.key === 'Enter' && !e.shiftKey) {
        // Sin resultados todavía: Enter no debe mandar el "@tarea …" a medio escribir.
        e.preventDefault();
        return;
      }
    }
    if (mention && suggestions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(suggestions[active]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    // Escribiendo `/ticket`: Tab lo completa y Enter abre el formulario.
    if (showSlash && !e.shiftKey && (e.key === 'Tab' || e.key === 'Enter') && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (e.key === 'Tab') setText('/ticket ');
      else openTicket('');
      return;
    }
    // En táctil Enter es salto de línea (el teclado no tiene Shift a mano); se envía con el botón.
    const touch = window.matchMedia('(hover: none)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  }

  return (
    <div
      className={cn('relative px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1 md:px-5', compact && 'px-3 md:px-4')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {taskQuery && (
        <div className="absolute bottom-full left-4 right-4 z-20 mb-1.5 overflow-hidden rounded-lg border bg-popover p-1 shadow-md md:left-5 md:right-auto md:w-[28rem]">
          <div className="flex items-center gap-2 px-2 py-1.5 label-caps text-faint">
            Citar tarea
            <span className="truncate font-sans text-[11px] font-normal normal-case tracking-normal">· persona y/o palabras, p. ej. @tarea @Fer login</span>
            {taskLoading && <Loader2 className="ml-auto size-3 animate-spin" />}
          </div>
          {taskResults.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              {taskLoading
                ? 'Buscando…'
                : taskQuery.query
                  ? 'Ninguna tarea coincide.'
                  : 'No tienes tareas abiertas. Escribe una persona o palabras para buscar las de otros.'}
            </p>
          ) : (
            taskResults.map((t, i) => {
              const people = t.assigneeDevIds
                .map((id) => devOf(id))
                .filter((d): d is NonNullable<typeof d> => !!d)
                .map((d) => ({ name: d.name, avatarUrl: d.avatarUrl, id: d.id, email: d.email }));
              return (
                <button
                  key={t.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickTask(t);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm', i === active && 'bg-orange-soft')}
                >
                  <StatusIcon state={t.status} className="size-4" />
                  <span className="shrink-0 font-mono text-[11px] font-medium text-faint">{t.identifier}</span>
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  {t.projectName && <span className="hidden max-w-[7rem] truncate text-xs text-muted-foreground sm:inline">{t.projectName}</span>}
                  <AvatarStack people={people} size="size-5" max={2} />
                </button>
              );
            })
          )}
        </div>
      )}

      {showSlash && (
        <div className="absolute bottom-full left-4 right-4 z-20 mb-1.5 overflow-hidden rounded-lg border bg-popover p-1 shadow-md md:left-5 md:right-auto md:w-96">
          <div className="px-2 py-1.5 label-caps text-faint">Comandos</div>
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              openTicket('');
            }}
            className="flex w-full items-center gap-2 rounded-md bg-orange-soft px-2 py-1.5 text-left text-sm"
          >
            <span className="grid size-6 place-items-center rounded-md bg-orange text-primary-foreground">
              <TicketPlus className="size-3.5" />
            </span>
            <span className="font-mono text-[12.5px] font-semibold">/ticket</span>
            <span className="ml-auto truncate text-xs text-muted-foreground">Crear un ticket: roz lo asigna y avisa</span>
          </button>
        </div>
      )}

      {mention && suggestions.length > 0 && (
        <div className="absolute bottom-full left-4 right-4 z-20 mb-1.5 overflow-hidden rounded-lg border bg-popover p-1 shadow-md md:left-5 md:right-auto md:w-80">
          <div className="px-2 py-1.5 label-caps text-faint">Mencionar</div>
          {suggestions.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm', i === active && 'bg-orange-soft')}
            >
              {s.id === '__canal' || s.id === '__tarea' ? (
                <span className="grid size-6 place-items-center rounded-full bg-panel text-xs font-bold text-foreground tabular-nums">
                  {s.id === '__tarea' ? '#' : '@'}
                </span>
              ) : (
                <UserAvatar url={s.avatarUrl} email={s.email} id={s.id} name={s.name} className="size-6" />
              )}
              <span className="font-medium">{s.id.startsWith('__') ? `@${s.name}` : s.name}</span>
              {s.hint && <span className="ml-auto truncate text-xs text-muted-foreground">{s.hint}</span>}
            </button>
          ))}
        </div>
      )}

      <div
        className={cn(
          'rounded-lg border bg-card shadow-sm transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/30',
          dragging && 'border-dashed border-orange bg-orange-soft/40 ring-2 ring-orange/25',
        )}
      >
        {uploads.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b p-2">
            {uploads.map((u) => (
              <div key={u.key} className={cn('relative flex items-center gap-2 rounded-md border bg-sidebar p-1.5 pr-7 text-xs', u.error && 'border-red/50 bg-red-soft')}>
                {u.preview && u.isVideo ? (
                  <span className="relative size-10 overflow-hidden rounded bg-black">
                    <video src={u.preview} muted playsInline preload="metadata" className="size-full object-cover" />
                    <Play className="absolute inset-0 m-auto size-4 fill-white text-white" />
                  </span>
                ) : u.preview ? (
                  <img src={u.preview} alt="" className="size-10 rounded object-cover" />
                ) : (
                  <span className="grid size-10 place-items-center rounded bg-panel text-muted-foreground">
                    <FileText className="size-5" />
                  </span>
                )}
                <span className="max-w-[10rem]">
                  <span className="block truncate font-medium">{u.file.name}</span>
                  <span className={cn('block truncate', u.error ? 'text-destructive' : 'text-muted-foreground')} title={u.error ?? undefined}>
                    {u.error ? `No se subió — ${u.error}` : u.attachment ? 'Listo' : `Subiendo… ${Math.round(u.progress * 100)}%`}
                  </span>
                  {!u.attachment && !u.error && (
                    <span className="mt-1 block h-1 overflow-hidden rounded-full bg-panel">
                      <span className="block h-full rounded-full bg-orange transition-[width]" style={{ width: `${Math.max(4, u.progress * 100)}%` }} />
                    </span>
                  )}
                </span>
                {!u.attachment && !u.error && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                <button
                  type="button"
                  onClick={() => removeUpload(u.key)}
                  className="absolute right-1 top-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Quitar archivo"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            updateTriggers(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') updateMention();
          }}
          onClick={updateMention}
          onBlur={() =>
            setTimeout(() => {
              setMention(null);
              setTaskQuery(null);
            }, 120)
          }
          onPaste={onPaste}
          rows={1}
          placeholder={placeholder}
          aria-label={placeholder}
          className="block w-full resize-none bg-transparent px-3 pt-3 text-sm outline-none placeholder:text-muted-foreground"
        />

        <div className="flex items-center gap-1 px-2 pb-2 pt-1">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 rounded-btn bg-panel text-muted-foreground hover:bg-toggle-off/70 hover:text-foreground"
            onClick={() => fileRef.current?.click()}
            aria-label="Adjuntar archivo"
          >
            <Plus />
          </Button>
          {/* El status (daily) va en el canal, no en hilos. */}
          {!compact && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 rounded-btn bg-panel px-2.5 label-caps text-muted-foreground hover:bg-toggle-off/70 hover:text-foreground"
              onClick={() => setStatusOpen(true)}
              aria-label="Compartir status"
            >
              <ClipboardList className="size-3.5" /> Status
            </Button>
          )}
          <span className="ml-1.5 hidden min-w-0 truncate text-[11px] text-faint md:block">
            <kbd className={KBD}>Shift+Enter</kbd> salto de línea · <kbd className={KBD}>@</kbd> mencionar
            {' · '}
            <kbd className={KBD}>@tarea</kbd> citar tarea · <kbd className={KBD}>/ticket</kbd> crear ticket
          </span>
          <div className="ml-auto flex items-center gap-2">
            {text.length > MAX_MESSAGE_LENGTH * 0.9 && (
              <span className={cn('text-[10.5px] tabular-nums', text.length > MAX_MESSAGE_LENGTH ? 'text-red' : 'text-faint')}>
                {text.length}/{MAX_MESSAGE_LENGTH}
              </span>
            )}
            <Button
              type="button"
              size="icon-sm"
              variant="brand"
              className={cn('transition-opacity', !canSend && 'opacity-40')}
              disabled={!canSend}
              onClick={send}
              aria-label="Enviar"
            >
              {uploading ? <Loader2 className="animate-spin" /> : <SendHorizonal />}
            </Button>
          </div>
        </div>
      </div>

      <TicketDialog
        open={ticket.open}
        initialTitle={ticket.title}
        onOpenChange={(open) => setTicket((t) => ({ ...t, open }))}
      />

      {!compact && (
        <StatusDialog
          open={statusOpen}
          onOpenChange={setStatusOpen}
          onSend={(note, tasks) => onSend(encodeMentions(note, devs), [], tasks)}
        />
      )}
    </div>
  );
}
