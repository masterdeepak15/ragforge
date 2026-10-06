import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ApiKeyService } from './auth/api-keys.js';
import { createMcpApiKey, openAdminDb, seedOllamaProvider } from './admin.js';
import type { DatabaseContext } from './db/connection.js';

let dir: string;
let db: DatabaseContext;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ragforge-admin-'));
  db = await openAdminDb({ sqliteUrl: `file:${join(dir, 'test.db').replace(/\\/g, '/')}` });
});
afterEach(async () => {
  await db.close();
  // Windows keeps the database file locked for a moment after close; a leftover temp folder is harmless.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

const providers = async () => (await db.client.execute('SELECT * FROM ai_providers ORDER BY name')).rows as any[];

describe('openAdminDb', () => {
  it('creates the database file and its tables, so a fresh install can be prepared before the first start', async () => {
    const tables = (await db.client.execute(`SELECT name FROM sqlite_master WHERE type = 'table'`)).rows.map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['users', 'knowledge_bases', 'ai_providers', 'api_keys']));
  });
});

describe('seedOllamaProvider', () => {
  const ollama = { baseUrl: 'http://127.0.0.1:11434', llmModel: 'llama3.2:3b', embeddingModel: 'nomic-embed-text' };

  it('adds Ollama as the provider for answers and for indexing when nothing is configured', async () => {
    const result = await seedOllamaProvider(db, ollama);
    expect(result.created).toBe(true);
    const rows = await providers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'ollama',
      base_url: 'http://127.0.0.1:11434',
      default_llm_model: 'llama3.2:3b',
      default_embedding_model: 'nomic-embed-text',
      is_default_llm: 1,
      is_default_embedding: 1,
    });
  });

  it('is safe to run again: it updates the models instead of adding a second copy', async () => {
    await seedOllamaProvider(db, ollama);
    const again = await seedOllamaProvider(db, { ...ollama, llmModel: 'llama3.1:8b' });
    expect(again.created).toBe(false);
    const rows = await providers();
    expect(rows).toHaveLength(1);
    expect(rows[0].default_llm_model).toBe('llama3.1:8b');
  });

  it('does not take over a provider someone already chose for answers, but does take over indexing', async () => {
    await db.client.execute({
      sql: `INSERT INTO ai_providers (id, name, provider, is_default_llm, default_llm_model) VALUES (?, 'Claude', 'anthropic', 1, 'claude-haiku')`,
      args: [randomUUID()],
    });
    await seedOllamaProvider(db, ollama);
    const rows = await providers();
    const claude = rows.find((r) => r.provider === 'anthropic');
    const local = rows.find((r) => r.provider === 'ollama');
    expect(claude.is_default_llm).toBe(1);
    expect(local.is_default_llm).toBe(0);
    expect(local.is_default_embedding).toBe(1); // Claude cannot index, so Ollama must
  });
});

describe('createMcpApiKey', () => {
  it('creates a key that works for MCP and is only stored hashed', async () => {
    const { id, key } = await createMcpApiKey(db, { name: 'Claude Code' });
    expect(key).toMatch(/^rf_/);
    expect(await new ApiKeyService(db).verify(key)).toEqual({ id, scopeKbIds: null });
    const stored = (await db.client.execute({ sql: 'SELECT key_hash, name, created_by FROM api_keys WHERE id = ?', args: [id] })).rows[0] as any;
    expect(stored.key_hash).not.toContain(key);
    expect(stored).toMatchObject({ name: 'Claude Code', created_by: 'cli' });
  });

  it('can limit a key to some knowledge bases', async () => {
    const { key } = await createMcpApiKey(db, { name: 'Cursor', knowledgeBaseIds: ['kb1', 'kb2'] });
    expect((await new ApiKeyService(db).verify(key))?.scopeKbIds).toEqual(['kb1', 'kb2']);
  });
});
