import { useEffect, useRef, useState } from 'react';
import { toast } from '@/lib/toast';
import { AlertTriangle, ChevronDown, Loader2, RotateCw, Sparkles, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiGet, apiSend, type AssignClassification, type AssignmentDetailResponse, type AssignCandidate, type Ticket } from '@/lib/api';
import {
  FAILED_REASON_LABEL, REASON_LABEL, RELATION_LABEL, SOURCE_LABEL, SUGGESTION_LABEL, TIER_LABEL, URGENCY_LABEL, pointsLabel,
} from '@/lib/assign';
import { cn } from '@/lib/utils';

const OPEN = ['planificada', 'pendiente', 'en_progreso', 'revision'];
const POLL_MS = 3000;
const POLL_TRIES = 15; // ~45 s

/**
 * Asignación automática dentro del detalle de una tarea:
 *   · pendiente  → "roz está eligiendo responsable…" (y consulta hasta que termine);
 *   · asignada   → insignia + "¿Por qué?" con la clasificación, el porqué del elegido y los descartados;
 *   · escalada   → "Necesita decisión" con la sugerencia (dividir / repriorizar / backlog);
 *   · fallida    → el error y "Reintentar";
 *   · sin correr → botón "Asignar automáticamente" en una tarea abierta sin responsable.
 */
