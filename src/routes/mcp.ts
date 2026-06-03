// MCP sobre HTTP (JSON-RPC 2.0, semántica Streamable HTTP: POST -> JSON). Autenticado por
// bearer ROZ_MCP_TOKEN. Implementa el subconjunto que el cliente conversacional necesita:
// initialize, tools/list, tools/call.
import { Hono } from 'hono';
import { config } from '../config.js';
import type { RozContext } from '../types/hono.js';
import { tools, toolsByName, toInputSchema } from '../mcp/server.js';

export const mcpRoutes = new Hono<RozContext>();

const PROTOCOL_VERSION = '2025-06-18';

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

mcpRoutes.post('/', async (c) => {
  // Auth.
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!config.mcp.token || token !== config.mcp.token) {
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
          serverInfo: { name: 'roz', version: '0.1.0' },
        }),
      );

    case 'notifications/initialized':
      return c.body(null, 202);

    case 'tools/list':
      return c.json(
        rpcResult(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: toInputSchema(t),
          })),
        }),
      );

    case 'tools/call': {
      const tool = toolsByName.get(params?.name);
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
