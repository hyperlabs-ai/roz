// custom_id de botones, selects y modales de roz en Discord. Formato (≤ 100 caracteres, el tope de
// Discord):
//
//   roz1:<acción>[:<arg>…]
//
//   · `roz1`   → versión del formato. Si cambia el significado de una acción, sube la versión: los
//                mensajes viejos (que siguen en el canal con sus botones) traen `roz1` y el router
//                responde "esta ficha es de una versión anterior" en vez de hacer otra cosa.
//   · acción   → una de CUSTOM_ID_SPECS (fija; nada libre).
//   · args     → SOLO ids de recursos (uuid de roz, snowflake de Discord) o `_` = sin valor. Nunca
//                nombres, textos, tokens ni ids de usuario: el custom_id viaja a todos los que ven el
//                mensaje y cualquiera puede mandar uno inventado. Quién actúa lo dice la interacción
//                (el usuario que hace clic), nunca el custom_id; los permisos se revisan en roz.
//
// Puro, sin red: test/discord-commands-custom-id.test.ts.

export const CUSTOM_ID_VERSION = 'roz1';
export const CUSTOM_ID_MAX = 100;

/** Tipo de cada argumento. `uuid?` y `snowflake?` aceptan `_` (sin valor) → null al leer. */
export type CustomIdArgKind = 'uuid' | 'uuid?' | 'snowflake';

/** Dónde vive la acción: un botón, un select o el submit de un modal. */
export type CustomIdSurface = 'button' | 'select' | 'modal';

export interface CustomIdSpec {
  surface: CustomIdSurface;
  args: readonly CustomIdArgKind[];
  /** Archivo de handlers/ dueño de la acción (documentación y test de registro). */
  owner: string;
}

export const CUSTOM_ID_SPECS = {
  // Ficha de tarea (handlers/tarea.ts). Los usan también ticket y citar, que publican la misma ficha.
  'tarea.tomar': { surface: 'button', args: ['uuid'], owner: 'tarea' },
  'tarea.estado': { surface: 'select', args: ['uuid'], owner: 'tarea' },
  // Ticket (handlers/ticket.ts): arg = proyecto elegido en la opción, o `_` → el modal trae el select.
  'ticket.modal': { surface: 'modal', args: ['uuid?'], owner: 'ticket' },
  // Daily (handlers/status.ts).
  'status.elegir': { surface: 'select', args: [], owner: 'status' },
  'status.buscar': { surface: 'button', args: [], owner: 'status' },
  'status.buscar.modal': { surface: 'modal', args: [], owner: 'status' },
  // Crear tarea desde un mensaje (handlers/mensaje-crear-tarea.ts): canal + mensaje de origen.
  'msg.tarea.modal': { surface: 'modal', args: ['snowflake', 'snowflake'], owner: 'mensaje-crear-tarea' },
  // Plan del agente (handlers/plan.ts).
  'plan.aprobar': { surface: 'button', args: ['uuid'], owner: 'plan' },
  'plan.cambios': { surface: 'button', args: ['uuid'], owner: 'plan' },
  'plan.cambios.modal': { surface: 'modal', args: ['uuid'], owner: 'plan' },
  // Junta (handlers/junta.ts): arg = proyecto o `_`.
  'junta.modal': { surface: 'modal', args: ['uuid?'], owner: 'junta' },
  // Guardar como decisión (handlers/mensaje-decision.ts): canal + mensaje; el select elige el proyecto.
  'msg.decision.proyecto': { surface: 'select', args: ['snowflake', 'snowflake'], owner: 'mensaje-decision' },
} as const satisfies Record<string, CustomIdSpec>;

export type CustomIdAction = keyof typeof CUSTOM_ID_SPECS;
export const CUSTOM_ID_ACTIONS = Object.keys(CUSTOM_ID_SPECS) as CustomIdAction[];

export interface ParsedCustomId {
  action: CustomIdAction;
  /** En el orden de la spec; `_` → null. */
  args: (string | null)[];
}

export type CustomIdParse =
  | { ok: true; id: ParsedCustomId }
  | { ok: false; reason: 'not_roz' | 'old_version' | 'unknown_action' | 'bad_args' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNOWFLAKE_RE = /^\d{15,25}$/;
const NONE = '_';

function argOk(kind: CustomIdArgKind, value: string): boolean {
  switch (kind) {
    case 'uuid':
      return UUID_RE.test(value);
    case 'uuid?':
      return value === NONE || UUID_RE.test(value);
    case 'snowflake':
      return SNOWFLAKE_RE.test(value);
  }
}

export function isCustomIdAction(action: string): action is CustomIdAction {
  return Object.prototype.hasOwnProperty.call(CUSTOM_ID_SPECS, action);
}

/** Arma un custom_id. Lanza si los args no calzan con la spec (es un error de programación). */
export function buildCustomId(action: CustomIdAction, ...args: (string | null | undefined)[]): string {
  const spec: CustomIdSpec = CUSTOM_ID_SPECS[action];
  if (args.length !== spec.args.length) throw new Error(`custom_id ${action}: se esperaban ${spec.args.length} argumentos`);
  const parts = args.map((a, i) => {
    const kind = spec.args[i]!;
    const v = a === null || a === undefined || a === '' ? NONE : a.toLowerCase();
    if (!argOk(kind, v)) throw new Error(`custom_id ${action}: argumento ${i} inválido`);
    return v;
  });
  const id = [CUSTOM_ID_VERSION, action, ...parts].join(':');
  if (id.length > CUSTOM_ID_MAX) throw new Error(`custom_id ${action}: más de ${CUSTOM_ID_MAX} caracteres`);
  return id;
}

/** Lee un custom_id. Lo que no sea de roz, de otra versión o con args raros NO se ejecuta. */
export function parseCustomId(raw: string | null | undefined): CustomIdParse {
  if (!raw || raw.length > CUSTOM_ID_MAX) return { ok: false, reason: 'not_roz' };
  const parts = raw.split(':');
  const version = parts[0] ?? '';
  if (!/^roz\d+$/.test(version)) return { ok: false, reason: 'not_roz' };
  if (version !== CUSTOM_ID_VERSION) return { ok: false, reason: 'old_version' };
  const action = parts[1] ?? '';
  if (!isCustomIdAction(action)) return { ok: false, reason: 'unknown_action' };
  const spec: CustomIdSpec = CUSTOM_ID_SPECS[action];
  const args = parts.slice(2);
  if (args.length !== spec.args.length) return { ok: false, reason: 'bad_args' };
  for (let i = 0; i < args.length; i++) if (!argOk(spec.args[i]!, args[i]!)) return { ok: false, reason: 'bad_args' };
  return { ok: true, id: { action, args: args.map((a) => (a === NONE ? null : a)) } };
}
