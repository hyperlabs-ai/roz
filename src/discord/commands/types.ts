// Tipos de los comandos de roz en Discord (/roz y las acciones de mensaje). Contrato completo en
// docs/discord-commands-contract.md. Aquí viven:
//   · el subconjunto del payload CRUDO de una interacción (snake_case, como lo manda el gateway y lo
//     reenvía el puente sin tocar);
//   · los componentes de mensaje/modal que roz arma (también en la forma de la API);
//   · los contextos que reciben los handlers y lo que devuelven (`Reply`);
//   · la forma de los handlers (lo que cada archivo de handlers/ exporta).
//
// La lógica de despacho está en router.ts; cómo se convierte un `Reply` en el callback de Discord,
// en respond.ts.
import type { DiscordApiEmbed, DiscordApiMessage, DiscordApiUser } from '../../adapters/discord.js';
import type { CustomIdAction, ParsedCustomId } from './custom-id.js';
import type { MessageCommandKey, RozSubcommand } from './definitions.js';

// ================================================================ payload crudo de Discord

/** InteractionType (https://discord.com/developers/docs/interactions/receiving-and-responding). */
export const INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

/** InteractionCallbackType: el `type` del cuerpo de POST /interactions/{id}/{token}/callback. */
export const CALLBACK_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
} as const;

/** ApplicationCommandType. */
export const COMMAND_TYPE = { CHAT_INPUT: 1, USER: 2, MESSAGE: 3 } as const;

/** ApplicationCommandOptionType. */
export const OPTION_TYPE = {
  SUB_COMMAND: 1,
  SUB_COMMAND_GROUP: 2,
  STRING: 3,
  INTEGER: 4,
  BOOLEAN: 5,
  USER: 6,
  CHANNEL: 7,
  ROLE: 8,
  MENTIONABLE: 9,
  NUMBER: 10,
  ATTACHMENT: 11,
} as const;

/** ComponentType. Label (18) es el contenedor de los componentes de un modal. */
export const COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_INPUT: 4,
  USER_SELECT: 5,
  SECTION: 9,
  TEXT_DISPLAY: 10,
  THUMBNAIL: 11,
  SEPARATOR: 14,
  CONTAINER: 17,
  LABEL: 18,
} as const;

export const BUTTON_STYLE = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5 } as const;
export const TEXT_INPUT_STYLE = { SHORT: 1, PARAGRAPH: 2 } as const;

/** MessageFlags.EPHEMERAL */
export const EPHEMERAL_FLAG = 64;
/** MessageFlags.IS_COMPONENTS_V2 (1 << 15): el mensaje es solo componentes (sin content ni embeds). */
export const COMPONENTS_V2_FLAG = 1 << 15;

export interface DiscordInteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordInteractionOption[];
  focused?: boolean;
}

/** Componente tal como vuelve en un MODAL_SUBMIT (fila vieja o Label nuevo). */
export interface DiscordSubmittedComponent {
  type: number;
  custom_id?: string;
  value?: string;
  values?: string[];
  components?: DiscordSubmittedComponent[];
  component?: DiscordSubmittedComponent;
}

export interface DiscordInteractionData {
  // APPLICATION_COMMAND / AUTOCOMPLETE
  id?: string;
  name?: string;
  type?: number;
  options?: DiscordInteractionOption[];
  target_id?: string;
  resolved?: {
    messages?: Record<string, DiscordApiMessage>;
    users?: Record<string, DiscordApiUser>;
  };
  // MESSAGE_COMPONENT
  custom_id?: string;
  component_type?: number;
  values?: string[];
  // MODAL_SUBMIT
  components?: DiscordSubmittedComponent[];
}

/** Interacción CRUDA (payload `d` del evento INTERACTION_CREATE del gateway). */
export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  /** Secreto de 15 min: con él se responde. Nunca se loguea ni se devuelve. */
  token: string;
  version?: number;
  guild_id?: string;
  channel_id?: string;
  channel?: { id: string; type?: number; name?: string; parent_id?: string | null };
  member?: { user?: DiscordApiUser; nick?: string | null; roles?: string[]; permissions?: string };
  user?: DiscordApiUser;
  data?: DiscordInteractionData;
  /** El mensaje que tiene el componente (MESSAGE_COMPONENT, o MODAL_SUBMIT abierto desde un componente). */
  message?: DiscordApiMessage & { interaction_metadata?: { user?: DiscordApiUser } };
  locale?: string;
  guild_locale?: string;
  app_permissions?: string;
}

/** Cuerpo que el puente manda a POST /v1/internal/discord/interactions. */
export interface DiscordInteractionEnvelope {
  /** DISCORD_GUILD_ID del puente; debe ser el de roz o 403. */
  guildId: string;
  /** Epoch ms en que el puente recibió el evento (diagnóstico y presupuesto de tiempo). */
  receivedAt?: number;
  interaction: DiscordInteraction;
}

