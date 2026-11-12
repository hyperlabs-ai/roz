// Comandos de /roz ejecutados DESDE roz (compositor del chat de Discord dentro de roz; contrato
// docs/discord-commands-contract.md §9). Paridad con Discord sin duplicar lógica: se corre el MISMO
// handler del registro con un contexto armado aquí (no hay interacción real ni token), y lo que el
// handler devuelve (`Reply`) se reparte así:
//
//   · mensaje público / followup público → se publica en el canal por el webhook de roz con el nombre
//     y la foto del dev, como cualquier mensaje enviado desde roz (queda en el espejo y se emite);
//   · efímero / followup efímero / `update` → se devuelve al front sin publicar (pulso, infra,
//     errores esperados, "publicado", la confirmación de la junta…).
//
// Lo que en Discord es un modal aquí lo pide el front con su propia UI y llega como `fields`:
//   · ticket → modal `ticket.modal`  (campos `titulo`, `descripcion`; proyecto como opción o campo);
//   · junta  → modal `junta.modal`   (campos `titulo`, `notas`);
//   · status → select `status.elegir` (campo `tareas` = ids; `nota` opcional, va como texto del status).
// El resto (tarea, plan, pulso, infra) es el `run` del subcomando con sus opciones.
//
// No pasa por el router: la identidad sale de la sesión (el dev de roz) y debe coincidir con el
// vínculo de Discord (resolveActor), y el canal se valida con los permisos del espejo como el envío
// normal (`send` para lo que publica).
import { buildAllowedMentions, executeWebhook, type DiscordApiMessage } from '../../adapters/discord.js';
import { db } from '../../db/supabase.js';
import { AppError, ValidationError } from '../../utils/errors.js';
import { inBackground } from '../../utils/background.js';
import { config } from '../../config.js';
import {
  TEXT_CHANNEL_TYPES,
  isThreadType,
  type DiscordChannelRow,
  type DiscordEmbed,
  type DiscordMessageView,
} from '../../types/discord.js';
import { assertChannelVisible, notLinkedError, type Viewer } from '../access.js';
import { DISCORD_CANNOT_SEND, DISCORD_CHANNEL_UNSUPPORTED, DISCORD_THREAD_LOCKED } from '../errors.js';
import { rowFromSend, webhookAvatar } from '../messages.js';
import { normalizeEmbed } from '../normalize.js';
import { broadcastMessage } from '../realtime.js';
import { webhookChannelOf } from '../store.js';
import { buildMessageViews } from '../views.js';
import { withWebhook } from '../webhooks.js';
import { CUSTOM_ID_SPECS, buildCustomId, type CustomIdAction, type ParsedCustomId } from './custom-id.js';
import { commandMenu, ROZ_COMMAND_NAME, ROZ_SUBCOMMAND_DEFS, type CommandMenuItem, type RozSubcommand } from './definitions.js';
import { REGISTRY, type Registry } from './registry.js';
import { LIMITS, NOT_LINKED_CHOICE_VALUE, clampChoices, clip } from './respond.js';
import { resolveActor } from './router.js';
import { fitV2, flattenV2, isV2Message, toV2, v2ToEmbed } from './v2.js';
import {
  BUTTON_STYLE,
  COMPONENT_TYPE,
  COMPONENTS_V2_FLAG,
  INTERACTION_TYPE,
  OPTION_TYPE,
  type AutocompleteChoice,
  type BaseContext,
  type CommandActor,
  type DiscordInteraction,
  type DiscordInteractionData,
  type OptionValues,
  type OutgoingMessage,
  type Reply,
} from './types.js';

// ================================================================ forma de la API

/** Lo que manda el front: subcomando, opciones (como en Discord) y los campos del "modal". */
export interface RozCommandInput {
  subcommand: RozSubcommand;
  options?: Record<string, string>;
  fields?: Record<string, string | string[]>;
}

/** Mensaje que solo ve quien usó el comando (lo que en Discord sería efímero). */
export interface RozEphemeralMessage {
  content: string;
  embeds: DiscordEmbed[];
  /** Botones de enlace del mensaje (p. ej. "Abrir en roz"); los demás botones no aplican en roz. */
  links: { label: string; url: string }[];
}

export interface RozCommandResult {
  /** Mensajes publicados en el canal (ya en el espejo; también llegan por tiempo real). */
  published: DiscordMessageView[];
  ephemeral: RozEphemeralMessage[];
}

