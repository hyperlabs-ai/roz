import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Hash, Lock } from 'lucide-react';
import { toast } from '@/lib/toast';
import { DiscordProvider, useDiscord } from '@/discord/DiscordContext';
import { isTextLike, type UiMessage } from '@/discord/model';
import { apiGet, type DiscordMessageView, type DiscordStatusView, type DiscordTaskRef, type Ticket, type TicketFilterOptions } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Layout } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { TaskDialog } from '@/components/TaskDialog';
import { cn } from '@/lib/utils';
import { ChannelSidebar } from './ChannelSidebar';
import { ChannelView } from './ChannelView';
import { CreateIssueDialog } from './CreateIssueDialog';
import { LimitsNote, LinkPrompt } from './DiscordStatus';
import { ChannelSkeleton, ChatState } from './ChatState';

const LAST_KEY = 'roz-discord-last';

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

type TaskDialogState = { mode: 'edit'; task: Ticket } | null;
interface IssueState {
  message: DiscordMessageView;
  patch: (id: string, fn: (m: UiMessage) => UiMessage) => void;
}

function DiscordChatInner() {
  const { conversationId: channelId, messageId: legacyMessageId } = useParams();
  const [params] = useSearchParams();
  const focus = params.get('m');
  const navigate = useNavigate();
  const wide = useWide();
  const discord = useDiscord();
  const [taskDialog, setTaskDialog] = useState<TaskDialogState>(null);
  const [issue, setIssue] = useState<IssueState | null>(null);

  const filters = useApi(() => apiGet<TicketFilterOptions>('/tickets/filters'), [], { key: '/tickets/filters', ttl: 600_000 });

  // Enlaces del chat interno anterior (/app/chat/m/:id): ya no se pueden resolver aquí.
  useEffect(() => {
    if (!legacyMessageId) return;
    toast('Ese enlace es del chat anterior de roz', { description: 'El chat del equipo ahora vive en Discord.' });
    navigate('/app/chat', { replace: true });
  }, [legacyMessageId, navigate]);

  const entry = channelId ? discord.channels.get(channelId) ?? null : null;

  useEffect(() => {
    if (entry && !entry.isThread) rememberLast(entry.id);
  }, [entry?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onTask = useCallback((ref: DiscordTaskRef) => {
    if (ref.workItemId) {
      apiGet<{ task: Ticket }>(`/tickets/${ref.workItemId}`)
        .then(({ task }) => setTaskDialog({ mode: 'edit', task }))
        .catch((e) => toast.error('No se pudo abrir la tarea', { description: e instanceof Error ? e.message : String(e) }));
    } else if (ref.url) {
      window.open(ref.url, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const onCreateIssue = useCallback(
    (message: DiscordMessageView, _apply: (m: DiscordMessageView) => void, patch: IssueState['patch']) => setIssue({ message, patch }),
    [],
  );

  // Raíz en desktop: el último canal abierto, o el primero de texto.
  const firstText = useMemo(() => {
    if (!discord.tree) return null;
    const all = [...discord.tree.uncategorized, ...discord.tree.categories.flatMap((c) => c.channels)];
    return all.find((c) => isTextLike(c.type) && c.supported) ?? null;
  }, [discord.tree]);

  if (!channelId && !legacyMessageId && wide && discord.tree) {
    const last = lastOpened();
    const target = (last && discord.channels.has(last) ? last : null) ?? firstText?.id;
    if (target) return <Navigate to={`/app/chat/${target}`} replace />;
  }

  const showList = wide || !channelId;

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
      {showList && (
        <aside className={cn('h-full min-h-0 shrink-0 border-r border-chat-sidebar-border', wide ? 'w-56 lg:w-64 xl:w-72' : 'w-full')}>
          <ChannelSidebar />
        </aside>
      )}

      {channelId ? (
        <section className="h-full min-h-0 min-w-0 flex-1">
          {entry ? (
            <ChannelView
              key={entry.id}
              entry={entry}
              focusMessageId={focus}
              onBack={wide ? undefined : () => navigate('/app/chat')}
              onCreateIssue={onCreateIssue}
              onTask={onTask}
            />
          ) : discord.tree ? (
            <ChatState
              icon={<Lock />}
              color="red"
              eyebrow="Sin acceso"
              title="Este canal no existe o tu cuenta no puede verlo."
              lede="Pudo haberse borrado en Discord, o cambiaron sus permisos."
              action={
                <Button variant="secondary" size="sm" onClick={() => navigate('/app/chat')}>
                  Volver a los canales
                </Button>
              }
            />
          ) : (
            <ChannelSkeleton label="Abriendo el canal" />
          )}
        </section>
      ) : (
        wide && (
          <section className="h-full min-w-0 flex-1">
            {discord.tree ? (
              // Con canales, la raíz redirige al último abierto; esto solo se ve si no hay ninguno de texto.
              <ChatState
                icon={<Hash />}
                eyebrow="Sin canales de texto"
                title="No hay un canal de texto que puedas abrir."
                lede="Tu cuenta de Discord solo ve canales de voz o foros en este servidor."
                action={<LimitsNote />}
              />
            ) : (
              <ChannelSkeleton label="Cargando los canales" />
            )}
          </section>
        )
      )}

      {filters.data && (
        <>
          <CreateIssueDialog
            message={issue?.message ?? null}
            filters={filters.data}
            onOpenChange={(v) => !v && setIssue(null)}
            onCreated={(task, message) => {
              // La ficha aparece al instante; el `discord.message.updated` del backend la confirma.
              issue?.patch(message.id, (m) =>
                m.tasks.some((t) => t.identifier === task.identifier)
                  ? m
                  : {
                      ...m,
                      tasks: [
                        ...m.tasks,
                        { identifier: task.identifier, workItemId: task.id, name: task.name, status: task.status, url: task.url },
                      ],
                    },
              );
            }}
          />
          <TaskDialog
            open={taskDialog !== null}
            onOpenChange={(v) => !v && setTaskDialog(null)}
            task={taskDialog?.task ?? null}
            filters={filters.data}
            onSaved={() => {}}
          />
        </>
      )}
    </div>
  );
}

/**
 * Chat del equipo sobre Discord (ROZ_DISCORD_CHAT): los canales reales del servidor, con el diseño de
 * roz. Sin cuenta ligada no se piden canales: se muestra el aviso para ligarla.
 */
export function DiscordChat({ status, reloadStatus }: { status: DiscordStatusView; reloadStatus: () => void }) {
  const blocked = status.unavailable === 'not_linked' || status.unavailable === 'not_member' || status.unavailable === 'not_configured';
  return (
    <Layout title="Discord">
      {blocked ? (
        <LinkPrompt status={status} />
      ) : (
        <DiscordProvider status={status} reloadStatus={reloadStatus}>
          <DiscordChatInner />
        </DiscordProvider>
      )}
    </Layout>
  );
}
