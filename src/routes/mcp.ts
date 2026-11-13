// MCP sobre HTTP (JSON-RPC 2.0, semántica Streamable HTTP: POST -> JSON). Implementa el subconjunto
// que el cliente conversacional necesita: initialize, tools/list, tools/call.
//
// Tres tipos de credencial, de más a menos alcance:
//   · token de zeus (`zeus_…`, uno o varios por dev): la forma normal. El agente actúa como esa
//     persona; ve las herramientas de zeus y las de lectura de roz.
//   · token de runner (`rozr_…`): el agente que corre solo en la PC de un dev. Contexto de solo
//     lectura + reportar avance + mensajes.
//   · ROZ_MCP_TOKEN compartido: el cliente conversacional histórico. Ve las herramientas de roz, pero
//     NO las de zeus: no identifica a nadie, y en zeus todo queda atribuido a una persona.
import { Hono } from 'hono';
import { config } from '../config.js';
import type { RozContext } from '../types/hono.js';
import { AppError } from '../utils/errors.js';
import { secureEqual, bearerToken } from '../utils/secure-compare.js';
import { tools, toolsByName, toInputSchema } from '../mcp/server.js';
import { authenticateRunner } from '../plans/runners.js';
import { looksLikeRunnerToken } from '../plans/tokens.js';
import { actorForDev, authenticateZeusToken, looksLikeZeusToken, type ZeusActor } from '../zeus/core.js';
import { zeusTools, zeusToolsByName } from '../zeus/mcp.js';

export const mcpRoutes = new Hono<RozContext>();

/**
 * Herramientas que ve un runner (roz-runner corre `claude -p` con su token rozr_…). Solo lectura de
 * contexto + reportar avance: el agente no crea tareas, no da de alta devs ni confirma propuestas.
 * Con ROZ_MCP_TOKEN (el cliente conversacional) se ven todas, como siempre.
 */
const RUNNER_TOOLS = new Set(['get_plan', 'get_decisions', 'report_progress', 'get_project_context', 'list_projects']);

/** Herramientas de roz que ve un dev con su token de zeus: lectura y su propio flujo de propuesta. */
const DEV_TOOLS = new Set([
  ...RUNNER_TOOLS,
  'list_devs',
  'suggest_assignee',
  'get_intake_form',
  'propose_change',
  'confirm_proposal',
]);
/** Herramientas de zeus que un runner puede usar además de las de solo lectura. */
const RUNNER_ZEUS_WRITE = new Set(['zeus_send_message', 'zeus_request', 'zeus_mark_read']);

type Caller = { kind: 'full' } | { kind: 'runner'; actor: ZeusActor } | { kind: 'dev'; actor: ZeusActor };

/** Quién llama y con qué alcance. Null = no autorizado. */
async function mcpCaller(token: string): Promise<Caller | null> {
  if (config.mcp.token && secureEqual(token, config.mcp.token)) return { kind: 'full' };
  if (looksLikeZeusToken(token)) {
    const actor = await authenticateZeusToken(token, 'mcp');
    return actor ? { kind: 'dev', actor } : null;
  }
  if (!looksLikeRunnerToken(token)) return null;
  try {
    const auth = await authenticateRunner(token);
    return { kind: 'runner', actor: await actorForDev(auth.dev.id, 'runner') };
  } catch {
    return null;
  }
}

function rozVisible(caller: Caller): typeof tools {
  if (caller.kind === 'full') return tools;
  const allow = caller.kind === 'runner' ? RUNNER_TOOLS : DEV_TOOLS;
  return tools.filter((t) => allow.has(t.name));
}

function zeusVisible(caller: Caller): typeof zeusTools {
  if (caller.kind === 'full') return [];
  if (caller.kind === 'dev') return zeusTools;
  return zeusTools.filter((t) => t.readOnly || RUNNER_ZEUS_WRITE.has(t.name));
}

function visibleTools(caller: Caller): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [...zeusVisible(caller), ...rozVisible(caller)].map((t) => ({ name: t.name, description: t.description, inputSchema: toInputSchema(t) }));
}

const PROTOCOL_VERSION = '2025-06-18';

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

mcpRoutes.post('/', async (c) => {
  // Auth (comparación en tiempo constante; fail-closed si el token no está configurado).
  const caller = await mcpCaller(bearerToken(c.req.header('authorization')));
  if (!caller) {
    return c.json(rpcError(null, -32001, 'Unauthorized'), 401);
  }

  const body = (await c.req.json().catch(() => null)) as
    | { jsonrpc?: string; id?: unknown; method?: string; params?: any }
    | null;
  if (!body || body.method == null) {
    return c.json(rpcError(body?.id ?? null, -32600, 'Invalid Request'), 400);
  }

  const { id, method, params } = body;

  switch (method) {
    case 'initialize':
      return c.json(
        rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'zeus', version: '0.2.0' },
          ...(caller.kind === 'full'
            ? {}
            : {
                instructions:
                  'zeus es el contexto compartido del equipo. Antes de planear o tocar código de un proyecto llama ' +
                  'zeus_context_index, y trae con zeus_get solo lo que aplique. Las reglas y decisiones vigentes se respetan. ' +
                  'El registro de zeus es la fuente de verdad de ADR, specs, reglas y documentos: para cambiar uno edítalo AQUÍ ' +
                  'con zeus_write (también los importados de un repo), no en su archivo del repo, que solo fue el origen de la importación. ' +
                  'Nunca escribas secretos ni valores de variables de entorno en mensajes o documentos.',
              }),
        }),
      );

    case 'notifications/initialized':
      return c.body(null, 202);

    case 'tools/list':
      return c.json(
        rpcResult(id, { tools: visibleTools(caller) }),
      );

    case 'tools/call': {
      const name = String(params?.name ?? '');
      // Solo se resuelve entre lo que ESTE llamador ve: una herramienta fuera de su alcance es,
      // para él, una herramienta que no existe.
      const zeusTool = zeusVisible(caller).some((t) => t.name === name) ? zeusToolsByName.get(name) : undefined;
      const rozTool = !zeusTool && rozVisible(caller).some((t) => t.name === name) ? toolsByName.get(name) : undefined;
      const tool = zeusTool ?? rozTool;
      if (!tool) return c.json(rpcError(id, -32602, `Unknown tool: ${name}`), 400);
      const parsed = tool.schema.safeParse(params?.arguments ?? {});
      if (!parsed.success) {
        return c.json(rpcError(id, -32602, `Invalid arguments: ${parsed.error.message}`), 400);
      }
      try {
        const out = zeusTool && caller.kind !== 'full' ? await zeusTool.handler(parsed.data, caller.actor) : await rozTool!.handler(parsed.data);
        return c.json(
          rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }),
        );
      } catch (err) {
        // Un AppError es una respuesta de dominio ("ese archivo ya no existe en el repo", "no te toca
        // resolverla"): el agente necesita el mensaje limpio, no un stack.
        const expected = err instanceof AppError;
        if (!expected) c.get('logger')?.error({ err, tool: tool.name }, 'mcp tool error');
        const text = expected
          ? `Error (${err.code}): ${err.message}${err.details ? ` ${JSON.stringify(err.details)}` : ''}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
        return c.json(rpcResult(id, { content: [{ type: 'text', text }], isError: true }));
      }
    }

    default:
      return c.json(rpcError(id, -32601, `Method not found: ${method}`), 404);
  }
});
