// /roz pulso [persona] — quién trabaja en qué. Dueño: agente "visibilidad".
// Contrato: docs/discord-commands-contract.md §5.5.
//
//   · autocomplete: `persona` → devs activos (value = dev.id).
//   · run: getPulse (src/dashboard/pulse.ts). Sin persona → pulseMessage (una tarjeta por persona con
//     issue o agente; las demás en una línea tenue); con persona → personMessage (issue actual, plan
//     del agente, presencia del calendario, su semana). EFÍMERO.
import { getPulse } from '../../../dashboard/pulse.js';
import { db } from '../../../db/supabase.js';
import type { PulsePerson } from '../../../types/roz-v2.js';
import { NotFoundError } from '../../../utils/errors.js';
import { appEmojis } from '../emojis.js';
import { personMessage, pulseMessage } from '../embeds.js';
import { clip, ephemeral } from '../respond.js';
import type { AutocompleteChoice, HandlerModule } from '../types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sin acentos y en minúsculas, para buscar "jose" y encontrar "José". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Devs activos que calzan con lo escrito (el actor primero si calza). Una consulta. */
export async function devChoices(query: string, actorDevId: string): Promise<AutocompleteChoice[]> {
  const { data, error } = await db().from('dev').select('id, name, github_login, active').eq('active', true);
  if (error) throw error;
  const q = fold(query);
  return ((data ?? []) as { id: string; name: string; github_login: string | null }[])
    .filter((d) => !q || fold(d.name).includes(q) || fold(d.github_login ?? '').includes(q))
    .sort((a, b) => (a.id === actorDevId ? -1 : b.id === actorDevId ? 1 : a.name.localeCompare(b.name, 'es')))
    .slice(0, 25)
    .map((d) => ({ name: d.name, value: d.id }));
}

/** La persona del pulso por id (lo normal) o por nombre/login (si escribió y dio Enter sin elegir). */
export function findPerson(people: PulsePerson[], raw: string): PulsePerson | null {
  const value = raw.trim();
  if (!value) return null;
  if (UUID_RE.test(value)) return people.find((p) => p.devId.toLowerCase() === value.toLowerCase()) ?? null;
  const q = fold(value);
  return (
    people.find((p) => fold(p.name) === q || fold(p.githubLogin ?? '') === q) ??
    people.find((p) => fold(p.name).includes(q) || fold(p.githubLogin ?? '').includes(q)) ??
    null
  );
}

export const handlers: HandlerModule = {
  slash: {
    pulso: {
      defer: 'ephemeral',
      async autocomplete(ctx) {
        return devChoices(String(ctx.focused.value ?? ''), ctx.actor.devId);
      },
      async run(ctx) {
        const persona = typeof ctx.options.persona === 'string' ? ctx.options.persona : '';
        const [{ people, generatedAt }, emojis] = await Promise.all([getPulse(), persona.trim() ? appEmojis() : Promise.resolve(null)]);
        if (persona.trim()) {
          const person = findPerson(people, persona);
          if (!person) throw new NotFoundError(`no encontré a «${clip(persona, 60)}» en el pulso del equipo`);
          return ephemeral(personMessage(person, emojis, { updatedAt: generatedAt }));
        }
        return ephemeral(pulseMessage(people, { updatedAt: generatedAt }));
      },
    },
  },
};
