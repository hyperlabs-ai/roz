// /roz plan [issue] y los botones Aprobar / Pedir cambios. Dueño: agente "visibilidad".
// Contrato: docs/discord-commands-contract.md §5.4.
//
//   · autocomplete: `issue` → planes visibles (value = identificador, p. ej. WAT-44).
//   · run: con issue → la ficha del plan (planMessage de embeds.ts: estado, riesgo, pasos, PR; botones
//     solo si plan.actions los permite al actor). PÚBLICO. Sin issue → los planes del actor, EFÍMERO.
//   · plan.aprobar: approvePlan (src/plans/service.ts; solo el dueño, lo revisa checkAction) → update.
//   · plan.cambios: abre el modal `plan.cambios.modal` (campo `comentario`, ≤ FEEDBACK_MAX). 'never'.
//   · plan.cambios.modal: requestChanges → update de la ficha.
//
// Los permisos son los de roz: los servicios de planes revisan quién puede (un 403 sale efímero como
// "No se pudo: …" por el router). Los botones de una ficha pública los puede apretar cualquiera; el
// servicio rechaza al que no es dueño.
import { FEEDBACK_MAX, approvePlan, getPlanDetail, listPlans, planByIdentifier, requestChanges, type Actor } from '../../../plans/service.js';
import { PLAN_STATUS_LABEL, type AgentPlanSummary } from '../../../types/roz-v2.js';
import { AppError, NotFoundError } from '../../../utils/errors.js';
import { buildCustomId } from '../custom-id.js';
import { appEmojis } from '../emojis.js';
import { planLink, planMessage, planTone } from '../embeds.js';
import { button, clip, ephemeral, modal, openModal, publicMessage, row, textField, updateMessage } from '../respond.js';
import type { ActionRowComponent, AutocompleteChoice, CommandActor, HandlerModule, OutgoingMessage } from '../types.js';
import { dot, header, inline, separator, text, v2Message } from '../v2.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Actor de los servicios de planes: necesita el usuario de acceso (approved_by = auth.users.id). */
export function planActor(actor: CommandActor): Actor {
  if (!actor.authUserId) {
    throw new AppError(
      'NOT_REGISTERED',
      'tu perfil de roz todavía no tiene usuario de acceso. Entra una vez al dashboard de roz y vuelve a intentarlo.',
      403,
    );
  }
  return { userId: actor.authUserId, devId: actor.devId };
}

/** Orden para listas: lo que espera al actor primero, luego lo suyo, luego lo más reciente. */
function byRelevance(devId: string) {
  return (a: AgentPlanSummary, b: AgentPlanSummary): number => {
    const wa = a.actions.includes('aprobar') ? 0 : 1;
    const wb = b.actions.includes('aprobar') ? 0 : 1;
    if (wa !== wb) return wa - wb;
    const ma = a.owner.id === devId ? 0 : 1;
    const mb = b.owner.id === devId ? 0 : 1;
    if (ma !== mb) return ma - mb;
    return b.updatedAt.localeCompare(a.updatedAt);
  };
}

function statusLabel(p: AgentPlanSummary): string {
  return PLAN_STATUS_LABEL[p.status] ?? p.status;
}

/** Choices del autocompletado de `issue`. Puro: recibe los planes ya cargados. */
export function planChoices(plans: AgentPlanSummary[], query: string, devId: string): AutocompleteChoice[] {
  const q = query.trim().toLowerCase();
  return plans
    .filter((p) => !q || p.identifier.toLowerCase().includes(q) || p.issue.name.toLowerCase().includes(q) || p.owner.name.toLowerCase().includes(q))
    .sort(byRelevance(devId))
    .slice(0, 25)
    .map((p) => ({ name: `${p.identifier} · ${p.issue.name} — ${statusLabel(p)}`, value: p.identifier }));
}

/** Plan por lo que llegó en `issue`: identificador (lo normal), uuid del plan, o texto suelto. */
async function resolvePlanId(raw: string, devId: string): Promise<string> {
  const value = raw.trim();
  if (!value) throw new NotFoundError('escribe el issue del plan, p. ej. WAT-44');
  if (UUID_RE.test(value)) return value;
  const live = await planByIdentifier(value);
  if (live) return live.id;
  // Terminados recientes (hecho/cancelado de la última semana) o texto que no es un identificador.
  const { plans } = await listPlans({ viewerDevId: devId, scope: 'team' });
  const q = value.toLowerCase();
  const hit =
    plans.find((p) => p.identifier.toLowerCase() === q) ??
    plans.find((p) => p.identifier.toLowerCase().includes(q) || p.issue.name.toLowerCase().includes(q));
  if (!hit) throw new NotFoundError(`no encontré un plan del agente para «${clip(value, 60)}»`);
  return hit.id;
}

