// MCP sobre HTTP (JSON-RPC 2.0, semántica Streamable HTTP: POST -> JSON). Autenticado por
// bearer ROZ_MCP_TOKEN. Implementa el subconjunto que el cliente conversacional necesita:
// initialize, tools/list, tools/call.
import { Hono } from 'hono';
import { config } from '../config.js';
import type { RozContext } from '../types/hono.js';
import { secureEqual, bearerToken } from '../utils/secure-compare.js';
import { tools, toolsByName, toInputSchema } from '../mcp/server.js';
import { authenticateRunner } from '../plans/runners.js';
import { looksLikeRunnerToken } from '../plans/tokens.js';

export const mcpRoutes = new Hono<RozContext>();

/**
 * Herramientas que ve un runner (roz-runner corre `claude -p` con su token rozr_…). Solo lectura de
 * contexto + reportar avance: el agente no crea tareas, no da de alta devs ni confirma propuestas.
 * Con ROZ_MCP_TOKEN (el cliente conversacional) se ven todas, como siempre.
 */
const RUNNER_TOOLS = new Set(['get_plan', 'get_decisions', 'report_progress', 'get_project_context', 'list_projects']);

/** Quién llama: el cliente conversacional (todas las herramientas) o un runner (subconjunto). */
async function mcpCaller(token: string): Promise<'full' | 'runner' | null> {
  if (config.mcp.token && secureEqual(token, config.mcp.token)) return 'full';
  if (!looksLikeRunnerToken(token)) return null;
  try {
    await authenticateRunner(token);
    return 'runner';
  } catch {
    return null;
  }
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
  // Además de ROZ_MCP_TOKEN se aceptan tokens de runner vigentes (roz v2), con menos herramientas.
  const caller = await mcpCaller(bearerToken(c.req.header('authorization')));
  if (!caller) {
    return c.json(rpcError(null, -32001, 'Unauthorized'), 401);
  }
  const visible = caller === 'full' ? tools : tools.filter((t) => RUNNER_TOOLS.has(t.name));

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
          serverInfo: { name: 'roz', version: '0.1.0' },
        }),
      );

    case 'notifications/initialized':
      return c.body(null, 202);

    case 'tools/list':
      return c.json(
        rpcResult(id, {
          tools: visible.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: toInputSchema(t),
          })),
        }),
      );

    case 'tools/call': {
      const found = toolsByName.get(params?.name);
      const tool = found && (caller === 'full' || RUNNER_TOOLS.has(found.name)) ? found : undefined;
      if (!tool) return c.json(rpcError(id, -32602, `Unknown tool: ${params?.name}`), 400);
      const parsed = tool.schema.safeParse(params?.arguments ?? {});
      if (!parsed.success) {
        return c.json(rpcError(id, -32602, `Invalid arguments: ${parsed.error.message}`), 400);
      }
      try {
        const out = await tool.handler(parsed.data);
        return c.json(
          rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }),
        );
      } catch (err) {
        c.get('logger')?.error({ err, tool: tool.name }, 'mcp tool error');
        return c.json(
          rpcResult(id, {
            content: [{ type: 'text', text: `Error: ${String(err)}` }],
            isError: true,
          }),
        );
      }
    }

    default:
      return c.json(rpcError(id, -32601, `Method not found: ${method}`), 404);
  }
});
