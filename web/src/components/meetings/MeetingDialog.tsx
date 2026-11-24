import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DateTimeField } from '@/components/ui/date-field';
import { Input } from '@/components/ui/input';
import { NumberField } from '@/components/ui/number-field';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Eyebrow } from '@/components/brand';
import { ProjectIcon } from '@/components/avatars';
import { AttendeeChip, FieldLabel, TEXTAREA_CLS } from '@/components/meetings/meeting-ui';
import { useAction } from '@/lib/useAction';
import {
  MEETING_TRANSCRIPT_MAX_CHARS, rozV2Api,
  type ManualTranscriptFormat, type MeetingAttendee, type MeetingDetail, type MeetingSummary, type ParsedMeetingPaste,
} from '@/lib/api';
import { compact } from '@/lib/format';
import { cn } from '@/lib/utils';

const AUTO = '__auto__';
const NONE = '__none__';
const EMAIL = /[^\s<>,;]+@[^\s<>,;]+\.[^\s<>,;]+/;
const pad = (n: number) => String(n).padStart(2, '0');

/** "Ana López <ana@acme.com>", "ana@acme.com" o "Ana López" → asistente. */
function parseAttendee(raw: string): MeetingAttendee | null {
  const text = raw.trim().replace(/[,;]+$/, '');
  if (!text) return null;
  const email = text.match(EMAIL)?.[0]?.toLowerCase() ?? null;
  const name = text.replace(/<[^>]*>/, '').replace(EMAIL, '').replace(/[<>()"]/g, '').trim();
  return { name: name || (email ? email.split('@')[0]! : text), email };
}

/** Fecha → valor de DateTimeField ('YYYY-MM-DDTHH:mm', hora local del navegador). */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function nowLocalInput(): string {
  const d = new Date();
  d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
  return toLocalInput(d);
}

function formatFromFile(name: string | null): ManualTranscriptFormat {
  const ext = name?.toLowerCase().split('.').pop();
  return ext === 'vtt' ? 'vtt' : ext === 'srt' ? 'srt' : 'texto';
}

/**
 * Nueva junta (sin `meeting`) o editar sus datos (con `meeting`). Al crear, se pega el texto (lo que
 * copia Granola, notas o un transcript) y roz autollena título, fecha, duración y asistentes; todo se
 * puede corregir. Lo que la persona ya tocó no se vuelve a pisar al seguir pegando.
 */
export function MeetingDialog({
  open,
  onOpenChange,
  projects,
  meeting,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: { id: string; name: string }[];
  /** Con junta = editar (sin transcript). */
  meeting?: MeetingDetail | MeetingSummary | null;
  onSaved: (m: MeetingSummary) => void;
}) {
  const editing = !!meeting;
  const action = useAction();
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [heldAt, setHeldAt] = useState(nowLocalInput());
  const [duration, setDuration] = useState<number | null>(null);
  const [attendees, setAttendees] = useState<MeetingAttendee[]>([]);
  const [draft, setDraft] = useState('');
  const [projectId, setProjectId] = useState<string>(AUTO);
  const [parsing, setParsing] = useState(false);
  const [filled, setFilled] = useState(false);
  // Campos que la persona editó a mano: el autollenado ya no los toca.
  const touched = useRef(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    touched.current = new Set();
    setContent('');
    setFileName(null);
    setDraft('');
    setParsing(false);
    setFilled(false);
    if (meeting) {
      setTitle(meeting.title);
      setHeldAt(toLocalInput(new Date(meeting.heldAt)));
      setDuration(meeting.durationMin);
      setAttendees(meeting.attendees);
      setProjectId(meeting.projectId ?? NONE);
    } else {
      setTitle('');
      setHeldAt(nowLocalInput());
      setDuration(null);
      setAttendees([]);
      setProjectId(AUTO);
    }
  }, [open, meeting]);

  // Autollenado: se lee el texto (con pausa) y se llena lo que la persona no ha tocado.
  useEffect(() => {
    if (editing || !content.trim()) return;
    let alive = true;
    const t = setTimeout(() => {
      setParsing(true);
      rozV2Api
        .parseMeeting(content)
        .then((p) => alive && apply(p))
        .catch(() => {})
        .finally(() => alive && setParsing(false));
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, editing]);

  function apply(p: ParsedMeetingPaste) {
    const t = touched.current;
    let any = false;
    if (p.title && !t.has('title')) { setTitle(p.title); any = true; }
    if (p.date && !t.has('heldAt')) {
      setHeldAt(`${p.date}T${p.time ?? (heldAt.slice(11, 16) || '12:00')}`);
      any = true;
    }
    if (p.durationMin && !t.has('duration')) { setDuration(p.durationMin); any = true; }
    if (p.attendees.length && !t.has('attendees')) { setAttendees(p.attendees); any = true; }
    setFilled(any);
  }
  const touch = (k: string) => touched.current.add(k);

  function commitDraft() {
    const parts = draft.split(/[,;\n]/).map(parseAttendee).filter((a): a is MeetingAttendee => !!a);
    if (!parts.length) return;
    touch('attendees');
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
      touch('attendees');
      setAttendees((prev) => prev.slice(0, -1));
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setContent(await file.text());
    if (!touched.current.has('title') && !title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ''));
  }

  const tooLong = content.length > MEETING_TRANSCRIPT_MAX_CHARS;
  const canSubmit = editing ? !!title.trim() && !!heldAt : !!content.trim() && !tooLong && !!heldAt;
  const busy = action.busy('save');

  function submit() {
    if (!canSubmit) return;
    const pending = draft.split(/[,;\n]/).map(parseAttendee).filter((a): a is MeetingAttendee => !!a);
    const list = [...attendees, ...pending];
    const when = new Date(heldAt).toISOString();
    const project = projectId === AUTO || projectId === NONE ? null : projectId;
    void action.run(
      'save',
      () =>
        meeting
          ? rozV2Api.updateMeeting(meeting.id, { title: title.trim(), heldAt: when, durationMin: duration, attendees: list, projectId: project })
          : rozV2Api.createMeeting({
              title: title.trim() || null,
              heldAt: when,
              durationMin: duration,
              attendees: list,
              projectId: project,
              format: formatFromFile(fileName),
              content,
              fileName,
            }),
      {
        success: editing ? 'Junta actualizada' : 'Junta guardada',
        error: 'No se pudo guardar la junta',
        onDone: (r) => {
          onSaved(r.meeting);
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <Eyebrow color="yellow">Juntas</Eyebrow>
          <DialogTitle className="text-[22px]">{editing ? 'Editar junta' : 'Nueva junta'}</DialogTitle>
          <DialogDescription className={cn(editing && 'sr-only')}>
            Pega lo que copiaste de Granola (o tus notas, o el transcript). Título, fecha y asistentes se llenan solos.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3.5">
          {!editing && (
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="mt-content">Texto de la junta</FieldLabel>
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  <FileText className="size-3" />
                  {fileName ?? 'o sube un .txt, .vtt o .srt'}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".txt,.md,.vtt,.srt,text/plain,text/vtt,text/markdown"
                  className="hidden"
                  onChange={(e) => void onFile(e.target.files?.[0])}
                />
              </div>
              <textarea
                id="mt-content"
                autoFocus
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  if (fileName) setFileName(null);
                }}
                placeholder={'Weekly con Acme\nFri, 14 Nov 25 · Ana López, Luis Ruiz\n\nAna: arrancamos con el cotizador…'}
                className={cn(TEXTAREA_CLS, 'min-h-[180px] resize-y font-mono text-xs leading-[1.55]', tooLong && 'border-destructive')}
              />
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="inline-flex items-center gap-1.5 text-faint">
                  {parsing ? (
                    <><Loader2 className="size-3 animate-spin" /> Leyendo…</>
                  ) : filled ? (
                    <><Check className="size-3 text-green" /> Autollenado: revisa los datos de abajo</>
                  ) : null}
                </span>
                <span className={cn('tabular-nums', tooLong ? 'text-destructive' : 'text-faint')}>
                  {compact(content.length)} / {compact(MEETING_TRANSCRIPT_MAX_CHARS)}
                </span>
              </div>
            </div>
          )}

          <div className="grid gap-1.5">
            <FieldLabel htmlFor="mt-title">Título</FieldLabel>
            <Input
              id="mt-title"
              value={title}
              maxLength={200}
              onChange={(e) => { touch('title'); setTitle(e.target.value); }}
              placeholder={editing ? '' : 'Se toma del texto; si no trae, "Junta sin título"'}
            />
          </div>

          <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="grid gap-1.5">
              <FieldLabel htmlFor="mt-date">Fecha y hora</FieldLabel>
              <DateTimeField id="mt-date" value={heldAt} clearable={false} onChange={(e) => { touch('heldAt'); setHeldAt(e.target.value); }} />
            </div>
            <div className="grid gap-1.5">
              <FieldLabel htmlFor="mt-dur">Duración</FieldLabel>
              <NumberField
                id="mt-dur"
                min={1}
                max={1440}
                nullable
                value={duration}
                onCommit={(v) => { touch('duration'); setDuration(v ?? null); }}
                unit="min"
                aria-label="Duración en minutos"
                className="w-[96px]"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <FieldLabel htmlFor="mt-att">Quién estuvo</FieldLabel>
            <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-card p-1.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
              {attendees.map((a, i) => (
                <AttendeeChip
                  key={`${a.email ?? a.name}-${i}`}
                  a={a}
                  onRemove={() => { touch('attendees'); setAttendees((prev) => prev.filter((_, j) => j !== i)); }}
                />
              ))}
              <input
                id="mt-att"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onDraftKey}
                onBlur={commitDraft}
                placeholder={attendees.length ? 'Agregar…' : 'Ana López <ana@acme.com>, Enter para agregar'}
                className="min-w-[120px] flex-1 bg-transparent px-1 py-0.5 text-[13px] outline-none placeholder:text-faint"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <FieldLabel>Proyecto (opcional)</FieldLabel>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {!editing && <SelectItem value={AUTO}>Por el correo del cliente (si coincide)</SelectItem>}
                <SelectItem value={NONE}>Sin proyecto</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="flex items-center gap-2"><ProjectIcon id={p.id} size="xs" className="size-4" />{p.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button variant="dark" onClick={submit} disabled={!canSubmit || busy}>
            {busy ? <><Loader2 className="animate-spin" /> Guardando…</> : editing ? 'Guardar cambios' : 'Guardar junta'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
