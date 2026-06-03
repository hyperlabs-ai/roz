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
} from '../router/assign.js';
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
    name: 'propose_change',
    description:
      'Envía una propuesta de cambio/feature/bug/ticket para un proyecto. roz la evalúa ' +
      'contra el contexto del proyecto y SUGIERE (no asigna) un dev. IMPORTANTE: no inventes ' +
      'el alcance — si el usuario no dio título y spec concretos (qué se quiere, criterio de ' +
      'aceptación, contexto), PÍDESELOS antes de llamar esta tool. roz rechaza propuestas vagas.',
    schema: z.object({
      projectKey: z.string().describe('Clave del proyecto, p.ej. "ROZ"'),
      kind: z
        .enum(['feature', 'bug', 'chore', 'ticket', 'refactor'])
        .describe('Tipo de trabajo. Explícito; no lo infieras si el usuario no lo dijo.'),
      title: z.string().describe('Título concreto (mín. 6 caracteres)'),
      spec: z
        .string()
        .describe('Spec concreta: qué se quiere, criterio de aceptación, contexto (mín. 30 caracteres)'),
      requester: z.string().optional().describe('Quién origina la propuesta (para notificar al cerrar)'),
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
    name: 'upsert_dev',
    description:
      'Crea o actualiza un dev. Para actualizar, pasa su id. Mapea linearUserId para que los ' +
      'issues queden asignados a la persona real y whatsapp (E.164, p.ej. +52...) para notificar.',
    schema: z.object({
      id: z.string().optional().describe('id del dev para actualizar; omitir para crear'),
      name: z.string(),
      email: z.string().optional(),
      whatsapp: z.string().optional().describe('E.164, p.ej. +526441976008'),
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
