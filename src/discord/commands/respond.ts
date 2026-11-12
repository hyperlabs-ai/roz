// Respuestas a interacciones de Discord: constructores de `Reply` para los handlers, componentes
// (botones, selects, campos de modal), la conversión `Reply` → callback de Discord, y cómo roz
// completa lo diferido con el token de la interacción (REST de src/adapters/discord.ts).
//
// Reglas que se aplican SIEMPRE aquí, para que ningún handler las olvide:
//   · todo mensaje sale en Components V2 (v2.ts): un Container con el naranja de roz;
//   · allowed_mentions sin @everyone/@here/roles (solo suenan los usuarios que el handler lista);
//   · topes de Discord (2000 de contenido, 10 embeds, 5 filas, 25 opciones/choices, 100 por valor…):
//     se recorta en vez de dejar que Discord rechace la respuesta entera;
//   · los errores al usuario nunca llevan tokens ni detalle crudo (errorReply).
import {
  DISCORD_ERROR,
  buildAllowedMentions,
  createInteractionFollowup,
  editInteractionOriginal,
  isDiscordError,
  type DiscordApiEmbed,
  type InteractionCallbackBody,
  type InteractionMessageBody,
} from '../../adapters/discord.js';
import { AppError } from '../../utils/errors.js';
import { appLink } from './links.js';
import { fitV2, notice, toV2 } from './v2.js';
import {
  BUTTON_STYLE,
  CALLBACK_TYPE,
  COMPONENT_TYPE,
  COMPONENTS_V2_FLAG,
  EPHEMERAL_FLAG,
  INTERACTION_TYPE,
  TEXT_INPUT_STYLE,
  type ActionRowComponent,
  type AutocompleteChoice,
  type ButtonComponent,
  type DeferMode,
  type DiscordSubmittedComponent,
  type FollowupMessage,
  type LabelComponent,
  type Modal,
  type ModalComponent,
  type OutgoingMessage,
  type Reply,
  type SelectOption,
  type StringSelectComponent,
  type TextDisplayComponent,
} from './types.js';

// ================================================================ topes de Discord

export const LIMITS = {
  content: 2000,
  embeds: 10,
  rows: 5,
  buttonsPerRow: 5,
  buttonLabel: 80,
  selectOptions: 25,
  selectLabel: 100,
  selectValue: 100,
  selectDescription: 100,
  placeholder: 150,
  choices: 25,
  choiceName: 100,
  choiceValue: 100,
  modalTitle: 45,
  modalComponents: 5,
  fieldLabel: 45,
  fieldDescription: 100,
  textInputMax: 4000,
  textInputPlaceholder: 100,
} as const;

