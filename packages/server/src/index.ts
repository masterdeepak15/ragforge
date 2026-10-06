import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { join } from 'path';
import { createDatabaseContext, runMigrations } from './db/connection.js';
import { HybridRetriever } from './core/retrieval/hybrid.retriever.js';
import { ProviderFactory } from './core/providers/factory.js';
import { setupRoutes } from './routes/setup.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { providerRoutes } from './routes/provider.routes.js';
import { oauthRoutes } from './routes/oauth.routes.js';
import { knowledgeBaseRoutes } from './routes/kb.routes.js';
import { documentRoutes } from './routes/document.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { playgroundRoutes } from './routes/playground.routes.js';
import type { DatabaseContext } from './db/connection.js';

// Environment configuration
const PORT = parseInt(process.env.PORT || '8080');
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Storage mode: sqlite (local) or postgres (production)
const STORAGE_MODE = (process.env.STORAGE_MODE || 'sqlite') as 'sqlite' | 'postgres';

// Database connection options
const DB_OPTIONS = {
  sqliteUrl: process.env.SQLITE_URL || 'file:./ragforge.db',
  sqliteAuthToken: process.env.SQLITE_AUTH_TOKEN,
  postgresUrl: process.env.POSTGRES_URL,
};

declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseContext;
    retriever: HybridRetriever;
    authenticate: any;
    upload: any;
    dataDir: string;
  }
}

export interface CreateAppOptions {
  storageMode?: 'sqlite' | 'postgres';
  sqliteUrl?: string;
  dataDir?: string;
  jwtSecret?: string;
  logLevel?: string;
  /** Register SIGINT/SIGTERM handlers (disabled in tests). */
  signalHandlers?: boolean;
}

export async function createApp(options: CreateAppOptions = {}) {
  const storageMode = options.storageMode ?? STORAGE_MODE;
  const app = Fastify({ logger: { level: options.logLevel ?? 'info' } });
  app.decorate('dataDir', options.dataDir ?? process.env.DATA_DIR ?? join(process.cwd(), 'data'));

  // 1. Database setup
  app.log.info(`[RAGForge] Connecting to ${storageMode} database...`);
  app.db = await createDatabaseContext(storageMode, {
    ...DB_OPTIONS,
    ...(options.sqliteUrl ? { sqliteUrl: options.sqliteUrl } : {}),
  });
  await runMigrations(app.db);

  // 2. Initialize retrieval engine
  app.retriever = new HybridRetriever({
    vectorStore: app.db.vectorStore,
    async getChunksByIds(ids: string[]) {
      const client: any = app.db.client;
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(',');
      const rs = await client.execute({
        sql: `SELECT * FROM document_chunks WHERE id IN (${placeholders})`,
        args: ids,
      });
      return rs.rows.map((row: any) => ({
        id: row.id,
        documentId: row.document_id,
        knowledgeBaseId: row.knowledge_base_id,
        chunkIndex: row.chunk_index,
        content: row.content,
        tokenCount: row.token_count,
        metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
        createdAt: row.created_at,
      }));
    },
    async getAllChunksForKb(knowledgeBaseId: string) {
      const client: any = app.db.client;
      const rs = await client.execute({
        sql: `SELECT id, content FROM document_chunks WHERE knowledge_base_id = ?`,
        args: [knowledgeBaseId],
      });
      return rs.rows.map((row: any) => ({ id: row.id, content: row.content }));
    },
    async getEmbedding(text: string) {
      const client: any = app.db.client;
      const rs = await client.execute({
        sql: `SELECT * FROM ai_providers WHERE is_default_embedding = 1 LIMIT 1`,
        args: [],
      });
      const provider = rs.rows[0];
      if (!provider) throw new Error('No default embedding provider configured');

      const apiKey = provider.api_key_encrypted ? ProviderFactory.decryptApiKey(provider.api_key_encrypted as string) : undefined;
      const instance = ProviderFactory.create(provider.provider as any, {
        baseUrl: provider.base_url as string | undefined,
        apiKey,
      });

      if (!instance.generateEmbeddings) throw new Error('Provider does not support embeddings');
      const result = await instance.generateEmbeddings({
        model: provider.default_embedding_model as string || 'nomic-embed-text',
        texts: [text],
      });
      return result.embeddings[0];
    },
  });

  // 3. JWT authentication
  await app.register(jwt, { secret: options.jwtSecret ?? JWT_SECRET });
  app.decorate('authenticate', async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch (err) {
      reply.status(401).send({ error: 'Authentication required' });
    }
  });

  // 4. CORS & multipart
  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
    attachFieldsToBody: 'keyValues',
  });
  app.decorate('upload', multipart);

  // 5. Static assets (serve React build)
  const webBuildPath = join(process.cwd(), 'packages/web/dist');
  await app.register(fastifyStatic, {
    root: webBuildPath,
    prefix: '/',
    decorateReply: false,
  });

  // 6. API routes
  await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(providerRoutes);
  await app.register(oauthRoutes);
  await app.register(knowledgeBaseRoutes);
  await app.register(documentRoutes);
  await app.register(chatRoutes);
  await app.register(playgroundRoutes);

  // 7. Catch-all for React routing (SPA)
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.status(404).send({ error: 'API endpoint not found' });
    } else {
      reply.sendFile('index.html');
    }
  });

  // Graceful shutdown
  const gracefulShutdown = async () => {
    console.log('[RAGForge] Shutting down gracefully...');
    await app.db.close();
    process.exit(0);
  };
  if (options.signalHandlers ?? true) {
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
  }
  app.addHook('onClose', async () => {
    await app.db.close();
  });

  return app;
}

export async function startServer() {
  const app = await createApp();

  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`
🚀 RAGForge is running!

   Local:   http://localhost:${PORT}
   Network: ${PUBLIC_URL}

📊 Dashboard:       ${PUBLIC_URL}/
⚙️  Setup:          ${PUBLIC_URL}/setup
🤖 AI Providers:    ${PUBLIC_URL}/settings
📚 Knowledge Bases: ${PUBLIC_URL}/knowledge-bases
💬 Chat:            ${PUBLIC_URL}/chat

Storage: ${STORAGE_MODE.toUpperCase()}${STORAGE_MODE === 'sqlite' ? ' (local)' : ' (production)'}
`);
  } catch (err) {
    console.error('[RAGForge] Failed to start server:', err);
    process.exit(1);
  }
}