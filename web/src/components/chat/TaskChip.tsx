import { createContext, useContext } from 'react';
import { ClipboardList, FolderGit2, ListChecks } from 'lucide-react';
import { useChat } from '@/chat/ChatContext';
import { StatusIcon } from '@/components/tasks/inline-cells';
import { CardLabels, CardMeta } from '@/components/tasks/card-parts';
import type { ChatMessage, ChatTaskRef } from '@/lib/chat';
import { CLOSED_STATES, canonState } from '@/lib/labels';
import { cn } from '@/lib/utils';

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

  return (
    <button
      type="button"
      onClick={() => openTask(task.id)}
      title={`Abrir ${task.identifier}`}
      className="group/card block w-full max-w-[18rem] self-start rounded-lg border bg-card p-2.5 text-left shadow-sm transition-[background-color,box-shadow,border-color] duration-150 hover:border-foreground/15 hover:bg-accent hover:shadow-md"
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="truncate">{caption ?? task.statusLabel}</span>
        {task.projectName && (
          <span className="ml-auto flex min-w-0 items-center gap-1 normal-case tracking-normal">
            <FolderGit2 className="size-3 shrink-0" />
            <span className="truncate">{task.projectName}</span>
          </span>
        )}
      </div>
      <CardLabels labels={task.labels} />
      <div className="flex items-start gap-1.5">
        <StatusIcon state={task.status} className="mt-[1px] size-[15px]" />
        <span className={cn('min-w-0 flex-1 text-[13px] leading-snug', closed && 'text-muted-foreground line-through')}>
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
        <TaskCard key={t.id} task={t} caption={`Creada desde este mensaje · ${t.statusLabel}`} />
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
    <div className="mt-1.5 max-w-2xl rounded-xl border bg-muted/30 p-2.5">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <ClipboardList className="size-4 text-primary" />
        <span className="uppercase tracking-wide">Status</span>
        <span className="font-normal">
          · {planned === 1 ? '1 tarea' : `${planned} tareas`}
          {tasks.length > 0 && done > 0 && ` · ${done} cerrada${done === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} />
        ))}
      </div>
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
    <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
      <ListChecks className="mt-0.5 size-4 shrink-0 text-primary" />
      <p className="min-w-0">
        <span className="font-medium text-foreground">{who}</span> creó la tarea{' '}
        {meta.workItemId ? (
          <button type="button" onClick={() => openTask(meta.workItemId!)} className="font-medium text-primary hover:underline">
            {meta.identifier} · {meta.name}
          </button>
        ) : (
          <span className="font-medium text-foreground">{meta.identifier}</span>
        )}{' '}
        a partir de este mensaje.
      </p>
    </div>
  );
}