// ================================================================ lo que roz arma

export interface ButtonComponent {
  type: typeof COMPONENT_TYPE.BUTTON;
  style: number;
  label?: string;
  emoji?: { name: string; id?: string };
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  default?: boolean;
}

export interface StringSelectComponent {
  type: typeof COMPONENT_TYPE.STRING_SELECT;
  custom_id: string;
  options: SelectOption[];
  placeholder?: string;
  min_values?: number;
  max_values?: number;
  disabled?: boolean;
  required?: boolean;
}

export interface TextInputComponent {
  type: typeof COMPONENT_TYPE.TEXT_INPUT;
  custom_id: string;
  style: number;
  min_length?: number;
  max_length?: number;
  required?: boolean;
  value?: string;
  placeholder?: string;
}

export interface TextDisplayComponent {
  type: typeof COMPONENT_TYPE.TEXT_DISPLAY;
  content: string;
}

export interface LabelComponent {
  type: typeof COMPONENT_TYPE.LABEL;
  label: string;
  description?: string;
  component: TextInputComponent | StringSelectComponent;
}

export interface ActionRowComponent {
  type: typeof COMPONENT_TYPE.ACTION_ROW;
  components: Array<ButtonComponent | StringSelectComponent>;
}

export type ModalComponent = LabelComponent | TextDisplayComponent;

// ---------------------------------------------------------------- Components V2 (mensajes)
// https://docs.discord.com/developers/components/reference. Con el flag IS_COMPONENTS_V2 el mensaje
// no lleva content ni embeds: todo va en componentes (≤ 40 en total, contando los anidados).

export interface ThumbnailComponent {
  type: typeof COMPONENT_TYPE.THUMBNAIL;
  media: { url: string };
  /** Texto alternativo (≤ 1024). */
  description?: string;
}

export interface SectionComponent {
  type: typeof COMPONENT_TYPE.SECTION;
  /** 1 a 3 TextDisplay. */
  components: TextDisplayComponent[];
  /** Obligatorio: miniatura o botón. */
  accessory: ThumbnailComponent | ButtonComponent;
}

export interface SeparatorComponent {
  type: typeof COMPONENT_TYPE.SEPARATOR;
  divider?: boolean;
  /** 1 = chico, 2 = grande. */
  spacing?: 1 | 2;
}

export type ContainerChild = TextDisplayComponent | SectionComponent | SeparatorComponent | ActionRowComponent;

export interface ContainerComponent {
  type: typeof COMPONENT_TYPE.CONTAINER;
  /** RGB 0x000000..0xFFFFFF. */
  accent_color?: number;
  components: ContainerChild[];
}

/** Componente de primer nivel de un mensaje: filas (clásico) o piezas de Components V2. */
export type MessageComponent = ActionRowComponent | ContainerComponent | TextDisplayComponent | SectionComponent | SeparatorComponent;

/** Mensaje que arma un handler. respond.ts le agrega allowed_mentions seguro y los flags. */
export interface OutgoingMessage {
  content?: string;
  embeds?: DiscordApiEmbed[];
  /**
   * Filas de botones/selects (clásico) o un Container de Components V2 (lo que arman las fichas de
   * embeds.ts). respond.ts SIEMPRE manda Components V2: un mensaje de texto o con filas se envuelve en
   * un Container con el naranja de roz.
   */
  components?: MessageComponent[];
  /** Usuarios de Discord que SÍ deben sonar si el texto los menciona. Nunca roles ni @everyone. */
  mentionUserIds?: string[];
}

export interface Modal {
  /** Debe salir de buildCustomId (acción de tipo 'modal'). */
  custom_id: string;
  /** ≤ 45 caracteres. */
  title: string;
  components: ModalComponent[];
}

export interface AutocompleteChoice {
  /** 1..100 caracteres. */
  name: string;
  /** 1..100 caracteres. */
  value: string;
}

/** Algo más que publicar DESPUÉS de la respuesta inicial (followup del mismo token). */
export interface FollowupMessage {
  message: OutgoingMessage;
  ephemeral: boolean;
}

/**
 * Lo que devuelve un handler. El router lo convierte en el callback de Discord (o, si el handler tardó
 * más que el presupuesto, en la edición del mensaje diferido).
 *   · message → mensaje nuevo (type 4). `ephemeral` solo cuenta si no hubo que diferir: diferido, la
 *               visibilidad ya la fijó `defer` del handler.
 *   · update  → edita el mensaje del componente (type 7). Solo para componentes y modales abiertos
 *               desde un componente; en otro caso se trata como `message` efímero.
 *   · modal   → abre un modal (type 9). Tiene que ser la PRIMERA respuesta: no se puede diferir.
 *   · choices → resultado de autocompletado (type 8), máx. 25.
 */
