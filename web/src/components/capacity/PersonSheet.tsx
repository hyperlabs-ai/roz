// Panel lateral de una persona: el ÚNICO sitio donde se edita la capacidad.
//
// La lista y la gráfica solo pintan; al hacer click en una fila (o una columna) se abre este panel
// con todo lo editable de esa persona: rol, dedicación, horas, perfil, asignaciones principales y
// secundarias con su %, tareas continuas y la nota. Cada campo guarda solo al salir de él (o al
// elegir en un selector) y el backend responde la tabla entera recalculada, así que el estado de
// carga de la cabecera se repinta con el mismo viaje.
//
// Como no hay botón de guardar, cada campo dice lo que le pasó: "Guardando" mientras viaja y
// "Guardado" al volver (`useSaveState`). El % de una asignación se mueve con un deslizador (de 5 en
// 5) o tecleando el número exacto; el reparto completo se ve en la barra de la cabecera, tramo por
// proyecto, con la marca del 100%.
//
// Es un Dialog de Radix pegado a la derecha (foco atrapado, Esc, overlay) y no un panel que empuja
// el contenido: la lista de atrás no se mueve mientras se edita.
import { useEffect, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AlertTriangle, ArrowDown, ArrowUp, GitBranch, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DialogCloseButton } from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FormSection, SaveMark, useSaveState } from '@/components/ui/field';
import { NumberField } from '@/components/ui/number-field';
import { Slider } from '@/components/ui/slider';
import { SkillChip } from '@/components/bits';
import { PersonAvatar, ProjectIcon } from '@/components/avatars';
import { COMMITMENT_LABEL, COMMITMENT_OPTIONS, ROLE_OPTIONS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { AssignmentKind, CapacityAssignment, CapacityDev, CapacityProject } from '@/lib/api';
import { groupMeta, hoursLine, personLine, StatePill, type CapacityActions } from './cells';

const NONE = '__none__'; // los Select de Radix no aceptan value=""

// Animación de entrada lateral. Vive aquí (y no en styles.css) porque es la única hoja lateral de
// la app; si aparece otra, se sube a `styles.css` junto a `.t-modal`.
const SHEET_CSS = `
@keyframes cap-sheet-in { from { transform: translateX(24px); opacity: 0 } to { transform: none; opacity: 1 } }
@keyframes cap-sheet-out { from { transform: none; opacity: 1 } to { transform: translateX(24px); opacity: 0 } }
.cap-sheet[data-state='open'] { animation: cap-sheet-in 220ms cubic-bezier(.2,.8,.2,1) both }
.cap-sheet[data-state='closed'] { animation: cap-sheet-out 150ms ease-in both }
@media (prefers-reduced-motion: reduce) { .cap-sheet[data-state] { animation-duration: 1ms } }
`;

export function PersonSheet({
  dev,
  projects,
  actions,
  onClose,
}: {
  dev: CapacityDev | null;
  projects: CapacityProject[];
  actions: CapacityActions;
  onClose: () => void;
}) {
  // Se conserva la última persona durante la animación de salida: sin esto el panel se vaciaría
  // un instante antes de irse.
  const last = useRef<CapacityDev | null>(dev);
  if (dev) last.current = dev;
  const d = dev ?? last.current;

  return (
    <>
      {/* Fuera del Portal: dentro, Radix lo desmontaría al cerrar y la animación de salida se
          quedaría sin keyframes. */}
      <style>{SHEET_CSS}</style>
      <DialogPrimitive.Root open={!!dev} onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="t-overlay fixed inset-0 z-50 bg-scrim/30" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="cap-sheet fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-card text-card-foreground shadow-lg outline-none sm:max-w-[480px]"
          >
            {d && <SheetBody key={d.id} dev={d} projects={projects} actions={actions} />}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}

function SheetBody({ dev, projects, actions }: { dev: CapacityDev; projects: CapacityProject[]; actions: CapacityActions }) {
  const { canEdit, patchDev } = actions;
  const inherited = dev.weeklyHoursOverride == null;
  const [roleSave, trackRole] = useSaveState();
  const [commitSave, trackCommit] = useSaveState();
  const [hoursSave, trackHours] = useSaveState();
  const [profileSave, trackProfile] = useSaveState();
  const [workSave, trackWork] = useSaveState();
  const [noteSave, trackNote] = useSaveState();

  return (
    <>
      {/* Cabecera: quién es y cómo está de carga. Fija; lo de abajo es lo que hace scroll. */}
      <header className="border-b px-5 pb-4 pt-4">
        <div className="flex items-center gap-3">
          <PersonAvatar url={dev.avatarUrl} id={dev.id} name={dev.name} presence={dev.active ? undefined : 'off'} className="size-11" />
          <div className="min-w-0 flex-1">
            <DialogPrimitive.Title className="truncate text-lg font-semibold leading-tight tracking-[-0.03em]">
              {dev.name}
            </DialogPrimitive.Title>
            <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
              {personLine(dev)}{!dev.active && ' · Inactivo'}
            </p>
          </div>
          <DialogCloseButton className="-mr-1.5" />
        </div>

        <div className="mt-4 flex items-end justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[30px] font-semibold leading-none tracking-[-0.04em] tabular-nums">{dev.load.pct}%</span>
            <StatePill dev={dev} />
          </div>
          <span className="pb-0.5 text-[12px] tabular-nums text-muted-foreground">{hoursLine(dev)}</span>
        </div>
        <AllocationBar dev={dev} />
      </header>

      <div className="scroll-thin flex-1 space-y-7 overflow-y-auto px-5 py-5">
        {/* --- Perfil --- */}
        <FormSection title="Perfil">
          <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
            <Field label="Rol" save={roleSave}>
              <Select value={dev.role} disabled={!canEdit} onValueChange={(v) => trackRole(patchDev(dev.id, { role: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Dedicación" save={commitSave}>
              <Select value={dev.commitment} disabled={!canEdit} onValueChange={(v) => trackCommit(patchDev(dev.id, { commitment: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COMMITMENT_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="Horas por semana"
              save={hoursSave}
              hint={inherited
                ? `Hereda las de ${COMMITMENT_LABEL[dev.commitment]?.toLowerCase() ?? 'su dedicación'}`
                : canEdit
                  ? <button type="button" onClick={() => trackHours(patchDev(dev.id, { weeklyHours: null }))} className="font-medium text-orange-ink hover:underline">Volver a heredar</button>
                  : 'Fijadas a mano'}
            >
              <NumberField
                value={dev.weeklyHoursOverride}
                placeholder={String(dev.weeklyHours)}
                nullable
                stepper
                min={1}
                max={80}
                unit="h"
                disabled={!canEdit}
                aria-label="Horas por semana"
                className="w-full"
                onCommit={(v) => trackHours(patchDev(dev.id, { weeklyHours: v }))}
              />
            </Field>
            <Field label="Perfil" save={profileSave}>
              <DraftField
                value={dev.profile}
                placeholder="Dev Junior / Frontend"
                disabled={!canEdit}
                onSave={(v) => trackProfile(patchDev(dev.id, { profile: v }))}
              />
            </Field>
          </div>
        </FormSection>

        {/* --- Asignaciones --- */}
        <AssignmentSection dev={dev} kind="principal" projects={projects} actions={actions} />
        <AssignmentSection dev={dev} kind="secondary" projects={projects} actions={actions} />

        {/* --- Trabajo continuo --- */}
        <FormSection title="Tareas continuas" aside={<SaveMark state={workSave} />}>
          <DraftField
            multiline
            value={dev.continuousWork}
            placeholder="Cambios menores, mantenimiento, soporte…"
            disabled={!canEdit}
            onSave={(v) => trackWork(patchDev(dev.id, { continuousWork: v }))}
          />
          {dev.skills.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {dev.skills.slice(0, 6).map((s) => <SkillChip key={s.skillId} tag={s.tag} level={s.level} />)}
              {dev.skills.length > 6 && (
                <span className="self-center text-[11px] tabular-nums text-faint">+{dev.skills.length - 6}</span>
              )}
            </div>
          )}
        </FormSection>

        <FormSection title="Nota de carga" aside={<SaveMark state={noteSave} />}>
          <DraftField
            multiline
            rows={1}
            value={dev.loadNote}
            placeholder="Foco comercial, en crecimiento…"
            disabled={!canEdit}
            onSave={(v) => trackNote(patchDev(dev.id, { loadNote: v }))}
          />
        </FormSection>
      </div>

      <footer className="flex items-center justify-between gap-3 border-t bg-sidebar px-5 py-3">
        <span className="min-w-0 truncate text-[12px] text-muted-foreground">
          {canEdit ? 'Cada cambio se guarda solo.' : 'Solo lectura. Inicia sesión para editar.'}
        </span>
        <DialogPrimitive.Close asChild>
          <Button variant="secondary" size="sm">Cerrar</Button>
        </DialogPrimitive.Close>
      </footer>
    </>
  );
}

// ---------------------------------------------------------------- reparto

/**
 * El reparto de la semana, tramo por asignación: las principales en el color del estado de carga,
 * las secundarias en el mismo color atenuado. Si la suma pasa de 100, la barra entera representa
 * el total y una marca señala dónde cae el 100%: lo que queda a su derecha es lo que sobra.
 */
function AllocationBar({ dev }: { dev: CapacityDev }) {
  const g = groupMeta(dev);
  const rows = [...dev.principal, ...dev.secondary].filter((a) => a.loadPct > 0);
  const total = rows.reduce((s, a) => s + a.loadPct, 0);
  const scale = Math.max(100, total);
  const over = total > 100;

  return (
    <div className="mt-3">
      <div className="relative">
        <div className="flex h-2 gap-px overflow-hidden rounded-full bg-toggle-off/70">
          {rows.map((a) => (
            <span
              key={a.id}
              title={`${a.projectName ?? 'Sin proyecto'} · ${a.loadPct}%`}
              style={{ width: `${(a.loadPct / scale) * 100}%` }}
              className={cn('h-full transition-[width] duration-300 ease-spring', g.dot, a.kind === 'secondary' && 'opacity-45')}
            />
          ))}
        </div>
        {over && (
          <span
            aria-hidden
            style={{ left: `${(100 / scale) * 100}%` }}
            className="absolute -bottom-1 -top-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          />
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-[11.5px] text-faint">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5"><span className={cn('size-2 rounded-[3px]', g.dot)} />Principal</span>
          <span className="flex items-center gap-1.5"><span className={cn('size-2 rounded-[3px] opacity-45', g.dot)} />Secundario</span>
        </span>
        {over ? (
          <span className="flex items-center gap-1 font-medium text-red">
            <AlertTriangle className="size-3" />
            Sobran {total - 100} puntos: baja algún %
          </span>
        ) : total < 100 ? (
          <span className="tabular-nums">{100 - total}% sin asignar</span>
        ) : (
          <span>Semana completa</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- asignaciones

/**
 * Principales o secundarias. Añadir es elegir el proyecto directamente (no una fila vacía que luego
 * hay que rellenar). En las principales, el selector desaparece al llegar al tope de la dedicación
 * y se dice por qué: es más honesto enseñar el límite que dejar elegir y devolver un error.
 */
function AssignmentSection({ dev, kind, projects, actions }: {
  dev: CapacityDev;
  kind: AssignmentKind;
  projects: CapacityProject[];
  actions: CapacityActions;
}) {
  const principal = kind === 'principal';
  const list = principal ? dev.principal : dev.secondary;
  const atCap = principal && list.length >= dev.load.maxPrincipal;
  const principalFull = dev.principal.length >= dev.load.maxPrincipal;
  const total = list.reduce((s, a) => s + a.loadPct, 0);
  const [addSave, trackAdd] = useSaveState();

  const options: ComboboxOption[] = [
    ...projects.map((p) => ({ value: p.id, label: p.name, icon: <ProjectIcon id={p.id} size="xs" /> })),
    { value: NONE, label: 'Sin proyecto', icon: <NoProjectIcon />, hint: 'Tiempo reservado sin proyecto' },
  ];

  return (
    <FormSection
      title={principal ? 'Proyectos principales' : 'Proyectos secundarios'}
      aside={
        <span className="flex items-center gap-2 text-[12px] tabular-nums text-faint">
          <SaveMark state={addSave} />
          {principal && (
            <span className={cn('rounded-full px-1.5 py-0.5 text-[11px] font-medium', dev.load.overAssigned ? 'bg-red-soft text-red' : 'bg-panel text-muted-foreground')}>
              {list.length} de {dev.load.maxPrincipal}
            </span>
          )}
          {list.length > 0 && <span className="font-medium text-foreground">{total}%</span>}
        </span>
      }
    >
      <div className="space-y-2">
        {list.map((a) => (
          <AssignmentEditor
            key={a.id}
            a={a}
            weeklyHours={dev.weeklyHours}
            projects={projects}
            options={options}
            actions={actions}
            canPromote={!principal && !principalFull}
          />
        ))}

        {!list.length && !actions.canEdit && (
          <p className="rounded-lg border border-dashed px-3 py-3 text-center text-[12.5px] text-faint">Sin asignaciones</p>
        )}

        {actions.canEdit && !atCap && (
          <Combobox
            value={null}
            options={options}
            searchPlaceholder="Buscar proyecto…"
            onChange={(v) => trackAdd(actions.addAssignment(dev.id, { kind, position: list.length, projectId: v === NONE ? null : v }))}
            trigger={
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded-md border border-dashed px-3 text-[13px] text-muted-foreground transition-colors hover:border-orange/50 hover:bg-orange-soft hover:text-orange-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-orange/50 data-[state=open]:bg-orange-soft data-[state=open]:text-orange-ink"
              >
                <Plus className="size-4" />
                Añadir {principal ? 'principal' : 'secundario'}
              </button>
            }
          />
        )}

        {actions.canEdit && atCap && (
          <p className={cn('flex items-start gap-1.5 text-[12px]', dev.load.overAssigned ? 'text-red' : 'text-faint')}>
            {dev.load.overAssigned && <AlertTriangle className="mt-0.5 size-3 shrink-0" />}
            {dev.load.overAssigned
              ? `Tiene más principales de las que caben en ${COMMITMENT_LABEL[dev.commitment]?.toLowerCase()}: pasa una a secundaria o quítala.`
              : `Tope de ${COMMITMENT_LABEL[dev.commitment]?.toLowerCase()}: ${dev.load.maxPrincipal} principal${dev.load.maxPrincipal === 1 ? '' : 'es'}.`}
          </p>
        )}
      </div>
    </FormSection>
  );
}

function NoProjectIcon() {
  return <span aria-hidden className="size-3.5 shrink-0 rounded-[4px] border border-dashed border-faint" />;
}

/**
 * Una asignación. Arriba, el proyecto y su % (número exacto); debajo, el deslizador del mismo % con
 * las horas a las que equivale. El repo solo aparece si el proyecto tiene varios (el caso
 * Hyperflow: un proyecto, un repo por dev). El enfoque está plegado hasta que se usa: una fila
 * recién creada no enseña una caja vacía. Mover entre principal ↔ secundaria y quitar viven en el
 * menú «⋯», fuera del camino del %.
 */
function AssignmentEditor({ a, weeklyHours, projects, options, actions, canPromote }: {
  a: CapacityAssignment;
  weeklyHours: number;
  projects: CapacityProject[];
  options: ComboboxOption[];
  actions: CapacityActions;
  /** Solo para secundarias: si cabe otra principal. */
  canPromote: boolean;
}) {
  const { canEdit, patchAssignment, removeAssignment } = actions;
  const repos = projects.find((p) => p.id === a.projectId)?.repos ?? [];
  const principal = a.kind === 'principal';
  const canSwap = principal || canPromote;
  const [save, track] = useSaveState();

  // % en vivo mientras se arrastra; se guarda al soltar. `sent` evita el doble envío cuando soltar
  // el ratón y soltar la tecla confirman el mismo valor.
  const [live, setLive] = useState(a.loadPct);
  const sent = useRef(a.loadPct);
  useEffect(() => { setLive(a.loadPct); sent.current = a.loadPct; }, [a.loadPct]);
  const savePct = (v: number) => {
    setLive(v);
    if (v === sent.current) return;
    sent.current = v;
    void track(patchAssignment(a.id, { loadPct: v }));
  };

  const [focusOpen, setFocusOpen] = useState(!!a.focus);
  const [focusFresh, setFocusFresh] = useState(false); // recién abierto a mano: entra con el cursor
  useEffect(() => { if (a.focus) setFocusOpen(true); }, [a.focus]);

  const hours = Math.round((weeklyHours * live) / 10) / 10;

  return (
    <div className="group/row rounded-lg border bg-sidebar p-3 transition-colors focus-within:border-foreground/20">
      <div className="flex items-center gap-2">
        <Combobox
          value={a.projectId ?? NONE}
          options={options}
          disabled={!canEdit}
          size="sm"
          searchPlaceholder="Buscar proyecto…"
          className="flex-1 font-medium"
          onChange={(v) => {
            const next = v === NONE ? null : v;
            if (next !== a.projectId) void track(patchAssignment(a.id, { projectId: next, repoId: null }));
          }}
        />
        <NumberField
          value={live}
          onCommit={(v) => savePct(v ?? 0)}
          min={0}
          max={100}
          step={5}
          unit="%"
          size="sm"
          disabled={!canEdit}
          aria-label="Porcentaje de capacidad"
          className="w-[68px]"
        />
        {canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Más acciones"
                className="grid size-8 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-panel data-[state=open]:text-foreground"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[200px]">
              <DropdownMenuItem
                disabled={!canSwap}
                onSelect={() => { void track(patchAssignment(a.id, { kind: principal ? 'secondary' : 'principal' })); }}
              >
                {principal ? <ArrowDown className="size-4" /> : <ArrowUp className="size-4" />}
                {principal ? 'Pasar a secundario' : canPromote ? 'Pasar a principal' : 'No cabe otra principal'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red focus:bg-red-soft focus:text-red"
                onSelect={() => { void track(removeAssignment(a.id)); }}
              >
                <Trash2 className="size-4" />
                Quitar asignación
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Slider
          value={live}
          step={5}
          disabled={!canEdit}
          aria-label="Porcentaje de capacidad"
          tone={principal ? 'text-orange' : 'text-muted-foreground'}
          onValueChange={setLive}
          onValueCommit={savePct}
        />
        <span className="w-[68px] shrink-0 text-right text-[11.5px] tabular-nums text-faint">≈ {hours} h/sem</span>
      </div>

      {(repos.length > 1 || focusOpen || canEdit || save !== 'idle') && (
        <div className="mt-2.5 space-y-2">
          {repos.length > 1 && (
            <Select
              value={a.repoId ?? NONE}
              disabled={!canEdit}
              onValueChange={(v) => { void track(patchAssignment(a.id, { repoId: v === NONE ? null : v })); }}
            >
              <SelectTrigger className="h-8 text-[12.5px] text-muted-foreground">
                <span className="flex min-w-0 items-center gap-2">
                  <GitBranch className="size-3.5 shrink-0 text-faint" />
                  <span className="truncate"><SelectValue placeholder="Todo el proyecto" /></span>
                </span>
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value={NONE}>Todo el proyecto</SelectItem>
                {repos.map((r) => <SelectItem key={r.id} value={r.id} className="font-mono text-xs">{r.repo}</SelectItem>)}
              </SelectContent>
            </Select>
          )}

          {focusOpen ? (
            <DraftField
              multiline
              rows={1}
              autoFocus={focusFresh}
              value={a.focus}
              placeholder="Enfoque: qué hace en este proyecto…"
              disabled={!canEdit}
              onSave={(v) => { void track(patchAssignment(a.id, { focus: v })); }}
              onEmptyBlur={() => { setFocusOpen(false); setFocusFresh(false); }}
            />
          ) : null}

          {(save !== 'idle' || (canEdit && !focusOpen)) && (
            <div className="flex min-h-4 items-center justify-between gap-2">
              {canEdit && !focusOpen ? (
                <button
                  type="button"
                  onClick={() => { setFocusFresh(true); setFocusOpen(true); }}
                  className="inline-flex items-center gap-1 rounded text-[12px] text-faint transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Plus className="size-3" />
                  Añadir enfoque
                </button>
              ) : <span />}
              <SaveMark state={save} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- campos

/**
 * Texto que guarda al salir del campo (y con Enter en una línea; Esc descarta). No guarda en cada
 * tecla: un PATCH por pulsación llenaría la red de peticiones que se pisan entre sí. El multilínea
 * crece con lo que se escribe en vez de reservar una caja vacía.
 */
function DraftField({ value, onSave, onEmptyBlur, placeholder, multiline, rows = 2, disabled, autoFocus }: {
  value: string | null;
  onSave: (v: string | null) => void;
  /** Se salió del campo dejándolo vacío (sirve para volver a plegarlo). */
  onEmptyBlur?: () => void;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(value ?? '');
  const focused = useRef(false);
  const discard = useRef(false); // Esc: el blur que provoca NO debe guardar el borrador
  useEffect(() => { if (!focused.current) setDraft(value ?? ''); }, [value]);

  const commit = () => {
    focused.current = false;
    if (discard.current) { discard.current = false; if (!(value ?? '').trim()) onEmptyBlur?.(); return; }
    const next = draft.trim();
    if (next !== (value ?? '').trim()) onSave(next || null);
    if (!next) onEmptyBlur?.();
  };
  const common = {
    value: draft,
    placeholder,
    disabled,
    autoFocus,
    onFocus: () => { focused.current = true; },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Escape') { e.stopPropagation(); discard.current = true; setDraft(value ?? ''); (e.target as HTMLElement).blur(); }
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); (e.target as HTMLElement).blur(); }
    },
  };
  return multiline
    ? <Textarea {...common} rows={rows} maxRows={8} className="text-[13px]" />
    : <Input {...common} />;
}
