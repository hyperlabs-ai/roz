// Registry de tools de roz (la cara interactiva: "implementar un feature desde Claude").
// El Claude conversacional las llama vía MCP sobre HTTP (Streamable HTTP / JSON-RPC),
// servido en routes/mcp.ts, y Claude Desktop vía stdio (src/mcp/stdio.ts). Un solo
// registry → ambos transportes exponen exactamente las mismas tools.
//
// Principio: roz es ESTRICTO. Las tools exigen entradas concretas y NO infieren el
// alcance, la asignación ni la ocupación. Lo que falta, se le pide al usuario.
import { z } from 'zod';
import { evaluateProposal, confirmProposal } from '../intake/proposal.js';
import {
  listDevs,
  upsertDev,
  setAvailability,
  setDevSkills,
  suggestAssignee,
  syncLinearMembers,
  listProjects,
  syncProjects,
} from '../router/assign.js';
import { intakeForm } from '../intake/form.js';
import { listUsers } from '../adapters/linear.js';
import { getProjectContext } from '../brain/retrieval.js';

export interface McpTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  handler: (args: any) => Promise<unknown>;
}

export const tools: McpTool[] = [
  // ---------- Intake ----------
  {
    name: 'get_intake_form',
    description:
      'PRIMER paso para proponer un cambio. Devuelve el guion de preguntas (con opciones de ' +
      'opción múltiple) que debes hacerle al usuario, según el tipo. Llámalo sin kind para las ' +
      'preguntas comunes y de nuevo con {kind} cuando el usuario elija el tipo. Conduce la ' +
      'entrevista con esas preguntas y luego llama propose_change.',
    schema: z.object({
      kind: z.enum(['feature', 'bug', 'chore', 'ticket', 'refactor']).optional(),
    }),
    handler: (args) => Promise.resolve(intakeForm(args.kind)),
  },
  {
    name: 'propose_change',
    description:
      'Crea una propuesta con CERO fricción. Solo necesitas 4 cosas: projectKey (de ' +
      'list_projects), kind, priority y una description libre de lo que el usuario quiere/falla. ' +
      'roz GENERA el título y DOCUMENTA el detalle (estructura según el tipo) — NO le pidas al ' +
      'usuario el título ni cada campo. Devuelve un borrador + "missing" (lo crítico que falte) y ' +
      'recomienda varios devs. Nada se asigna aquí.',
    schema: z.object({
      projectKey: z.string().describe('Clave del proyecto. Obtenla de list_projects; no la inventes.'),
      kind: z.enum(['feature', 'bug', 'chore', 'ticket', 'refactor']).describe('Tipo (elección rápida del usuario).'),
      priority: z.enum(['urgent', 'high', 'medium', 'low']).describe('Prioridad (elección rápida; no la infieras).'),
      description: z
        .string()
        .describe('Lo que el usuario quiere o lo que falla, en sus palabras. Una o dos frases bastan.'),
      title: z.string().optional().describe('Opcional. Si el usuario no lo dio, OMÍTELO: roz lo genera.'),
      attachments: z.array(z.string()).optional().describe('Opcional (bugs): URLs/refs de capturas, logs o video.'),
      requester: z.string().optional().describe('Quién origina la propuesta (para notificar al cerrar).'),
    }),
    handler: (args) => evaluateProposal(args),
  },
  {
    name: 'confirm_proposal',
    description:
      'Confirma una propuesta YA evaluada y el dev ELEGIDO EXPLÍCITAMENTE por el usuario. ' +
      'roz crea el issue en Linear (asignado) y dispara la notificación. No elijas tú al dev: ' +
      'el usuario debe decidirlo (puede ser el sugerido u otro de list_devs).',
    schema: z.object({
      proposalId: z.string().describe('id devuelto por propose_change'),
      assigneeDevId: z.string().describe('id del dev elegido por el usuario'),
    }),
    handler: (args) => confirmProposal(args.proposalId, args.assigneeDevId),
  },
  {
    name: 'list_projects',
    description:
      'Lista los proyectos disponibles (selector). Úsalo para que el usuario ELIJA el proyecto; ' +
      'no aceptes una clave escrita a mano. `linked:false` = aún sin team de Linear configurado.',
    schema: z.object({}),
    handler: () => listProjects(),
  },
  {
    name: 'sync_projects',
    description:
      'Importa los equipos del workspace de Linear como proyectos (upsert por clave). Corre esto ' +
      'si falta un proyecto en list_projects.',
    schema: z.object({}),
    handler: () => syncProjects(),
  },
  {
    name: 'suggest_assignee',
    description:
      'Devuelve la sugerencia del router (skill×disponibilidad÷carga) para un texto de spec, ' +
      'sin crear nada. Útil para reconsiderar el asignado.',
    schema: z.object({ projectKey: z.string(), specText: z.string() }),
    handler: async (args) => {
      const sug = await suggestAssignee(args.projectKey, args.specText);
      return sug ?? { suggestion: null };
    },
  },

  // ---------- Gestión de devs / roles / ocupación ----------
  {
    name: 'list_devs',
    description: 'Lista devs con skills, disponibilidad (ocupación) y carga actual (issues in-progress en Linear).',
    schema: z.object({}),
    handler: () => listDevs(),
  },
  {
    name: 'list_linear_members',
    description:
      'Lista los miembros reales del workspace de Linear (id, nombre, email). Útil para vincular ' +
      'un dev de roz con la persona correcta antes de asignar.',
    schema: z.object({}),
    handler: () => listUsers(),
  },
  {
    name: 'sync_linear_members',
    description:
      'Importa/vincula los miembros del workspace de Linear como devs de roz: vincula por ' +
      'linear_user_id o email y crea los que falten. Así el nombre del dev SÍ apunta a la ' +
      'persona real de Linear y las asignaciones funcionan automáticamente.',
    schema: z.object({}),
    handler: () => syncLinearMembers(),
  },
  {
    name: 'upsert_dev',
    description:
      'Crea o actualiza un dev. Para actualizar, pasa su id. Mapea linearUserId para que los ' +
      'issues queden asignados a la persona real y email para notificar (Resend).',
    schema: z.object({
      id: z.string().optional().describe('id del dev para actualizar; omitir para crear'),
      name: z.string(),
      email: z.string().optional().describe('correo del dev — canal de notificación actual'),
      whatsapp: z.string().optional().describe('E.164 (guardado para uso futuro; aún no se notifica por aquí)'),
      linearUserId: z.string().optional(),
      githubLogin: z.string().optional(),
      availability: z.number().min(0).max(1).optional().describe('0 saturado .. 1 libre'),
      active: z.boolean().optional(),
    }),
    handler: (args) => upsertDev(args),
  },
  {
    name: 'set_availability',
    description: 'Ajusta la ocupación de un dev: 0 = saturado, 1 = totalmente disponible.',
    schema: z.object({
      devId: z.string(),
      availability: z.number().min(0).max(1),
    }),
    handler: (args) => setAvailability(args.devId, args.availability),
  },
  {
    name: 'set_dev_skills',
    description:
      'Define los skills/roles de un dev (reemplaza el set actual). Crea skills nuevos con su ' +
      'embedding para que el router pueda matchear. Nivel 1..5.',
    schema: z.object({
      devId: z.string(),
      skills: z
        .array(
          z.object({
            tag: z.string().describe('p.ej. "ai", "frontend", "backend"'),
            level: z.number().int().min(1).max(5).optional(),
            description: z.string().optional().describe('ayuda a calcular el embedding del skill'),
          }),
        )
        .describe('lista de skills del dev'),
    }),
    handler: (args) => setDevSkills(args.devId, args.skills),
  },

  // ---------- Contexto ----------
  {
    name: 'get_project_context',
    description: 'Recupera contexto relevante del second brain para un proyecto (retrieval híbrido).',
    schema: z.object({
      projectKey: z.string(),
      query: z.string().describe('Tema/pregunta para enfocar el retrieval'),
    }),
    handler: (args) => getProjectContext(args.projectKey, args.query),
  },
];

