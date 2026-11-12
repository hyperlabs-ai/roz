import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useDiscord } from '@/discord/DiscordContext';
import { plainText } from '@/discord/markdown';
import { discordUrl } from '@/discord/model';
import { discordApi, type DiscordMessageView, type DiscordProjectChannelView, type Ticket, type TicketFilterOptions } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { TEXTAREA_CLS } from '@/components/meetings/meeting-ui';
import { UserAvatar } from '@/components/bits';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

const NONE = '__none__';

/**
 * "Crear issue" desde un mensaje de Discord (contrato §B.11): `POST /discord/messages/:id/task` con
 * el mismo cuerpo que la creación de tareas. El backend decide el camino (Linear con ROZ_LINEAR_SOT,
 * o la tarea nativa), deja el mensaje enlazado y responde en el canal con el bot.
 */
export function CreateIssueDialog({
  message,
  filters,
  onOpenChange,
  onCreated,
}: {
  message: DiscordMessageView | null;
  filters: TicketFilterOptions;
  onOpenChange: (open: boolean) => void;
  onCreated: (task: Ticket, message: DiscordMessageView) => void;
}) {
  const { channels, members, roles, guildId } = useDiscord();
  const mappings = useApi(() => discordApi.projectChannels(), [], { key: '/discord/project-channels', ttl: 300_000 });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState('planificada');
  const [priority, setPriority] = useState(NONE);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const entry = message ? channels.get(message.channelId) : undefined;
  const parentId = entry?.isThread ? entry.parentId : null;

  // Proyecto sugerido: el que tiene mapeado este canal (o el padre del hilo).
  const suggestedProject = useMemo(() => {
    const items: DiscordProjectChannelView[] = mappings.data?.items ?? [];
    if (!message) return null;
    return items.find((i) => i.channelId === message.channelId)?.projectId ?? (parentId ? items.find((i) => i.channelId === parentId)?.projectId : null) ?? null;
  }, [mappings.data, message, parentId]);

  useEffect(() => {
    if (!message) return;
    const resolve = {
      user: (id: string) => members.get(id)?.displayName ?? message.mentions.find((u) => u.id === id)?.globalName ?? message.mentions.find((u) => u.id === id)?.username ?? 'alguien',
      channel: (id: string) => channels.get(id)?.name ?? 'canal',
      role: (id: string) => roles.get(id)?.name ?? 'rol',
    };
    const text = plainText(message.content, resolve);
    const first = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    const where = entry ? `#${entry.name}` : 'Discord';
    const link = guildId ? discordUrl(guildId, message.channelId, message.id) : null;
    setName(first.length > 120 ? `${first.slice(0, 119).trimEnd()}…` : first || `Seguimiento del mensaje de ${message.author.displayName}`);
    setDescription(`${text}${text ? '\n\n' : ''}— Desde ${link ? `[${where}](${link})` : where} · ${message.author.displayName}`);
    setStatus('planificada');
    setPriority(NONE);
    // Responsables sugeridos: las personas mencionadas que son devs de roz.
    const devIds = new Set(filters.devs.map((d) => d.id));
    setAssignees(
      message.mentions
        .map((u) => members.get(u.id)?.devId)
        .filter((id): id is string => !!id && devIds.has(id)),
    );
  }, [message?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!message) return;
    const projects = filters.allProjects;
    setProjectId(suggestedProject && projects.some((p) => p.id === suggestedProject) ? suggestedProject : projects[0]?.id ?? '');
  }, [message?.id, suggestedProject]); // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    if (!message || !name.trim() || !projectId) return;
    setBusy(true);
    try {
      const { task } = await discordApi.createTask(message.id, {
        name: name.trim(),
        description: description.trim() || null,
        projectId,
        status,
        priority: priority === NONE ? null : priority,
        assigneeDevIds: assignees,
        labels: [],
        dueDate: null,
      });
      toast.success(`Se creó ${task.identifier}`, { description: 'Quedó enlazada al mensaje y se avisó en el canal.' });
      onCreated(task, message);
      onOpenChange(false);
    } catch (e) {
      toast.error('No se pudo crear el issue', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!message} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader eyebrow="Discord · crear issue">
          <DialogTitle>Crear issue desde el mensaje</DialogTitle>
          <DialogDescription>
            {message ? `De ${message.author.displayName}${entry ? ` en #${entry.name}` : ''}.` : null} La tarea queda enlazada al mensaje y roz
            avisa en el canal.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="dc-issue-name">Nombre</Label>
            <Input id="dc-issue-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="dc-issue-desc">Descripción</Label>
            <textarea id="dc-issue-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={6} className={cn(TEXTAREA_CLS, 'resize-y')} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label>Proyecto</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecciona" />
                </SelectTrigger>
                <SelectContent>
                  {filters.allProjects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Estado</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(filters.allStates.length ? filters.allStates : filters.states).map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Prioridad</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Sin prioridad</SelectItem>
                  {filters.priorities.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Responsables</Label>
            <div className="flex flex-wrap gap-1.5">
              {filters.devs.map((d) => {
                const on = assignees.includes(d.id);
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setAssignees((a) => (on ? a.filter((x) => x !== d.id) : [...a, d.id]))}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs transition-colors',
                      on ? 'border-orange/60 bg-orange-soft font-medium text-orange-ink' : 'bg-card text-muted-foreground hover:bg-sidebar',
                    )}
                  >
                    <UserAvatar url={d.avatarUrl} id={d.id} name={d.name} className="size-5" />
                    {d.name}
                    {on && <Check className="size-3" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="brand" onClick={() => void create()} disabled={busy || !name.trim() || !projectId}>
            {busy && <Loader2 className="animate-spin" />} Crear issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
