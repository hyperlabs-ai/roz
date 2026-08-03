import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Lightbulb, Plus, Lock, Users, HelpCircle, ListChecks, Loader2, Search } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, ErrorCard } from '@/components/bits';
import { DefinitionBar } from '@/components/ideas/DefinitionMeter';
import { IdeaDialog } from '@/components/IdeaDialog';
import { useApi } from '@/lib/useApi';
import { apiGet, apiSend, type Idea } from '@/lib/api';
import { IDEA_STATUS_LABEL, IDEA_STATUS_OPTIONS, definitionScore, ideaStatusVariant } from '@/lib/ideas';
import { relative } from '@/lib/format';
import { cn } from '@/lib/utils';

const ALL = '__all__'; // centinela del Select para "sin filtro"

/**
 * Ideas: capturar y aterrizar proyectos antes de que existan.
 *
 * Rejilla de tarjetas en vez de tabla densa a propósito: una idea es un documento, no una fila, y
 * lo que hay que ver de un vistazo es qué tan definida está — no un montón de columnas.
 *
 * El alta es de fricción CERO (un título y Enter): la idea llega cuando llega, y si capturarla
 * cuesta un formulario, se pierde. Definirla es el trabajo de después, en el editor.
 */
export default function Ideas() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const mine = params.get('mine') === '1';
  const openId = params.get('idea');

  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  // Id del borrador recién creado. Sirve para que el editor sepa que, si lo cierras sin escribir
  // nada, esa fila se puede tirar: pulsar "Nueva idea" no debe dejar basura si te arrepientes.
  const [draftId, setDraftId] = useState<string | null>(null);
  const [sort, setSort] = useState<'updated' | 'definition'>('updated');

  const { data, loading, error, reload } = useApi<{ ideas: Idea[] }>(
    () => apiGet(`/ideas?${new URLSearchParams({ ...(status ? { status } : {}), ...(mine ? { mine: '1' } : {}) })}`),
    [status, mine],
  );

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const ideas = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = (data?.ideas ?? []).filter(
      (i) => !term || [i.title, i.pitch, i.problem].some((v) => v?.toLowerCase().includes(term)),
    );
    if (sort === 'definition') {
      return [...list].sort((a, b) => definitionScore({ ...b, mustCount: b.mustCount }).pct - definitionScore({ ...a, mustCount: a.mustCount }).pct);
    }
    return list;
  }, [data, q, sort]);

  /**
   * Nueva idea = abrir el editor, punto. No se pide el título antes: cuando la idea llega todavía
   * no tiene nombre, y obligar a bautizarla en la puerta es justo la fricción que hace que se
   * pierda. Se crea con un título provisional y se escribe todo dentro.
   */
  async function create() {
    setCreating(true);
    try {
      const { idea } = await apiSend<{ idea: Idea }>('POST', '/ideas', { title: 'Sin título' });
      setDraftId(idea.id);
      // Sin reload: la rejilla no debe mostrar un "Sin título" detrás del modal por una idea que
      // todavía puede descartarse. Se recarga al guardar o al descartar.
      setParam('idea', idea.id);
    } catch (e: any) {
      toast.error('No se pudo crear la idea', { description: String(e?.message ?? e) });
    }
    setCreating(false);
  }

  return (
    <Layout
      title="Ideas"
      subtitle="Captura una idea en cuanto llegue y aterrízala contestando lo que falta"
      actions={
        <Button className="h-9" onClick={create} disabled={creating}>
          {creating ? <Loader2 className="animate-spin" /> : <Plus />}
          <span className="ml-1.5">Nueva idea</span>
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar…" className="h-9 pl-8" />
          </div>

          <Select value={status || ALL} onValueChange={(v) => setParam('status', v === ALL ? null : v)}>
            <SelectTrigger className="h-9 w-[150px] text-xs">
              <SelectValue placeholder="Estado" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL} className="text-xs">Todos los estados</SelectItem>
              {IDEA_STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
            <SelectTrigger className="h-9 w-[160px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updated" className="text-xs">Recientes primero</SelectItem>
              <SelectItem value="definition" className="text-xs">Más definidas primero</SelectItem>
            </SelectContent>
          </Select>

          <Button variant={mine ? 'default' : 'outline'} size="sm" className="h-9" onClick={() => setParam('mine', mine ? null : '1')}>
            <Lock className="size-3.5" />
            <span className="ml-1.5">Solo mías</span>
          </Button>
        </div>

        {error && <ErrorCard message={error} />}

        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-44 rounded-xl" />)}
          </div>
        ) : ideas.length === 0 ? (
          <EmptyState
            icon={<Lightbulb />}
            action={
              !q && !status && !mine ? (
                <Button size="sm" onClick={create} disabled={creating}>
                  <Plus />
                  <span className="ml-1.5">Nueva idea</span>
                </Button>
              ) : undefined
            }
          >
            {q || status || mine
              ? 'Ninguna idea coincide con el filtro.'
              : 'Sin ideas todavía. Abre una y empieza a escribir — el título puede esperar.'}
          </EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {ideas.map((idea) => (
              <IdeaCard key={idea.id} idea={idea} onOpen={() => setParam('idea', idea.id)} />
            ))}
          </div>
        )}
      </div>

      <IdeaDialog
        ideaId={openId}
        open={!!openId}
        isDraft={!!openId && openId === draftId}
        onOpenChange={(v) => {
          if (v) return;
          setDraftId(null);
          setParam('idea', null);
        }}
        onSaved={() => {
          setDraftId(null); // ya tiene contenido: deja de ser un borrador descartable
          reload();
        }}
      />
    </Layout>
  );
}

function IdeaCard({ idea, onOpen }: { idea: Idea; onOpen: () => void }) {
  const score = definitionScore({ ...idea, mustCount: idea.mustCount });
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-2.5 rounded-xl border bg-card p-4 text-left shadow-sm transition-all duration-200 ease-spring hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate font-semibold">{idea.title}</h3>
        <Badge variant={ideaStatusVariant(idea.status)} className="shrink-0 text-[10px]">
          {IDEA_STATUS_LABEL[idea.status] ?? idea.status}
        </Badge>
      </div>

      <p className={cn('line-clamp-2 min-h-[2.5rem] text-sm', idea.pitch ? 'text-muted-foreground' : 'text-muted-foreground/50')}>
        {idea.pitch || 'Sin descripción en una frase'}
      </p>

      <DefinitionBar pct={score.pct} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <ListChecks className="size-3" />
          {idea.mustCount}/{idea.featureCount}
        </span>
        {idea.openQuestions > 0 && (
          <span className="inline-flex items-center gap-1 text-warning">
            <HelpCircle className="size-3" />
            {idea.openQuestions}
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          {idea.shared ? <Users className="size-3" /> : <Lock className="size-3" />}
          {idea.shared ? (idea.canEdit ? 'Compartida' : (idea.createdByName ?? 'De otro dev')) : 'Privada'}
        </span>
        <span className="ml-auto">{relative(idea.updatedAt)}</span>
      </div>
    </button>
  );
}
