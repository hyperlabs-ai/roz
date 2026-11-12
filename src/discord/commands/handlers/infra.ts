// /roz infra [proyecto] — estado de los servicios. Dueño: agente "visibilidad".
// Contrato: docs/discord-commands-contract.md §5.6.
//
//   · autocomplete: `proyecto` → proyectos con servicios (value = project.id).
//   · run: lee los snapshots que guarda el poll (src/infra/*; nunca pega a Vercel/Railway/Supabase en
//     línea) → infraMessage: primero una tarjeta por caído/degradado (último error y deploy
//     sospechoso), luego una línea por proveedor con los nombres colapsados. EFÍMERO.
//
// "Deploy sospechoso": el deploy del último sondeo si es DISTINTO (otro sha o fecha) al que había la
// última vez que el servicio se vio sano; si es el mismo, la caída no viene de un deploy y se muestra
// como "Último deploy".
import { db } from '../../../db/supabase.js';
import type { ServiceDeploy, ServiceStatus } from '../../../infra/types.js';
import { NotFoundError } from '../../../utils/errors.js';
import { appEmojis } from '../emojis.js';
import { infraMessage, type ServiceCardInput } from '../embeds.js';
import { notice } from '../v2.js';
import { clip, ephemeral } from '../respond.js';
import type { AutocompleteChoice, HandlerModule } from '../types.js';
import { fold } from './pulso.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly ServiceStatus[] = ['healthy', 'degraded', 'down', 'paused', 'unknown'];
/** El error del proveedor va corto: el mensaje entero tiene 4000 caracteres de texto. */
const ERROR_MAX = 300;

interface ServiceRow {
  id: string;
  project_id: string;
  provider: string;
  external_ref: string;
  label: string | null;
}

interface SnapshotRow {
  captured_at: string;
  status: string;
  deploy: ServiceDeploy | null;
  details: Record<string, unknown> | null;
  error: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
}

function asStatus(s: string | null | undefined): ServiceStatus {
  return (STATUSES as readonly string[]).includes(s ?? '') ? (s as ServiceStatus) : 'unknown';
}

