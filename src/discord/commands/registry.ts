// Registro de handlers: junta lo que exporta cada archivo de handlers/ en un solo mapa por tipo. Cada
// subcomando, acción de mensaje y custom_id tiene UN dueño (CUSTOM_ID_SPECS.owner); un duplicado o un
// faltante sale en `problems` y lo atrapa test/discord-commands-router.test.ts.
import { CUSTOM_ID_ACTIONS, CUSTOM_ID_SPECS, type CustomIdAction } from './custom-id.js';
import { MESSAGE_COMMAND_KEYS, ROZ_SUBCOMMANDS, type MessageCommandKey, type RozSubcommand } from './definitions.js';
import type { ComponentHandler, HandlerModule, MessageCommandHandler, ModalHandler, SlashHandler } from './types.js';
import { handlers as tarea } from './handlers/tarea.js';
import { handlers as ticket } from './handlers/ticket.js';
import { handlers as status } from './handlers/status.js';
import { handlers as mensajeCrearTarea } from './handlers/mensaje-crear-tarea.js';
import { handlers as mensajeCitar } from './handlers/mensaje-citar.js';
import { handlers as plan } from './handlers/plan.js';
import { handlers as pulso } from './handlers/pulso.js';
import { handlers as infra } from './handlers/infra.js';
import { handlers as junta } from './handlers/junta.js';
import { handlers as mensajeDecision } from './handlers/mensaje-decision.js';

export interface Registry {
  slash: Partial<Record<RozSubcommand, SlashHandler>>;
  message: Partial<Record<MessageCommandKey, MessageCommandHandler>>;
  components: Partial<Record<CustomIdAction, ComponentHandler>>;
  modals: Partial<Record<CustomIdAction, ModalHandler>>;
}

/** Archivo de handlers/ → lo que exporta. La clave es el `owner` de CUSTOM_ID_SPECS. */
export const HANDLER_MODULES: Record<string, HandlerModule> = {
  tarea,
  ticket,
  status,
  'mensaje-crear-tarea': mensajeCrearTarea,
  'mensaje-citar': mensajeCitar,
  plan,
  pulso,
  infra,
  junta,
  'mensaje-decision': mensajeDecision,
};

export function buildRegistry(modules: Record<string, HandlerModule> = HANDLER_MODULES): { registry: Registry; problems: string[] } {
  const registry: Registry = { slash: {}, message: {}, components: {}, modals: {} };
  const problems: string[] = [];
  const put = <K extends string, V>(map: Partial<Record<K, V>>, key: K, value: V, kind: string, owner: string) => {
    if (map[key]) problems.push(`${kind} ${key}: definido dos veces (otra vez en ${owner})`);
    map[key] = value;
  };
  for (const [owner, mod] of Object.entries(modules)) {
    for (const [k, v] of Object.entries(mod.slash ?? {})) if (v) put(registry.slash, k as RozSubcommand, v, 'subcomando', owner);
    for (const [k, v] of Object.entries(mod.message ?? {})) if (v) put(registry.message, k as MessageCommandKey, v, 'acción de mensaje', owner);
    for (const [k, v] of Object.entries(mod.components ?? {})) {
      if (!v) continue;
      const spec = CUSTOM_ID_SPECS[k as CustomIdAction];
      if (!spec || spec.surface === 'modal') problems.push(`componente ${k}: no es un botón/select de CUSTOM_ID_SPECS`);
      else if (spec.owner !== owner) problems.push(`componente ${k}: su dueño es ${spec.owner}, no ${owner}`);
      put(registry.components, k as CustomIdAction, v, 'componente', owner);
    }
    for (const [k, v] of Object.entries(mod.modals ?? {})) {
      if (!v) continue;
      const spec = CUSTOM_ID_SPECS[k as CustomIdAction];
      if (!spec || spec.surface !== 'modal') problems.push(`modal ${k}: no es un modal de CUSTOM_ID_SPECS`);
      else if (spec.owner !== owner) problems.push(`modal ${k}: su dueño es ${spec.owner}, no ${owner}`);
      put(registry.modals, k as CustomIdAction, v, 'modal', owner);
    }
  }
  for (const s of ROZ_SUBCOMMANDS) if (!registry.slash[s]) problems.push(`subcomando ${s}: sin handler`);
  for (const m of MESSAGE_COMMAND_KEYS) if (!registry.message[m]) problems.push(`acción de mensaje ${m}: sin handler`);
  for (const a of CUSTOM_ID_ACTIONS) {
    const surface = CUSTOM_ID_SPECS[a].surface;
    if (surface === 'modal' ? !registry.modals[a] : !registry.components[a]) problems.push(`custom_id ${a}: sin handler`);
  }
  return { registry, problems };
}

/** Registro de producción. */
export const REGISTRY: Registry = buildRegistry().registry;
