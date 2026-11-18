// Diálogos de la Bandeja: escribir o responder un mensaje, abrir una solicitud y resolverla.
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { invalidate } from '@/lib/store';
import { useAction } from '@/lib/useAction';
import { ZEUS_REQUEST_KINDS, zeusApi, type ZeusMe, type ZeusMessage, type ZeusRequest, type ZeusRequestKind } from '@/lib/zeus';
import { INBOX_KEY, ME_KEY, useZeusGraph, useZeusOrg } from './hooks';
import { KIND_META, REQUEST_KIND_LABEL } from './zeus-ui';

export function refreshInbox(): void {
  invalidate(INBOX_KEY);
  invalidate(ME_KEY);
}

export function ComposeDialog({
  open,
  me,
  replyTo,
  onClose,
}: {
  open: boolean;
  me: ZeusMe | null;
  replyTo: ZeusMessage | null;
  onClose: () => void;
}) {
  const org = useZeusOrg();
  const act = useAction();
  const [to, setTo] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  // Encargo = trabajo que la otra persona debe hacer: queda pendiente en su bandeja hasta cerrarlo.
  const [kind, setKind] = useState<'message' | 'task'>('message');
  useEffect(() => {
    if (!open) return;
    setTo(replyTo?.fromDevId ?? null);
    setSubject(replyTo ? (replyTo.subject ? (/^re:/i.test(replyTo.subject) ? replyTo.subject : `Re: ${replyTo.subject}`) : '') : '');
    setBody('');
    setKind('message');
  }, [open, replyTo]);

  const options = useMemo<ComboboxOption[]>(
    () =>
      (org.data?.members ?? [])
        .filter((m) => m.active && m.devId !== me?.devId)
        .map((m) => ({ value: m.devId, label: m.name, hint: m.role, keywords: m.email ?? '' }))
        .sort((a, b) => a.label.localeCompare(b.label, 'es')),
    [org.data, me?.devId],
  );
  const busy = act.busy('send-message');
  const task = kind === 'task';
  const canSend = !!to && body.trim().length > 0 && (!task || subject.trim().length > 0) && !busy;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader eyebrow={replyTo ? 'Zeus · responder' : 'Zeus · mensaje'}>
          <DialogTitle>{replyTo ? `Responder a ${replyTo.fromName}` : task ? 'Nuevo encargo' : 'Nuevo mensaje'}</DialogTitle>
          <DialogDescription>
            {task
              ? 'Queda como pendiente en su bandeja (y su Claude lo ve por MCP) hasta que lo marque hecho o lo rechace. Tú ves en qué va.'
              : 'Le llega a su bandeja y su agente lo ve por MCP la próxima vez que consulte zeus.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
          <Field label="Para" htmlFor="zm-to" required error={org.error && !org.data ? 'No se pudo cargar el equipo.' : undefined}>
            <Combobox id="zm-to" value={to} onChange={setTo} options={options} placeholder={org.loading ? 'Cargando…' : 'Elegir a alguien'} searchPlaceholder="Buscar persona…" emptyText="Nadie con ese nombre" />
          </Field>
          {!replyTo && (
            <Field label="Tipo" htmlFor="zm-kind">
              <Select value={kind} onValueChange={(v) => setKind(v as 'message' | 'task')}>
                <SelectTrigger id="zm-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="message">Mensaje</SelectItem>
                  <SelectItem value="task">Encargo</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>
        <Field label={task ? 'Qué tiene que hacer' : 'Asunto'} htmlFor="zm-subject" optional={!task} required={task}>
          <Input id="zm-subject" value={subject} maxLength={160} onChange={(e) => setSubject(e.target.value)} placeholder={task ? 'Implementar el webhook de pagos' : undefined} />
        </Field>
        <Field label={task ? 'Cómo y con qué criterio' : 'Mensaje'} htmlFor="zm-body" required>
          <Textarea id="zm-body" rows={4} maxRows={12} value={body} onChange={(e) => setBody(e.target.value)} autoFocus={!!replyTo} />
        </Field>
        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button
            disabled={!canSend}
            onClick={() =>
              void act.run(
                'send-message',
                () =>
                  zeusApi.sendMessage({
                    toDevId: to!,
                    body: body.trim(),
                    kind,
                    ...(subject.trim() ? { subject: subject.trim() } : {}),
                    ...(replyTo?.ref ? { ref: replyTo.ref } : {}),
                  }),
                { success: task ? 'Encargo enviado' : 'Mensaje enviado', error: 'No se pudo enviar', onDone: () => { refreshInbox(); onClose(); } },
              )
            }
          >
            {busy ? <Loader2 className="animate-spin" /> : <Send />}
            Enviar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- encargos y planes

const STATUS_COPY: Record<'accepted' | 'changes_requested' | 'declined' | 'done' | 'cancelled', { title: string; button: string; note: string; required: boolean }> = {
  accepted: { title: 'Aceptar', button: 'Aceptar', note: 'Algo que deba saber quien lo mandó (opcional)', required: false },
  changes_requested: { title: 'Pedir ajustes', button: 'Pedir ajustes', note: 'Qué hay que cambiar para que lo aceptes', required: true },
  declined: { title: 'Rechazar', button: 'Rechazar', note: 'Por qué no se hará', required: true },
  done: { title: 'Marcar como hecho', button: 'Marcar hecho', note: 'Qué quedó, dónde verlo (opcional)', required: false },
  cancelled: { title: 'Retirar', button: 'Retirar', note: 'Por qué ya no hace falta (opcional)', required: false },
};

export type StatusAction = keyof typeof STATUS_COPY;

/** Cambiar el estado de un encargo o plan, con nota. A la otra persona le llega aviso. */
export function StatusDialog({ target, onClose }: { target: { message: ZeusMessage; status: StatusAction } | null; onClose: () => void }) {
  const act = useAction();
  const [note, setNote] = useState('');
  useEffect(() => {
    if (target) setNote('');
  }, [target]);
  if (!target) return null;
  const { message, status } = target;
  const copy = STATUS_COPY[status];
  const busy = act.busy(`status:${message.id}`);
  const what = message.kind === 'plan' ? 'el plan' : 'el encargo';
  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader eyebrow={`Zeus · ${message.kind === 'plan' ? 'plan' : 'encargo'}`}>
          <DialogTitle>{copy.title} {what}</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{status === 'cancelled' ? message.toName : message.fromName}</span> · {message.subject ?? '(sin título)'}
          </DialogDescription>
        </DialogHeader>
        <Field label="Nota" htmlFor="zs-note" optional={!copy.required} required={copy.required}>
          <Textarea id="zs-note" autoFocus rows={3} maxRows={10} value={note} onChange={(e) => setNote(e.target.value)} placeholder={copy.note} />
        </Field>
        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Volver</Button>
          <Button
            variant={status === 'declined' ? 'destructive' : 'default'}
            disabled={busy || (copy.required && !note.trim())}
            onClick={() =>
              void act.run(`status:${message.id}`, () => zeusApi.setMessageStatus(message.id, status, note.trim() || undefined), {
                success: 'Listo, se le avisó',
                error: 'No se pudo cambiar el estado',
                onDone: onClose,
                onSettled: refreshInbox,
              })
            }
          >
            {busy && <Loader2 className="animate-spin" />}
            {copy.button}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** El plan completo, con sus versiones anteriores si lo ajustaron. */
export function PlanDialog({ messageId, onClose }: { messageId: string | null; onClose: () => void }) {
  const [data, setData] = useState<(ZeusMessage & { history: ZeusMessage[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    setError(null);
    setShown(null);
    if (!messageId) return;
    let live = true;
    zeusApi
      .message(messageId)
      .then((m) => live && setData(m))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'No se pudo cargar'));
    return () => {
      live = false;
    };
  }, [messageId]);
  if (!messageId) return null;
  const versions = data ? [data, ...(data.history ?? [])] : [];
  const current = versions.find((v) => v.id === (shown ?? data?.id)) ?? data;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader eyebrow={data ? `Zeus · plan de ${data.fromName}${data.projectKey ? ` · ${data.projectKey}` : ''}` : 'Zeus · plan'}>
          <DialogTitle>{data?.subject ?? 'Cargando…'}</DialogTitle>
          <DialogDescription>Para implementarlo con Claude: pídele que revise tu bandeja de zeus (o /mcp__zeus__pendientes) y te preguntará si lo implementa o lo ajusta.</DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-red">{error}</p>}
        {versions.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {versions.map((v, i) => (
              <Button key={v.id} size="sm" variant={(shown ?? data?.id) === v.id ? 'default' : 'secondary'} onClick={() => setShown(v.id)}>
                {i === 0 ? 'Versión actual' : `Versión ${versions.length - i}`}
              </Button>
            ))}
          </div>
        )}
        {current && (
          <pre className="scroll-thin max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel p-3 font-mono text-[12.5px] leading-relaxed">{current.body}</pre>
        )}
        {current?.statusNote && (
          <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Nota:</span> {current.statusNote}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

const NO_RESOURCE = '__ninguno__';

export function NewRequestDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (r: ZeusRequest) => void }) {
  const graph = useZeusGraph(null);
  const act = useAction();
  const [kind, setKind] = useState<ZeusRequestKind>('access');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [resource, setResource] = useState<string>(NO_RESOURCE);
  useEffect(() => {
    if (!open) return;
    setKind('access');
    setTitle('');
    setDetail('');
    setResource(NO_RESOURCE);
  }, [open]);

  const options = useMemo<ComboboxOption[]>(
    () => [
      { value: NO_RESOURCE, label: 'Ninguno en particular' },
      ...(graph.data?.nodes ?? [])
        // Lo que se puede pedir: un recurso, un proyecto, un repo o un documento. No una persona.
        .filter((n) => n.kind !== 'dev' && n.kind !== 'runner' && n.status !== 'archived')
        .map((n) => ({ value: n.ref, label: n.title, hint: KIND_META[n.kind]?.label ?? n.kind, keywords: n.summary }))
        .sort((a, b) => a.label.localeCompare(b.label, 'es')),
    ],
    [graph.data],
  );
  const busy = act.busy('new-request');

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader eyebrow="Zeus · solicitud">
          <DialogTitle>Nueva solicitud</DialogTitle>
          <DialogDescription>
            No hace falta saber a quién pedírselo: zeus la manda al dueño del recurso; si no tiene, al líder del proyecto, a tu jefe directo o a un admin.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[150px_1fr]">
          <Field label="Tipo" htmlFor="zr-kind">
            <Select value={kind} onValueChange={(v) => setKind(v as ZeusRequestKind)}>
              <SelectTrigger id="zr-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ZEUS_REQUEST_KINDS.map((k) => <SelectItem key={k} value={k}>{REQUEST_KIND_LABEL[k]}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Qué necesitas" htmlFor="zr-title" required>
            <Input id="zr-title" autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Acceso de lectura a la base de staging" />
          </Field>
        </div>
        <Field label="Sobre qué" htmlFor="zr-resource" hint="Si eliges un recurso o proyecto, la solicitud va directo con su dueño." optional>
          <Combobox id="zr-resource" value={resource} onChange={setResource} options={options} searchFrom={0} searchPlaceholder="Buscar en zeus…" emptyText="Nada con ese nombre" />
        </Field>
        <Field label="Detalle" htmlFor="zr-detail" optional>
          <Textarea id="zr-detail" rows={3} maxRows={10} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Para qué lo necesitas y por cuánto tiempo" />
        </Field>
        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button
            disabled={!title.trim() || busy}
            onClick={() =>
              void act.run(
                'new-request',
                () => zeusApi.createRequest({ kind, title: title.trim(), ...(detail.trim() ? { detail: detail.trim() } : {}), ...(resource !== NO_RESOURCE ? { resourceRef: resource } : {}) }),
                {
                  // El aviso dice a quién se le envió: es lo que la persona quiere saber al terminar.
                  success: false,
                  error: 'No se pudo abrir la solicitud',
                  onDone: (r) => { refreshInbox(); onCreated(r); onClose(); },
                },
              )
            }
          >
            {busy && <Loader2 className="animate-spin" />}
            Enviar solicitud
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ResolveDialog({ target, onClose }: { target: { request: ZeusRequest; decision: 'approved' | 'denied' } | null; onClose: () => void }) {
  const act = useAction();
  const [note, setNote] = useState('');
  useEffect(() => {
    if (target) setNote('');
  }, [target]);
  if (!target) return null;
  const { request, decision } = target;
  const approve = decision === 'approved';
  const busy = act.busy(`resolve:${request.id}`);
  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader eyebrow={approve ? 'Zeus · aprobar' : 'Zeus · denegar'}>
          <DialogTitle>{approve ? 'Aprobar la solicitud' : 'Denegar la solicitud'}</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{request.requesterName}</span> · {request.title}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {approve
            ? 'Queda registrada como aprobada y se le avisa a quien la pidió. Zeus no ejecuta el cambio: si hace falta dar el acceso en otro sistema, eso lo haces tú.'
            : 'Queda registrada como denegada y se le avisa a quien la pidió. Dile por qué.'}
        </p>
        <Field label="Nota" htmlFor="zr-note" optional={approve} required={!approve}>
          <Textarea id="zr-note" autoFocus rows={3} maxRows={8} value={note} onChange={(e) => setNote(e.target.value)} placeholder={approve ? 'Listo, ya tienes acceso hasta el viernes' : 'Por qué no procede'} />
        </Field>
        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Volver</Button>
          <Button
            variant={approve ? 'default' : 'destructive'}
            disabled={busy || (!approve && !note.trim())}
            onClick={() =>
              void act.run(`resolve:${request.id}`, () => zeusApi.resolveRequest(request.id, decision, note.trim() || undefined), {
                success: approve ? 'Solicitud aprobada' : 'Solicitud denegada',
                error: 'No se pudo resolver',
                onDone: onClose,
                // También si falla (otra persona la resolvió antes): la bandeja se pone al día.
                onSettled: refreshInbox,
              })
            }
          >
            {busy && <Loader2 className="animate-spin" />}
            {approve ? 'Aprobar' : 'Denegar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
