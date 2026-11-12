import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from '@/lib/toast';
import { CloudOff, Lock, MessagesSquare } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { ChannelSkeleton, ChatSkeleton, ChatState } from '@/components/discord/ChatState';
import { Button } from '@/components/ui/button';
import { useChat } from '@/chat/ChatContext';
import { useMessageActions } from '@/chat/useMessages';
import { ChatSidebar } from '@/components/chat/ChatSidebar';
import { ConversationView } from '@/components/chat/ConversationView';
import { ThreadPanel } from '@/components/chat/ThreadPanel';
import { BrowseChannelsDialog, ChannelDialog, NewDmDialog } from '@/components/chat/dialogs';
import { TaskBridgeContext, type TaskBridge } from '@/components/chat/TaskChip';
import { TaskDialog } from '@/components/TaskDialog';
import { apiGet, type Ticket, type TicketFilterOptions } from '@/lib/api';
import { DISCORD_STATUS_KEY, discordStatusOrOff } from '@/discord/status';
import { DiscordChat } from '@/components/discord/DiscordChat';
import { useApi } from '@/lib/useApi';
import { chatApi, conversationTitle, decodeMentions, type ChatMessage, type ChatTaskRef } from '@/lib/chat';
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

/*
 * El chat es full-bleed como Discord: en desktop NO lleva la topbar de sección (la oculta `AppShell`
 * en las rutas full-bleed). Las dos barras del chat (servidor/lista y canal/conversación) hacen de
 * encabezado, a la misma altura. En móvil la topbar se queda: ahí lleva el menú hamburguesa.
 */

type TaskDialogState = { mode: 'create'; message: ChatMessage } | { mode: 'edit'; task: Ticket } | null;

/**
 * Chat del equipo, estilo Slack con los colores de roz: canales (públicos y privados), MDs, hilos,
 * adjuntos, menciones, y cada mensaje se puede convertir en tarea de roz.
 *
 * Rutas: /app/chat (lista), /app/chat/:conversationId (?thread=<raíz> abre el hilo) y
 * /app/chat/m/:messageId (enlace a un mensaje: desde una tarea o un push).
 *
 * Es el chat con ROZ_DISCORD_CHAT apagado: idéntico a como era antes del chat de Discord.
 */
function InternalChat() {
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
    const where = conv ? (conv.kind === 'channel' ? `#${conv.name}` : `MD con ${conversationTitle(conv, chat.nameOf, chat.me)}`) : 'el chat';
    const link = `${window.location.origin}/app/chat/m/${m.id}`;
    const activeIds = new Set(chat.devs.filter((d) => d.active).map((d) => d.id));
    return {
      name: firstLinePlain(text) || `Seguimiento del mensaje de ${author}`,
      description: `${text}${text ? '\n\n' : ''}— Desde [${where}](${link}) · ${author}`,
      assigneeDevIds: m.mentions.filter((id) => activeIds.has(id)),
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
            <aside className={cn('h-full min-h-0 shrink-0 border-r border-chat-sidebar-border', wide ? 'w-56 lg:w-64 xl:w-72' : 'w-full')}>
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
                <ChatState
                  eyebrow="Sin acceso"
                  color="red"
                  icon={<Lock />}
                  title="Esta conversación no existe o no tienes acceso."
                  lede="Pudo haberse eliminado, o es un canal privado al que no te han invitado."
                  action={
                    <Button variant="secondary" size="sm" onClick={() => navigate('/app/chat')}>
                      Volver al chat
                    </Button>
                  }
                />
              ) : (
                <ChannelSkeleton label="Abriendo la conversación" />
              )}
            </section>
          )}

          {wide && !conversationId && !messageId && (
            <section className="h-full min-w-0 flex-1">
              {chat.ready ? (
                <ChatState
                  icon={<MessagesSquare />}
                  eyebrow="Chat del equipo"
                  title="Elige una conversación o crea un canal."
                  lede="Canales por proyecto, mensajes directos e hilos. Cualquier mensaje se convierte en tarea con su ficha."
                  action={
                    <>
                      <Button variant="brand" size="sm" onClick={() => setCreateOpen(true)}>
                        Crear canal
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setBrowseOpen(true)}>
                        Explorar canales
                      </Button>
                    </>
                  }
                />
              ) : (
                <ChannelSkeleton label="Cargando el chat" />
              )}
            </section>
          )}

          {showThread && (
            <aside
              className={cn(
                'h-full min-h-0 border-l bg-card',
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

/**
 * Página del chat. Una sola llamada decide qué chat se monta: `GET /discord/status` responde también
 * con el flag apagado (`enabled: false`), y entonces queda el chat interno tal cual (contrato §E).
 * Con el flag encendido, si el puente o Discord fallan en caliente, se queda el chat de Discord en
 * "sin conexión": nunca cae en silencio al chat interno.
 */
export default function Chat() {
  const status = useApi(() => discordStatusOrOff(), [], { key: DISCORD_STATUS_KEY, ttl: 60_000 });

  if (status.data?.enabled === false) return <InternalChat />;

  if (status.data) return <DiscordChat status={status.data} reloadStatus={status.reload} />;

  return (
    <Layout title="Chat">
      {status.error ? (
        <ChatState
          eyebrow="Sin conexión"
          color="red"
          icon={<CloudOff />}
          title="No se pudo abrir el chat."
          lede={status.error}
          action={
            <Button variant="secondary" size="sm" onClick={status.reload}>
              Reintentar
            </Button>
          }
        />
      ) : (
        <ChatSkeleton />
      )}
    </Layout>
  );
}
