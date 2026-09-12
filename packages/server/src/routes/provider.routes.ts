import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { ProviderFactory } from '../core/providers/factory.js';
import type { AIProviderType } from '@ragforge/shared';

export async function providerRoutes(app: FastifyInstance) {
  const db = () => app.db.client;

  /** GET /api/providers — list all providers (masked keys) */
  app.get('/api/providers', { onRequest: [app.authenticate] }, async (_req, reply) => {
    const rs = await db().execute({ sql: `SELECT * FROM ai_providers ORDER BY created_at ASC`, args: [] });
    return reply.send(rs.rows.map(maskProvider));
  });

  /** POST /api/providers — add a new provider */
  app.post<{
    Body: {
      name: string;
      provider: AIProviderType;
      baseUrl?: string;
      apiKey?: string;
      encryptedOAuthToken?: string;
      isDefaultLlm?: boolean;
      isDefaultEmbedding?: boolean;
      defaultLlmModel?: string;
      defaultEmbeddingModel?: string;
    }
  }>('/api/providers', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { name, provider, baseUrl, apiKey, encryptedOAuthToken, isDefaultLlm, isDefaultEmbedding, defaultLlmModel, defaultEmbeddingModel } = req.body;

    if (!name || !provider) return reply.status(400).send({ error: 'name and provider are required' });

    // Encrypt credential: either raw API key or already-encrypted OAuth token from callback
    let apiKeyEncrypted: string | null = null;
    if (apiKey) {
      apiKeyEncrypted = ProviderFactory.encryptApiKey(apiKey);
    } else if (encryptedOAuthToken) {
      apiKeyEncrypted = encryptedOAuthToken;
    }

    const id = randomUUID();
    if (isDefaultLlm) {
      await db().execute({ sql: `UPDATE ai_providers SET is_default_llm = 0`, args: [] });
    }
    if (isDefaultEmbedding) {
      await db().execute({ sql: `UPDATE ai_providers SET is_default_embedding = 0`, args: [] });
    }

    await db().execute({
      sql: `INSERT INTO ai_providers (id, name, provider, base_url, api_key_encrypted, is_default_llm, is_default_embedding, default_llm_model, default_embedding_model)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, name, provider, baseUrl ?? null, apiKeyEncrypted, isDefaultLlm ? 1 : 0, isDefaultEmbedding ? 1 : 0, defaultLlmModel ?? null, defaultEmbeddingModel ?? null],
    });

    const rs = await db().execute({ sql: `SELECT * FROM ai_providers WHERE id = ?`, args: [id] });
    return reply.status(201).send(maskProvider(rs.rows[0]));
  });

  /** PATCH /api/providers/:id — update a provider */
  app.patch<{ Params: { id: string }; Body: Record<string, any> }>(
    '/api/providers/:id',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params;
    const updates = req.body as Record<string, any>;

      const fields: string[] = [];
      const args: any[] = [];

      if (updates.name !== undefined) { fields.push('name = ?'); args.push(updates.name); }
      if (updates.baseUrl !== undefined) { fields.push('base_url = ?'); args.push(updates.baseUrl); }
      if (updates.apiKey !== undefined) { fields.push('api_key_encrypted = ?'); args.push(ProviderFactory.encryptApiKey(updates.apiKey)); }
      if (updates.isDefaultLlm !== undefined) {
        if (updates.isDefaultLlm) await db().execute({ sql: `UPDATE ai_providers SET is_default_llm = 0`, args: [] });
        fields.push('is_default_llm = ?'); args.push(updates.isDefaultLlm ? 1 : 0);
      }
      if (updates.isDefaultEmbedding !== undefined) {
        if (updates.isDefaultEmbedding) await db().execute({ sql: `UPDATE ai_providers SET is_default_embedding = 0`, args: [] });
        fields.push('is_default_embedding = ?'); args.push(updates.isDefaultEmbedding ? 1 : 0);
      }
      if (updates.defaultLlmModel !== undefined) { fields.push('default_llm_model = ?'); args.push(updates.defaultLlmModel); }
      if (updates.defaultEmbeddingModel !== undefined) { fields.push('default_embedding_model = ?'); args.push(updates.defaultEmbeddingModel); }

      if (fields.length === 0) return reply.status(400).send({ error: 'No fields to update' });
      fields.push('updated_at = CURRENT_TIMESTAMP');
      args.push(id);

      await db().execute({ sql: `UPDATE ai_providers SET ${fields.join(', ')} WHERE id = ?`, args });
      const rs = await db().execute({ sql: `SELECT * FROM ai_providers WHERE id = ?`, args: [id] });
      return reply.send(maskProvider(rs.rows[0]));
    }
  );

  /** DELETE /api/providers/:id */
  app.delete<{ Params: { id: string } }>(
    '/api/providers/:id',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      await db().execute({ sql: `DELETE FROM ai_providers WHERE id = ?`, args: [req.params.id] });
      return reply.status(204).send();
    }
  );

  /** GET /api/providers/:id/models — list available models */
  app.get<{ Params: { id: string } }>(
    '/api/providers/:id/models',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const rs = await db().execute({ sql: `SELECT * FROM ai_providers WHERE id = ?`, args: [req.params.id] });
      const row = rs.rows[0];
      if (!row) return reply.status(404).send({ error: 'Provider not found' });

      const apiKey = row.api_key_encrypted ? ProviderFactory.decryptApiKey(row.api_key_encrypted as string) : undefined;
      const instance = ProviderFactory.create(row.provider as AIProviderType, {
        baseUrl: row.base_url as string | undefined,
        apiKey,
      });

      const [llmModels, embeddingModels] = await Promise.allSettled([
        instance.listModels ? instance.listModels() : Promise.resolve([]),
        instance.listEmbeddingModels ? instance.listEmbeddingModels() : Promise.resolve([]),
      ]);

      return reply.send({
        llm: llmModels.status === 'fulfilled' ? llmModels.value : [],
        embedding: embeddingModels.status === 'fulfilled' ? embeddingModels.value : [],
      });
    }
  );
}

function maskProvider(row: any) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.base_url,
    hasApiKey: !!row.api_key_encrypted,
    apiKeyMasked: row.api_key_encrypted ? '••••••••' : null,
    isDefaultLlm: !!row.is_default_llm,
    isDefaultEmbedding: !!row.is_default_embedding,
    defaultLlmModel: row.default_llm_model,
    defaultEmbeddingModel: row.default_embedding_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
