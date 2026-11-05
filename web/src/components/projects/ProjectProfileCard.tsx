import { useEffect, useState } from 'react';
import { toast } from '@/lib/toast';
import { Loader2, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiSend, PROJECT_TYPES, type ProjectProfileSuggestion } from '@/lib/api';
import { invalidate } from '@/lib/store';

const NONE = '__none__';

/**
 * Perfil del proyecto: tipo principal y descripción. Es el contexto que lee roz (Jev) al clasificar
 * los tickets del proyecto — lo que separa "arreglar un botón" en una landing de lo mismo en una app
 * con backend complejo. "Sugerir con IA" lo propone leyendo los repos de GitHub; no se guarda hasta
 * que la persona guarda.
 */
export function ProjectProfileCard({
  projectId,
  projectType,
  description,
  profileSource,
  hasRepos,
  isAdmin,
  onSaved,
}: {
  projectId: string;
  projectType: string | null;
  description: string | null;
  profileSource: string | null;
  hasRepos: boolean;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [type, setType] = useState(projectType ?? NONE);
  const [text, setText] = useState(description ?? '');
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [suggestedFrom, setSuggestedFrom] = useState<ProjectProfileSuggestion | null>(null);

  useEffect(() => {
    setType(projectType ?? NONE);
    setText(description ?? '');
  }, [projectType, description]);

  const dirty = (type === NONE ? null : type) !== (projectType ?? null) || text.trim() !== (description ?? '').trim();

  async function suggest() {
    setSuggesting(true);
    try {
      const { suggestion } = await apiSend<{ suggestion: ProjectProfileSuggestion }>('POST', `/projects/${projectId}/profile/suggest`);
      if (suggestion.projectType) setType(suggestion.projectType);
      if (suggestion.description) setText(suggestion.description);
      setSuggestedFrom(suggestion);
      toast.success('Sugerencia lista', { description: 'Revísala y guarda.' });
    } catch (e: any) {
      toast.error('No se pudo sugerir', { description: String(e?.message ?? e) });
    }
    setSuggesting(false);
  }

  async function save() {
    setSaving(true);
    try {
      await apiSend('PATCH', `/projects/${projectId}`, { projectType: type === NONE ? null : type, description: text.trim() || null });
      toast.success('Perfil guardado');
      setSuggestedFrom(null);
      invalidate('/projects');
      onSaved();
    } catch (e: any) {
      toast.error('No se pudo guardar', { description: String(e?.message ?? e) });
    }
    setSaving(false);
  }

  return (
    <Card className="mt-4">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            Perfil del proyecto
            {profileSource === 'ia' && (
              <Badge variant="outline" className="gap-1 text-[10px]">
                <Sparkles className="size-3" /> Lo llenó roz: revísalo
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Qué es y cómo está hecho. roz lo usa para entender los tickets de este proyecto (no es lo mismo un botón en una landing que en
            una app con backend).
          </CardDescription>
        </div>
        {isAdmin && (
          <Button variant="outline" size="sm" onClick={suggest} disabled={suggesting || !hasRepos} title={hasRepos ? undefined : 'Vincula un repo primero'}>
            {suggesting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            Sugerir con IA
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-[240px_minmax(0,1fr)]">
          <div className="space-y-1.5">
            <Label htmlFor="proj-type">Tipo</Label>
            <Select value={type} onValueChange={setType} disabled={!isAdmin}>
              <SelectTrigger id="proj-type">
                <SelectValue placeholder="Sin tipo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>— Sin tipo —</SelectItem>
                {PROJECT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {type !== NONE && <p className="text-xs text-muted-foreground">{PROJECT_TYPES.find((t) => t.value === type)?.hint}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="proj-desc">Descripción</Label>
            <textarea
              id="proj-desc"
              value={text}
              onChange={(e) => setText(e.target.value)}
              readOnly={!isAdmin}
              rows={4}
              maxLength={1000}
              placeholder="Qué es el producto, para quién y cómo está hecho (frontend, backend, base de datos, app móvil, integraciones…)."
              className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>
        {suggestedFrom && (
          <p className="text-xs text-muted-foreground">
            Sugerido leyendo {suggestedFrom.repos.join(', ')}
            {suggestedFrom.typeBy === 'jev' ? ' · tipo: Jev' : suggestedFrom.typeBy === 'claude' ? ' · tipo: Claude' : ' · tipo: no estuvo claro, elígelo'}
            {suggestedFrom.descriptionBy === 'claude' ? ' · descripción: Claude' : suggestedFrom.descriptionBy === 'github' ? ' · descripción: datos de GitHub (edítala si quieres)' : ''}
            . No se guarda hasta que guardes.
          </p>
        )}
        {isAdmin && (
          <div className="flex justify-end">
            <Button size="sm" onClick={save} disabled={!dirty || saving}>
              {saving && <Loader2 className="size-4 animate-spin" />} Guardar perfil
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