/** Quita lo que parezca credencial de un mensaje de error del proveedor y lo acorta. */
export function scrubError(text: string | null | undefined): string | null {
  if (!text?.trim()) return null;
  const clean = text
    .replace(/(bearer|token|apikey|api_key|authorization|secret|password)(["'\s:=]+)(?:bearer\s+)?[^\s"',;]+/gi, '$1$2[oculto]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[oculto]')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(clean, ERROR_MAX);
}

/** ¿El deploy actual es otro que el del último sondeo sano? */
export function isNewDeploy(current: ServiceDeploy | null, healthy: ServiceDeploy | null): boolean {
  if (!current) return false;
  if (!healthy) return true;
  if (current.sha && healthy.sha) return current.sha !== healthy.sha;
  return (current.createdAt ?? '') !== (healthy.createdAt ?? '');
}

async function latestSnapshot(serviceId: string): Promise<SnapshotRow | null> {
  const { data, error } = await db()
    .from('service_snapshot')
    .select('captured_at, status, deploy, details, error')
    .eq('project_service_id', serviceId)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as SnapshotRow | null) ?? null;
}

/** Último error registrado y el deploy de la última vez que estuvo sano (solo para los caídos). */
async function troubleOf(serviceId: string): Promise<{ lastError: string | null; healthyDeploy: ServiceDeploy | null }> {
  const [errRes, okRes] = await Promise.all([
    db()
      .from('service_snapshot')
      .select('captured_at, error')
      .eq('project_service_id', serviceId)
      .not('error', 'is', null)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db()
      .from('service_snapshot')
      .select('captured_at, deploy')
      .eq('project_service_id', serviceId)
      .eq('status', 'healthy')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (errRes.error) throw errRes.error;
  if (okRes.error) throw okRes.error;
  return {
    lastError: (errRes.data as { error: string | null } | null)?.error ?? null,
    healthyDeploy: (okRes.data as { deploy: ServiceDeploy | null } | null)?.deploy ?? null,
  };
}

async function loadServices(): Promise<{ services: ServiceRow[]; projects: Map<string, string> }> {
  const [svc, proj] = await Promise.all([
    db().from('project_service').select('id, project_id, provider, external_ref, label'),
    db().from('project').select('id, name'),
  ]);
  if (svc.error) throw svc.error;
  if (proj.error) throw proj.error;
  return {
    services: (svc.data ?? []) as ServiceRow[],
    projects: new Map(((proj.data ?? []) as ProjectRow[]).map((p) => [p.id, p.name])),
  };
}

/** Proyecto por id (lo normal) o por nombre (si escribió y dio Enter sin elegir). */
export function resolveProject(projects: Map<string, string>, withServices: Set<string>, raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (UUID_RE.test(value)) {
    const id = value.toLowerCase();
    return projects.has(id) ? id : null;
  }
  const q = fold(value);
  const candidates = [...projects].filter(([id]) => withServices.has(id));
  return (candidates.find(([, name]) => fold(name) === q) ?? candidates.find(([, name]) => fold(name).includes(q)))?.[0] ?? null;
}

/** Fichas de servicio para el mensaje. Exportado para las pruebas. */
export async function loadServiceCards(projectId: string | null): Promise<{ cards: ServiceCardInput[]; projectName: string | null }> {
  const { services, projects } = await loadServices();
  const scoped = projectId ? services.filter((s) => s.project_id === projectId) : services;
  const snaps = await Promise.all(scoped.map((s) => latestSnapshot(s.id)));
  const cards = await Promise.all(
    scoped.map(async (s, i): Promise<ServiceCardInput> => {
      const snap = snaps[i] ?? null;
      const status = asStatus(snap?.status);
      const base: ServiceCardInput = {
        name: s.label || s.external_ref,
        provider: s.provider,
        projectName: projects.get(s.project_id) ?? null,
        status,
        deploy: snap?.deploy ?? null,
        checkedAt: snap?.captured_at ?? null,
      };
      if (status !== 'down' && status !== 'degraded') return base;
      const trouble = await troubleOf(s.id);
      const suspect = isNewDeploy(snap?.deploy ?? null, trouble.healthyDeploy) ? snap?.deploy ?? null : null;
      return { ...base, lastError: scrubError(snap?.error ?? trouble.lastError), suspectDeploy: suspect };
    }),
  );
  return { cards, projectName: projectId ? projects.get(projectId) ?? null : null };
}

export const handlers: HandlerModule = {
  slash: {
    infra: {
      defer: 'ephemeral',
      async autocomplete(ctx) {
        const { services, projects } = await loadServices();
        const withServices = new Set(services.map((s) => s.project_id));
        const q = fold(String(ctx.focused.value ?? ''));
        const out: AutocompleteChoice[] = [...projects]
          .filter(([id, name]) => withServices.has(id) && (!q || fold(name).includes(q)))
          .sort((a, b) => a[1].localeCompare(b[1], 'es'))
          .map(([id, name]) => ({ name, value: id }));
        return out;
      },
      async run(ctx) {
        const raw = typeof ctx.options.proyecto === 'string' ? ctx.options.proyecto : '';
        let projectId: string | null = null;
        if (raw.trim()) {
          const { services, projects } = await loadServices();
          projectId = resolveProject(projects, new Set(services.map((s) => s.project_id)), raw);
          if (!projectId) throw new NotFoundError(`no encontré un proyecto con servicios que se llame «${clip(raw, 60)}»`);
        }
        const { cards, projectName } = await loadServiceCards(projectId);
        if (!cards.length) {
          return ephemeral(
            notice(
              'off',
              projectName ? `${projectName} no tiene servicios vinculados.` : 'No hay servicios vinculados todavía.',
              'Vincúlalos en roz → Infraestructura.',
            ),
          );
        }
        const emojis = await appEmojis();
        return ephemeral(infraMessage(cards, { projectName, emojis }));
      },
    },
  },
};