export interface RozAutocompleteInput {
  subcommand: RozSubcommand;
  /** Opción que se está escribiendo. */
  option: string;
  value: string;
  /** Las demás opciones ya llenas (p. ej. `persona` mientras se escribe `buscar`). */
  options?: Record<string, string>;
}

/** Códigos de error propios de esta superficie. */
export const DISCORD_COMMAND_UNSUPPORTED = 'DISCORD_COMMAND_UNSUPPORTED';
export const DISCORD_COMMAND_IDENTITY = 'DISCORD_COMMAND_IDENTITY';

/** Topes de los campos que en Discord son de un modal (los mismos de Discord: 4000 por campo). */
export const FIELD_LIMITS = { titulo: 200, descripcion: LIMITS.textInputMax, notas: LIMITS.textInputMax, nota: 2000 } as const;
/** status.elegir es un select de Discord: ≤ 25 valores. */
export const STATUS_MAX_TASKS = LIMITS.selectOptions;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FromRozDeps {
  registry: Registry;
  resolveActor: (discordUserId: string) => Promise<CommandActor | null>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Publica un mensaje en el canal por el webhook del dev (inyectable en pruebas). */
  publish: (viewer: Viewer, actor: CommandActor, channel: DiscordChannelRow, message: OutgoingMessage) => Promise<DiscordMessageView>;
}

function deps(over: Partial<FromRozDeps>): FromRozDeps {
  return {
    registry: over.registry ?? REGISTRY,
    resolveActor: over.resolveActor ?? resolveActor,
    log: over.log ?? (() => {}),
    publish: over.publish ?? publishOutgoing,
  };
}

/** Menú "/" del compositor: la misma lista y descripciones que el desplegable de Discord. */
export function rozCommandMenu(): CommandMenuItem[] {
  return commandMenu();
}

// ================================================================ identidad y canal

/** El actor es el dev de la sesión, visto por su vínculo de Discord (lo mismo que haría el router). */
async function actorFor(viewer: Viewer, d: FromRozDeps): Promise<CommandActor> {
  const actor = await d.resolveActor(viewer.link.discord_user_id);
  if (!actor) throw notLinkedError();
  if (actor.devId.toLowerCase() !== viewer.devId.toLowerCase()) {
    throw new AppError(DISCORD_COMMAND_IDENTITY, 'Tu cuenta de Discord está ligada a otra persona de roz.', 403);
  }
  return actor;
}

function assertCanPublish(channel: DiscordChannelRow, canSend: boolean): void {
  if (!TEXT_CHANNEL_TYPES.has(channel.type) && !isThreadType(channel.type)) {
    throw new AppError(DISCORD_CHANNEL_UNSUPPORTED, 'En este tipo de canal no se puede escribir desde roz.', 400);
  }
  if (!canSend) {
    if (isThreadType(channel.type) && channel.locked) throw new AppError(DISCORD_THREAD_LOCKED, 'El hilo está bloqueado.', 409);
    throw new AppError(DISCORD_CANNOT_SEND, 'No tienes permiso para escribir en este canal.', 403);
  }
}

/** ¿Este uso puede publicar en el canal? (si sí, se exige `send` ANTES de crear nada). */
export function mayPublish(subcommand: RozSubcommand, options: Record<string, string>): boolean {
  if (subcommand === 'tarea' || subcommand === 'ticket' || subcommand === 'status') return true;
  if (subcommand === 'plan') return !!options.issue;
  return false;
}

// ================================================================ entrada

/** Solo las opciones que define el subcomando, recortadas a su max_length; las requeridas, presentes. */
export function cleanOptions(subcommand: RozSubcommand, raw: Record<string, unknown> | undefined): Record<string, string> {
  const defs = ROZ_SUBCOMMAND_DEFS[subcommand].options ?? [];
  const out: Record<string, string> = {};
  for (const def of defs) {
    const v = raw?.[def.name];
    const text = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
    if (text) out[def.name] = def.max_length ? text.slice(0, def.max_length) : text;
    else if (def.required) throw new ValidationError(`falta «${def.name}»: ${def.description}`);
  }
  return out;
}