/** Recorta con "…" si pasa del tope. */
export function clip(text: string, max: number): string {
  const t = text ?? '';
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

// ================================================================ constructores de Reply

function asMessage(msg: string | OutgoingMessage): OutgoingMessage {
  return typeof msg === 'string' ? { content: msg } : msg;
}

/** Solo lo ve quien usó el comando (consultas, búsquedas, errores). */
export function ephemeral(msg: string | OutgoingMessage, followups?: FollowupMessage[]): Reply {
  return { kind: 'message', message: asMessage(msg), ephemeral: true, ...(followups?.length ? { followups } : {}) };
}

/** Lo ve el canal (fichas, status, tickets creados). */
export function publicMessage(msg: string | OutgoingMessage, followups?: FollowupMessage[]): Reply {
  return { kind: 'message', message: asMessage(msg), ephemeral: false, ...(followups?.length ? { followups } : {}) };
}

/** Edita el mensaje del componente (p. ej. la ficha tras "Tomar"). */
export function updateMessage(msg: string | OutgoingMessage, followups?: FollowupMessage[]): Reply {
  return { kind: 'update', message: asMessage(msg), ...(followups?.length ? { followups } : {}) };
}

export function openModal(modal: Modal): Reply {
  return { kind: 'modal', modal };
}

export function choices(list: AutocompleteChoice[]): Reply {
  return { kind: 'choices', choices: clampChoices(list) };
}

/** Followup para mandar después de la respuesta inicial. */
export function followup(msg: string | OutgoingMessage, opts: { ephemeral: boolean }): FollowupMessage {
  return { message: asMessage(msg), ephemeral: opts.ephemeral };
}

/** ≤ 25 choices, nombre y valor de 1..100 (los vacíos se descartan: Discord rechazaría todo). */
export function clampChoices(list: AutocompleteChoice[]): AutocompleteChoice[] {
  const out: AutocompleteChoice[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    const name = clip(String(c.name ?? '').trim(), LIMITS.choiceName);
    const value = String(c.value ?? '');
    if (!name || !value || value.length > LIMITS.choiceValue || seen.has(value)) continue;
    seen.add(value);
    out.push({ name, value });
    if (out.length === LIMITS.choices) break;
  }
  return out;
}

// ================================================================ componentes

export function row(...components: Array<ButtonComponent | StringSelectComponent>): ActionRowComponent {
  return { type: COMPONENT_TYPE.ACTION_ROW, components };
}

export function button(input: {
  label: string;
  customId: string;
  style?: 'primary' | 'secondary' | 'success' | 'danger';
  disabled?: boolean;
  emoji?: string;
}): ButtonComponent {
  const style = { primary: BUTTON_STYLE.PRIMARY, secondary: BUTTON_STYLE.SECONDARY, success: BUTTON_STYLE.SUCCESS, danger: BUTTON_STYLE.DANGER }[
    input.style ?? 'secondary'
  ];
  return {
    type: COMPONENT_TYPE.BUTTON,
    style,
    label: clip(input.label, LIMITS.buttonLabel),
    custom_id: input.customId,
    ...(input.disabled ? { disabled: true } : {}),
    ...(input.emoji ? { emoji: { name: input.emoji } } : {}),
  };
}

/** Botón que abre una URL. Solo http(s): Discord rechaza el mensaje con otra cosa. */
export function linkButton(label: string, url: string): ButtonComponent | null {
  if (!/^https?:\/\//i.test(url)) return null;
  return { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.LINK, label: clip(label, LIMITS.buttonLabel), url };
}

function cleanOptions(options: SelectOption[]): SelectOption[] {
  const seen = new Set<string>();
  const out: SelectOption[] = [];
  for (const o of options) {
    if (!o.value || o.value.length > LIMITS.selectValue || seen.has(o.value)) continue;
    seen.add(o.value);
    out.push({
      label: clip(o.label || o.value, LIMITS.selectLabel),
      value: o.value,
      ...(o.description ? { description: clip(o.description, LIMITS.selectDescription) } : {}),
      ...(o.default ? { default: true } : {}),
    });
    if (out.length === LIMITS.selectOptions) break;
  }
  return out;
}

export function stringSelect(input: {
  customId: string;
  options: SelectOption[];
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  disabled?: boolean;
}): StringSelectComponent {
  const options = cleanOptions(input.options);
  const max = Math.max(1, Math.min(input.maxValues ?? 1, options.length || 1, LIMITS.selectOptions));
  const min = Math.max(0, Math.min(input.minValues ?? 1, max));
  return {
    type: COMPONENT_TYPE.STRING_SELECT,
    custom_id: input.customId,
    options,
    ...(input.placeholder ? { placeholder: clip(input.placeholder, LIMITS.placeholder) } : {}),
    min_values: min,
    max_values: max,
    ...(input.disabled ? { disabled: true } : {}),
  };
}

/** Campo de texto de un modal (Label + TextInput, la forma actual de los modales de Discord). */
export function textField(input: {
  customId: string;
  label: string;
  description?: string;
  paragraph?: boolean;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  value?: string;
  placeholder?: string;
}): LabelComponent {
  const max = Math.min(input.maxLength ?? LIMITS.textInputMax, LIMITS.textInputMax);
  return {
    type: COMPONENT_TYPE.LABEL,
    label: clip(input.label, LIMITS.fieldLabel),
    ...(input.description ? { description: clip(input.description, LIMITS.fieldDescription) } : {}),
    component: {
      type: COMPONENT_TYPE.TEXT_INPUT,
      custom_id: input.customId,
      style: input.paragraph ? TEXT_INPUT_STYLE.PARAGRAPH : TEXT_INPUT_STYLE.SHORT,
      required: input.required ?? true,
      ...(input.minLength !== undefined ? { min_length: Math.max(0, Math.min(input.minLength, max)) } : {}),
      max_length: max,
      ...(input.value ? { value: clip(input.value, max) } : {}),
      ...(input.placeholder ? { placeholder: clip(input.placeholder, LIMITS.textInputPlaceholder) } : {}),
    },
  };
}

/** Select dentro de un modal (Label + StringSelect). */
export function selectField(input: {
  customId: string;
  label: string;
  description?: string;
  options: SelectOption[];
  required?: boolean;
  placeholder?: string;
}): LabelComponent {
  const select = stringSelect({ customId: input.customId, options: input.options, placeholder: input.placeholder, minValues: input.required === false ? 0 : 1 });
  return {
    type: COMPONENT_TYPE.LABEL,
    label: clip(input.label, LIMITS.fieldLabel),
    ...(input.description ? { description: clip(input.description, LIMITS.fieldDescription) } : {}),
    component: { ...select, required: input.required ?? true },
  };
}

export function textDisplay(content: string): TextDisplayComponent {
  return { type: COMPONENT_TYPE.TEXT_DISPLAY, content: clip(content, 4000) };
}

export function modal(customId: string, title: string, components: ModalComponent[]): Modal {
  return { custom_id: customId, title: clip(title, LIMITS.modalTitle), components: components.slice(0, LIMITS.modalComponents) };
}

/**
 * Campos de un MODAL_SUBMIT por custom_id. Entiende la forma nueva (Label → `component`) y la vieja
 * (fila → `components`). Texto → string; select → string[].
 */
export function readModalFields(components: DiscordSubmittedComponent[] | undefined): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const visit = (c: DiscordSubmittedComponent | undefined) => {
    if (!c) return;
    if (c.custom_id) {
      if (Array.isArray(c.values)) out[c.custom_id] = c.values.map(String);
      else if (typeof c.value === 'string') out[c.custom_id] = c.value;
    }
    if (c.component) visit(c.component);
    for (const child of c.components ?? []) visit(child);
  };
  for (const c of components ?? []) visit(c);
  return out;
}

// ================================================================ Reply → Discord

/**
 * Cuerpo de mensaje para Discord: SIEMPRE Components V2 (flag IS_COMPONENTS_V2, sin content ni
 * embeds; un mensaje clásico se envuelve en el Container de roz con `toV2`), recortado a los topes
 * (`fitV2`), allowed_mentions seguro y el flag efímero si toca.
 *
 * `edit` = el cuerpo EDITA un mensaje que ya existe (callback type 7, PATCH @original): ahí Discord
 * exige vaciar content (null) y embeds ([]) al poner el flag, o rechaza la edición con 400. Así una
 * ficha vieja (con embeds) se convierte a V2 cuando alguien aprieta "Tomar".
 */
export function toMessageBody(msg: OutgoingMessage, ephemeralFlag = false, edit = false): InteractionMessageBody {
  const body: InteractionMessageBody = {
    components: fitV2(toV2({ ...msg, embeds: (msg.embeds ?? []).slice(0, LIMITS.embeds) as DiscordApiEmbed[] })),
    allowed_mentions: buildAllowedMentions(msg.mentionUserIds ?? []),
    flags: COMPONENTS_V2_FLAG | (ephemeralFlag ? EPHEMERAL_FLAG : 0),
  };
  if (edit) {
    body.content = null;
    body.embeds = [];
  }
  return body;
}

/** ¿El tipo de interacción admite type 6/7 (editar el mensaje del componente)? */
export function canUpdate(interactionType: number, hasMessage: boolean): boolean {
  return interactionType === INTERACTION_TYPE.MESSAGE_COMPONENT || (interactionType === INTERACTION_TYPE.MODAL_SUBMIT && hasMessage);
}

/** Callback inmediato para un Reply ya listo. */
export function toCallback(reply: Reply, interactionType: number, hasMessage: boolean): InteractionCallbackBody {
  switch (reply.kind) {
    case 'choices':
      return { type: CALLBACK_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices: clampChoices(reply.choices) } };
    case 'modal':
      return { type: CALLBACK_TYPE.MODAL, data: { ...reply.modal } };
    case 'update':
      if (canUpdate(interactionType, hasMessage)) {
        return { type: CALLBACK_TYPE.UPDATE_MESSAGE, data: toMessageBody(reply.message, false, true) as Record<string, unknown> };
      }
      return { type: CALLBACK_TYPE.CHANNEL_MESSAGE_WITH_SOURCE, data: toMessageBody(reply.message, true) as Record<string, unknown> };
    case 'message':
      return { type: CALLBACK_TYPE.CHANNEL_MESSAGE_WITH_SOURCE, data: toMessageBody(reply.message, reply.ephemeral) as Record<string, unknown> };
  }
}

