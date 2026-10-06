import type { FastifyInstance } from 'fastify';
import { ApiKeyService } from '../auth/api-keys.js';

const MAX_NAME_LENGTH = 100;

export async function apiKeyRoutes(app: FastifyInstance) {
  const keys = new ApiKeyService(app.db);

  /** Viewers are read-only users; minting credentials that read the knowledge base is not read-only. */
  const requireWriter = async (req: any, reply: any) => {
    await app.authenticate(req, reply);
    if (!reply.sent && req.user?.role === 'viewer') {
      return reply.status(403).send({ error: 'Viewers cannot manage API keys' });
    }
  };

  /** GET /api/api-keys */
  app.get('/api/api-keys', { onRequest: [requireWriter] }, async (_req, reply) => reply.send(await keys.list()));

  /** POST /api/api-keys — the only response that ever contains the key itself */
  app.post<{ Body: { name?: string; knowledgeBaseIds?: string[] | null } }>(
    '/api/api-keys',
    { onRequest: [requireWriter] },
    async (req, reply) => {
      const name = (req.body?.name ?? '').trim();
      if (!name || name.length > MAX_NAME_LENGTH) {
        return reply.status(400).send({ error: `name is required (1-${MAX_NAME_LENGTH} characters)` });
      }

      let scopeKbIds: string[] | null = null;
      const requested = req.body?.knowledgeBaseIds;
      if (Array.isArray(requested)) {
        scopeKbIds = [...new Set(requested)];
        for (const id of scopeKbIds) {
          const rs = await app.db.client.execute({ sql: `SELECT id FROM knowledge_bases WHERE id = ?`, args: [id] });
          if (!rs.rows[0]) return reply.status(400).send({ error: `Unknown knowledge base: ${id}` });
        }
      }

      const created = await keys.create({ name, scopeKbIds, createdBy: (req.user as any).sub });
      return reply.status(201).send({ ...created, name, scopeKbIds });
    }
  );

  /** DELETE /api/api-keys/:id — revoke */
  app.delete<{ Params: { id: string } }>('/api/api-keys/:id', { onRequest: [requireWriter] }, async (req, reply) => {
    if (!(await keys.revoke(req.params.id))) return reply.status(404).send({ error: 'API key not found' });
    return reply.status(204).send();
  });
}
