// Zeus: el contexto unificado del equipo. Un grafo de ADRs, specs y cambios de OpenSpec, documentos,
// diseño, reglas y recursos, junto con las personas, proyectos, repos y PCs que los rodean; una
// bandeja de mensajes y solicitudes; el organigrama; la bóveda de variables de entorno (solo nombres)
// y los tokens con los que cada dev conecta su Claude Code. El consumidor principal es el agente por
// MCP: estas pantallas son para VER el mapa y administrarlo a mano.
//
// Cada sección es una RUTA (`/`, `/biblioteca`, `/bandeja`…; ver `routes.ts`) y se navega
// desde el menú lateral, que también lleva la insignia de la bandeja. Cada una guarda su propio
// estado en la consulta (`?nodo=`, `?foco=`, `?doc=`), que no viaja al cambiar de sección. Los enlaces
// viejos con `?tab=` se redirigen aquí mismo.
import { Navigate, useLocation } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { Badge } from '@/components/ui/badge';
import { AccessTab } from '@/components/zeus/AccessTab';
import { DocsTab } from '@/components/zeus/DocsTab';
import { InboxTab } from '@/components/zeus/InboxTab';
import { MapTab } from '@/components/zeus/MapTab';
import { OrgTab } from '@/components/zeus/OrgTab';
import { VaultTab } from '@/components/zeus/VaultTab';
import { OnlineDot, useZeusMe } from '@/components/zeus/zeus-ui';
import { ZEUS_SECTIONS, zeusTabTarget, type ZeusSection } from '@/lib/routes';

export default function Zeus({ section = 'mapa' }: { section?: ZeusSection }) {
  const { search, hash } = useLocation();
  // Misma caché que el menú lateral (`/zeus/me`), que es quien la mantiene al día.
  const me = useZeusMe();

  // `?tab=X` es de cuando las secciones eran pestañas: manda a la ruta de esa sección.
  const legacy = zeusTabTarget(search);
  if (legacy) return <Navigate to={{ ...legacy, hash }} replace />;

  const title = ZEUS_SECTIONS.find((s) => s.id === section)?.label ?? 'Mapa';

  return (
    <Layout
      title={title}
      eyebrow="Zeus"
      width="full"
      actions={
        me.data ? (
          (me.data.zeusAdmin || me.data.needsAdmin) && (
            <div className="flex flex-wrap items-center gap-2">
              {me.data.zeusAdmin && <Badge variant="brand">Admin de zeus</Badge>}
              {me.data.needsAdmin && <Badge variant="human" dot>Sin administrador</Badge>}
            </div>
          )
        ) : me.error ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><OnlineDot online={false} /> zeus no responde</span>
        ) : undefined
      }
    >
      {section === 'mapa' && <MapTab />}
      {section === 'biblioteca' && <DocsTab />}
      {section === 'bandeja' && <InboxTab me={me.data} />}
      {section === 'equipo' && <OrgTab me={me.data} />}
      {section === 'llaves' && <VaultTab me={me.data} />}
      {section === 'acceso' && <AccessTab me={me.data} />}
    </Layout>
  );
}