/** Modo de diferido efectivo: 'update' solo existe para componentes; en lo demás cae a efímero. */
export function effectiveDefer(mode: DeferMode, interactionType: number, hasMessage: boolean): Exclude<DeferMode, 'never'> | null {
  if (mode === 'never') return null;
  if (mode === 'update' && !canUpdate(interactionType, hasMessage)) return 'ephemeral';
  return mode;
}

/** Callback de "roz está pensando…" (type 5) o de "ya voy" sobre el componente (type 6). */
export function deferCallback(mode: Exclude<DeferMode, 'never'>): InteractionCallbackBody {
  if (mode === 'update') return { type: CALLBACK_TYPE.DEFERRED_UPDATE_MESSAGE };
  if (mode === 'ephemeral') return { type: CALLBACK_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } };
  return { type: CALLBACK_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE };
}

// ================================================================ completar lo diferido

export interface InteractionHandle {
  applicationId: string;
  token: string;
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * El PUENTE manda el callback inicial después de recibir la respuesta de roz, así que el trabajo en
 * segundo plano de roz puede llegar a Discord ANTES que ese callback: Discord responde "Unknown
 * Webhook/Message" (10015/10008) porque la interacción aún no está reconocida. Se reintenta un rato
 * corto; pasado eso, el error es real.
 */
const ACK_RETRIES = 8;
const ACK_RETRY_MS = 350;

export async function withAckRetry<T>(fn: () => Promise<T>, sleep: Sleep = realSleep): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const notYet = isDiscordError(err, DISCORD_ERROR.UNKNOWN_WEBHOOK) || isDiscordError(err, DISCORD_ERROR.UNKNOWN_MESSAGE);
      if (!notYet || attempt >= ACK_RETRIES) throw err;
      await sleep(ACK_RETRY_MS);
    }
  }
}

