// Celdas de la tabla de capacidad. Una por columna, cada una exportada por separado: la tabla no
// es más que estas piezas puestas en fila, así que reordenar columnas o reusar una celda en otra
// pantalla (p.ej. el perfil del dev) no obliga a tocar la página.
//
// Todas editan EN SITIO y guardan al salir del campo, no en cada tecla: son campos de texto largo
// y un PATCH por pulsación llenaría la red de peticiones que se pisan entre sí.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { UserAvatar, SkillChip, ProgressBar } from '@/components/bits';
import {
  ROLE_LABEL, ROLE_OPTIONS, COMMITMENT_OPTIONS, COMMITMENT_SHORT, LOAD_STATE,
} from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { CapacityAssignment, CapacityDev, CapacityProject } from '@/lib/api';

const NONE = '__none__'; // los Select de Radix no aceptan value=""

export interface CapacityActions {
  patchDev: (devId: string, patch: Record<string, unknown>) => Promise<void>;
  addAssignment: (devId: string, body: Record<string, unknown>) => Promise<void>;
  patchAssignment: (id: string, body: Record<string, unknown>) => Promise<void>;
  removeAssignment: (id: string) => Promise<void>;
  /** false = solo lectura (no admin). Las celdas se pintan igual, pero sin controles. */
  canEdit: boolean;
}

// ---------------------------------------------------------------- texto editable

/**
 * Texto que se edita donde está. En reposo es un botón con el valor; al activarse, un campo ya
 * enfocado y con el cursor al final.
 *
 * Guarda al salir (blur) y con Enter — con Esc se descarta. En modo `multiline` Enter hace salto
 * de línea y se guarda solo al salir: en un campo de varias líneas, que Enter guardara haría
 * imposible escribir el segundo renglón.
 */
export function InlineText({
  value, onSave, placeholder = '—', multiline, className, disabled,
}: {
  value: string | null;
  onSave: (v: string | null) => void;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  useEffect(() => { if (!editing) setDraft(value ?? ''); }, [value, editing]);
  useEffect(() => {
    if (!editing || !ref.current) return;
    ref.current.focus();
    ref.current.setSelectionRange(ref.current.value.length, ref.current.value.length);
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next === (value ?? '').trim()) return;  // sin cambio: ni PATCH ni toast
    onSave(next || null);
  };

  if (disabled) {
    return (
      <p className={cn('whitespace-pre-line text-[13px]', !value && 'text-muted-foreground/60', className)}>
        {value || placeholder}
      </p>
    );
  }

  if (editing) {
    const common = {
      ref,
      value: draft,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
      onBlur: commit,
      className: cn(
        'w-full rounded-md border border-input bg-background px-1.5 py-1 text-[13px] outline-none ring-1 ring-ring',
        className,
      ),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { setDraft(value ?? ''); setEditing(false); }
        if (e.key === 'Enter' && !multiline) { e.preventDefault(); commit(); }
      },
    };
    return multiline ? <textarea {...common} rows={3} /> : <input {...common} />;
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={cn(
        'w-full rounded-md px-1.5 py-1 text-left text-[13px] transition-colors hover:bg-accent',
        !value && 'text-muted-foreground/60',
        className,
      )}
    >
      <span className="whitespace-pre-line">{value || placeholder}</span>
    </button>
  );
}

// ---------------------------------------------------------------- Integrante