function textField(fields: Record<string, string | string[]> | undefined, name: string, max: number, required: boolean, label: string): string {
  const v = fields?.[name];
  const text = (Array.isArray(v) ? v.join('\n') : (v ?? '')).trim();
  if (!text && required) throw new ValidationError(`falta ${label}`);
  if (text.length > max) throw new ValidationError(`${label} pasa de ${max} caracteres`);
  return text;
}

function projectArg(options: Record<string, string>, fields: Record<string, string | string[]> | undefined): string | null {
  const fromField = typeof fields?.proyecto === 'string' ? fields.proyecto.trim() : '';
  const v = options.proyecto || fromField;
  if (!v) return null;
  if (!UUID_RE.test(v)) throw new ValidationError('elige el proyecto de la lista');
  return v;
}

// ================================================================ contexto sintético

const DISCORD_EPOCH = 1420070400000n;

/** Snowflake "de ahora" (los handlers no lo usan para el presupuesto; solo para que tenga forma válida). */
function nowSnowflake(): string {
  return ((BigInt(Date.now()) - DISCORD_EPOCH) << 22n).toString();
}

function syntheticInteraction(viewer: Viewer, actor: CommandActor, channel: DiscordChannelRow, type: number, data: DiscordInteractionData): DiscordInteraction {
  return {
    id: nowSnowflake(),
    application_id: config.discord.clientId,
    type,
    // Sin token: desde roz no hay interacción que contestar (los handlers nunca lo usan).
    token: '',
    guild_id: viewer.snap.guildId,
    channel_id: channel.id,
    channel: { id: channel.id, type: channel.type, name: channel.name, parent_id: channel.parent_id },
    member: { user: { id: actor.discordUserId, username: viewer.link.username, global_name: viewer.link.global_name, avatar: viewer.link.avatar } },
    data,
  };
}

function slashData(subcommand: RozSubcommand, options: OptionValues): DiscordInteractionData {
  return {
    name: ROZ_COMMAND_NAME,
    type: 1,
    options: [
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: subcommand,
        options: Object.entries(options).map(([name, value]) => ({ type: OPTION_TYPE.STRING, name, value })),
      },
    ],
  };
}

function customId(action: CustomIdAction, args: (string | null)[]): ParsedCustomId {
  // Misma forma que parseCustomId: los args en el orden de la spec.
  const spec = CUSTOM_ID_SPECS[action];
  return { action, args: spec.args.map((_, i) => args[i] ?? null) };
}

// ================================================================ ejecutar

/**
 * POST /api/dashboard/discord/channels/:channelId/commands. Corre el handler del subcomando como el
 * dev de la sesión y publica lo público por el webhook de roz. Errores esperados = AppError (< 500)
 * con un mensaje para la persona, como en Discord.
 */