export const toolsByName = new Map(tools.map((t) => [t.name, t]));

// ---------- zod -> JSON Schema (mínimo) para tools/list por HTTP ----------
function unwrap(def: z.ZodTypeAny): { schema: z.ZodTypeAny; optional: boolean } {
  let s = def;
  let optional = false;
  // ZodOptional / ZodDefault envuelven el tipo real.
  while (s instanceof z.ZodOptional || s instanceof z.ZodDefault) {
    if (s instanceof z.ZodOptional) optional = true;
    s = (s as z.ZodOptional<z.ZodTypeAny>).unwrap?.() ?? (s as any)._def.innerType;
  }
  return { schema: s, optional };
}

function jsonSchemaFor(def: z.ZodTypeAny): Record<string, unknown> {
  const description = def.description;
  const { schema } = unwrap(def);
  const base: Record<string, unknown> = description ? { description } : {};

  if (schema instanceof z.ZodString) return { type: 'string', ...base };
  if (schema instanceof z.ZodNumber) return { type: 'number', ...base };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean', ...base };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: (schema as z.ZodEnum<[string, ...string[]]>).options, ...base };
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: jsonSchemaFor((schema as z.ZodArray<z.ZodTypeAny>).element), ...base };
  }
  if (schema instanceof z.ZodObject) {
    return { ...objectSchema(schema as z.ZodObject<z.ZodRawShape>), ...base };
  }
  return { type: 'string', ...base };
}

function objectSchema(obj: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = obj.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, def] of Object.entries(shape)) {
    properties[key] = jsonSchemaFor(def);
    const { optional } = unwrap(def);
    if (!optional && !(def instanceof z.ZodOptional) && !(def instanceof z.ZodDefault)) {
      required.push(key);
    }
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

export function toInputSchema(tool: McpTool): Record<string, unknown> {
  return objectSchema(tool.schema);
}
