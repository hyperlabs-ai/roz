import { useEffect, useState } from 'react';
import { Check, Copy, GitBranch, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/brand';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Markdown } from '@/components/Markdown';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import type { AgentPlanSummary, PlanHumanAction, RunnerPullResponse } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Texto de cada acción: lo que hace, en una frase, antes de confirmar. */
export const ACTION_COPY: Record<PlanHumanAction, { label: string; title: string; body: string; confirm: string; danger?: boolean }> = {
  aprobar: {
    label: 'Aprobar',
    title: 'Aprobar el plan',
    body: 'El plan vuelve a la cola en fase de implementación: el agente lo implementa en la PC de su dueño hasta abrir la PR.',
    confirm: 'Aprobar',
  },
  pedir_cambios: {
    label: 'Pedir cambios',
    title: 'Pedir cambios al plan',
    body: 'El agente vuelve a planear con tus comentarios. Lo que escribas le llega tal cual.',
    confirm: 'Pedir cambios',
  },
  reclamar: {
    label: 'Reclamar',
    title: 'Reclamar el plan',
    body: 'Pasa a tu cola y se te asigna el issue en Linear. Queda registrado como corrección de la asignación ("reclamado").',
    confirm: 'Reclamarlo',
  },
  jalar: {
    label: 'Jalar',
    title: 'Implementarlo tú',
    body: 'El agente no correrá este plan. roz te da la rama (con el ID de Linear) y el PLAN.md para que trabajes sobre ellos.',
    confirm: 'Jalar',
  },
  soltar: {
    label: 'Soltar',
    title: 'Soltar el plan',
    body: 'Queda marcado como reclamable para que alguien más lo tome. Si lo habías jalado, regresa a la cola del agente.',
    confirm: 'Soltar',
  },
  cancelar: {
    label: 'Cancelar',
    title: 'Cancelar el plan',
    body: 'El agente deja de trabajar en él. El issue en Linear no se toca.',
    confirm: 'Cancelar plan',
    danger: true,
  },
};

/**
 * Confirmación de una acción sobre un plan. Pedir cambios exige comentarios; reclamar y cancelar
 * aceptan una nota opcional. El resto es solo "¿seguro?".
 */
export function PlanActionDialog({
  plan,
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  plan: AgentPlanSummary | null;
  action: PlanHumanAction | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (text: string | null) => void;
}) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (action) setText('');
  }, [action, plan?.id]);
  if (!plan || !action) return null;
  const copy = ACTION_COPY[action];
  const needsText = action === 'pedir_cambios';
  const takesText = needsText || action === 'reclamar' || action === 'cancelar';
  const tooLong = text.length > 4000;
  const canConfirm = (!needsText || text.trim().length > 0) && !tooLong;

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <Eyebrow color={copy.danger ? 'red' : action === 'aprobar' ? 'green' : 'purple-deep'}>Agentes · {copy.label.toLowerCase()}</Eyebrow>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-faint">{plan.identifier}</span> · {plan.issue.name}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{copy.body}</p>
        {action === 'reclamar' && (
          <p className="text-xs text-muted-foreground">
            Hoy es de <span className="font-medium text-foreground">{plan.owner.name}</span>.
          </p>
        )}
        {takesText && (
          <Field
            label={needsText ? 'Qué debe cambiar' : action === 'reclamar' ? 'Nota' : 'Motivo'}
            htmlFor="pa-text"
            required={needsText}
            optional={!needsText}
            aside={needsText ? <span className={cn('tabular-nums', tooLong && 'font-medium text-red')}>{text.length} / 4000</span> : undefined}
            error={tooLong ? 'Pasa de 4000 caracteres: recórtalo.' : undefined}
          >
            <Textarea
              id="pa-text"
              autoFocus
              rows={needsText ? 4 : 2}
              maxRows={12}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={needsText ? 'Separa la migración en su propio paso; no toques el webhook…' : ''}
              invalid={tooLong}
            />
          </Field>
        )}
        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Volver</Button>
          <Button
            variant={copy.danger ? 'destructive' : action === 'aprobar' ? 'default' : 'dark'}
            onClick={() => onConfirm(takesText ? text.trim() || null : null)}
            disabled={!canConfirm || busy}
          >
            {busy && <Loader2 className="animate-spin" />}
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Después de jalar: la rama y el PLAN.md, listos para copiar. */
export function PullResultDialog({ pull, onClose }: { pull: RunnerPullResponse | null; onClose: () => void }) {
  if (!pull) return null;
  const git = `git fetch origin && git switch -c ${pull.branch} origin/${pull.baseBranch ?? 'main'}`;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader eyebrow="Agentes · plan">
          <DialogTitle className="flex items-center gap-2"><GitBranch className="size-4" /> {pull.identifier} es tuyo</DialogTitle>
          <DialogDescription>{pull.issue.title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <CopyLine label="Con roz-runner (crea el worktree y escribe PLAN.md)" value={`roz-runner pull ${pull.identifier}`} />
          <CopyLine label={`O a mano${pull.repo ? ` en ${pull.repo}` : ''}`} value={git} />
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="label-caps">PLAN.md</span>
              <CopyButton value={pull.planMd} />
            </div>
            <div className="max-h-80 overflow-y-auto rounded-lg border bg-sidebar p-3">
              <Markdown>{pull.planMd}</Markdown>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Listo</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CopyLine({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2 rounded-lg border bg-sidebar px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

export function CopyButton({ value, label = 'Copiar' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 gap-1 px-2 text-xs"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check className="size-3.5 text-green" /> : <Copy className="size-3.5" />}
      {done ? 'Copiado' : label}
    </Button>
  );
}
