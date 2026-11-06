import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from '@/lib/toast';
import { Loader2, MessagesSquare } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { useChat } from '@/chat/ChatContext';
import { useMessageActions } from '@/chat/useMessages';
import { ChatSidebar } from '@/components/chat/ChatSidebar';
import { ConversationView } from '@/components/chat/ConversationView';
import { ThreadPanel } from '@/components/chat/ThreadPanel';
import { BrowseChannelsDialog, ChannelDialog, NewDmDialog } from '@/components/chat/dialogs';
import { TaskBridgeContext, type TaskBridge } from '@/components/chat/TaskChip';
import { TaskDialog } from '@/components/TaskDialog';
import { apiGet, type Ticket, type TicketFilterOptions } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import {
  chatApi, conversationTitle, decodeMentions, extractDevMentions, extractProjectMentions, withoutMentions, type ChatMessage, type ChatTaskRef,
} from '@/lib/chat';
import { cn } from '@/lib/utils';

const LAST_KEY = 'roz-chat-last';

function rememberLast(id: string) {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    /* sin storage */
  }
}
function lastOpened(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

/** Corte desktop/móvil del chat: con menos de `md` la lista y la conversación son pantallas aparte. */
function useWide(): boolean {
  const query = '(min-width: 768px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    on();
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

function toTaskRef(t: Ticket): ChatTaskRef {
  return {
    id: t.id,
    identifier: t.identifier,
    name: t.name,
    status: t.status,
    statusLabel: t.statusLabel,
    priority: t.priority,
    dueDate: t.dueDate,
    overdue: t.overdue,
    labels: t.labels ?? [],
    projectName: t.projectName,
    assigneeDevIds: (t.assignees?.length ? t.assignees : t.assignee ? [t.assignee] : []).map((a) => a.id),
  };
}

/** Texto plano de un mensaje para el nombre de una tarea: primera línea, sin markdown. */
function firstLinePlain(text: string, max = 120): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const plain = line
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

type TaskDialogState = { mode: 'create'; message: ChatMessage } | { mode: 'edit'; task: Ticket } | null;

/**
 * Chat del equipo, estilo Slack con los colores de roz: canales (públicos y privados), MDs, hilos,
 * adjuntos, menciones, y cada mensaje se puede convertir en tarea de roz.
 *
 * Rutas: /app/chat (lista), /app/chat/:conversationId (?thread=<raíz> abre el hilo) y
 * /app/chat/m/:messageId (enlace a un mensaje: desde una tarea o un push).
 */
export default function Chat() {
  const { conversationId, messageId } = useParams();
  const [params, setParams] = useSearchParams();
  const threadId = params.get('thread');
  const navigate = useNavigate();
  const wide = useWide();
  const chat = useChat();
  const { attachTask } = useMessageActions();

  const [createOpen, setCreateOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [dmOpen, setDmOpen] = useState(false);
  const [taskDialog, setTaskDialog] = useState<TaskDialogState>(null);
  const [missing, setMissing] = useState<string | null>(null);

  const filters = useApi(() => apiGet<TicketFilterOptions>('/tickets/filters'), [], { key: '/tickets/filters', ttl: 600_000 });

  // ---- Enlace a un mensaje: se resuelve su conversación y se abre su hilo ----
  useEffect(() => {
    if (!messageId) return;
    let alive = true;
    chatApi
      .locate(messageId)
      .then((r) => alive && navigate(`/app/chat/${r.conversationId}?thread=${r.rootId}`, { replace: true }))
      .catch(() => {
        if (!alive) return;
        toast.error('No se encontró el mensaje', { description: 'Pudo haberse eliminado, o es de una conversación privada.' });
        navigate('/app/chat', { replace: true });
      });
    return () => {
      alive = false;
    };
  }, [messageId, navigate]);

  // ---- Conversación abierta ----
  const conversation = useMemo(
    () => (conversationId ? chat.conversations.find((c) => c.id === conversationId) ?? null : null),
    [chat.conversations, conversationId],
  );

  useEffect(() => {
    chat.setActiveId(conversationId ?? null);
    return () => chat.setActiveId(null);
  }, [conversationId, chat.setActiveId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Una conversación que no está en mi lista (canal público ajeno, o recién creada por otra persona).
  useEffect(() => {
    if (!conversationId || !chat.ready || conversation) return;
    setMissing(null);
    let alive = true;
    chat.reloadConversation(conversationId).then((c) => {
      if (alive && !c) setMissing(conversationId);
    });
    return () => {
      alive = false;
    };
  }, [conversationId, chat.ready, conversation]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (conversation?.membership) rememberLast(conversation.id);
  }, [conversation?.id, conversation?.membership]);

  // Si la conversación abierta se borra (o me sacan), de vuelta a la lista.
  useEffect(
    () =>
      chat.subscribe((e) => {
        if (e.type === 'conversation.removed' && e.conversationId === conversationId) {
          toast('Esa conversación ya no está disponible');
          navigate('/app/chat', { replace: true });
        }
      }),
    [chat.subscribe, conversationId, navigate], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const openThread = useCallback(
    (rootId: string) => {
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set('thread', rootId);
        return next;
      });
    },
    [setParams],
  );
  const closeThread = useCallback(() => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete('thread');
      return next;
    });
  }, [setParams]);

  // ---- Puente con tareas ----
  const bridge = useMemo<TaskBridge>(
    () => ({
      openTask: (taskId) => {
        apiGet<{ task: Ticket }>(`/tickets/${taskId}`)
          .then(({ task }) => setTaskDialog({ mode: 'edit', task }))
          .catch((e) => toast.error('No se pudo abrir la tarea', { description: e instanceof Error ? e.message : String(e) }));
      },
      createFrom: (message) => setTaskDialog({ mode: 'create', message }),
    }),
    [],
  );

  const prefill = useMemo(() => {
    if (taskDialog?.mode !== 'create') return undefined;
    const m = taskDialog.message;
    const conv = chat.conversations.find((c) => c.id === m.conversationId);
    const author = m.authorDevId ? chat.nameOf(m.authorDevId) ?? 'Alguien' : 'Alguien';
    const text = decodeMentions(m.body, chat.nameOf).trim();
    // El nombre de la tarea va sin las menciones ("@Ana arregla el login @HyperHub" → "arregla el
    // login"): quién y dónde ya quedan en responsables y proyecto.
    const bare = decodeMentions(withoutMentions(m.body), chat.nameOf).trim();
    const where = conv ? (conv.kind === 'channel' ? `#${conv.name}` : `MD con ${conversationTitle(conv, chat.nameOf, chat.me)}`) : 'el chat';
    const link = `${window.location.origin}/app/chat/m/${m.id}`;
    const activeById = new Map(chat.devs.filter((d) => d.active).map((d) => [d.id.toLowerCase(), d.id]));
    return {
      name: firstLinePlain(bare) || firstLinePlain(text) || `Seguimiento del mensaje de ${author}`,
      description: `${text}${text ? '\n\n' : ''}— Desde [${where}](${link}) · ${author}`,
      // Asignación SIN IA: las personas arrobadas son las responsables y el `@proyecto` mencionado
      // es el proyecto. Lo que no se mencionó, se elige en el diálogo.
      assigneeDevIds: extractDevMentions(m.body).map((id) => activeById.get(id)).filter((id): id is string => !!id),
      projectId: extractProjectMentions(m.body)[0]?.id,
    };
  }, [taskDialog, chat.conversations, chat.nameOf, chat.devs, chat.me]);

  function onTaskSaved(task: Ticket, mode: 'created' | 'updated' | 'deleted') {
    if (mode === 'created' && taskDialog?.mode === 'create') {
      attachTask(taskDialog.message, toTaskRef(task));
      toast.success(`Se creó ${task.identifier}`, { description: 'Quedó enlazada al mensaje y se avisó en su hilo.' });
    } else if (mode === 'updated') {
      chat.dispatch({ type: 'task.updated', task: toTaskRef(task) });
    } else if (mode === 'deleted') {
      chat.dispatch({ type: 'task.deleted', taskId: task.id });
    }
  }

  // ---- Ruta raíz: en desktop se abre la última conversación (o #general) ----
  if (!conversationId && !messageId && wide && chat.ready) {
    const last = lastOpened();
    const target =
      chat.conversations.find((c) => c.id === last && c.membership) ??
      chat.conversations.find((c) => c.kind === 'channel' && c.isDefault) ??
      chat.conversations[0];
    if (target) return <Navigate to={`/app/chat/${target.id}`} replace />;
  }

  const showList = wide || !conversationId;
  const showConversation = !!conversationId;
  const showThread = !!threadId && !!conversation;

  return (
    <Layout title="Chat">
      <TaskBridgeContext.Provider value={bridge}>
        <div className="relative flex h-full min-h-0 overflow-hidden">
          {showList && (
            <aside className={cn('h-full min-h-0 shrink-0', wide ? 'w-56 lg:w-64 xl:w-72' : 'w-full')}>
              <ChatSidebar onCreateChannel={() => setCreateOpen(true)} onBrowse={() => setBrowseOpen(true)} onNewDm={() => setDmOpen(true)} />
            </aside>
          )}

          {showConversation && (
            <section className={cn('h-full min-h-0 min-w-0 flex-1', showThread && wide && 'hidden xl:block')}>
              {messageId ? null : conversation ? (
                <ConversationView
                  key={conversation.id}
                  conversation={conversation}
                  onOpenThread={openThread}
                  onBack={wide ? undefined : () => navigate('/app/chat')}
                />
              ) : missing === conversationId ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                  <MessagesSquare className="size-8 text-muted-foreground" />
                  <p className="font-medium">Esta conversación no existe o no tienes acceso.</p>
                  <button type="button" className="text-sm text-primary hover:underline" onClick={() => navigate('/app/chat')}>
                    Volver al chat
                  </button>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              )}
            </section>
          )}

          {wide && !conversationId && !messageId && (
            <section className="flex h-full flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
              <MessagesSquare className="size-10" />
              <p className="text-sm">{chat.ready ? 'Elige una conversación o crea un canal.' : 'Cargando el chat…'}</p>
            </section>
          )}

          {showThread && (
            <aside
              className={cn(
                'h-full min-h-0 border-l',
                // Desde xl caben conversación y hilo lado a lado; antes, el hilo toma el lugar de la
                // conversación (y en móvil, la pantalla entera).
                wide ? 'min-w-0 flex-1 xl:w-[26rem] xl:flex-none' : 'absolute inset-0 z-20 w-full',
              )}
            >
              <ThreadPanel
                key={threadId}
                conversation={conversation!}
                rootId={threadId!}
                canWrite={!!conversation!.membership}
                onClose={closeThread}
              />
            </aside>
          )}
        </div>

        <ChannelDialog open={createOpen} onOpenChange={setCreateOpen} />
        <BrowseChannelsDialog open={browseOpen} onOpenChange={setBrowseOpen} />
        <NewDmDialog open={dmOpen} onOpenChange={setDmOpen} />

        {filters.data && (
          <TaskDialog
            open={taskDialog !== null}
            onOpenChange={(v) => !v && setTaskDialog(null)}
            task={taskDialog?.mode === 'edit' ? taskDialog.task : null}
            prefill={prefill}
            chatMessageId={taskDialog?.mode === 'create' ? taskDialog.message.id : undefined}
            filters={filters.data}
            onSaved={onTaskSaved}
          />
        )}
      </TaskBridgeContext.Provider>
    </Layout>
  );
}
