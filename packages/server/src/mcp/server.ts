import type { FastifyInstance } from 'fastify';
import { APP_VERSION } from '../config/env.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ApiKeyService } from '../auth/api-keys.js';
import { RateLimiter } from './rate-limit.js';
import { registerTools } from './tools.js';

export interface McpOptions {
  /** Requests per minute allowed per API key. */
  rateLimitPerMinute: number;
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * Exposes the knowledge bases over MCP (Streamable HTTP, stateless) at `POST /mcp`.
 * Authentication is `Authorization: Bearer rf_…`; the key is re-verified on every request, so
 * revocation takes effect immediately. A fresh McpServer serves each request.
 */
export async function registerMcp(app: FastifyInstance, opts: McpOptions): Promise<void> {
  const keys = new ApiKeyService(app.db);
  const limiter = new RateLimiter(opts.rateLimitPerMinute);

  app.post('/mcp', async (req, reply) => {
    const header = req.headers.authorization ?? '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const key = token ? await keys.verify(token) : null;
    if (!key) {
      return reply
        .status(401)
        .header('WWW-Authenticate', 'Bearer realm="ragforge-mcp"')
        .send(rpcError(-32001, 'Unauthorized: missing, invalid or revoked API key'));
    }

    const decision = limiter.take(key.id);
    if (!decision.ok) {
      return reply
        .status(429)
        .header('Retry-After', String(decision.retryAfterSec))
        .send(rpcError(-32029, `Rate limit exceeded; retry in ${decision.retryAfterSec}s`));
    }

    const server = new McpServer({ name: 'ragforge', version: APP_VERSION });
    registerTools(server, { db: app.db, retriever: app.retriever, scope: key.scopeKbIds });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });

    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      app.log.error({ err }, 'MCP request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify(rpcError(-32603, 'Internal server error')));
      }
    }
  });

  // Stateless server: no server-initiated streams and no sessions to terminate.
  const notAllowed = async (_req: unknown, reply: any) =>
    reply.status(405).header('Allow', 'POST').send(rpcError(-32000, 'Method not allowed; use POST'));
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
