// /roz junta [proyecto] → modal (título + notas/transcript) → sesión manual en la bandeja de Juntas.
// Dueño: agente "visibilidad". Contrato: docs/discord-commands-contract.md §5.7.
//
//   · autocomplete: `proyecto` → proyectos activos (value = project.id).
//   · run: SIEMPRE abre el modal `junta.modal:<projectId|_>` (campos `titulo` y `notas`, ≤ 4000: el tope
//     de un campo de modal). defer 'never'. Sin opción, el proyecto es el mapeado al canal (si hay).
//   · junta.modal: createMeeting (src/meetings/service.ts) con format 'texto', source manual; la
//     extracción (tareas, compromisos, decisiones) sale por el outbox como cualquier junta. Responde
//     EFÍMERO con el link a la bandeja (/app/meetings).
import { db } from '../../../db/supabase.js';
import { createMeeting } from '../../../meetings/service.js';
import { AppError, ValidationError } from '../../../utils/errors.js';
import { buildCustomId } from '../custom-id.js';
import { appLink } from '../links.js';
import { ephemeral, linkButton, modal, openModal, row, textField } from '../respond.js';
import type { AutocompleteChoice, CommandActor, HandlerModule } from '../types.js';
import { notice } from '../v2.js';
import { fold } from './pulso.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Tope de un campo de texto de modal en Discord. Para transcripts más largos, la bandeja de roz. */
export const NOTES_MAX = 4000;

interface ProjectRow {
  id: string;
  name: string;
}

async function activeProjects(): Promise<ProjectRow[]> {
  const { data, error } = await db().from('project').select('id, name, active').eq('active', true);
  if (error) throw error;
  return (data ?? []) as ProjectRow[];
}

/** Proyectos activos que calzan con lo escrito. Una consulta. */
export async function projectChoices(query: string): Promise<AutocompleteChoice[]> {
  const q = fold(query);
  return (await activeProjects())
    .filter((p) => !q || fold(p.name).includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'))
    .slice(0, 25)
    .map((p) => ({ name: p.name, value: p.id }));
}

/** Proyecto mapeado al canal (o al canal padre si es un hilo). null si no hay. */
export async function projectForChannel(channelId: string | null, parentId: string | null = null): Promise<string | null> {
  const ids = [channelId, parentId].filter((x): x is string => !!x);
  for (const id of ids) {
    const { data, error } = await db().from('discord_project_channel').select('project_id, channel_id').eq('channel_id', id).maybeSingle();
    if (error) throw error;
    const pid = (data as { project_id: string } | null)?.project_id;
    if (pid) return pid;
  }
  return null;
}

/** Proyecto de la opción: uuid (lo normal), nombre (Enter sin elegir) o, sin opción, el del canal. */
async function resolveProjectOption(raw: string, channelId: string | null, parentId: string | null): Promise<string | null> {
  const value = raw.trim();
  if (UUID_RE.test(value)) return value.toLowerCase();
  if (value) {
    const q = fold(value);
    const projects = await activeProjects();
    return (projects.find((p) => fold(p.name) === q) ?? projects.find((p) => fold(p.name).includes(q)))?.id ?? null;
  }
  return projectForChannel(channelId, parentId);
}

/** Quien crea la junta (created_by = auth.users.id): sin usuario de acceso no se puede. */
function meetingUser(actor: CommandActor) {
  if (!actor.authUserId) {
    throw new AppError(
      'NOT_REGISTERED',
      'tu perfil de roz todavía no tiene usuario de acceso. Entra una vez al dashboard de roz y vuelve a intentarlo.',
      403,
    );
  }
  return { id: actor.authUserId, devId: actor.devId, devName: actor.devName };
}

function field(fields: Record<string, string | string[]>, key: string): string {
  const v = fields[key];
  return (Array.isArray(v) ? v.join('\n') : v ?? '').trim();
}

export const handlers: HandlerModule = {
  slash: {
    junta: {
      defer: 'never',
      async autocomplete(ctx) {
        return projectChoices(String(ctx.focused.value ?? ''));
      },
      async run(ctx) {
        const raw = typeof ctx.options.proyecto === 'string' ? ctx.options.proyecto : '';
        // El modal tiene que ser la primera respuesta: si buscar el proyecto falla, se abre sin él.
        let projectId: string | null = null;
        try {
          projectId = await resolveProjectOption(raw, ctx.channelId, ctx.interaction.channel?.parent_id ?? null);
        } catch (err) {
          ctx.log('discord: junta sin proyecto (no se pudo resolver)', { error: err instanceof Error ? err.message : String(err) });
        }
        return openModal(
          modal(buildCustomId('junta.modal', projectId), 'Nueva junta para roz', [
            textField({ customId: 'titulo', label: 'Título', maxLength: 200, placeholder: 'Ej.: Kickoff con el cliente' }),
            textField({
              customId: 'notas',
              label: 'Notas o transcript',
              description: `Hasta ${NOTES_MAX} caracteres. Para transcripts largos, súbelos en roz → Juntas.`,
              paragraph: true,
              maxLength: NOTES_MAX,
              placeholder: 'Pega aquí las notas o el transcript de la junta.',
            }),
          ]),
        );
      },
    },
  },
  modals: {
    'junta.modal': {
      defer: 'ephemeral',
      async run(ctx) {
        const title = field(ctx.fields, 'titulo');
        const notes = field(ctx.fields, 'notas');
        if (!title) throw new ValidationError('la junta necesita un título');
        if (!notes) throw new ValidationError('pega las notas o el transcript de la junta');
        const meeting = await createMeeting(
          meetingUser(ctx.actor),
          {
            title,
            heldAt: new Date().toISOString(),
            attendees: [],
            projectId: ctx.customId.args[0] ?? null,
            format: 'texto',
            content: notes,
          },
          { log: (msg, data) => ctx.log(msg, data) },
        );
        const url = appLink(`/app/meetings?m=${encodeURIComponent(meeting.id)}`);
        const btn = url ? linkButton('Abrir en Juntas', url) : null;
        const where = meeting.projectName ? ` · ${meeting.projectName}` : '';
        return ephemeral(
          notice(
            'ok',
            `Junta «${meeting.title}» guardada${where}`,
            `roz está leyendo las notas: las tareas y compromisos aparecerán en la bandeja de Juntas en un momento${btn ? '' : ' (roz → Juntas)'}.`,
            btn ? [row(btn)] : [],
          ),
        );
      },
    },
  },
};
