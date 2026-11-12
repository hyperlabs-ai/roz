import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { useChat } from '@/chat/ChatContext';
import { AvatarStack } from '@/components/bits';
import { StatusIcon } from '@/components/tasks/inline-cells';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { MAX_STATUS_TASKS, chatApi, type ChatTaskRef } from '@/lib/chat';
import { cn } from '@/lib/utils';

const PICKER_LIMIT = 40;

/**
 * Selector del bloque Status (daily). Arranca con las tareas abiertas de quien lo abre; escribir
 * busca (nombre, identificador o `@persona`) para sumar tareas de otros. La selección sobrevive a
 * las búsquedas: se puede marcar una, buscar otra y marcarla también. Al enviar, el mensaje lleva
 * la lista y se pinta con las fichas del kanban.
 */
export function StatusDialog({
  open,
  onOpenChange,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (note: string, tasks: ChatTaskRef[]) => void;
}) {
  const { devOf } = useChat();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChatTaskRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mapa y no lista: conserva el orden en que se fueron marcando, que es el orden del mensaje.
  const [picked, setPicked] = useState<Map<string, ChatTaskRef>>(new Map());
  const [note, setNote] = useState('');
  const seq = useRef(0);

  // Al abrir se parte de cero (lo marcado en un status anterior no debe colarse en el siguiente).
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setPicked(new Map());
    setNote('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      chatApi
        .searchTasks(query, PICKER_LIMIT)
        .then(({ tasks }) => {
          if (mine !== seq.current) return;
          setResults(tasks);
          setError(null);
        })
        .catch((e) => {
          if (mine !== seq.current) return;
          setResults([]);
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false);
        });
    }, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [open, query]);

  // Las ya marcadas que la búsqueda actual no trae se listan arriba, para que no "desaparezcan".
  const rows = useMemo(() => {
    const inResults = new Set(results.map((t) => t.id));
    return [...[...picked.values()].filter((t) => !inResults.has(t.id)), ...results];
  }, [results, picked]);

  const full = picked.size >= MAX_STATUS_TASKS;

  function toggle(t: ChatTaskRef) {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(t.id)) next.delete(t.id);
      else if (next.size < MAX_STATUS_TASKS) next.set(t.id, t);
      return next;
    });
  }

  function submit() {
    if (!picked.size) return;
    onSend(note.trim(), [...picked.values()]);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-xl">
        <DialogHeader eyebrow="Chat · daily">
          <DialogTitle className="flex items-center gap-2">
            Compartir status
          </DialogTitle>
          <DialogDescription>Elige las tareas que quieres mostrar en el chat. Se verán con su estado actual.</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nombre, ROZ-12 o @persona"
            className="pl-8"
            autoFocus
          />
        </div>

        <div className="-mx-1 min-h-[12rem] flex-1 space-y-0.5 overflow-y-auto px-1">
          {rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {loading
                ? 'Buscando…'
                : error
                  ? `No se pudieron cargar las tareas: ${error}`
                  : query
                    ? 'Ninguna tarea coincide.'
                    : 'No tienes tareas abiertas. Escribe para buscar las de otros.'}
            </p>
          ) : (
            rows.map((t) => {
              const on = picked.has(t.id);
              const people = t.assigneeDevIds
                .map((id) => devOf(id))
                .filter((d): d is NonNullable<typeof d> => !!d)
                .map((d) => ({ name: d.name, avatarUrl: d.avatarUrl }));
              return (
                <button
                  key={t.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  disabled={!on && full}
                  onClick={() => toggle(t)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-40',
                    on && 'bg-orange-soft',
                  )}
                >
                  <span
                    className={cn(
                      'grid size-4 shrink-0 place-items-center rounded border',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                    )}
                  >
                    {on && <Check className="size-3" />}
                  </span>
                  <StatusIcon state={t.status} className="size-4" />
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{t.identifier}</span>
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  <AvatarStack people={people} size="size-5" max={2} />
                </button>
              );
            })
          )}
        </div>

        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="Nota opcional (bloqueos, qué sigue…)"
          className="w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
        />

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {picked.size === 0 ? 'Marca al menos una tarea' : `${picked.size} de ${MAX_STATUS_TASKS} seleccionadas`}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={submit} disabled={!picked.size}>
              Enviar status
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
