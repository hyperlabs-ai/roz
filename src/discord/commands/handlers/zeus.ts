// /roz bandeja · /roz linear · /roz crear — la bandeja de zeus y Linear desde Discord.
//
//   · bandeja: resumen EFÍMERO de lo que tienes pendiente: tickets activos de Linear, encargos y
//     planes abiertos, solicitudes por decidir, mensajes sin leer y avisos de variables. Solo
//     nombres de variables, nunca valores.
//   · linear [persona]: tickets activos (en curso y por hacer) de alguien, por defecto tú. EFÍMERO.
//   · crear [para]: modal (título, descripción, equipo, prioridad) → ticket en Linear asignado a
//     quien lo crea (o a `para`). Público: la ficha queda en el canal.
//
// Todo pasa por los mismos servicios que el MCP (src/zeus/linear.ts, src/zeus/inbox.ts): Linear
// se consulta en vivo y la atribución es la misma ("vía zeus · <nombre>").
import { linearEnabled } from '../../../adapters/linear.js';
import type { ZeusLinearIssue, ZeusMessage } from '../../../types/zeus.js';
import { ValidationError } from '../../../utils/errors.js';
import { actorForDev, type ZeusActor } from '../../../zeus/core.js';
import { getInbox } from '../../../zeus/inbox.js';
import { createIssueAs, linearCatalog, listIssues } from '../../../zeus/linear.js';
import { buildCustomId } from '../custom-id.js';
import { appLink } from '../links.js';
import { clip, ephemeral, linkButton, modal, openModal, publicMessage, row, selectField, textField } from '../respond.js';
import type { ButtonComponent, CommandActor, ContainerChild, HandlerModule } from '../types.js';
import { dot, header, inline, notice, relativeTime, separator, text, v2Message } from '../v2.js';
import { isUuid, optionText, personaChoices } from './tarea.js';

/** Por Discord no hay "via discord" en zeus: cuenta como la web (una persona con sesión). */
const zeusActor = (a: CommandActor): Promise<ZeusActor> => actorForDev(a.devId, 'web');

const PRIORITY_EMOJI = ['⚪', '🔴', '🟠', '🟡', '🔵'] as const;

/** Una línea por ticket: `HYP-12` título · estado · prioridad, con enlace. */
export function issueLine(i: ZeusLinearIssue): string {
  const prio = i.priority > 0 ? ` · ${PRIORITY_EMOJI[i.priority] ?? ''} ${i.priorityLabel}` : '';
  const project = i.project ? ` · ${inline(i.project, 40)}` : '';
  return `${dot(i.stateType === 'started' ? 'agent' : i.stateType === 'backlog' ? 'off' : 'wait')} [${i.identifier}](${i.url}) ${inline(i.title, 90)}\n-# ${i.state}${prio}${project}`;
}

const MAX_ISSUES = 8;
const MAX_ITEMS = 5;

function issueBlock(issues: ZeusLinearIssue[]): string {
  const shown = issues.slice(0, MAX_ISSUES).map(issueLine);
  const rest = issues.length - shown.length;
  return [...shown, ...(rest > 0 ? [`-# … y ${rest} más`] : [])].join('\n');
}

function messageLine(m: ZeusMessage): string {
  const when = relativeTime(m.createdAt);
  return `• **${inline(m.fromName, 40)}**: ${inline(m.subject ?? m.body, 90)}${when ? ` · ${when}` : ''}`;
}

const inboxButton = (): ButtonComponent | null => {
  const url = appLink('/bandeja');
  return url ? linkButton('Abrir la bandeja', url) : null;
};

// ---------------------------------------------------------------- resumen de la bandeja

async function bandejaMessage(actor: CommandActor) {
  const za = await zeusActor(actor);
  const [inbox, linear] = await Promise.all([
    getInbox(za, { limit: 30 }),
    linearEnabled() ? listIssues({ assignee: null }, za).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })) : Promise.resolve(null),
  ]);
  const unreadMsgs = inbox.messages.filter((m) => m.kind === 'message' && !m.readAt);
  const unreadEnvs = inbox.envChanges.filter((m) => !m.readAt);
  const decide = inbox.toResolve.filter((r) => r.status === 'pending');
  const issues = linear && 'issues' in linear ? linear.issues : [];

  const parts: ContainerChild[] = [
    header(`Tu bandeja, ${actor.devName.split(' ')[0]}`, [
      `${issues.length} en Linear`,
      `${inbox.open.length + decide.length} de zeus por atender`,
      `${unreadMsgs.length} sin leer`,
    ].join(' · ')),
    separator(),
    text(
      `**Linear**\n${
        !linear
          ? '-# zeus no tiene Linear conectado.'
          : 'error' in linear
            ? `-# Linear no respondió: ${inline(linear.error, 120)}`
            : issues.length
              ? issueBlock(issues)
              : '-# Sin tickets activos asignados a ti.'
      }`,
    ),
  ];
  if (inbox.open.length || decide.length) {
    const work = [
      ...inbox.open.slice(0, MAX_ITEMS).map((m) => `• ${m.kind === 'plan' ? 'Plan' : 'Encargo'} de **${inline(m.fromName, 40)}**: ${inline(m.subject ?? '(sin título)', 90)}`),
      ...decide.slice(0, MAX_ITEMS).map((r) => `• Solicitud de **${inline(r.requesterName, 40)}**: ${inline(r.title, 90)}`),
    ];
    parts.push(separator(), text(`**Por atender en zeus**\n${work.join('\n')}`));
  }
  if (unreadMsgs.length) {
    const more = unreadMsgs.length > MAX_ITEMS ? `\n-# … y ${unreadMsgs.length - MAX_ITEMS} más` : '';
    parts.push(separator(), text(`**Mensajes sin leer**\n${unreadMsgs.slice(0, MAX_ITEMS).map(messageLine).join('\n')}${more}`));
  }
  if (unreadEnvs.length) {
    const envs = unreadEnvs.slice(0, MAX_ITEMS).map((m) => `• ${inline(m.subject ?? '', 110)}`);
    parts.push(separator(), text(`**Variables que cambiaron**\n${envs.join('\n')}\n-# Ponte al día con \`zeus env status\` en tu PC.`));
  }
  if (inbox.waiting.length) parts.push(text(`-# Esperas respuesta de ${inbox.waiting.length} encargo(s) o plan(es) que mandaste.`));
  const btn = inboxButton();
  if (btn) parts.push(row(btn));
  return v2Message(parts);
}

