import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { ProviderFactory } from '../core/providers/factory.js';
import { PROVIDER_SPECS, testProviderConnection, validateBaseUrl, type ProviderSpec } from '../core/providers/connection-test.js';
import type { AIProviderType } from '@ragforge/shared';

type Role = 'llm' | 'embedding';
const ROLE_COLUMN: Record<Role, string> = { llm: 'is_default_llm', embedding: 'is_default_embedding' };
const supports = (spec: ProviderSpec, role: Role) => (role === 'llm' ? spec.supportsLlm : spec.supportsEmbeddings);

function oauthConfigured(type: AIProviderType): boolean {
  if (type === 'gemini') return !!process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (type === 'groq') return !!process.env.GROQ_OAUTH_CLIENT_ID && !!process.env.GROQ_OAUTH_CLIENT_SECRET;
  return false;
}

export async function providerRoutes(app: FastifyInstance) {
  const db = () => app.db.client;

  /** Provider settings make outbound requests and hold credentials, so viewers may look but not change. */
  const requireWriter = async (req: any, reply: any) => {
    await app.authenticate(req, reply);
    if (!reply.sent && req.user?.role === 'viewer') {
      return reply.status(403).send({ error: 'Viewers cannot manage AI providers' });
    }
  };

  const getRow = async (id: string): Promise<any | null> => {
    const rs = await db().execute({ sql: `SELECT * FROM ai_providers WHERE id = ?`, args: [id] });
    return (rs.rows[0] as any) ?? null;
  };

  /** Clears a default role so a single provider can take it. */
  const clearRole = (role: Role) => db().execute({ sql: `UPDATE ai_providers SET ${ROLE_COLUMN[role]} = 0`, args: [] });

  const hasDefault = async (role: Role): Promise<boolean> => {
    const rs = await db().execute({ sql: `SELECT id FROM ai_providers WHERE ${ROLE_COLUMN[role]} = 1 LIMIT 1`, args: [] });
    return rs.rows.length > 0;
  };

  /** After a removal, give an orphaned role to the oldest provider that can do it. */
  const promoteDefaults = async () => {
    const rows = (await db().execute({ sql: `SELECT id, provider FROM ai_providers ORDER BY created_at ASC, id`, args: [] })).rows as any[];
    for (const role of ['llm', 'embedding'] as Role[]) {
      if (await hasDefault(role)) continue;
      const candidate = rows.find((r) => PROVIDER_SPECS[r.provider as AIProviderType] && supports(PROVIDER_SPECS[r.provider as AIProviderType], role));
      if (candidate) await db().execute({ sql: `UPDATE ai_providers SET ${ROLE_COLUMN[role]} = 1 WHERE id = ?`, args: [candidate.id] });
    }
  };

  /** GET /api/providers — all providers (credentials masked) */
  app.get('/api/providers', { onRequest: [app.authenticate] }, async (_req, reply) => {
    const rs = await db().execute({ sql: `SELECT * FROM ai_providers ORDER BY created_at ASC`, args: [] });
    return reply.send(rs.rows.map(maskProvider));
  });

  /** GET /api/providers/capabilities — what each provider type can do, for the settings form */
  app.get('/api/providers/capabilities', { onRequest: [app.authenticate] }, async (_req, reply) =>
    reply.send({ providers: Object.values(PROVIDER_SPECS).map((spec) => ({ ...spec, oauthConfigured: oauthConfigured(spec.type) })) })
  );

  /** POST /api/providers/test — check settings before saving them */
  app.post<{ Body: { provider?: string; type?: string; baseUrl?: string; apiKey?: string } }>(
    '/api/providers/test',
    { onRequest: [requireWriter] },
    async (req, reply) => {
      const type = (req.body?.provider ?? req.body?.type) as AIProviderType | undefined;
      if (!type || !PROVIDER_SPECS[type]) return reply.status(400).send({ error: 'A known provider is required' });
      return reply.send(await testProviderConnection(type, { baseUrl: req.body.baseUrl, apiKey: req.body.apiKey }));
    }
  );

  /** POST /api/providers/:id/test — check a saved provider with its stored credentials */
  app.post<{ Params: { id: string } }>('/api/providers/:id/test', { onRequest: [requireWriter] }, async (req, reply) => {
    const row = await getRow(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Provider not found' });
    let apiKey: string | undefined;
    if (row.api_key_encrypted) {
      try {
        apiKey = ProviderFactory.decryptApiKey(row.api_key_encrypted as string);
      } catch {
        return reply.send({ ok: false, message: 'The stored key could not be read. Enter the key again.' });
      }
    }
    return reply.send(await testProviderConnection(row.provider, { baseUrl: row.base_url ?? undefined, apiKey }));
  });

  /** POST /api/providers — add a provider; the first one becomes the default for every role it supports */
  app.post<{
    Body: {
      provider?: string; type?: string; name?: string; baseUrl?: string; apiKey?: string; encryptedOAuthToken?: string;
      isDefaultLlm?: boolean; isDefaultEmbedding?: boolean;
      defaultLlmModel?: string; defaultModel?: string; defaultEmbeddingModel?: string;
    };
  }>('/api/providers', { onRequest: [requireWriter] }, async (req, reply) => {
    const body = req.body ?? {};
    const type = (body.provider ?? body.type) as AIProviderType | undefined; // "type" is the older field name
    if (!type) return reply.status(400).send({ error: 'provider is required' });
    const spec = PROVIDER_SPECS[type];
    if (!spec) return reply.status(400).send({ error: `Unknown provider "${type}"` });

    const baseUrl = body.baseUrl?.trim().replace(/\/+$/, '') || null;
    if (baseUrl) {
      const invalid = validateBaseUrl(baseUrl);
      if (invalid) return reply.status(400).send({ error: invalid });
    }
    if (spec.needsApiKey && !body.apiKey && !body.encryptedOAuthToken) {
      return reply.status(400).send({ error: `${spec.label} needs an API key` });
    }
    if (body.isDefaultEmbedding === true && !spec.supportsEmbeddings) {
      return reply.status(400).send({ error: `${spec.label} cannot create embeddings. Choose another provider for indexing.` });
    }

    const wantsLlm = body.isDefaultLlm === true;
    const wantsEmbedding = body.isDefaultEmbedding === true;
    // Unless told otherwise, fill any role nobody holds yet.
    const isDefaultLlm = wantsLlm || (body.isDefaultLlm === undefined && spec.supportsLlm && !(await hasDefault('llm')));
    const isDefaultEmbedding = wantsEmbedding || (body.isDefaultEmbedding === undefined && spec.supportsEmbeddings && !(await hasDefault('embedding')));
    if (wantsLlm) await clearRole('llm');
    if (wantsEmbedding) await clearRole('embedding');

    const id = randomUUID();
    const apiKeyEncrypted = body.apiKey ? ProviderFactory.encryptApiKey(body.apiKey) : (body.encryptedOAuthToken ?? null);
    await db().execute({
      sql: `INSERT INTO ai_providers (id, name, provider, base_url, api_key_encrypted, is_default_llm, is_default_embedding, default_llm_model, default_embedding_model)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, body.name?.trim() || spec.label, type, baseUrl, apiKeyEncrypted,
        isDefaultLlm ? 1 : 0, isDefaultEmbedding ? 1 : 0,
        body.defaultLlmModel || body.defaultModel || spec.defaultLlmModel,
        spec.supportsEmbeddings ? body.defaultEmbeddingModel || spec.defaultEmbeddingModel || null : null,
      ],
    });
    return reply.status(201).send(maskProvider(await getRow(id)));
  });

  /** PATCH /api/providers/:id */
  app.patch<{ Params: { id: string }; Body: Record<string, any> }>('/api/providers/:id', { onRequest: [requireWriter] }, async (req, reply) => {
    const row = await getRow(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Provider not found' });
    const spec = PROVIDER_SPECS[row.provider as AIProviderType];
    const u = req.body ?? {};

    if (u.isDefaultEmbedding === true && !spec?.supportsEmbeddings) {
      return reply.status(400).send({ error: `${spec?.label ?? 'This provider'} cannot create embeddings. Choose another provider for indexing.` });
    }
    if (u.baseUrl) {
      const invalid = validateBaseUrl(String(u.baseUrl));
      if (invalid) return reply.status(400).send({ error: invalid });
    }

    const fields: string[] = [];
    const args: any[] = [];
    if (u.name !== undefined) { fields.push('name = ?'); args.push(String(u.name).trim() || spec?.label || row.name); }
    if (u.baseUrl !== undefined) { fields.push('base_url = ?'); args.push(u.baseUrl ? String(u.baseUrl).trim().replace(/\/+$/, '') : null); }
    if (u.apiKey) { fields.push('api_key_encrypted = ?'); args.push(ProviderFactory.encryptApiKey(u.apiKey)); }
    if (u.isDefaultLlm !== undefined) {
      if (u.isDefaultLlm) await clearRole('llm');
      fields.push('is_default_llm = ?'); args.push(u.isDefaultLlm ? 1 : 0);
    }
    if (u.isDefaultEmbedding !== undefined) {
      if (u.isDefaultEmbedding) await clearRole('embedding');
      fields.push('is_default_embedding = ?'); args.push(u.isDefaultEmbedding ? 1 : 0);
    }
    const llmModel = u.defaultLlmModel ?? u.defaultModel;
    if (llmModel !== undefined) { fields.push('default_llm_model = ?'); args.push(llmModel || null); }
    if (u.defaultEmbeddingModel !== undefined) { fields.push('default_embedding_model = ?'); args.push(u.defaultEmbeddingModel || null); }

    if (fields.length === 0) return reply.status(400).send({ error: 'No fields to update' });
    fields.push('updated_at = CURRENT_TIMESTAMP');
    await db().execute({ sql: `UPDATE ai_providers SET ${fields.join(', ')} WHERE id = ?`, args: [...args, req.params.id] });
    return reply.send(maskProvider(await getRow(req.params.id)));
  });

  /** DELETE /api/providers/:id — idempotent; orphaned default roles move to another capable provider */
  app.delete<{ Params: { id: string } }>('/api/providers/:id', { onRequest: [requireWriter] }, async (req, reply) => {
    await db().execute({ sql: `DELETE FROM ai_providers WHERE id = ?`, args: [req.params.id] });
    await promoteDefaults();
    return reply.status(204).send();
  });

  /** GET /api/providers/:id/models — list available models */
  app.get<{ Params: { id: string } }>('/api/providers/:id/models', { onRequest: [app.authenticate] }, async (req, reply) => {
    const row = await getRow(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Provider not found' });

    const apiKey = row.api_key_encrypted ? ProviderFactory.decryptApiKey(row.api_key_encrypted as string) : undefined;
    const instance = ProviderFactory.create(row.provider as AIProviderType, { baseUrl: row.base_url as string | undefined, apiKey });

    const [llmModels, embeddingModels] = await Promise.allSettled([
      instance.listModels ? instance.listModels() : Promise.resolve([]),
      instance.listEmbeddingModels ? instance.listEmbeddingModels() : Promise.resolve([]),
    ]);

    return reply.send({
      llm: llmModels.status === 'fulfilled' ? llmModels.value : [],
      embedding: embeddingModels.status === 'fulfilled' ? embeddingModels.value : [],
    });
  });
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