/**
 * Termina una interacción diferida con el resultado del handler:
 *   · diferido type 5 (ephemeral/public) → se edita ese mensaje; su visibilidad ya quedó fijada.
 *   · diferido type 6 (update) + `update` → se edita el mensaje del componente; + `message` → followup.
 *   · `modal`/`choices` ya no se pueden mandar tarde: se edita con un error.
 */
export async function completeDeferred(
  handle: InteractionHandle,
  mode: Exclude<DeferMode, 'never'>,
  reply: Reply,
  sleep: Sleep = realSleep,
): Promise<void> {
  const { applicationId, token } = handle;
  // Al editar el original, los flags que ya tenía (efímero) se repiten junto con IS_COMPONENTS_V2:
  // Discord pide mandar todos los bits ya puestos (y el efímero no se puede cambiar al editar).
  const editFlagsEphemeral = mode === 'ephemeral';
  if (reply.kind === 'modal' || reply.kind === 'choices') {
    const late = { content: 'roz tardó demasiado en responder. Intenta de nuevo.' };
    if (mode !== 'update') await withAckRetry(() => editInteractionOriginal(applicationId, token, toMessageBody(late, editFlagsEphemeral, true)), sleep);
    else await withAckRetry(() => createInteractionFollowup(applicationId, token, toMessageBody(late, true)), sleep);
    return;
  }
  if (mode === 'update' && reply.kind === 'message') {
    await withAckRetry(() => createInteractionFollowup(applicationId, token, toMessageBody(reply.message, reply.ephemeral)), sleep);
  } else {
    await withAckRetry(() => editInteractionOriginal(applicationId, token, toMessageBody(reply.message, editFlagsEphemeral, true)), sleep);
  }
  await sendFollowups(handle, reply, sleep);
}

/** Followups del Reply (después de la respuesta inicial, inmediata o diferida). */
export async function sendFollowups(handle: InteractionHandle, reply: Reply, sleep: Sleep = realSleep): Promise<void> {
  if (reply.kind !== 'message' && reply.kind !== 'update') return;
  for (const f of reply.followups ?? []) {
    await withAckRetry(() => createInteractionFollowup(handle.applicationId, handle.token, toMessageBody(f.message, f.ephemeral)), sleep);
  }
}

// ================================================================ respuestas fijas

/** Error para el usuario: nunca detalle crudo, nunca tokens. AppError trae un mensaje ya pensado para mostrarse. */
export function errorReply(err: unknown): Reply {
  if (err instanceof AppError && err.status < 500) return ephemeral(notice('bad', `No se pudo: ${clip(err.message, 300)}`));
  if (isDiscordError(err)) return ephemeral(notice('bad', 'Discord no respondió a roz.', 'Intenta de nuevo en un momento.'));
  return ephemeral(notice('bad', 'Algo falló en roz al hacer esto.', 'Intenta de nuevo; si sigue, avisa en el canal de roz.'));
}

/** Sin cuenta ligada: una frase y el botón a Configuración. */
export function notLinkedReply(): Reply {
  const url = appLink('/app/settings');
  const btn = url ? linkButton('Ligar mi cuenta en roz', url) : null;
  const where = url && !btn ? ` (${url})` : '';
  return ephemeral(
    notice('off', 'Tu cuenta de Discord no está ligada a roz.', `Lígala en roz → Configuración → Cuenta de Discord${where} y vuelve a intentarlo.`, btn ? [row(btn)] : []),
  );
}

/** Choice que aparece en el autocompletado cuando no hay cuenta ligada. */
export const NOT_LINKED_CHOICE_VALUE = '__ligar_cuenta__';
export function notLinkedChoices(): AutocompleteChoice[] {
  return [{ name: 'Liga tu cuenta de Discord en roz (Configuración) para usar /roz', value: NOT_LINKED_CHOICE_VALUE }];
}

export function wrongGuildReply(): Reply {
  return ephemeral('Los comandos de roz solo funcionan en el servidor de la empresa.');
}

export function oldComponentReply(): Reply {
  return ephemeral('Este botón es de una versión anterior de roz. Vuelve a usar el comando para tener una ficha nueva.');
}

export function notReadyReply(what: string): Reply {
  return ephemeral(`${what} todavía no está listo en roz.`);
}