// ---------------------------------------------------------------- crear ticket

const NO_PRIORITY = '0';
const PRIORITY_OPTIONS = [
  { label: 'Sin prioridad', value: NO_PRIORITY },
  { label: 'Urgente', value: '1' },
  { label: 'Alta', value: '2' },
  { label: 'Media', value: '3' },
  { label: 'Baja', value: '4' },
];

async function defaultTeamKey(): Promise<string | null> {
  const { teams } = await linearCatalog();
  return (teams.find((t) => t.key === 'HYP') ?? teams[0])?.key ?? null;
}

function field(fields: Record<string, string | string[]>, key: string): string {
  const v = fields[key];
  return (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();
}

export const handlers: HandlerModule = {
  slash: {
    bandeja: {
      defer: 'ephemeral',
      async run(ctx) {
        return ephemeral(await bandejaMessage(ctx.actor));
      },
    },
    linear: {
      defer: 'ephemeral',
      async autocomplete(ctx) {
        return ctx.focused.name === 'persona' ? personaChoices(ctx.focused.value) : [];
      },
      async run(ctx) {
        if (!linearEnabled()) return ephemeral(notice('off', 'zeus no tiene Linear conectado.'));
        const persona = optionText(ctx.options.persona);
        const za = await zeusActor(ctx.actor);
        const { assignee, issues } = await listIssues({ assignee: persona || null }, za);
        const started = issues.filter((i) => i.stateType === 'started').length;
        const backlog = issues.filter((i) => i.stateType === 'backlog').length;
        const btn = inboxButton();
        return ephemeral(
          v2Message([
            header(`Linear · ${assignee ?? 'sin asignar'}`, `${started} en curso · ${issues.length - started - backlog} por hacer · ${backlog} en backlog`),
            separator(),
            text(issues.length ? issueBlock(issues) : '-# Sin tickets activos.'),
            text('-# Para implementar uno, dile a Claude «implementa HYP-123»: lo trae completo por zeus.'),
            btn ? row(btn) : null,
          ]),
        );
      },
    },
    crear: {
      defer: 'never',
      async autocomplete(ctx) {
        return ctx.focused.name === 'para' ? personaChoices(ctx.focused.value) : [];
      },
      async run(ctx) {
        if (!linearEnabled()) return ephemeral(notice('off', 'zeus no tiene Linear conectado.'));
        const para = optionText(ctx.options.para);
        if (para && !isUuid(para)) throw new ValidationError('elige a la persona de la lista');
        // Los equipos vienen de caché (10 min): el modal tiene que abrirse dentro de los 3 s.
        const { teams } = await linearCatalog();
        const defaultTeam = teams.find((t) => t.key === 'HYP') ?? teams[0];
        return openModal(
          modal(buildCustomId('linear.crear.modal', para || null), 'Nuevo ticket en Linear', [
            textField({ customId: 'titulo', label: 'Título', maxLength: 255, placeholder: 'Qué hay que hacer' }),
            textField({
              customId: 'descripcion',
              label: 'Descripción',
              paragraph: true,
              required: false,
              maxLength: 4000,
              placeholder: 'Contexto y criterios de aceptación (markdown)',
            }),
            selectField({
              customId: 'equipo',
              label: 'Equipo',
              options: teams.map((t) => ({ label: `${t.name} (${t.key})`, value: t.key, ...(t.key === defaultTeam?.key ? { default: true } : {}) })),
            }),
            selectField({ customId: 'prioridad', label: 'Prioridad', required: false, options: PRIORITY_OPTIONS }),
          ]),
        );
      },
    },
  },
  modals: {
    'linear.crear.modal': {
      defer: 'public',
      async run(ctx) {
        const title = field(ctx.fields, 'titulo');
        if (!title) throw new ValidationError('el ticket necesita título');
        const za = await zeusActor(ctx.actor);
        const prio = Number(field(ctx.fields, 'prioridad') || NO_PRIORITY);
        const issue = await createIssueAs(
          {
            // Desde el compositor de roz no hay select de equipo: el mismo default que el modal.
            team: field(ctx.fields, 'equipo') || (await defaultTeamKey()),
            title,
            description: field(ctx.fields, 'descripcion') || null,
            // Sin `para` se asigna a quien lo crea (lo que hace createIssueAs con assignee vacío).
            assignee: ctx.customId.args[0] ?? null,
            priority: Number.isInteger(prio) && prio > 0 ? prio : null,
          },
          za,
        );
        const btn = linkButton('Abrir en Linear', issue.url);
        return publicMessage(
          v2Message([
            text(`${dot('ok')} **${ctx.actor.devName}** creó [${issue.identifier}](${issue.url}) · ${clip(issue.title, 150)}`),
            text(`-# ${issue.team} · ${issue.state}${issue.assignee ? ` · asignado a ${issue.assignee}` : ' · sin asignar'}${issue.priority > 0 ? ` · ${issue.priorityLabel}` : ''}`),
            btn ? row(btn) : null,
          ]),
        );
      },
    },
  },
};