export async function runCommandFromRoz(
  viewer: Viewer,
  channelId: string,
  input: RozCommandInput,
  over: Partial<FromRozDeps> = {},
): Promise<RozCommandResult> {
  const d = deps(over);
  const { channel, abilities } = assertChannelVisible(viewer, channelId);
  const subcommand = input.subcommand;
  const options = cleanOptions(subcommand, input.options);
  const publishes = mayPublish(subcommand, options);
  if (publishes) assertCanPublish(channel, abilities.send);
  const actor = await actorFor(viewer, d);

  const base: BaseContext = {
    interaction: syntheticInteraction(viewer, actor, channel, INTERACTION_TYPE.APPLICATION_COMMAND, slashData(subcommand, options)),
    actor,
    guildId: viewer.snap.guildId,
    channelId: channel.id,
    log: d.log,
  };

  let reply: Reply;
  let statusNote = '';
  if (subcommand === 'ticket' || subcommand === 'junta') {
    const action: CustomIdAction = subcommand === 'ticket' ? 'ticket.modal' : 'junta.modal';
    const handler = d.registry.modals[action];
    if (!handler) throw unsupported();
    const project = projectArg(options, input.fields);
    const fields: Record<string, string | string[]> =
      subcommand === 'ticket'
        ? {
            titulo: textField(input.fields, 'titulo', FIELD_LIMITS.titulo, true, 'el título'),
            descripcion: textField(input.fields, 'descripcion', FIELD_LIMITS.descripcion, false, 'la descripción'),
          }
        : {
            titulo: textField(input.fields, 'titulo', FIELD_LIMITS.titulo, true, 'el título'),
            notas: textField(input.fields, 'notas', FIELD_LIMITS.notas, true, 'las notas'),
          };
    // Con el proyecto como argumento del modal (lo que en Discord sale de la opción); sin él, el
    // handler usa el del canal o el campo `proyecto` (el select del modal).
    if (project) fields.proyecto = project;
    const id = customId(action, [project]);
    reply = await handler.run({
      ...base,
      interaction: { ...base.interaction, type: INTERACTION_TYPE.MODAL_SUBMIT, data: { custom_id: buildCustomId(action, project), components: [] } },
      customId: id,
      fields,
      message: null,
    });
  } else if (subcommand === 'status') {
    const handler = d.registry.components['status.elegir'];
    if (!handler) throw unsupported();
    const raw = input.fields?.tareas;
    const ids = [...new Set((Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []).map((s) => s.trim()).filter(Boolean))];
    if (!ids.length) throw new ValidationError('elige al menos una tarea');
    if (ids.length > STATUS_MAX_TASKS) throw new ValidationError(`el status admite hasta ${STATUS_MAX_TASKS} tareas`);
    if (ids.some((x) => !UUID_RE.test(x))) throw new ValidationError('tarea inválida');
    statusNote = textField(input.fields, 'nota', FIELD_LIMITS.nota, false, 'la nota');
    reply = await handler.run({
      ...base,
      interaction: {
        ...base.interaction,
        type: INTERACTION_TYPE.MESSAGE_COMPONENT,
        data: { custom_id: buildCustomId('status.elegir'), component_type: COMPONENT_TYPE.STRING_SELECT, values: ids },
      },
      customId: customId('status.elegir', []),
      values: ids,
      message: null,
    });
  } else {
    const handler = d.registry.slash[subcommand];
    if (!handler) throw unsupported();
    reply = await handler.run({ ...base, subcommand, options });
  }

  return settle(reply, { viewer, actor, channel, canPublish: publishes, statusNote }, d);
}

function unsupported(): AppError {
  return new AppError(DISCORD_COMMAND_UNSUPPORTED, 'Este comando todavía no se puede usar desde roz.', 400);
}

interface SettleCtx {
  viewer: Viewer;
  actor: CommandActor;
  channel: DiscordChannelRow;
  canPublish: boolean;
  statusNote: string;
}

/** Reparte el Reply: lo público al canal, lo efímero de vuelta al front. */
async function settle(reply: Reply, s: SettleCtx, d: FromRozDeps): Promise<RozCommandResult> {
  const out: RozCommandResult = { published: [], ephemeral: [] };
  if (reply.kind === 'modal' || reply.kind === 'choices') {
    // Un handler que pide otro modal (o devuelve choices) no se puede completar sin Discord.
    d.log('discord: comando desde roz devolvió algo que solo existe en Discord', { kind: reply.kind });
    throw unsupported();
  }
  const pending: { message: OutgoingMessage; ephemeral: boolean }[] = [
    { message: reply.message, ephemeral: reply.kind === 'update' ? true : reply.ephemeral },
    ...(reply.followups ?? []),
  ];
  let noteUsed = !s.statusNote;
  for (const p of pending) {
    if (p.ephemeral || !s.canPublish) {
      out.ephemeral.push(ephemeralView(p.message));
      continue;
    }
    let message = p.message;
    if (!noteUsed) {
      // La nota del status va como texto del mensaje publicado (Discord no tiene campo de nota): en un
      // mensaje V2 queda como primer texto del Container (toV2 lo acomoda).
      message = { ...message, content: clip([s.statusNote, message.content ?? ''].filter(Boolean).join('\n\n'), LIMITS.content) };
      noteUsed = true;
    }
    if (isEmpty(message)) continue;
    out.published.push(await d.publish(s.viewer, s.actor, s.channel, message));
  }
  return out;
}

function isEmpty(m: OutgoingMessage): boolean {
  return !m.content?.trim() && !m.embeds?.length && !isV2Message(m);
}

/**
 * Lo efímero como lo pinta el front: texto, embeds normalizados y los botones de enlace. Un mensaje
 * en Components V2 (las fichas) se aplana en UN embed, como lo guarda el espejo.
 */