export function MemberCell({ dev }: { dev: CapacityDev }) {
  return (
    <div className="flex items-center gap-2">
      <UserAvatar url={dev.avatarUrl} name={dev.name} className="size-7 shrink-0" />
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium">{dev.name}</p>
        {!dev.active && <p className="text-[11px] text-muted-foreground">Inactivo</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Perfil / Rol

/**
 * Puesto, dedicación, horas y el matiz libre.
 *
 * Las horas enseñan el default de su dedicación cuando no hay valor propio, y vaciar el campo
 * vuelve a heredarlo — por eso el placeholder dice el número heredado en vez de "—": si no, no hay
 * forma de saber si 20 h es un dato o una suposición.
 */
export function ProfileCell({ dev, actions }: { dev: CapacityDev; actions: CapacityActions }) {
  const { canEdit, patchDev } = actions;
  const inherited = dev.weeklyHoursOverride == null;

  return (
    <div className="space-y-1.5">
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-1">
          <Select value={dev.role} onValueChange={(v) => patchDev(dev.id, { role: v })}>
            <SelectTrigger className="h-7 w-auto gap-1 px-1.5 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ROLE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={dev.commitment} onValueChange={(v) => patchDev(dev.id, { commitment: v })}>
            <SelectTrigger className="h-7 w-auto gap-1 px-1.5 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {COMMITMENT_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant="secondary" className="text-[11px]">{ROLE_LABEL[dev.role] ?? dev.role}</Badge>
          <Badge variant="outline" className="text-[11px]">{COMMITMENT_SHORT[dev.commitment]}</Badge>
        </div>
      )}

      <InlineText
        value={dev.profile}
        placeholder="Perfil (ej. Dev Junior / Frontend)"
        disabled={!canEdit}
        onSave={(v) => patchDev(dev.id, { profile: v })}
        className="text-muted-foreground"
      />

      <div className="flex items-center gap-1 px-1.5">
        <HoursInput
          hours={dev.weeklyHours}
          inherited={inherited}
          disabled={!canEdit}
          onSave={(v) => patchDev(dev.id, { weeklyHours: v })}
        />
        <span className="text-[11px] text-muted-foreground">h/sem{inherited ? ' (por dedicación)' : ''}</span>
      </div>
    </div>
  );
}

function HoursInput({ hours, inherited, disabled, onSave }: {
  hours: number;
  inherited: boolean;
  disabled?: boolean;
  onSave: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState(String(hours));
  useEffect(() => { setDraft(String(hours)); }, [hours]);

  if (disabled) return <span className={cn('text-[11px] font-medium', inherited && 'text-muted-foreground')}>{hours}</span>;

  const commit = () => {
    const raw = draft.trim();
    // Vacío = volver a heredar. Es la única forma de deshacer un valor propio sin borrar la fila.
    if (!raw) return onSave(null);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || n > 80) { setDraft(String(hours)); return; }
    if (n === hours && !inherited) return;
    onSave(Math.trunc(n));
  };

  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      inputMode="numeric"
      aria-label="Horas por semana"
      title={inherited ? 'Heredadas de su dedicación. Escribe un número para fijarlas; vacía el campo para volver a heredar.' : 'Horas propias. Vacía el campo para volver a heredar.'}
      className={cn(
        'w-9 rounded border border-transparent bg-transparent px-1 text-center text-[11px] font-medium transition-colors hover:border-input focus:border-input focus:outline-none',
        inherited && 'text-muted-foreground',
      )}
    />
  );
}

// ---------------------------------------------------------------- Proyectos

/**
 * Una asignación: proyecto, repo (si el proyecto tiene más de uno), enfoque y cuánta capacidad se
 * lleva.
 *
 * El selector de repo solo aparece cuando el proyecto tiene varios. Es el caso Hyperflow —un
 * proyecto, varios repos, cada dev en el suyo— y en los proyectos de un repo enseñarlo sería pedir
 * un dato que no tiene alternativa.
 */
