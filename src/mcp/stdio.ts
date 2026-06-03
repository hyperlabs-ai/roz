// Entrypoint MCP por stdio para clientes locales (Claude Desktop). Reutiliza el mismo
// registry de tools que el endpoint HTTP (src/mcp/server.ts), pero usando el transporte
// stdio del SDK oficial. Claude Desktop lanza este proceso y habla JSON-RPC por stdin/out.
//
// Importante: cargamos el .env por ruta ABSOLUTA (relativa a este archivo) ANTES de
// importar cualquier módulo que lea config, porque Claude Desktop lanza el proceso con un
// cwd arbitrario. Por eso el import del registry es dinámico (después de loadEnv).
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ZodRawShape } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '../../.env') }); // src/mcp/ y dist/mcp/ → ../../ = raíz del proyecto

const { tools } = await import('./server.js');

const server = new McpServer({ name: 'roz', version: '0.1.0' });

for (const t of tools) {
  const shape = ((t.schema as { shape?: ZodRawShape }).shape ?? {}) as ZodRawShape;
  server.registerTool(
    t.name,
    { description: t.description, inputSchema: shape },
    async (args: unknown) => {
      const out = await t.handler(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] };
    },
  );
}

await server.connect(new StdioServerTransport());