/** Ficha del plan tal como la ve `devId` (botones según sus acciones). */
async function planCard(planId: string, devId: string) {
  const [plan, emojis] = await Promise.all([getPlanDetail(planId, devId), appEmojis()]);
  return planMessage(plan, emojis);
}

/** Cuántos planes con botones caben (cada fila = 3 componentes de los 40 del mensaje). */
const MAX_PLAN_ROWS = 3;
const MAX_PLAN_LINES = 20;

/** Los planes del actor (efímero): una línea por plan y botones para los que esperan su aprobación. */
export function myPlansMessage(plans: AgentPlanSummary[], devId: string): OutgoingMessage {
  const sorted = [...plans].sort(byRelevance(devId));
  const lines = sorted.slice(0, MAX_PLAN_LINES).map((p) => {
    const link = planLink(p.id);
    const name = inline(p.issue.name, 60);
    const pr = p.prUrl ? ` · [PR](${p.prUrl})` : '';
    return `${dot(planTone(p.status, !!p.error))} \`${p.identifier}\` ${link ? `[${name}](${link})` : name} · ${statusLabel(p)}${pr}`;
  });
  const waiting = sorted.filter((p) => p.actions.includes('aprobar') || p.actions.includes('pedir_cambios'));
  const rows: ActionRowComponent[] = waiting.slice(0, MAX_PLAN_ROWS).map((p) =>
    row(
      ...[
        ...(p.actions.includes('aprobar') ? [button({ label: `Aprobar ${p.identifier}`, customId: buildCustomId('plan.aprobar', p.id), style: 'success' })] : []),
        ...(p.actions.includes('pedir_cambios')
          ? [button({ label: `Pedir cambios ${p.identifier}`, customId: buildCustomId('plan.cambios', p.id), style: 'secondary' })]
          : []),
      ],
    ),
  );
  const summary = plans.length
    ? [`${plans.length} plan${plans.length === 1 ? '' : 'es'}`, waiting.length ? `${waiting.length} esperan tu decisión` : null].filter(Boolean).join(' · ')
    : 'No tienes planes del agente vivos ni terminados esta semana.';
  const extra = plans.length > lines.length ? `\n-# …y ${plans.length - lines.length} más en roz.` : '';
  return v2Message([
    header('Tus planes del agente', summary),
    lines.length ? separator() : null,
    lines.length ? text(`${lines.join('\n')}${extra}`) : null,
    ...rows,
  ]);
}

export const handlers: HandlerModule = {
  slash: {
    plan: {
      defer: (ctx) => (ctx.options.issue ? 'public' : 'ephemeral'),
      async autocomplete(ctx) {
        const { plans } = await listPlans({ viewerDevId: ctx.actor.devId, scope: 'team' });
        return planChoices(plans, String(ctx.focused.value ?? ''), ctx.actor.devId);
      },
      async run(ctx) {
        const issue = typeof ctx.options.issue === 'string' ? ctx.options.issue : '';
        if (!issue.trim()) {
          const { plans } = await listPlans({ viewerDevId: ctx.actor.devId, scope: 'mine' });
          return ephemeral(myPlansMessage(plans, ctx.actor.devId));
        }
        const planId = await resolvePlanId(issue, ctx.actor.devId);
        return publicMessage(await planCard(planId, ctx.actor.devId));
      },
    },
  },
  components: {
    'plan.aprobar': {
      defer: 'update',
      async run(ctx) {
        const planId = ctx.customId.args[0]!;
        const actor = planActor(ctx.actor);
        await approvePlan(planId, actor);
        ctx.log('discord: plan aprobado', { planId });
        return updateMessage(await planCard(planId, actor.devId));
      },
    },
    'plan.cambios': {
      defer: 'never',
      async run(ctx) {
        const planId = ctx.customId.args[0]!;
        return openModal(
          modal(buildCustomId('plan.cambios.modal', planId), 'Pedir cambios al plan', [
            textField({
              customId: 'comentario',
              label: 'Qué tiene que cambiar',
              description: 'El agente replanea con este comentario.',
              paragraph: true,
              minLength: 1,
              maxLength: FEEDBACK_MAX,
              placeholder: 'Ej.: no toques la migración; usa el endpoint existente.',
            }),
          ]),
        );
      },
    },
  },
  modals: {
    'plan.cambios.modal': {
      defer: 'update',
      async run(ctx) {
        const planId = ctx.customId.args[0]!;
        const raw = ctx.fields.comentario;
        const comment = (Array.isArray(raw) ? raw.join('\n') : raw ?? '').trim();
        const actor = planActor(ctx.actor);
        await requestChanges(planId, actor, comment);
        ctx.log('discord: cambios pedidos al plan', { planId, chars: comment.length });
        return updateMessage(await planCard(planId, actor.devId));
      },
    },
  },
};