export function AutoAssignPanel({
  task,
  enabled,
  overrideLabels,
  onTaskChange,
}: {
  task: Ticket;
  enabled: boolean;
  overrideLabels: Record<string, string>;
  onTaskChange: (t: Ticket) => void;
}) {
  const state = task.autoAssign?.state ?? null;
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<AssignmentDetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const unassigned = !task.assignees?.length && !task.assignee;
  const canRun = enabled && task.source === 'native' && OPEN.includes(task.status) && unassigned && state !== 'pending';

  // Pendiente: se consulta la tarea hasta que la corrida termine (en segundo plano no hay socket).
  const latest = useRef(onTaskChange);
  latest.current = onTaskChange;
  useEffect(() => {
    if (state !== 'pending') return;
    let tries = 0;
    let alive = true;
    const tick = async () => {
      if (!alive || tries++ >= POLL_TRIES) return;
      try {
        const { task: fresh } = await apiGet<{ task: Ticket }>(`/tickets/${task.id}`);
        if (!alive) return;
        if (fresh.autoAssign?.state !== 'pending') {
          latest.current(fresh);
          return;
        }
      } catch {
        /* se reintenta en el siguiente tick */
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    let timer = setTimeout(tick, POLL_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [state, task.id]);

  // El detalle se pide al abrir "¿Por qué?", y de entrada si la tarea necesita decisión o falló
  // (ahí el detalle ES el mensaje). Se vuelve a pedir si cambia la decisión.
  const decisionId = task.autoAssign?.decisionId ?? null;
  const wantDetail = expanded || state === 'escalated' || state === 'failed';
  useEffect(() => {
    if (!wantDetail || !decisionId || state === 'pending') return;
    let alive = true;
    setLoadingDetail(true);
    apiGet<AssignmentDetailResponse>(`/tickets/${task.id}/assignment`)
      .then((r) => alive && setDetail(r))
      .catch((e) => alive && toast.error('No se pudo cargar el porqué', { description: String(e?.message ?? e) }))
      .finally(() => alive && setLoadingDetail(false));
    return () => {
      alive = false;
    };
  }, [wantDetail, decisionId, state, task.id]);

  async function run() {
    setRunning(true);
    try {
      const { task: fresh, result } = await apiSend<{ task: Ticket; result: { outcome: string } }>('POST', `/tickets/${task.id}/auto-assign`);
      onTaskChange(fresh);
      if (result.outcome === 'assigned') toast.success('Responsable asignado', { description: fresh.assignee?.name ?? undefined });
      else if (result.outcome === 'escalated') toast.warning('roz no encontró a quién asignarla', { description: 'Revisa la sugerencia.' });
      else toast.error('No se pudo asignar automáticamente');
      setExpanded(result.outcome === 'assigned');
    } catch (e: any) {
      toast.error('No se pudo asignar automáticamente', { description: String(e?.message ?? e) });
    }
    setRunning(false);
  }

  const runButton = (label: string, icon = <Sparkles className="size-3.5" />) => (
    <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-xs" onClick={run} disabled={running}>
      {running ? <Loader2 className="size-3.5 animate-spin" /> : icon} {label}
    </Button>
  );

  if (state === 'pending') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> roz está eligiendo responsable…
      </div>
    );
  }

  if (!state) return canRun ? <div>{runButton('Asignar automáticamente')}</div> : null;

  const d = detail?.decision ?? null;
  const name = (id: string | null | undefined) => (id ? detail?.devNames?.[id] ?? '—' : '—');

  if (state === 'escalated' && !unassigned) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted"
        >
          <Sparkles className="size-3" /> roz no tenía candidato · la asignó una persona
          <ChevronDown className={cn('size-3 transition-transform', expanded && 'rotate-180')} />
        </button>
        {expanded && d && (
          <div className="rounded-md border bg-card px-3 py-2 text-xs">
            <DecisionDetail decision={d} name={name} />
          </div>
        )}
      </div>
    );
  }

  if (state === 'escalated') {
    return (
      <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <AlertTriangle className="size-3.5 text-warning" /> Necesita decisión
          {task.autoAssign?.suggestion && (
            <span className="font-normal text-muted-foreground">· {SUGGESTION_LABEL[task.autoAssign.suggestion] ?? task.autoAssign.suggestion}</span>
          )}
        </div>
        {loadingDetail && !d ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : (
          <ul className="space-y-1">
            {(d?.suggestion?.options ?? []).map((o, i) => (
              <li key={i} className={cn(i === 0 ? 'text-foreground' : 'text-muted-foreground')}>
                <span className="font-medium">{SUGGESTION_LABEL[o.kind] ?? o.kind}:</span> {o.detail}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {canRun && runButton('Reintentar', <RotateCw className="size-3.5" />)}
          <button type="button" className="text-muted-foreground underline-offset-2 hover:underline" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Ocultar detalle' : 'Ver candidatos'}
          </button>
        </div>
        {expanded && d && <DecisionDetail decision={d} name={name} />}
      </div>
    );
  }

  if (state === 'failed') {
    return (
      <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <XCircle className="size-3.5 text-destructive" /> No se pudo asignar automáticamente
        </div>
        {d && (
          <p className="text-muted-foreground">
            {FAILED_REASON_LABEL[d.reason ?? ''] ?? d.reason}
            {d.error ? ` — ${d.error}` : ''}
          </p>
        )}
        {canRun && runButton('Reintentar', <RotateCw className="size-3.5" />)}
      </div>
    );
  }

  // asignada / corregida
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
      >
        <Sparkles className="size-3" />
        {state === 'overridden' ? 'roz eligió a otra persona · corregida' : 'Asignada automáticamente'}
        <ChevronDown className={cn('size-3 transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded &&
        (loadingDetail && !d ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : d ? (
          <div className="rounded-md border bg-card px-3 py-2 text-xs">
            {d.overriddenAt && (
              <p className="mb-2 rounded bg-muted px-2 py-1">
                Cambiada de <span className="font-medium">{name(d.chosenDevId)}</span> a{' '}
                <span className="font-medium">{d.overrideDevId ? name(d.overrideDevId) : 'nadie'}</span> ·{' '}
                {overrideLabels[d.overrideCategory ?? ''] ?? d.overrideCategory}
                {d.overrideNote ? ` — “${d.overrideNote}”` : ''}
              </p>
            )}
            <DecisionDetail decision={d} name={name} />
          </div>
        ) : null)}
    </div>
  );
}

export function Row({ label, children, source }: { label: string; children: React.ReactNode; source?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {source && <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{SOURCE_LABEL[source] ?? source}</span>}
    </div>
  );
}

export function CapacityBar({ c }: { c: NonNullable<AssignCandidate['capacity']> }) {
  const max = Math.max(c.capacityHours, c.loadHours + c.effectiveHours, 1);
  const pct = (h: number) => `${Math.min(100, (h / max) * 100)}%`;
  return (
    <div className="space-y-1">
      <div className="relative h-2 overflow-hidden rounded-full bg-muted">
        <div className="absolute inset-y-0 left-0 bg-muted-foreground/40" style={{ width: pct(c.loadHours) }} />
        <div
          className={cn('absolute inset-y-0', c.fits ? 'bg-primary' : 'bg-destructive')}
          style={{ left: pct(c.loadHours), width: pct(c.effectiveHours) }}
        />
        <div className="absolute inset-y-0 w-px bg-foreground" style={{ left: pct(c.limitHours) }} title="85%" />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {c.loadHours} h de carga + {c.effectiveHours} h de esta tarea · techo {c.limitHours} h (85% de {c.capacityHours} h en {c.horizonDays} días hábiles)
        {c.unestimated > 0 && ` · ${c.unestimated} sin estimar (cuentan 3 pts)`}
      </p>
    </div>
  );
}

/** "Cómo la entendió roz": tipo de solución, skills, tamaño, urgencia y fecha, con quién dio cada dato. */
export function ClassificationRows({ c }: { c: AssignClassification }) {
  const t = c.solutionType;
  return (
    <>
      {c.typeState !== undefined && (
        <Row label="Tipo" source={c.typeSource}>
          {t ? (
            <span className="font-medium">{t.name}</span>
          ) : c.typeState === 'ninguno' ? (
            'no es trabajo de ningún tipo de la tabla'
          ) : (
            'no está claro'
          )}
        </Row>
      )}
      <Row label="Skill" source={c.skillSource}>
        {c.skill ? (
          <>
            <span className="font-medium">{c.skill.tag}</span> · pide nivel {c.skill.minLevel}+
            {t?.module && <span className="text-muted-foreground"> (la del módulo que toca)</span>}
          </>
        ) : c.moduleOpen ? (
          <>
            abierta{' '}
            <span className="text-muted-foreground">
              — no es claramente solo interfaz (puede tocar el backend)
              {c.signals?.jevSkill ? ` (roz pensó en ${c.signals.jevSkill})` : ''}: va primero con quien lleva el proyecto
            </span>
          </>
        ) : c.skillState === 'incierta' ? (
          'no está claro'
        ) : (
          'no pide una skill del catálogo'
        )}
      </Row>
      {c.secondarySkill && (
        <Row label="Ayuda saber">
          <span className="font-medium">{c.secondarySkill.tag}</span>{' '}
          <span className="text-muted-foreground">(no excluye a nadie; desempata)</span>
        </Row>
      )}
      <Row label="Tamaño" source={c.pointsSource}>
        {pointsLabel(c.points)}
        {c.signals?.sizeSplit ? ' (roz dudó)' : ''}
        {c.signals?.sizeRaisedToMin && t ? (
          <span className="text-muted-foreground"> · roz leyó {c.signals.jevPoints} pts; el mínimo de este tipo es {t.sizeMin}</span>
        ) : null}
        {c.signals?.sizeAboveTypical && t ? (
          <span className="text-muted-foreground"> · más grande de lo típico ({t.sizeMin}–{t.sizeMax} pts): ¿conviene dividirla?</span>
        ) : null}
      </Row>
      <Row label="Urgencia">
        {URGENCY_LABEL[c.urgency] ?? c.urgency} <span className="text-muted-foreground">— {c.urgencyWhy}</span>
      </Row>
      {c.deadline && (
        <Row label="Fecha límite">
          {c.dueDate ?? `${c.deadline} (sin fecha: horizonte por defecto)`}
          {c.horizonDays ? <span className="text-muted-foreground"> · {c.horizonDays} días hábiles</span> : null}
        </Row>
      )}
    </>
  );
}

/** Por qué el elegido: nivel del orden, relación, horas efectivas, desempate y su capacidad. */
export function ChosenWhy({
  chosen,
  tieBreaks,
  name,
}: {
  chosen: AssignCandidate;
  tieBreaks: { promotedDevId: string; overDevIds: string[]; reviewerDevId: string }[];
  name: (id: string | null | undefined) => string;
}) {
  const tie = tieBreaks.find((t) => t.promotedDevId === chosen.devId);
  return (
    <>
      <p>
        {chosen.tier ? TIER_LABEL[chosen.tier] : '—'} · {RELATION_LABEL[chosen.relation]} (×{chosen.multiplier}) →{' '}
        {chosen.effectiveHours} h efectivas
        {chosen.skillLevel !== null && <> · nivel {chosen.skillLevel}</>}
        {chosen.secondaryLevel ? <> · {chosen.secondaryLevel} en la secundaria</> : null}
      </p>
      {tie && (
        <p className="text-muted-foreground">
          Ganó por desempate sobre {tie.overDevIds.map(name).join(', ')} (tarea chica y no urgente). Revisor sugerido:{' '}
          <span className="font-medium text-foreground">{name(tie.reviewerDevId)}</span>.
        </p>
      )}
      {chosen.capacity && <CapacityBar c={chosen.capacity} />}
    </>
  );
}

/** Descartados con TODOS sus motivos. */
export function DiscardedList({ candidates }: { candidates: AssignCandidate[] }) {
  return (
    <ul className="space-y-1">
      {candidates.map((x) => (
        <li key={x.devId}>
          <span className="font-medium">{x.name}</span>{' '}
          <span className="text-muted-foreground">— {x.reasons.map((r) => `${REASON_LABEL[r.code] ?? r.code}: ${r.detail}`).join(' · ')}</span>
        </li>
      ))}
    </ul>
  );
}

function DecisionDetail({ decision: d, name }: { decision: NonNullable<AssignmentDetailResponse['decision']>; name: (id: string | null | undefined) => string }) {
  const c = d.classification;
  const chosen = d.candidates.find((x) => x.status === 'elegido') ?? null;
  const alternatives = d.candidates.filter((x) => x.status === 'alternativa');
  const discarded = d.candidates.filter((x) => x.status === 'descartado');

  return (
    <div className="space-y-3">
      {c && (
        <section className="space-y-1">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Cómo la entendió roz</h4>
          <ClassificationRows c={c} />
        </section>
      )}

      {chosen && (
        <section className="space-y-1.5">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Por qué {chosen.name}</h4>
          <ChosenWhy chosen={chosen} tieBreaks={d.tieBreaks} name={name} />
        </section>
      )}

      {alternatives.length > 0 && (
        <section className="space-y-1">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">También cabían</h4>
          <p>{alternatives.map((a) => a.name).join(', ')}</p>
        </section>
      )}

      {discarded.length > 0 && (
        <section className="space-y-1">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Descartados</h4>
          <DiscardedList candidates={discarded} />
        </section>
      )}

      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer select-none">
          {d.jevModel ?? 'sin modelo'} · política {d.policyVersion}
          {d.questionsVersion ? ` · preguntas ${d.questionsVersion}` : ''} · ver lo que se envió a Jev
        </summary>
        <pre className="scroll-thin mt-1 max-h-56 overflow-auto rounded bg-muted p-2 text-[10px] leading-snug">
          {JSON.stringify(d.request, null, 2)}
        </pre>
      </details>
    </div>
  );
}
