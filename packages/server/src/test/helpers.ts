import { createHash, randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../index.js';
import { ProviderFactory } from '../core/providers/factory.js';

export const FAKE_EMBEDDING_DIM = 8;

/** Deterministic embedding: 8 floats derived from the SHA-256 of the text. */
export function fakeEmbed(text: string): number[] {
  const digest = createHash('sha256').update(text).digest();
  return Array.from({ length: FAKE_EMBEDDING_DIM }, (_, i) => digest[i] / 255 - 0.5);
}

export interface TestApp {
  app: FastifyInstance;
  token: string;
  dataDir: string;
  fakeEmbed: (text: string) => number[];
  close(): Promise<void>;
}

/**
 * Boots the full app on a throwaway SQLite database with an admin user, a
 * default embedding provider backed by `fakeEmbed`, and a temp data directory.
 */
export async function createTestApp(opts: { worker?: boolean; mcpRateLimit?: number; webDir?: string; logStream?: NodeJS.WritableStream } = {}): Promise<TestApp> {
  const dataDir = await mkdtemp(join(tmpdir(), 'ragforge-test-'));

  ProviderFactory.register('ollama', () => ({
    async generateEmbeddings({ texts }: { texts: string[] }) {
      return { embeddings: texts.map(fakeEmbed), model: 'fake', usage: { totalTokens: 0 } } as any;
    },
    async listEmbeddingModels() {
      return [];
    },
  }));

  const app = await createApp({
    storageMode: 'sqlite',
    sqliteUrl: ':memory:',
    dataDir,
    jwtSecret: 'test-secret',
    logLevel: opts.logStream ? 'info' : 'silent',
    logStream: opts.logStream,
    signalHandlers: false,
    startWorker: opts.worker ?? false,
    mcpRateLimit: opts.mcpRateLimit ?? 100_000,
    webDir: opts.webDir,
  });
  await app.ready();

  const init = await app.inject({
    method: 'POST',
    url: '/api/setup/init',
    payload: { username: 'admin', email: 'admin@test.local', password: 'password123' },
  });
  if (init.statusCode !== 200) throw new Error(`setup/init failed: ${init.statusCode} ${init.body}`);
  const token: string = init.json().token;

  await app.db.client.execute({
    sql: `INSERT INTO ai_providers (id, name, provider, is_default_embedding, default_embedding_model)
          VALUES (?, 'fake', 'ollama', 1, 'fake')`,
    args: [randomUUID()],
  });

  return {
    app,
    token,
    dataDir,
    fakeEmbed,
    async close() {
      await app.close();
      await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}
