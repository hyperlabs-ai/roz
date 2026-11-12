import { createContext, useContext } from 'react';
import { ClipboardList, FolderGit2 } from 'lucide-react';
import { useChat } from '@/chat/ChatContext';
import { StatusIcon } from '@/components/tasks/inline-cells';
import { CardLabels, CardMeta } from '@/components/tasks/card-parts';
import type { ChatMessage, ChatTaskRef } from '@/lib/chat';
import { CLOSED_STATES, canonState, stateBadgeVariant } from '@/lib/labels';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { BalancedGrid } from '@/components/grid';
import { RozBotAvatar } from '@/components/avatars';

/** Filo izquierdo de la ficha por estado (como `.now` del mock): cerrada verde, en curso azul. */
const EDGE: Record<ReturnType<typeof stateBadgeVariant>, string> = {
  success: 'border-l-green',
  info: 'border-l-blue',
  secondary: 'border-l-toggle-off',
};

/**
 * Puente entre el chat y las tareas: abrir una tarea existente o crear una desde un mensaje. Lo
 * provee la página del chat (que es dueña del TaskDialog); los mensajes solo lo invocan.
 */
export interface TaskBridge {
  openTask: (taskId: string) => void;
  createFrom: (message: ChatMessage) => void;
}

export const TaskBridgeContext = createContext<TaskBridge>({ openTask: () => {}, createFrom: () => {} });
export const useTaskBridge = () => useContext(TaskBridgeContext);

/**
 * Una tarea dentro del chat, con la MISMA tarjeta del kanban (etiquetas, estado, nombre,
 * identificador, prioridad, fecha límite, responsables — de components/tasks/card-parts). Lo único
 * que agrega es lo que en el tablero da la columna y aquí no hay: el estado en texto y el proyecto.
 */
export function TaskCard({ task, caption }: { task: ChatTaskRef; caption?: string }) {
  const { openTask } = useTaskBridge();
  const { devOf } = useChat();
  const people = task.assigneeDevIds
    .map((id) => devOf(id))
    .filter((d): d is NonNullable<typeof d> => !!d)
    .map((d) => ({ name: d.name, avatarUrl: d.avatarUrl }));
  const closed = CLOSED_STATES.includes(canonState(task.status));
  const variant = stateBadgeVariant(canonState(task.status));

  return (
    <button
      type="button"
      onClick={() => openTask(task.id)}
      title={`Abrir ${task.identifier}`}
      className={cn(
        'group/card block w-full max-w-[19rem] self-start rounded-md border border-l-[3px] bg-card px-3 py-2.5 text-left transition-[background-color,box-shadow,border-color] duration-150 hover:bg-sidebar hover:shadow-md',
        EDGE[variant],
      )}
    >
      {/* Cabecera de la ficha: ID mono (como `.kcard .id`) + estado + proyecto. */}
      <div className="mb-1.5 flex items-center gap-2">
        <span className="shrink-0 font-mono text-[11px] font-medium text-faint transition-colors group-hover/card:text-foreground">
          {task.identifier}
        </span>
        <Badge variant={variant} dot className="px-2 py-px text-[10.5px]">
          {task.statusLabel}
        </Badge>
        {task.projectName && (
          <span className="ml-auto flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            <FolderGit2 className="size-3 shrink-0" />
            <span className="truncate">{task.projectName}</span>
          </span>
        )}
      </div>
      {caption && <div className="label-caps mb-1.5 truncate">{caption}</div>}
      <CardLabels labels={task.labels} />
      <div className="flex items-start gap-1.5">
        <StatusIcon state={task.status} className="mt-[1px] size-[15px]" />
        <span className={cn('min-w-0 flex-1 text-[13px] font-medium leading-snug', closed && 'font-normal text-muted-foreground line-through')}>
          {task.name}
        </span>
      </div>
      <CardMeta identifier={task.identifier} priority={task.priority} dueDate={task.dueDate} overdue={task.overdue} people={people} />
    </button>
  );
}

/** Tarjetas de un mensaje: las que nacieron de él y las que cita, sin repetir. */
export function MessageTasks({ message }: { message: ChatMessage }) {
  const created = message.tasks;
  const cited = (message.citedTasks ?? []).filter((t) => !created.some((c) => c.id === t.id));
  if (!created.length && !cited.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {created.map((t) => (
        <TaskCard key={t.id} task={t} caption="Creada desde este mensaje" />
      ))}
      {cited.map((t) => (
        <TaskCard key={t.id} task={t} />
      ))}
    </div>
  );
}

/**
 * Bloque Status (daily): las tareas que la persona eligió, con su estado de AHORA (si alguien las
 * movió después, el bloque lo refleja). Va dentro del mensaje, debajo de la nota si la hay.
 */
export function StatusBlock({ message }: { message: ChatMessage }) {
  const tasks = message.statusTasks ?? [];
  const planned = Array.isArray((message.meta as { taskIds?: unknown } | null)?.taskIds)
    ? ((message.meta as { taskIds: unknown[] }).taskIds.length)
    : tasks.length;
  const missing = Math.max(planned - tasks.length, 0);
  const done = tasks.filter((t) => CLOSED_STATES.includes(canonState(t.status))).length;
  return (
    <div className="mt-1.5 max-w-2xl rounded-xl bg-panel p-3">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <ClipboardList className="size-4 text-orange" />
        <span className="label-caps text-foreground">Status</span>
        <span className="text-[11px] text-faint tabular-nums">
          {planned === 1 ? '1 tarea' : `${planned} tareas`}
        </span>
        {tasks.length > 0 && done > 0 && (
          <Badge variant="ok" dot className="px-2 py-px text-[10.5px]">
            {done} cerrada{done === 1 ? '' : 's'}
          </Badge>
        )}
      </div>
      <BalancedGrid max={{ base: 1, sm: 2 }} className="gap-2">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} />
        ))}
      </BalancedGrid>
      {missing > 0 && (
        <p className="mt-2 text-xs italic text-muted-foreground">
          {missing === 1 ? '1 tarea ya no existe.' : `${missing} tareas ya no existen.`}
        </p>
      )}
    </div>
  );
}

/** Aviso de sistema en un hilo: "X creó la tarea ROZ-12 a partir de este mensaje". */
export function TaskCreatedNotice({ message }: { message: ChatMessage }) {
  const { openTask } = useTaskBridge();
  const { nameOf } = useChat();
  const meta = (message.meta ?? {}) as { workItemId?: string; identifier?: string; name?: string };
  const who = message.authorDevId ? nameOf(message.authorDevId) ?? 'Alguien' : 'Alguien';
  return (
    <div className="flex items-start gap-2.5 rounded-md border-l-[3px] border-l-orange bg-sidebar px-3 py-2 text-sm text-muted-foreground">
      {/* El aviso lo da roz: Roz-bot en vez de un ícono genérico. */}
      <RozBotAvatar className="mt-px size-5" />
      <p className="min-w-0">
        <span className="font-medium text-foreground">{who}</span> creó la tarea{' '}
        {meta.workItemId ? (
          <button type="button" onClick={() => openTask(meta.workItemId!)} className="font-medium text-foreground hover:text-orange-ink hover:underline">
            <span className="font-mono text-[12px] text-orange-ink">{meta.identifier}</span> · {meta.name}
          </button>
        ) : (
          <span className="font-medium text-foreground">{meta.identifier}</span>
        )}{' '}
        a partir de este mensaje.
      </p>
    </div>
  );
}
