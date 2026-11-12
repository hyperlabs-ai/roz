import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ClipboardPaste, FileText, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Eyebrow, IntegrationIcon } from '@/components/brand';
import { SegmentMeter } from '@/components/bits';
import { FieldLabel, MiniAvatar, TEXTAREA_CLS } from '@/components/meetings/meeting-ui';
import { useAction } from '@/lib/useAction';
import {
  MEETING_TRANSCRIPT_MAX_CHARS, rozV2Api,
  type ManualTranscriptFormat, type MeetingAttendee, type MeetingSummary, type ResolveProjectResponse,
} from '@/lib/api';
import { compact } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ProjectIcon } from '@/components/avatars';

type Origin = 'pegar' | 'archivo' | 'granola';
const AUTO = '__auto__';
const EMAIL = /[^\s<>,;]+@[^\s<>,;]+\.[^\s<>,;]+/;

/** "Ana López <ana@acme.com>", "ana@acme.com" o "Ana López" → asistente. */
export function parseAttendee(raw: string): MeetingAttendee | null {
  const text = raw.trim().replace(/[,;]+$/, '');
  if (!text) return null;
  const email = text.match(EMAIL)?.[0]?.toLowerCase() ?? null;
  const name = text.replace(/<[^>]*>/, '').replace(EMAIL, '').replace(/[<>()"]/g, '').trim();
  return { name: name || (email ? email.split('@')[0]! : text), email };
}

function nowLocalInput(): string {
  const d = new Date();
  d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatFromFile(name: string): ManualTranscriptFormat {
  const ext = name.toLowerCase().split('.').pop();
  return ext === 'vtt' ? 'vtt' : ext === 'srt' ? 'srt' : 'texto';
}

const ORIGINS: { value: Origin; title: string; hint: string; icon: ReactNode }[] = [
  { value: 'pegar', title: 'Pegar texto', hint: 'Notas, resumen o transcript', icon: <ClipboardPaste className="size-4 text-muted-foreground" /> },
  { value: 'archivo', title: 'Subir archivo', hint: '.txt .vtt .srt', icon: <Upload className="size-4 text-muted-foreground" /> },
  { value: 'granola', title: 'Exportado de Granola', hint: 'Copia y pega el resumen', icon: <IntegrationIcon name="granola" size="sm" /> },
];

/**
 * "+ Sesión manual" (modal del mock): una junta que no entró por Granola. Se pega el texto, se sube
 * un .txt/.vtt/.srt (lo lee el navegador y se manda su contenido) o se pega el resumen que da
 * Granola. El proyecto se resuelve solo por el dominio de correo de los asistentes, o se elige.
 * Paso 1 = captura; paso 2 = roz ya la guardó y la está leyendo.
 */
export function ManualSessionDialog({
  open,
  onOpenChange,
  projects,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: { id: string; name: string }[];
  onCreated: (m: MeetingSummary) => void;
}) {
  const action = useAction();
  const [origin, setOrigin] = useState<Origin>('pegar');
  const [title, setTitle] = useState('');
  const [heldAt, setHeldAt] = useState(nowLocalInput());
  const [duration, setDuration] = useState('');
  const [attendees, setAttendees] = useState<MeetingAttendee[]>([]);
  const [draft, setDraft] = useState('');
  const [projectId, setProjectId] = useState<string>(AUTO);
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ResolveProjectResponse | null>(null);
  const [dragging, setDragging] = useState(false);
  const [created, setCreated] = useState<MeetingSummary | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setOrigin('pegar');
    setTitle('');
    setHeldAt(nowLocalInput());
    setDuration('');
    setAttendees([]);
    setDraft('');
    setProjectId(AUTO);
    setContent('');
    setFileName(null);
    setResolved(null);
    setDragging(false);
    setCreated(null);
  }, [open]);

  // Proyecto por dominio: se consulta cuando cambian los correos y está en automático.
  const emails = attendees.map((a) => a.email).filter((e): e is string => !!e);
  const emailKey = emails.join(',');
  useEffect(() => {
    if (projectId !== AUTO || !emails.length) {
      setResolved(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      rozV2Api.resolveProject(emails).then((r) => alive && setResolved(r)).catch(() => alive && setResolved(null));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailKey, projectId]);

  function commitDraft() {
    const parts = draft.split(/[,;\n]/).map(parseAttendee).filter((a): a is MeetingAttendee => !!a);
    if (!parts.length) return;
    setAttendees((prev) => {
      const seen = new Set(prev.map((a) => (a.email ?? a.name).toLowerCase()));
      return [...prev, ...parts.filter((a) => !seen.has((a.email ?? a.name).toLowerCase()))].slice(0, 100);
    });
    setDraft('');
  }
  function onDraftKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault();
      commitDraft();
    } else if (e.key === 'Backspace' && !draft && attendees.length) {
      setAttendees((prev) => prev.slice(0, -1));
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setOrigin('archivo');
    setContent(text);
    setFileName(file.name);
    if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ''));
  }
  function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setDragging(false);
    void onFile(e.dataTransfer.files?.[0]);
  }

  const format: ManualTranscriptFormat = origin === 'granola' ? 'granola_resumen' : origin === 'archivo' && fileName ? formatFromFile(fileName) : 'texto';
  const tooLong = content.length > MEETING_TRANSCRIPT_MAX_CHARS;
  const durationNum = duration ? Number(duration) : null;
  const badDuration = durationNum !== null && (!Number.isFinite(durationNum) || durationNum < 1 || durationNum > 1440);
  const canSubmit = !!title.trim() && title.length <= 200 && !!heldAt && !!content.trim() && !tooLong && !badDuration;
  const busy = action.busy('create');
  const step = created ? 2 : 1;

  function submit() {
    if (!canSubmit) return;
    // Un asistente a medio escribir cuenta: es lo que la persona ve en la caja.
    const pending = draft.split(/[,;\n]/).map(parseAttendee).filter((a): a is MeetingAttendee => !!a);
    void action.run(
      'create',
      () =>
        rozV2Api.createMeeting({
          title: title.trim(),
          heldAt: new Date(heldAt).toISOString(),
          durationMin: durationNum,
          attendees: [...attendees, ...pending],
          projectId: projectId === AUTO ? null : projectId,
          format,
          content,
          fileName: origin === 'archivo' ? fileName : null,
        }),
      {
        success: false,
        error: 'No se pudo guardar la junta',
        onDone: (r) => {
          // La junta se abre detrás del modal; el paso 2 confirma lo que roz ya hizo.
          setCreated(r.meeting);
          onCreated(r.meeting);
        },
      },
    );
  }

  const resolvedMatch = resolved?.projectId ? resolved.matches.find((m) => m.projectId === resolved.projectId) : null;

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <Eyebrow color="yellow">Juntas · sin API de Granola</Eyebrow>
          <DialogTitle className="text-[22px]">Nueva sesión manual</DialogTitle>
          <DialogDescription className="sr-only">
            roz lee la junta, propone tareas y compromisos con su cita literal, y guarda las decisiones en el brain.
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <ReadingStep meeting={created} />
        ) : (
          <div className="grid gap-3.5">
            <div className="grid gap-1.5">
              <FieldLabel>¿De dónde viene?</FieldLabel>
              <div role="radiogroup" aria-label="Origen" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {ORIGINS.map((o) => {
                  const on = origin === o.value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => {
                        setOrigin(o.value);
                        if (o.value !== 'archivo') setFileName(null);
                      }}
                      className={cn(
                        'grid gap-1 rounded-lg border-[1.5px] p-2.5 text-left text-[12.5px] transition-colors duration-fast',
                        on ? 'border-orange bg-orange-soft' : 'border-border bg-card hover:bg-sidebar',
                      )}
                    >
                      <span className="flex items-center gap-2 text-[13px] font-semibold">{o.icon}{o.title}</span>
                      <span className="text-[11.5px] text-muted-foreground">{o.hint}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-2.5 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <FieldLabel htmlFor="ms-title">Título</FieldLabel>
                <Input id="ms-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Ej. Llamada con Cuvisa" />
              </div>
              <div className="grid gap-1.5">
                <FieldLabel htmlFor="ms-date">Fecha y duración</FieldLabel>
                <div className="flex gap-2">
                  <Input id="ms-date" type="datetime-local" value={heldAt} onChange={(e) => setHeldAt(e.target.value)} className="min-w-0 flex-1" />
                  <Input
                    id="ms-dur"
                    type="number"
                    min={1}
                    max={1440}
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    placeholder="min"
                    aria-label="Duración en minutos"
                    className={cn('w-[84px] shrink-0', badDuration && 'border-destructive')}
                  />
                </div>
              </div>
            </div>

            <div className="grid gap-1.5">
              <FieldLabel htmlFor="ms-att">Asistentes</FieldLabel>
              <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-card p-1.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
                {attendees.map((a, i) => {
                  // Con correo y sin nombre propio = alguien de fuera (cliente): chip azul como en el mock.
                  const external = !!a.email && a.name === a.email.split('@')[0];
                  return (
                    <span
                      key={`${a.email ?? a.name}-${i}`}
                      title={a.email ?? undefined}
                      className={cn(
                        'inline-flex max-w-full items-center gap-1.5 rounded-full py-0.5 pl-1 pr-1 text-xs font-medium',
                        external ? 'bg-blue-soft pl-2.5 text-blue-ink' : 'bg-panel',
                      )}
                    >
                      {!external && <MiniAvatar name={a.name} email={a.email} />}
                      <span className="truncate">{external ? a.email : a.name}</span>
                      {!external && a.email && <span className="truncate font-normal text-muted-foreground">{a.email}</span>}
                      <button
                        type="button"
                        aria-label={`Quitar a ${a.name}`}
                        onClick={() => setAttendees((prev) => prev.filter((_, j) => j !== i))}
                        className="grid size-4 place-items-center rounded-full opacity-60 transition-opacity hover:opacity-100"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  );
                })}
                <input
                  id="ms-att"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onDraftKey}
                  onBlur={commitDraft}
                  placeholder={attendees.length ? 'Agrega un correo…' : 'Ana López <ana@acme.com>, Enter para agregar'}
                  className="min-w-[120px] flex-1 bg-transparent px-1 py-0.5 text-[13px] outline-none placeholder:text-faint"
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <FieldLabel>Proyecto</FieldLabel>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={AUTO}>Resolver por el correo del cliente</SelectItem>
                  {projects.map((p) => <SelectItem key={p.id} value={p.id}><span className="flex items-center gap-2"><ProjectIcon id={p.id} size="xs" className="size-4" />{p.name}</span></SelectItem>)}
                </SelectContent>
              </Select>
              {projectId === AUTO && (
                <span className="text-[11.5px] text-faint">
                  {!emails.length
                    ? 'Agrega asistentes con correo para resolverlo por dominio, o elige uno.'
                    : resolvedMatch
                      ? <>El dominio {resolvedMatch.domain} resuelve el proyecto: <b className="font-semibold text-foreground">{resolvedMatch.projectName}</b></>
                      : resolved && resolved.matches.length > 1
                        ? `Varios proyectos coinciden (${resolved.matches.map((m) => m.projectName).join(', ')}): elige uno.`
                        : 'Ningún dominio coincide: quedará sin proyecto hasta que elijas uno.'}
                </span>
              )}
            </div>

            {origin !== 'archivo' && (
              <div className="grid gap-1.5">
                <FieldLabel htmlFor="ms-content">{origin === 'granola' ? 'Resumen de Granola' : 'Notas o transcript'}</FieldLabel>
                <textarea
                  id="ms-content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={origin === 'granola' ? 'Pega aquí el resumen que generó Granola…' : '[Cliente] Necesitamos que el cotizador muestre precios con IVA…'}
                  className={cn(TEXTAREA_CLS, 'min-h-[118px] resize-y font-mono text-xs leading-[1.55]', tooLong && 'border-destructive')}
                />
              </div>
            )}

            <input
              ref={fileInput}
              type="file"
              accept=".txt,.vtt,.srt,text/plain,text/vtt"
              className="hidden"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                'flex w-full flex-col items-center justify-center gap-1 rounded-lg border-[1.5px] border-dashed text-center text-[12.5px] text-muted-foreground transition-colors duration-fast',
                origin === 'archivo' ? 'px-4 py-7' : 'p-3.5',
                dragging ? 'border-orange bg-orange-soft text-foreground' : 'border-toggle-off hover:bg-sidebar',
              )}
            >
              {origin === 'archivo' && <FileText className="size-5 text-faint" />}
              {fileName ? (
                <span>
                  <span className="font-medium text-foreground">{fileName}</span> · {compact(content.length)} caracteres · cambiar
                </span>
              ) : (
                'Arrastra aquí un .txt, .vtt o .srt, o haz clic para elegirlo'
              )}
            </button>

            <div className={cn('-mt-2 text-right text-[10.5px] tabular-nums', tooLong ? 'text-destructive' : 'text-faint')}>
              {compact(content.length)} / {compact(MEETING_TRANSCRIPT_MAX_CHARS)}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex items-center gap-2.5">
            <SegmentMeter value={step} max={2} color="orange" className="w-12" />
            <span className="label-caps">Paso {step} de 2</span>
            <span className="hidden text-[11.5px] text-faint sm:inline">· Pasa por el mismo motor que Granola</span>
          </div>
          {created ? (
            <Button onClick={() => onOpenChange(false)}>Ir a la junta</Button>
          ) : (
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
              <Button variant="dark" onClick={submit} disabled={!canSubmit || busy}>{busy ? 'Guardando…' : 'Extraer tareas'}</Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Paso 2: lo que roz ya hizo con la junta y lo que sigue (la extracción corre en segundo plano). */
function ReadingStep({ meeting }: { meeting: MeetingSummary }) {
  return (
    <div className="grid gap-3.5 py-1">
      <div className="flex items-center gap-2.5">
        <span className="size-2 animate-pulse rounded-full bg-orange" />
        <b className="text-[13px] font-semibold">Leyendo la junta…</b>
      </div>
      <div className="grid gap-0.5 text-sm">
        <CheckRow>Junta guardada: {meeting.title}</CheckRow>
        <CheckRow>
          {meeting.projectName
            ? `Proyecto${meeting.projectSource === 'dominio' ? ' resuelto por dominio' : ''}: ${meeting.projectName}`
            : 'Sin proyecto: elígelo en la junta antes de aceptar candidatas'}
        </CheckRow>
        <CheckRow>
          {meeting.attendees.length} asistente{meeting.attendees.length === 1 ? '' : 's'}
          {meeting.durationMin ? ` · ${meeting.durationMin} min` : ''}
        </CheckRow>
        <CheckRow wip>Extrayendo candidatas con su cita verificada contra el texto</CheckRow>
      </div>
      <p className="text-[11.5px] text-muted-foreground">
        Las candidatas quedan en la bandeja para revisarlas antes de mandarlas a Linear. Las decisiones se guardan en el brain.
      </p>
    </div>
  );
}

function CheckRow({ children, wip }: { children: ReactNode; wip?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span
        className={cn(
          'grid size-[18px] shrink-0 place-items-center rounded-[4px] text-white',
          wip ? 'animate-pulse bg-purple-deep' : 'bg-green',
        )}
      >
        {wip ? <span className="size-1 rounded-full bg-background" /> : <Check className="size-3" strokeWidth={3} />}
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}