export function ephemeralView(m: OutgoingMessage): RozEphemeralMessage {
  if (isV2Message(m)) {
    const flat = flattenV2(m.components);
    const embed = v2ToEmbed(m.components);
    return { content: m.content ?? '', embeds: embed ? [normalizeEmbed(embed)] : [], links: flat.links };
  }
  const links: { label: string; url: string }[] = [];
  for (const row of m.components ?? []) {
    if (row.type !== COMPONENT_TYPE.ACTION_ROW) continue;
    for (const c of row.components) {
      if (c.type === COMPONENT_TYPE.BUTTON && c.style === BUTTON_STYLE.LINK && c.url && /^https?:\/\//i.test(c.url)) {
        links.push({ label: c.label ?? 'Abrir', url: c.url });
      }
    }
  }
  return { content: m.content ?? '', embeds: (m.embeds ?? []).slice(0, LIMITS.embeds).map(normalizeEmbed), links };
}

// ================================================================ publicar por el webhook

async function upsertMessageRow(row: ReturnType<typeof rowFromSend>): Promise<void> {
  const { error } = await db().from('discord_message').upsert(row, { onConflict: 'id' });
  if (error) throw error;
}

/**
 * Publica un OutgoingMessage (texto, embeds y componentes) en el canal por el webhook de roz con el
 * nombre y la foto del dev, lo registra en el espejo (como sendDiscordMessage) y lo emite.
 * allowed_mentions: solo los usuarios de `mentionUserIds` (nunca roles ni @everyone).
 */
export async function publishOutgoing(viewer: Viewer, actor: CommandActor, channel: DiscordChannelRow, message: OutgoingMessage): Promise<DiscordMessageView> {
  const threadId = isThreadType(channel.type) ? channel.id : null;
  // Igual que en las respuestas a interacciones: Components V2 (el webhook es de la app, los admite).
  const components = fitV2(toV2({ ...message, embeds: (message.embeds ?? []).slice(0, LIMITS.embeds) }));
  const res: DiscordApiMessage = await withWebhook(webhookChannelOf(channel), (hook) =>
    executeWebhook({
      webhookId: hook.webhookId,
      token: hook.token,
      content: '',
      username: actor.devName,
      avatarUrl: webhookAvatar({ name: actor.devName, github_login: actor.githubLogin }, viewer.link),
      allowedMentions: buildAllowedMentions(message.mentionUserIds ?? []),
      threadId,
      flags: COMPONENTS_V2_FLAG,
      components,
    }),
  );
  const row = rowFromSend(res, viewer.snap.guildId, { devId: viewer.devId, clientNonce: null, replyToId: null });
  await upsertMessageRow(row);
  const [view] = await buildMessageViews([row], viewer.snap, { refreshAttachments: false });
  inBackground(() => broadcastMessage(viewer.snap, 'discord.message.created', view!));
  return view!;
}

// ================================================================ autocompletado

/**
 * POST /api/dashboard/discord/channels/:channelId/commands/autocomplete. El MISMO autocompletado que
 * en Discord (handler.autocomplete). Sin autocompletado en el handler (o la opción no lo tiene) → [].
 */
export async function autocompleteFromRoz(
  viewer: Viewer,
  channelId: string,
  input: RozAutocompleteInput,
  over: Partial<FromRozDeps> = {},
): Promise<AutocompleteChoice[]> {
  const d = deps(over);
  const { channel } = assertChannelVisible(viewer, channelId);
  const def = (ROZ_SUBCOMMAND_DEFS[input.subcommand].options ?? []).find((o) => o.name === input.option);
  const handler = d.registry.slash[input.subcommand];
  if (!def?.autocomplete || !handler?.autocomplete) return [];
  const actor = await actorFor(viewer, d);
  const options: OptionValues = {};
  for (const o of ROZ_SUBCOMMAND_DEFS[input.subcommand].options ?? []) {
    const v = input.options?.[o.name]?.trim();
    if (v && o.name !== input.option) options[o.name] = v.slice(0, o.max_length ?? 100);
  }
  const value = String(input.value ?? '').slice(0, def.max_length ?? 100);
  const data = slashData(input.subcommand, { ...options, [input.option]: value });
  const list = await handler.autocomplete({
    interaction: syntheticInteraction(viewer, actor, channel, INTERACTION_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE, data),
    actor,
    guildId: viewer.snap.guildId,
    channelId: channel.id,
    log: d.log,
    subcommand: input.subcommand,
    focused: { name: input.option, value },
    options,
  });
  return clampChoices(list).filter((c) => c.value !== NOT_LINKED_CHOICE_VALUE);
}
