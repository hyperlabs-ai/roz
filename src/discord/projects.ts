// Proyecto ↔ canal de Discord (contrato §B.10): dónde se publica el aviso de /ticket al responsable.
// Sin fila, el aviso va por DM del bot (src/discord/notify.ts).
import { db } from '../db/supabase.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import { TEXT_CHANNEL_TYPES, type DiscordProjectChannelView } from '../types/discord.js';
import { abilitiesIn, type Viewer } from './access.js';

interface ProjectLite {
  id: string;
  name: string;
}

/**
 * Todos los proyectos activos, con o sin canal. El NOMBRE del canal solo se da si quien pregunta lo
 * ve en Discord (`viewer`): el de un canal privado mapeado por otra persona no se filtra (sale el id,
 * que no dice nada, y channelName null). Sin cuenta ligada (`viewer` null) no se nombra ninguno.
 */
export async function listProjectChannels(viewer: Viewer | null): Promise<DiscordProjectChannelView[]> {
  const [{ data: projects, error: pErr }, { data: maps, error: mErr }] = await Promise.all([
    db().from('project').select('id, name').eq('active', true).order('name'),
    db().from('discord_project_channel').select('project_id, channel_id'),
  ]);
  if (pErr) throw pErr;
  if (mErr) throw mErr;
  const byProject = new Map(((maps ?? []) as { project_id: string; channel_id: string }[]).map((m) => [m.project_id, m.channel_id]));
  const channelIds = [...new Set(byProject.values())];
  const names = new Map<string, string>();
  if (channelIds.length) {
    const { data, error } = await db().from('discord_channel').select('id, name, deleted_at').in('id', channelIds);
    if (error) throw error;
    for (const c of (data ?? []) as { id: string; name: string; deleted_at: string | null }[]) {
      if (!c.deleted_at && viewer && abilitiesIn(viewer, c.id).view) names.set(c.id, c.name);
    }
  }
  return ((projects ?? []) as ProjectLite[]).map((p) => {
    const channelId = byProject.get(p.id) ?? null;
    return { projectId: p.id, projectName: p.name, channelId, channelName: channelId ? names.get(channelId) ?? null : null };
  });
}

/**
 * PUT /project-channels/:projectId. El canal tiene que ser de texto/anuncios y visible para quien lo
 * configura (no se publica en un canal que esa persona ni ve). `null` quita el mapeo.
 */
export async function setProjectChannel(viewer: Viewer, projectId: string, channelId: string | null): Promise<DiscordProjectChannelView> {
  const { data: project, error } = await db().from('project').select('id, name').eq('id', projectId).maybeSingle();
  if (error) throw error;
  if (!project) throw new NotFoundError('el proyecto no existe');
  const p = project as ProjectLite;

  if (channelId === null) {
    const { error: delErr } = await db().from('discord_project_channel').delete().eq('project_id', projectId);
    if (delErr) throw delErr;
    return { projectId: p.id, projectName: p.name, channelId: null, channelName: null };
  }

  const channel = viewer.snap.channelRows.get(channelId);
  if (!channel || channel.deleted_at || !abilitiesIn(viewer, channelId).view) throw new NotFoundError('el canal no existe');
  if (!TEXT_CHANNEL_TYPES.has(channel.type)) throw new ValidationError('el aviso solo se puede publicar en un canal de texto o de anuncios');

  const now = new Date().toISOString();
  const { error: upErr } = await db()
    .from('discord_project_channel')
    .upsert({ project_id: projectId, channel_id: channelId, updated_by: viewer.devId, updated_at: now }, { onConflict: 'project_id' });
  if (upErr) throw upErr;
  return { projectId: p.id, projectName: p.name, channelId, channelName: channel.name };
}
