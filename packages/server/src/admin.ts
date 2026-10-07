/**
 * Small, stable surface for the `ragforge` command line tool. It prepares the database and the
 * defaults an install needs without going through the web app, which requires an admin to sign in first.
 */
import { randomUUID } from 'crypto';
import { ApiKeyService } from './auth/api-keys.js';
import { createDatabaseContext, runMigrations, type DatabaseContext } from './db/connection.js';

export { APP_VERSION } from './config/env.js';
export { ApiKeyService } from './auth/api-keys.js';
export type { DatabaseContext };

/** Opens (and creates, if needed) the SQLite database and brings its tables up to date. */
export async function openAdminDb(options: { sqliteUrl: string; sqliteAuthToken?: string }): Promise<DatabaseContext> {
  const db = await createDatabaseContext('sqlite', options);
  await runMigrations(db);
  return db;
}

export interface OllamaSeed {
  baseUrl: string;
  llmModel: string;
  embeddingModel: string;
}

/**
 * Makes Ollama available as a provider. A second run updates the same entry. It becomes the default
 * for answers and for indexing only where nothing has been chosen yet, so it never overrides a choice
 * someone made in Settings.
 */
export async function seedOllamaProvider(db: DatabaseContext, seed: OllamaSeed): Promise<{ id: string; created: boolean }> {
  const client = db.client;
  const existing = (await client.execute({ sql: `SELECT id FROM ai_providers WHERE provider = 'ollama' AND base_url = ?`, args: [seed.baseUrl] })).rows[0] as any;
  if (existing) {
    await client.execute({
      sql: `UPDATE ai_providers SET default_llm_model = ?, default_embedding_model = ? WHERE id = ?`,
      args: [seed.llmModel, seed.embeddingModel, existing.id],
    });
    return { id: existing.id as string, created: false };
  }

  const has = async (column: 'is_default_llm' | 'is_default_embedding') =>
    Number(((await client.execute(`SELECT COUNT(*) AS n FROM ai_providers WHERE ${column} = 1`)).rows[0] as any).n) > 0;
  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO ai_providers (id, name, provider, base_url, is_default_llm, is_default_embedding, default_llm_model, default_embedding_model)
          VALUES (?, 'Ollama (local)', 'ollama', ?, ?, ?, ?, ?)`,
    args: [id, seed.baseUrl, (await has('is_default_llm')) ? 0 : 1, (await has('is_default_embedding')) ? 0 : 1, seed.llmModel, seed.embeddingModel],
  });
  return { id, created: true };
}

/** Creates an API key for connecting an AI tool over MCP. The key is shown once; only its hash is stored. */
export async function createMcpApiKey(
  db: DatabaseContext,
  input: { name: string; knowledgeBaseIds?: string[]; /** Revoke earlier keys this tool created with the same name. */ replaceExisting?: boolean },
): Promise<{ id: string; key: string }> {
  if (input.replaceExisting) {
    // Only keys made by this tool: a key an admin created in the web app is never touched.
    await db.client.execute({ sql: `UPDATE api_keys SET revoked_at = ? WHERE name = ? AND created_by = 'cli' AND revoked_at IS NULL`, args: [Date.now(), input.name] });
  }
  const { id, key } = await new ApiKeyService(db).create({ name: input.name, scopeKbIds: input.knowledgeBaseIds ?? null, createdBy: 'cli' });
  return { id, key };
}