export type Reply =
  | { kind: 'message'; message: OutgoingMessage; ephemeral: boolean; followups?: FollowupMessage[] }
  | { kind: 'update'; message: OutgoingMessage; followups?: FollowupMessage[] }
  | { kind: 'modal'; modal: Modal }
  | { kind: 'choices'; choices: AutocompleteChoice[] };

// ================================================================ contexto de los handlers

/** El dev de roz ligado al usuario de Discord que disparó la interacción. */
export interface CommandActor {
  devId: string;
  devName: string;
  githubLogin: string | null;
  /** auth.users.id del dev (dev.ops_user_id), para `requested_by`/`created_by`. null si no está ligado a Ops. */
  authUserId: string | null;
  discordUserId: string;
}

type Log = (msg: string, extra?: Record<string, unknown>) => void;

export interface BaseContext {
  interaction: DiscordInteraction;
  actor: CommandActor;
  guildId: string;
  /** Canal (o hilo) donde se usó. */
  channelId: string | null;
  log: Log;
}

/** Valores de las opciones del subcomando, ya aplanados (`{ buscar: 'login', persona: '<devId>' }`). */
export type OptionValues = Record<string, string | number | boolean>;

export interface SlashContext extends BaseContext {
  subcommand: RozSubcommand;
  options: OptionValues;
}

export interface AutocompleteContext extends BaseContext {
  subcommand: RozSubcommand;
  /** Opción que el usuario está escribiendo. */
  focused: { name: string; value: string };
  /** Las demás opciones ya llenas (p. ej. `persona` mientras escribe `buscar`). */
  options: OptionValues;
}

export interface MessageCommandContext extends BaseContext {
  command: MessageCommandKey;
  /** Mensaje sobre el que se hizo clic derecho (data.resolved.messages[target_id]). */
  target: DiscordApiMessage;
}

export interface ComponentContext extends BaseContext {
  customId: ParsedCustomId;
  /** Valores elegidos en un select (vacío en un botón). */
  values: string[];
  /** Mensaje que tiene el componente. */
  message: DiscordApiMessage | null;
}

export interface ModalContext extends BaseContext {
  customId: ParsedCustomId;
  /** Campos del modal por custom_id: texto (`value`) o selección (`values`). */
  fields: Record<string, string | string[]>;
  /** Mensaje del componente que abrió el modal, si lo abrió un componente. */
  message: DiscordApiMessage | null;
}

// ================================================================ handlers

/**
 * Qué hacer si el handler no termina dentro del presupuesto (~2 s de los 3 s de Discord):
 *   · 'ephemeral' → type 5 con flag efímero; el resultado edita ese mensaje (solo lo ve quien lo usó).
 *   · 'public'    → type 5 público; el resultado edita ese mensaje (lo ve el canal).
 *   · 'update'    → type 6 (solo componentes): el resultado edita el mensaje del componente.
 *   · 'never'     → no se difiere (modales y autocompletado): si se pasa del tiempo, error efímero.
 */
export type DeferMode = 'ephemeral' | 'public' | 'update' | 'never';

/** Modo fijo, o calculado del contexto (p. ej. `/roz plan` con issue → público; sin issue → efímero). */
export type DeferSpec<C> = DeferMode | ((ctx: C) => DeferMode);

export interface SlashHandler {
  defer: DeferSpec<SlashContext>;
  run(ctx: SlashContext): Promise<Reply>;
  /** Autocompletado de las opciones del subcomando. Sin presupuesto extra: ≤ ~2 s o vuelve vacío. */
  autocomplete?(ctx: AutocompleteContext): Promise<AutocompleteChoice[]>;
}

export interface MessageCommandHandler {
  defer: DeferSpec<MessageCommandContext>;
  run(ctx: MessageCommandContext): Promise<Reply>;
}

export interface ComponentHandler {
  defer: DeferSpec<ComponentContext>;
  run(ctx: ComponentContext): Promise<Reply>;
}

export interface ModalHandler {
  defer: DeferSpec<ModalContext>;
  run(ctx: ModalContext): Promise<Reply>;
}

/** Lo que exporta cada archivo de handlers/ (`export const handlers: HandlerModule = …`). */
export interface HandlerModule {
  slash?: Partial<Record<RozSubcommand, SlashHandler>>;
  message?: Partial<Record<MessageCommandKey, MessageCommandHandler>>;
  components?: Partial<Record<CustomIdAction, ComponentHandler>>;
  modals?: Partial<Record<CustomIdAction, ModalHandler>>;
}
