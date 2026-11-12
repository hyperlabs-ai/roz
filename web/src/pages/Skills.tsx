import { useCallback, useMemo, useState } from 'react';
import { Layout } from '@/components/Layout';
import { ErrorCard, RefreshButton } from '@/components/bits';
import { SectionHeader } from '@/components/brand';
import { useAuth } from '@/auth/AuthContext';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/lib/useApi';
import { useMirror } from '@/lib/useMirror';
import { invalidateOnly } from '@/lib/store';
import { apiGet, apiSend, type SkillCatalogItem, type SkillMatrix as SkillMatrixData } from '@/lib/api';
import { SolutionTypesPanel } from '@/components/skills/SolutionTypesPanel';
import { SkillMatrix, LevelLegend } from '@/components/skills/SkillMatrix';
import { SkillInsights, SkillInsightsSkeleton } from '@/components/skills/SkillInsights';
import { SkillCatalog, SkillDialog } from '@/components/skills/SkillCatalog';
import { cellKey, type Selection } from '@/components/skills/levels';

type Cell = SkillMatrixData['cells'][number];

export default function Skills() {
  const { user } = useAuth();
  const isAdmin = !!user; // control total para cualquier usuario autenticado (sin roles)
  // Catálogo y matriz cambian poco: TTL largo. Volver a la sección no vuelve a pedirlos.
  const catalog = useApi<{ skills: SkillCatalogItem[] }>(() => apiGet('/skills'), [], { key: '/skills', ttl: 300_000 });
  const matrix = useApi<SkillMatrixData>(() => apiGet('/skills/matrix'), [], { key: '/skills/matrix', ttl: 300_000 });
  const [selection, setSelection] = useState<Selection>(null);

  // Espejos locales. Antes cada clic en una celda hacía DOS refetches (`/skills` + `/skills/matrix`)
  // y repintaba el heatmap completo, mientras el toast ya afirmaba el nivel nuevo y la celda seguía
  // mostrando el viejo. Con el espejo, la celda cambia en el frame del clic y nada más se mueve.
  const skills = useMirror<SkillCatalogItem>(catalog.data?.skills, { key: (s) => s.skillId });
  const cells = useMirror<Cell>(matrix.data?.cells, { key: cellKey });

  const levels = useMemo(() => new Map(cells.items.map((c) => [cellKey(c), c.level])), [cells.items]);

  // Filas de la matriz: las que sirve el backend más las skills recién creadas aquí, para poder
  // asignarles nivel sin esperar el siguiente refetch. Las borradas aquí salen al instante.
  const rows = useMemo(() => {
    const served = matrix.data?.skills ?? [];
    // El tag vivo sale del catálogo (un renombre se ve en el mapa sin refetch).
    const alive = new Map(skills.items.map((s) => [s.skillId, s.tag]));
    const ids = new Set(served.map((s) => s.id));
    const extra = skills.items.filter((s) => !ids.has(s.skillId)).map((s) => ({ id: s.skillId, tag: s.tag }));
    const kept = catalog.data
      ? served.filter((s) => alive.has(s.id)).map((s) => ({ id: s.id, tag: alive.get(s.id) ?? s.tag }))
      : served;
    return [...extra, ...kept];
  }, [matrix.data?.skills, skills.items, catalog.data]);

  const devs = matrix.data?.devs ?? [];

  /**
   * Nivel de una celda (0–5). Un solo punto de verdad para los seis botones del popover.
   * El backend responde `{ok:true}` a este endpoint, así que `send` no devuelve fila y se queda el
   * optimista — que es correcto: el nivel lo eligió el cliente, no hay nada que adoptar.
   */
  const setLevel = useCallback(
    async (devId: string, skillId: string, level: number) => {
      const id = cellKey({ devId, skillId });
      const cell = cells.items.find((c) => cellKey(c) === id);
      // Sin toast de éxito: el número ya cambió en pantalla, y un toast por clic es puro ruido.
      const notes = { success: false as const, error: 'No se pudo guardar el nivel' };

      if (level <= 0) {
        if (cell) await cells.remove(cell, () => apiSend('DELETE', `/devs/${devId}/skills/${skillId}`), notes);
      } else if (!cell) {
        await cells.create({ devId, skillId, level }, async () => {
          await apiSend('POST', `/devs/${devId}/skills`, { skillId, level });
          return { devId, skillId, level };
        }, notes);
      } else {
        await cells.patch(cell, { level }, async () => {
          await apiSend('POST', `/devs/${devId}/skills`, { skillId, level });
        }, notes);
      }
      // El catálogo muestra cobertura y nivel promedio: se revalida en silencio. `invalidateOnly`
      // para NO arrastrar `/skills/matrix`, que es justo lo que no queremos repintar.
      invalidateOnly('/skills');
    },
    [cells],
  );

  const createSkill = useCallback(
    (tag: string, description: string | null) =>
      skills.create(
        { skillId: `nueva:${tag}`, tag, description, devCount: 0, avgLevel: 0, busFactorRisk: false },
        async () => {
          // El backend devuelve la fila cruda (`id, tag, description`), no el item del catálogo con
          // sus agregados: se mapea aquí con ceros y el refetch silencioso los rellena.
          const r = await apiSend<{ skill: { id: string; tag: string; description: string | null } }>(
            'POST', '/skills', { tag, description },
          );
          return { skillId: r.skill.id, tag: r.skill.tag, description: r.skill.description, devCount: 0, avgLevel: 0, busFactorRisk: false };
        },
        { success: { title: 'Skill creada', description: tag } },
      ),
    [skills],
  );

  const updateSkill = useCallback(
    (s: SkillCatalogItem, tag: string, description: string | null) =>
      skills.patch(s, { tag, description }, async () => {
        await apiSend('PATCH', `/skills/${s.skillId}`, { tag, description });
      }, { success: { title: 'Skill actualizada', description: tag } }),
    [skills],
  );

  const deleteSkill = useCallback(
    (s: SkillCatalogItem) =>
      skills.remove(s, () => apiSend('DELETE', `/skills/${s.skillId}`), {
        success: { title: 'Skill borrada', description: s.tag },
        error: 'No se pudo borrar',
      }).then(() => {
        setSelection((sel) => (sel?.kind === 'skill' && sel.id === s.skillId ? null : sel));
        invalidateOnly('/skills/matrix');
      }),
    [skills],
  );

  const refetching = catalog.refetching || matrix.refetching;

  return (
    <Layout
      title="Skills"
      actions={
        <>
          <RefreshButton
            busy={refetching}
            onClick={() => { catalog.reload(); matrix.reload(); }}
            title="Traer cambios del equipo"
          />
          {isAdmin && <SkillDialog onCreate={createSkill} />}
        </>
      }
    >
      {(catalog.error || matrix.error) && <ErrorCard className="mb-4" message={catalog.error ?? matrix.error} />}
      <Tabs defaultValue="map">
        <TabsList className="mb-1">
          <TabsTrigger value="map">Mapa de habilidades</TabsTrigger>
          <TabsTrigger value="catalog">Catálogo</TabsTrigger>
          <TabsTrigger value="solution-types">Tipos de solución</TabsTrigger>
        </TabsList>

        {/* Mapa a la izquierda (tan ancho como su contenido) y, en el resto del ancho, el panel vivo
            con el detalle de lo seleccionado y el riesgo. Las dos columnas se ESTIRAN al mismo alto
            (sin `items-start`): manda la más alta, y en la otra el sobrante se lo queda un panel
            que sabe crecer (la gráfica y la lista de riesgo, con scroll interno), así los fondos
            terminan en la misma línea. */}
        <TabsContent value="map">
          <div className="grid gap-3.5 lg:grid-cols-[minmax(380px,max-content)_minmax(360px,1fr)]">
            <Card className="flex min-w-0 flex-col p-4 sm:p-5">
              <SectionHeader
                size="sm"
                eyebrow="Mapa · equipo × habilidad"
                eyebrowColor="purple-deep"
                title="Quién domina qué"
                className="mb-4"
              />
              {matrix.loading ? (
                <div className="grid gap-1.5">
                  <Skeleton className="ml-[132px] h-8 w-[60%]" />
                  {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                </div>
              ) : matrix.data ? (
                <SkillMatrix
                  devs={devs}
                  rows={rows}
                  levels={levels}
                  isAdmin={isAdmin}
                  isBusy={cells.isBusy}
                  onSet={setLevel}
                  selection={selection}
                  onSelect={setSelection}
                />
              ) : null}
              {/* `mt-auto`: si la columna derecha es la alta, la leyenda baja al fondo de la tarjeta. */}
              <div className="mt-auto pt-4">
                <div className="border-t pt-3">
                  <LevelLegend />
                </div>
              </div>
            </Card>

            <div className="flex min-w-0 flex-col">
              {matrix.loading ? (
                <SkillInsightsSkeleton />
              ) : (
                <SkillInsights
                  devs={devs}
                  rows={rows}
                  levels={levels}
                  catalog={skills.items}
                  selection={selection}
                  onSelect={setSelection}
                />
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="catalog">
          <SkillCatalog
            items={skills.items}
            loading={catalog.loading}
            refetching={catalog.refetching}
            teamSize={devs.length || 6}
            isAdmin={isAdmin}
            isBusy={skills.isBusy}
            isFresh={skills.isFresh}
            onCreate={createSkill}
            onUpdate={updateSkill}
            onDelete={deleteSkill}
          />
        </TabsContent>

        <TabsContent value="solution-types">
          <SolutionTypesPanel skills={skills.items} isAdmin={isAdmin} />
        </TabsContent>
      </Tabs>
    </Layout>
  );
}
