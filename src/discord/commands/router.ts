// Router de interacciones de Discord (contrato: docs/discord-commands-contract.md). El puente recibe
// INTERACTION_CREATE por el gateway y la reenvía tal cual a POST /v1/internal/discord/interactions;
// aquí se decide TODO:
//
//   1. PING → PONG.
//   2. Servidor: la interacción tiene que venir de DISCORD_GUILD_ID (y de nuestra app). Otra cosa →
//      efímero "solo en el servidor de la empresa", sin ejecutar nada.
//   3. Identidad: el usuario de Discord → su dev de roz (discord_link ⋈ dev activo). Sin cuenta ligada
//      → efímero con el link a Configuración (en autocompletado: un único choice que lo dice).
//   4. Despacho por tipo: comando de barra (/roz <sub>) o de mensaje, autocompletado, componente
//      (custom_id versionado) o envío de modal.
//   5. Tiempo: Discord da 3 s para la respuesta inicial y el puente necesita margen para mandarla. Si
//      el handler termina dentro del presupuesto, su Reply es el callback; si no, el callback es
//      "diferido" (type 5/6 según `defer`) y el resultado se manda después con el token (`after`).
//
// Devuelve `{ callback, after }`: la ruta responde `callback` al puente (que lo manda a Discord) y
// corre `after` en segundo plano.
import { z } from 'zod';
import { config } from '../../config.js';
import { db } from '../../db/supabase.js';
import { snowflakeDate, type InteractionCallbackBody } from '../../adapters/discord.js';
import { parseCustomId, CUSTOM_ID_SPECS, type CustomIdParse, type ParsedCustomId } from './custom-id.js';
import { ROZ_COMMAND_NAME, isRozSubcommand, messageCommandKeyOf } from './definitions.js';
import { REGISTRY, type Registry } from './registry.js';
import {
  choices as choicesReply,
  clampChoices,
  completeDeferred,
  deferCallback,
  effectiveDefer,
  ephemeral,
  errorReply,
  notLinkedChoices,
  notLinkedReply,
  oldComponentReply,
  readModalFields,
  sendFollowups,
  toCallback,
  wrongGuildReply,
  type InteractionHandle,
} from './respond.js';
import {
  COMMAND_TYPE,
  INTERACTION_TYPE,
  OPTION_TYPE,
  type AutocompleteChoice,
  type BaseContext,
  type CommandActor,
  type DeferMode,
  type DeferSpec,
  type DiscordInteraction,
  type DiscordInteractionEnvelope,
  type DiscordInteractionOption,
  type OptionValues,
  type Reply,
} from './types.js';

// ================================================================ cuerpo del puente

const snowflake = z.string().regex(/^\d{15,25}$/);

export const InteractionEnvelopeSchema = z.object({
  guildId: snowflake,
  receivedAt: z.number().int().nonnegative().optional(),
  interaction: z
    .object({
      id: snowflake,
      application_id: snowflake,
      type: z.number().int().min(1).max(5),
      token: z.string().min(1).max(1000),
      guild_id: snowflake.optional(),
      channel_id: snowflake.optional(),
    })
    .passthrough(),
});

// ================================================================ tiempo

/** Plazo de Discord para la respuesta inicial. */
export const DISCORD_DEADLINE_MS = 3000;
/** Lo que se le deja al puente (y a la red) para mandar el callback después de que roz responde. */
export const BRIDGE_MARGIN_MS = 800;
/** Tope de espera en línea dentro de roz, aunque el reloj diga que sobra tiempo. */
export const INLINE_BUDGET_MS = 1800;

/**
 * Presupuesto para responder en línea. El snowflake de la interacción dice cuándo la creó Discord;
 * si el reloj de roz no es creíble (diferencia negativa o enorme), se usa el tope fijo.
 */
export function inlineBudgetMs(interactionId: string, now: number): number {
  let created: number;
  try {
    created = snowflakeDate(interactionId).getTime();
  } catch {
    return INLINE_BUDGET_MS;
  }
  const elapsed = now - created;
  if (!(elapsed >= 0 && elapsed < 10_000)) return INLINE_BUDGET_MS;
  return Math.max(0, Math.min(INLINE_BUDGET_MS, DISCORD_DEADLINE_MS - BRIDGE_MARGIN_MS - elapsed));
}

type Raced<T> = { done: true; value: T } | { done: false };