export function AssignmentEditor({ a, projects, actions }: {
  a: CapacityAssignment;
  projects: CapacityProject[];
  actions: CapacityActions;
}) {
  const { canEdit, patchAssignment, removeAssignment } = actions;
  const project = projects.find((p) => p.id === a.projectId);
  const repos = project?.repos ?? [];

  if (!canEdit) {
    return (
      <div className="rounded-lg border bg-card/50 p-2">
        <p className="truncate text-[13px] font-medium">{a.projectName ?? 'Sin proyecto'}</p>
        {a.repo && <p className="truncate font-mono text-[11px] text-muted-foreground">{a.repo}</p>}
        {a.focus && <p className="mt-1 whitespace-pre-line text-[12px] text-muted-foreground">{a.focus}</p>}
        <p className="mt-1 text-[11px] font-medium tabular-nums">{a.loadPct}% de su capacidad</p>
      </div>
    );
  }

  return (
    <div className="group/a relative rounded-lg border bg-card/50 p-2">
      <button
        type="button"
        onClick={() => removeAssignment(a.id)}
        className="absolute right-1 top-1 grid size-5 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover/a:opacity-100"
        aria-label="Quitar asignación"
        title="Quitar asignación"
      >
        <X className="size-3" />
      </button>

      <Select
        value={a.projectId ?? NONE}
        onValueChange={(v) => patchAssignment(a.id, { projectId: v === NONE ? null : v })}
      >
        <SelectTrigger className="h-7 w-full gap-1 border-0 bg-transparent px-1 text-[13px] font-medium shadow-none">
          <SelectValue placeholder="Sin proyecto" />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          <SelectItem value={NONE}>Sin proyecto</SelectItem>
          {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
        </SelectContent>
      </Select>

      {repos.length > 1 && (
        <Select
          value={a.repoId ?? NONE}
          onValueChange={(v) => patchAssignment(a.id, { repoId: v === NONE ? null : v })}
        >
          <SelectTrigger className="h-6 w-full gap-1 border-0 bg-transparent px-1 font-mono text-[11px] text-muted-foreground shadow-none">
            <SelectValue placeholder="Todo el proyecto" />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={NONE}>Todo el proyecto</SelectItem>
            {repos.map((r) => <SelectItem key={r.id} value={r.id} className="font-mono text-xs">{r.repo}</SelectItem>)}
          </SelectContent>
        </Select>
      )}

      <InlineText
        value={a.focus}
        placeholder="Enfoque…"
        multiline
        onSave={(v) => patchAssignment(a.id, { focus: v })}
        className="text-muted-foreground"
      />

      <div className="mt-1 flex items-center gap-1.5 px-1">
        <PctInput value={a.loadPct} onSave={(v) => patchAssignment(a.id, { loadPct: v })} />
        <span className="text-[11px] text-muted-foreground">% de capacidad</span>
      </div>
    </div>
  );
}

function PctInput({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = () => {
    const n = Number(draft.trim());
    // 100 es el tope POR asignación (lo exige el check de la base). Pasar del 100% total se hace
    // sumando filas, y eso es justo lo que la columna de carga marca como saturada.
    if (!Number.isFinite(n) || n < 0 || n > 100) { setDraft(String(value)); return; }
    if (Math.trunc(n) === value) return;
    onSave(Math.trunc(n));
  };

  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      inputMode="numeric"
      aria-label="Porcentaje de capacidad"
      className="w-10 rounded border border-transparent bg-transparent px-1 text-center text-[11px] font-medium tabular-nums transition-colors hover:border-input focus:border-input focus:outline-none"
    />
  );
}

/**
 * La columna de un tipo de asignación (principal o secundaria).
 *
 * El botón de añadir desaparece en las principales cuando ya se llegó al tope de su dedicación, y
 * el pie dice cuántas caben: es más honesto enseñar el límite que dejar pulsar y devolver un error.
 */
export function AssignmentCell({ dev, kind, projects, actions }: {
  dev: CapacityDev;
  kind: 'principal' | 'secondary';
  projects: CapacityProject[];
  actions: CapacityActions;
}) {
  const list = kind === 'principal' ? dev.principal : dev.secondary;
  const atCap = kind === 'principal' && list.length >= dev.load.maxPrincipal;

  return (
    <div className="space-y-1.5">
      {list.map((a) => <AssignmentEditor key={a.id} a={a} projects={projects} actions={actions} />)}

      {!list.length && !actions.canEdit && (
        <p className="px-1.5 text-[13px] text-muted-foreground/60">—</p>
      )}

      {actions.canEdit && !atCap && (
        <button
          type="button"
          onClick={() => actions.addAssignment(dev.id, { kind, position: list.length })}
          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
          Añadir {kind === 'principal' ? 'principal' : 'secundario'}
        </button>
      )}

      {kind === 'principal' && (
        <p className={cn('px-1.5 text-[11px]', dev.load.overAssigned ? 'font-medium text-destructive' : 'text-muted-foreground/70')}>
          {dev.load.overAssigned
            ? `${list.length} de ${dev.load.maxPrincipal} permitidas — quita una`
            : `${list.length}/${dev.load.maxPrincipal} principales`}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Cambios menores

/**
 * Trabajo continuo, leído junto a las skills de la persona.
 *
 * Las skills NO se editan aquí (viven en su propia pantalla): se enseñan porque son la razón por
 * la que alguien puede tomar cierto mantenimiento. El texto es lo que se escribe a mano; los chips
 * son la evidencia de al lado.
 */
export function ContinuousCell({ dev, actions }: { dev: CapacityDev; actions: CapacityActions }) {
  const top = dev.skills.slice(0, 4);
  return (
    <div className="space-y-1.5">
      <InlineText
        value={dev.continuousWork}
        placeholder="Cambios menores / tareas continuas…"
        multiline
        disabled={!actions.canEdit}
        onSave={(v) => actions.patchDev(dev.id, { continuousWork: v })}
      />
      {top.length > 0 && (
        <div className="flex flex-wrap gap-1 px-1.5">
          {top.map((s) => <SkillChip key={s.skillId} tag={s.tag} level={s.level} />)}
          {dev.skills.length > top.length && (
            <span className="self-center text-[11px] text-muted-foreground">+{dev.skills.length - top.length}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Estado de carga

/**
 * El estado de carga: barra, porcentaje y etiqueta, todo derivado de las asignaciones. Debajo, la
 * nota libre para lo que no es una cifra ("Foco Comercial / En Crecimiento").
 *
 * El número no se puede escribir a propósito — si se pudiera, dejaría de describir lo que hay
 * arriba, que es justo lo que esta columna existe para contar.
 */
export function LoadCell({ dev, actions }: { dev: CapacityDev; actions: CapacityActions }) {
  const state = LOAD_STATE[dev.load.state] ?? LOAD_STATE.libre;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium', state.pill)}>
          <span className={cn('size-1.5 rounded-full', state.dot)} />
          {state.label}
        </span>
        <span className="text-[13px] font-semibold tabular-nums">{dev.load.pct}%</span>
      </div>

      <ProgressBar pct={Math.min(100, dev.load.pct)} tone={state.tone} className="h-1.5" />

      <p className="text-[11px] text-muted-foreground">
        {dev.load.hoursUsed} de {dev.weeklyHours} h
        {dev.load.pct <= 100 && dev.load.hoursFree > 0 && ` · ${dev.load.hoursFree} h libres`}
        {dev.load.pct > 100 && ` · ${dev.load.pct - 100}% de más`}
      </p>

      <InlineText
        value={dev.loadNote}
        placeholder="Nota…"
        disabled={!actions.canEdit}
        onSave={(v) => actions.patchDev(dev.id, { loadNote: v })}
        className="text-muted-foreground"
      />
    </div>
  );
}

// ---------------------------------------------------------------- estructura de la tabla

/** Las columnas, declaradas como datos: reordenarlas o esconder una es tocar este array. */
export interface CapacityColumn {
  key: string;
  label: ReactNode;
  width: string;
  render: (dev: CapacityDev, projects: CapacityProject[], actions: CapacityActions) => ReactNode;
}

export const CAPACITY_COLUMNS: CapacityColumn[] = [
  { key: 'member', label: 'Integrante', width: 'w-44', render: (d) => <MemberCell dev={d} /> },
  { key: 'profile', label: 'Perfil / Rol', width: 'w-56', render: (d, _p, a) => <ProfileCell dev={d} actions={a} /> },
  {
    key: 'principal',
    label: <>Proyecto / Enfoque<br />Principal</>,
    width: 'w-64',
    render: (d, p, a) => <AssignmentCell dev={d} kind="principal" projects={p} actions={a} />,
  },
  {
    key: 'secondary',
    label: <>Proyecto / Enfoque<br />Secundario</>,
    width: 'w-64',
    render: (d, p, a) => <AssignmentCell dev={d} kind="secondary" projects={p} actions={a} />,
  },
  {
    key: 'continuous',
    label: <>Cambios Menores /<br />Tareas Continuas</>,
    width: 'w-64',
    render: (d, _p, a) => <ContinuousCell dev={d} actions={a} />,
  },
  {
    key: 'load',
    label: <>Estado de Carga<br />&amp; Capacidad</>,
    width: 'w-52',
    render: (d, _p, a) => <LoadCell dev={d} actions={a} />,
  },
];
