import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, Crown, Hash, Loader2, Lock, Search, UserMinus, X } from 'lucide-react';
import { useChat } from '@/chat/ChatContext';
import { UserAvatar } from '@/components/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { chatApi, fold, type ChatConversation, type PublicChannel } from '@/lib/chat';
import { relative } from '@/lib/format';
import { cn } from '@/lib/utils';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Vista previa del nombre como lo guardará el backend (src/chat/rules.ts → channelSlug). */
function slugPreview(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9áéíóúüñ-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/** Selector múltiple de personas con búsqueda (canal nuevo, MD, agregar miembros). */
export function DevPicker({
  selected,
  onChange,
  exclude = [],
  autoFocus,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  exclude?: string[];
  autoFocus?: boolean;
}) {
  const { devs } = useChat();
  const [q, setQ] = useState('');
  const options = useMemo(() => {
    const f = fold(q.trim());
    return devs.filter((d) => d.active && !exclude.includes(d.id) && (!f || fold(d.name).includes(f)));
  }, [devs, q, exclude]);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((id) => {
            const d = devs.find((x) => x.id === id);
            return (
              <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 py-0.5 pl-0.5 pr-2 text-xs font-medium text-primary">
                <UserAvatar url={d?.avatarUrl ?? null} name={d?.name ?? '?'} className="size-5" />
                {d?.name ?? 'Alguien'}
                <button type="button" onClick={() => toggle(id)} aria-label={`Quitar a ${d?.name}`} className="rounded-full hover:bg-primary/20">
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar personas…" className="pl-8" autoFocus={autoFocus} />
      </div>
      <div className="scroll-thin max-h-56 overflow-y-auto rounded-lg border">
        {options.length === 0 ? (
          <p className="p-3 text-center text-sm text-muted-foreground">Nadie coincide.</p>
        ) : (
          options.map((d) => {
            const on = selected.includes(d.id);
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => toggle(d.id)}
                className={cn('flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent', on && 'bg-primary/5')}
              >
                <UserAvatar url={d.avatarUrl} name={d.name} className="size-7" />
                <span className="flex-1 truncate font-medium">{d.name}</span>
                <span className={cn('grid size-5 place-items-center rounded border', on ? 'border-primary bg-primary text-primary-foreground' : 'border-input')}>
                  {on && <Check className="size-3.5" />}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function PrivacyToggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {[
        { v: false, icon: Hash, title: 'Público', text: 'Cualquiera del equipo lo encuentra y se une.' },
        { v: true, icon: Lock, title: 'Privado', text: 'Solo por invitación; no aparece al explorar.' },
      ].map((o) => (
        <button
          key={String(o.v)}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.v)}
          className={cn(
            'rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
            value === o.v ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'hover:bg-accent',
          )}
        >
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <o.icon className="size-4" /> {o.title}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{o.text}</span>
        </button>
      ))}
    </div>
  );
}

/** Crear un canal, o editar uno existente (`conversation`). */
export function ChannelDialog({
  open,
  onOpenChange,
  conversation,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  conversation?: ChatConversation | null;
}) {
  const { me, upsertConversation } = useChat();
  const navigate = useNavigate();
  const editing = !!conversation;
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(conversation?.name ?? '');
    setTopic(conversation?.topic ?? '');
    setDescription(conversation?.description ?? '');
    setIsPrivate(conversation?.isPrivate ?? false);
    setMembers([]);
  }, [open, conversation]);

  const slug = slugPreview(name);
  const isOwner = !!conversation && !!me && conversation.ownerIds.includes(me);

  async function submit() {
    if (!slug) return;
    setBusy(true);
    try {
      if (editing) {
        const patch: Parameters<typeof chatApi.updateConversation>[1] = {
          name: slug,
          topic: topic.trim() || null,
          description: description.trim() || null,
        };
        if (isOwner && isPrivate !== conversation!.isPrivate) patch.isPrivate = isPrivate;
        const { conversation: c } = await chatApi.updateConversation(conversation!.id, patch);
        upsertConversation(c);
        toast.success('Canal actualizado');
      } else {
        const { conversation: c } = await chatApi.createChannel({
          name: slug,
          topic: topic.trim() || null,
          description: description.trim() || null,
          isPrivate,
          memberDevIds: members,
        });
        upsertConversation(c);
        navigate(`/app/chat/${c.id}`);
        toast.success(`Se creó #${c.name}`);
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(editing ? 'No se pudo guardar el canal' : 'No se pudo crear el canal', { description: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="scroll-thin max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar canal' : 'Crear un canal'}</DialogTitle>
          <DialogDescription>
            {editing ? 'Cambia el nombre, el tema o la descripción.' : 'Los canales organizan las conversaciones del equipo por tema.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="channel-name">Nombre</Label>
            <div className="relative">
              <Hash className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="channel-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="p. ej. asistencia-equipos"
                className="pl-8"
                maxLength={80}
                autoFocus
              />
            </div>
            {name && slug !== name.trim() && (
              <p className="text-xs text-muted-foreground">Se guardará como <span className="font-medium text-foreground">#{slug || '…'}</span></p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="channel-topic">Tema <span className="font-normal text-muted-foreground">(opcional)</span></Label>
            <Input id="channel-topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="De qué se habla aquí" maxLength={250} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="channel-desc">Descripción <span className="font-normal text-muted-foreground">(opcional)</span></Label>
            <textarea
              id="channel-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={1000}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          {(!editing || !conversation!.isDefault) && (
            <div className="space-y-1.5">
              <Label>Visibilidad</Label>
              <PrivacyToggle value={isPrivate} onChange={setIsPrivate} disabled={editing && !isOwner} />
              {editing && !isOwner && <p className="text-xs text-muted-foreground">Solo quien administra el canal puede cambiarla.</p>}
            </div>
          )}
          {!editing && (
            <div className="space-y-1.5">
              <Label>Agregar personas <span className="font-normal text-muted-foreground">(opcional)</span></Label>
              <DevPicker selected={members} onChange={setMembers} exclude={me ? [me] : []} />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" disabled={busy || !slug}>
              {busy && <Loader2 className="animate-spin" />} {editing ? 'Guardar' : 'Crear canal'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Nuevo mensaje directo (1:1 o grupal). */
export function NewDmDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { me, upsertConversation } = useChat();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setSelected([]);
  }, [open]);

  async function submit() {
    if (!selected.length) return;
    setBusy(true);
    try {
      const { conversation } = await chatApi.openDm(selected);
      upsertConversation(conversation);
      navigate(`/app/chat/${conversation.id}`);
      onOpenChange(false);
    } catch (e) {
      toast.error('No se pudo abrir la conversación', { description: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nuevo mensaje</DialogTitle>
          <DialogDescription>Elige una persona, o varias para un mensaje grupal (hasta 8).</DialogDescription>
        </DialogHeader>
        <DevPicker selected={selected} onChange={(ids) => setSelected(ids.slice(0, 8))} exclude={me ? [me] : []} autoFocus />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={() => void submit()} disabled={busy || !selected.length}>
            {busy && <Loader2 className="animate-spin" />} Abrir conversación
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Explorar los canales públicos y unirse. */
export function BrowseChannelsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { upsertConversation } = useChat();
  const navigate = useNavigate();
  const [channels, setChannels] = useState<PublicChannel[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setChannels(null);
    chatApi
      .browse()
      .then((r) => setChannels(r.channels))
      .catch((e) => {
        setChannels([]);
        toast.error('No se pudieron cargar los canales', { description: errText(e) });
      });
  }, [open]);

  const list = useMemo(() => {
    const f = fold(q.trim());
    return (channels ?? []).filter((c) => !f || fold(c.name).includes(f) || fold(c.topic ?? '').includes(f));
  }, [channels, q]);

  async function join(c: PublicChannel) {
    setBusy(c.id);
    try {
      const { conversation } = await chatApi.join(c.id);
      upsertConversation(conversation);
      navigate(`/app/chat/${c.id}`);
      onOpenChange(false);
    } catch (e) {
      toast.error('No se pudo unir al canal', { description: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Explorar canales</DialogTitle>
          <DialogDescription>Canales públicos del equipo. Puedes abrirlos para leer antes de unirte.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar canales…" className="pl-8" autoFocus />
        </div>
        <div className="scroll-thin -mx-1 max-h-80 overflow-y-auto px-1">
          {channels === null ? (
            <div className="flex justify-center py-8 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
          ) : list.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No hay canales que coincidan.</p>
          ) : (
            list.map((c) => (
              <div key={c.id} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-accent">
                <Hash className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{c.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {c.memberCount === 1 ? '1 miembro' : `${c.memberCount} miembros`}
                    {c.lastMessageAt && ` · activo ${relative(c.lastMessageAt)}`}
                    {c.topic && ` · ${c.topic}`}
                  </div>
                </div>
                {c.joined ? (
                  <Button size="sm" variant="outline" onClick={() => { navigate(`/app/chat/${c.id}`); onOpenChange(false); }}>
                    Abrir
                  </Button>
                ) : (
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => { navigate(`/app/chat/${c.id}`); onOpenChange(false); }}>Ver</Button>
                    <Button size="sm" onClick={() => void join(c)} disabled={busy === c.id}>
                      {busy === c.id && <Loader2 className="animate-spin" />} Unirme
                    </Button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Miembros de una conversación; en canales, agregar personas y (si administras) quitarlas. */
export function MembersDialog({
  open,
  onOpenChange,
  conversation,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  conversation: ChatConversation;
}) {
  const { me, devOf, upsertConversation, reloadConversation } = useChat();
  const [adding, setAdding] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const isOwner = !!me && conversation.ownerIds.includes(me);
  const isChannel = conversation.kind === 'channel';
  const canAdd = isChannel && !!conversation.membership;

  useEffect(() => {
    if (open) setAdding([]);
  }, [open]);

  async function add() {
    if (!adding.length) return;
    setBusy(true);
    try {
      const { conversation: c } = await chatApi.addMembers(conversation.id, adding);
      upsertConversation(c);
      setAdding([]);
      toast.success(adding.length === 1 ? 'Se agregó 1 persona' : `Se agregaron ${adding.length} personas`);
    } catch (e) {
      toast.error('No se pudo agregar', { description: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(devId: string) {
    try {
      await chatApi.removeMember(conversation.id, devId);
      await reloadConversation(conversation.id);
    } catch (e) {
      toast.error('No se pudo quitar', { description: errText(e) });
    }
  }

  const members = [...conversation.memberIds].sort((a, b) => (devOf(a)?.name ?? '').localeCompare(devOf(b)?.name ?? ''));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Miembros</DialogTitle>
          <DialogDescription>
            {members.length === 1 ? '1 persona' : `${members.length} personas`} en {isChannel ? `#${conversation.name}` : 'esta conversación'}.
          </DialogDescription>
        </DialogHeader>
        <div className="scroll-thin max-h-64 space-y-0.5 overflow-y-auto">
          {members.map((id) => {
            const d = devOf(id);
            const owner = conversation.ownerIds.includes(id);
            return (
              <div key={id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent">
                <UserAvatar url={d?.avatarUrl ?? null} name={d?.name ?? '?'} className="size-7" />
                <span className="flex-1 truncate text-sm font-medium">
                  {d?.name ?? 'Alguien'} {id === me && <span className="font-normal text-muted-foreground">(tú)</span>}
                </span>
                {owner && (
                  <span className="inline-flex items-center gap-1 text-xs text-hyper" title="Administra el canal">
                    <Crown className="size-3.5" /> Admin
                  </span>
                )}
                {isChannel && isOwner && id !== me && !conversation.isDefault && (
                  <Button variant="ghost" size="icon-sm" onClick={() => void remove(id)} aria-label={`Quitar a ${d?.name}`}>
                    <UserMinus />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        {canAdd && (
          <div className="space-y-2 border-t pt-3">
            <Label>Agregar personas</Label>
            <DevPicker selected={adding} onChange={setAdding} exclude={conversation.memberIds} />
            <div className="flex justify-end">
              <Button onClick={() => void add()} disabled={busy || !adding.length}>
                {busy && <Loader2 className="animate-spin" />} Agregar
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