async function race<T>(p: Promise<T>, ms: number): Promise<Raced<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Raced<T>>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), Math.max(0, ms));
  });
  try {
    return await Promise.race([p.then((value): Raced<T> => ({ done: true, value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ================================================================ identidad

/** Dev de roz ligado a un usuario de Discord (discord_link ⋈ dev activo), o null. */
export async function resolveActor(discordUserId: string): Promise<CommandActor | null> {
  const { data: link, error } = await db().from('discord_link').select('dev_id, discord_user_id').eq('discord_user_id', discordUserId).maybeSingle();
  if (error) throw error;
  const l = link as { dev_id: string; discord_user_id: string } | null;
  if (!l) return null;
  const { data: dev, error: devErr } = await db().from('dev').select('id, name, github_login, active, ops_user_id').eq('id', l.dev_id).maybeSingle();
  if (devErr) throw devErr;
  const d = dev as { id: string; name: string; github_login: string | null; active: boolean | null; ops_user_id?: string | null } | null;
  if (!d || d.active === false) return null;
  return {
    devId: d.id,
    devName: d.name,
    githubLogin: d.github_login ?? null,
    authUserId: d.ops_user_id ?? null,
    discordUserId: l.discord_user_id,
  };
}

/** Usuario que disparó la interacción (en servidor viene en `member.user`). */
export function interactionUserId(i: DiscordInteraction): string | null {
  return i.member?.user?.id ?? i.user?.id ?? null;
}

// ================================================================ opciones

/** Subcomando y opciones aplanadas de /roz. */
export function readSubcommand(options: DiscordInteractionOption[] | undefined): {
  name: string | null;
  values: OptionValues;
  focused: { name: string; value: string } | null;
} {
  const sub = (options ?? []).find((o) => o.type === OPTION_TYPE.SUB_COMMAND);
  const values: OptionValues = {};
  let focused: { name: string; value: string } | null = null;
  for (const o of sub?.options ?? []) {
    if (o.value === undefined) continue;
    if (o.focused) focused = { name: o.name, value: String(o.value) };
    else values[o.name] = o.value;
  }
  return { name: sub?.name ?? null, values, focused };
}

// ================================================================ router

type Log = (msg: string, extra?: Record<string, unknown>) => void;

export interface RouterDeps {
  registry: Registry;
  resolveActor: (discordUserId: string) => Promise<CommandActor | null>;
  now: () => number;
  log: Log;
  /** Fuerza el presupuesto en línea (pruebas). */
  budgetMs?: number;
  /** Espera entre reintentos al completar lo diferido (pruebas). */
  sleep?: (ms: number) => Promise<void>;
}

export interface RouterOutcome {
  /** Cuerpo de POST /interactions/{id}/{token}/callback que el puente manda a Discord. */
  callback: InteractionCallbackBody;
  /** Trabajo después de responder (completar lo diferido, followups). null = nada. */
  after: (() => Promise<void>) | null;
  /** Para logs: qué se despachó (sin datos del usuario). */
  route: string;
}

const noopLog: Log = () => {};

function resolveDefer<C>(spec: DeferSpec<C>, ctx: C): DeferMode {
  return typeof spec === 'function' ? spec(ctx) : spec;
}

/** Corrige Replies que Discord rechazaría para este tipo de interacción. */
function sanitize(reply: Reply, interactionType: number): Reply {
  if (reply.kind === 'choices' && interactionType !== INTERACTION_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE) {
    return ephemeral('Algo falló en roz al hacer esto. Intenta de nuevo.');
  }
  // Un modal no se puede abrir como respuesta a otro modal.
  if (reply.kind === 'modal' && interactionType === INTERACTION_TYPE.MODAL_SUBMIT) {
    return ephemeral('Algo falló en roz al hacer esto. Intenta de nuevo.');
  }
  return reply;
}

function immediate(reply: Reply, i: DiscordInteraction, route: string, handle: InteractionHandle, deps: RouterDeps): RouterOutcome {
  const r = sanitize(reply, i.type);
  const hasFollowups = (r.kind === 'message' || r.kind === 'update') && !!r.followups?.length;
  return {
    callback: toCallback(r, i.type, !!i.message),
    after: hasFollowups ? () => sendFollowups(handle, r, deps.sleep) : null,
    route,
  };
}

/** Corre un handler con el presupuesto; si no alcanza, difiere y completa después. */
async function execute(
  run: () => Promise<Reply>,
  mode: DeferMode,
  i: DiscordInteraction,
  route: string,
  deadlineAt: number,
  deps: RouterDeps,
): Promise<RouterOutcome> {
  const handle: InteractionHandle = { applicationId: i.application_id, token: i.token };
  const p = Promise.resolve()
    .then(run)
    .catch((err) => {
      deps.log('discord: el handler falló', { route, err: err instanceof Error ? err.message : String(err) });
      return errorReply(err);
    });
  const raced = await race(p, deadlineAt - deps.now());
  if (raced.done) return immediate(raced.value, i, route, handle, deps);

  const deferMode = effectiveDefer(mode, i.type, !!i.message);
  if (!deferMode) {
    // Modal/autocompletado: lo que llegue tarde ya no sirve (Discord cerró la ventana).
    void p.then(() => deps.log('discord: respuesta que no se puede diferir llegó tarde', { route }));
    return immediate(ephemeral('roz tardó demasiado en responder. Intenta de nuevo.'), i, route, handle, deps);
  }
  return {
    callback: deferCallback(deferMode),
    after: async () => {
      const reply = sanitize(await p, i.type);
      await completeDeferred(handle, deferMode, reply, deps.sleep);
    },
    route: `${route} (diferido)`,
  };
}

export async function routeInteraction(envelope: DiscordInteractionEnvelope, over: Partial<RouterDeps> = {}): Promise<RouterOutcome> {
  const deps: RouterDeps = {
    registry: over.registry ?? REGISTRY,
    resolveActor: over.resolveActor ?? resolveActor,
    now: over.now ?? Date.now,
    log: over.log ?? noopLog,
    budgetMs: over.budgetMs,
    sleep: over.sleep,
  };
  const i = envelope.interaction;
  const startedAt = deps.now();
  const deadlineAt = startedAt + (deps.budgetMs ?? inlineBudgetMs(i.id, startedAt));
  const handle: InteractionHandle = { applicationId: i.application_id, token: i.token };
  const isAutocomplete = i.type === INTERACTION_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE;
  const reject = (reply: Reply, route: string) => immediate(isAutocomplete ? choicesReply([]) : reply, i, route, handle, deps);

  if (i.type === INTERACTION_TYPE.PING) return { callback: { type: 1 }, after: null, route: 'ping' };

  // Servidor y app: lo que no sea nuestro no se ejecuta.
  if (!i.guild_id || i.guild_id !== config.discord.guildId) return reject(wrongGuildReply(), 'servidor ajeno');
  if (config.discord.clientId && i.application_id !== config.discord.clientId) return reject(wrongGuildReply(), 'app ajena');

  const userId = interactionUserId(i);
  if (!userId) return reject(wrongGuildReply(), 'sin usuario');
  const actor = await deps.resolveActor(userId);
  if (!actor) {
    if (isAutocomplete) return immediate(choicesReply(notLinkedChoices()), i, 'sin cuenta ligada', handle, deps);
    return immediate(notLinkedReply(), i, 'sin cuenta ligada', handle, deps);
  }

  const base: BaseContext = {
    interaction: i,
    actor,
    guildId: i.guild_id,
    channelId: i.channel_id ?? i.channel?.id ?? null,
    log: deps.log,
  };
  const data = i.data ?? {};

  switch (i.type) {
    case INTERACTION_TYPE.APPLICATION_COMMAND: {
      if (data.type === COMMAND_TYPE.MESSAGE) {
        const key = messageCommandKeyOf(data.name ?? '');
        const target = data.target_id ? data.resolved?.messages?.[data.target_id] : undefined;
        const handler = key ? deps.registry.message[key] : undefined;
        if (!key || !handler) return reject(ephemeral('Esa acción ya no existe en roz.'), 'acción desconocida');
        if (!target) return reject(ephemeral('No pude leer ese mensaje.'), `mensaje ${key} sin target`);
        const ctx = { ...base, command: key, target };
        return execute(() => handler.run(ctx), resolveDefer(handler.defer, ctx), i, `mensaje ${key}`, deadlineAt, deps);
      }
      if (data.name !== ROZ_COMMAND_NAME) return reject(ephemeral('Ese comando ya no existe en roz.'), 'comando desconocido');
      const sub = readSubcommand(data.options);
      const handler = sub.name && isRozSubcommand(sub.name) ? deps.registry.slash[sub.name] : undefined;
      if (!sub.name || !isRozSubcommand(sub.name) || !handler) return reject(ephemeral('Ese subcomando ya no existe en roz.'), 'subcomando desconocido');
      const ctx = { ...base, subcommand: sub.name, options: sub.values };
      return execute(() => handler.run(ctx), resolveDefer(handler.defer, ctx), i, `/roz ${sub.name}`, deadlineAt, deps);
    }

    case INTERACTION_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE: {
      const sub = readSubcommand(data.options);
      const handler = sub.name && isRozSubcommand(sub.name) ? deps.registry.slash[sub.name] : undefined;
      if (data.name !== ROZ_COMMAND_NAME || !sub.name || !isRozSubcommand(sub.name) || !handler?.autocomplete || !sub.focused) {
        return immediate(choicesReply([]), i, 'autocompletado sin handler', handle, deps);
      }
      const ctx = { ...base, subcommand: sub.name, focused: sub.focused, options: sub.values };
      const complete = handler.autocomplete.bind(handler);
      const p: Promise<AutocompleteChoice[]> = Promise.resolve()
        .then(() => complete(ctx))
        .catch((err) => {
          deps.log('discord: autocompletado falló', { route: `/roz ${sub.name}`, err: err instanceof Error ? err.message : String(err) });
          return [];
        });
      const raced = await race(p, deadlineAt - deps.now());
      const list = raced.done ? clampChoices(raced.value) : [];
      return immediate(choicesReply(list), i, `autocompletado /roz ${sub.name} ${sub.focused.name}`, handle, deps);
    }

    case INTERACTION_TYPE.MESSAGE_COMPONENT: {
      const parsed = parseCustomId(data.custom_id);
      if (!parsed.ok) {
        // Cast explícito: sin strict (build de Vercel) el `ok` booleano no estrecha la unión.
        const { reason } = parsed as Extract<CustomIdParse, { ok: false }>;
        if (reason === 'old_version') return reject(oldComponentReply(), 'componente viejo');
        return reject(ephemeral('Ese botón ya no hace nada en roz.'), `componente ${reason}`);
      }
      const id: ParsedCustomId = (parsed as Extract<CustomIdParse, { ok: true }>).id;
      const handler = CUSTOM_ID_SPECS[id.action].surface !== 'modal' ? deps.registry.components[id.action] : undefined;
      if (!handler) return reject(ephemeral('Ese botón ya no hace nada en roz.'), `componente ${id.action} sin handler`);
      const ctx = { ...base, customId: id, values: (data.values ?? []).map(String), message: i.message ?? null };
      return execute(() => handler.run(ctx), resolveDefer(handler.defer, ctx), i, `componente ${id.action}`, deadlineAt, deps);
    }

    case INTERACTION_TYPE.MODAL_SUBMIT: {
      const parsed = parseCustomId(data.custom_id);
      if (!parsed.ok) {
        const { reason } = parsed as Extract<CustomIdParse, { ok: false }>;
        if (reason === 'old_version') return reject(oldComponentReply(), 'modal viejo');
        return reject(ephemeral('Ese formulario ya no hace nada en roz.'), `modal ${reason}`);
      }
      const id: ParsedCustomId = (parsed as Extract<CustomIdParse, { ok: true }>).id;
      const handler = CUSTOM_ID_SPECS[id.action].surface === 'modal' ? deps.registry.modals[id.action] : undefined;
      if (!handler) return reject(ephemeral('Ese formulario ya no hace nada en roz.'), `modal ${id.action} sin handler`);
      const ctx = { ...base, customId: id, fields: readModalFields(data.components), message: i.message ?? null };
      return execute(() => handler.run(ctx), resolveDefer(handler.defer, ctx), i, `modal ${id.action}`, deadlineAt, deps);
    }

    default:
      return reject(ephemeral('roz no sabe qué hacer con eso.'), `tipo ${i.type}`);
  }
}

/** Callback de error para cuando el router mismo revienta (la ruta no debe dejar al usuario sin respuesta). */
export function failureCallback(interactionType: number): InteractionCallbackBody {
  if (interactionType === INTERACTION_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE) return toCallback(choicesReply([]), interactionType, false);
  return toCallback(errorReply(null), interactionType, false);
}

