import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'fs';
import { join } from 'path';
import { createDatabaseContext, runMigrations } from './db/connection.js';
import { HybridRetriever } from './core/retrieval/hybrid.retriever.js';
import { InProcessEventBus, type EventBus } from './events/event-bus.js';
import { JobQueue } from './queue/job-queue.js';
import { Worker } from './queue/worker.js';
import { ingestDocument, resolveEmbedder } from './services/ingestion.handler.js';
import { createKeywordIndex } from './core/search/fts.js';
import { migrateLegacyVectors } from './core/vector/migrate-legacy.js';
import { ProviderFactory } from './core/providers/factory.js';
import { setupRoutes } from './routes/setup.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { providerRoutes } from './routes/provider.routes.js';
import { oauthRoutes } from './routes/oauth.routes.js';
import { knowledgeBaseRoutes } from './routes/kb.routes.js';
import { documentRoutes } from './routes/document.routes.js';
import { ingestionRoutes } from './routes/ingestion.routes.js';
import { apiKeyRoutes } from './routes/apikey.routes.js';
import { registerMcp } from './mcp/server.js';
import { healthRoutes } from './routes/health.routes.js';
import { statsRoutes } from './routes/stats.routes.js';
import { loadConfig } from './config/env.js';
import { resumableUploadRoutes, purgeStaleUploads } from './uploads/resumable.routes.js';
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
    dataDir: string;
    events: EventBus;
    jobs: JobQueue;
    worker: Worker;
    workerEnabled: boolean;
    ingestConcurrency: number;
  }
}

/** Hides login tokens (sent as `?token=` by EventSource, which cannot set headers) before a URL is logged. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/gi, '$1[redacted]');
}

export interface CreateAppOptions {
  storageMode?: 'sqlite' | 'postgres';
  sqliteUrl?: string;
  dataDir?: string;
  jwtSecret?: string;
  logLevel?: string;
  /** Where logs go (default stdout). Tests capture them here. */
  logStream?: NodeJS.WritableStream;
  /** Start the ingestion worker (disabled by default in tests). */
  startWorker?: boolean;
  /** Directory holding the built web app (default WEB_DIR env or packages/web/dist under the working directory). */
  webDir?: string;
  /** MCP requests per minute per API key (default MCP_RATE_LIMIT env or 60). */
  mcpRateLimit?: number;
  /** Register SIGINT/SIGTERM handlers (disabled in tests). */
  signalHandlers?: boolean;
}

export async function createApp(options: CreateAppOptions = {}) {
  const storageMode = options.storageMode ?? STORAGE_MODE;
  const app = Fastify({
    logger: {
      level: options.logLevel ?? 'info',
      ...(options.logStream ? { stream: options.logStream } : {}),
      serializers: {
        req: (req: any) => ({ method: req.method, url: redactUrl(req.url ?? ''), host: req.host ?? req.headers?.host, remoteAddress: req.ip, remotePort: req.socket?.remotePort }),
      },
    },
  });
  app.decorate('dataDir', options.dataDir ?? process.env.DATA_DIR ?? join(process.cwd(), 'data'));

  app.decorate('events', new InProcessEventBus());

  // 1. Database setup
  app.log.info(`[RAGForge] Connecting to ${storageMode} database...`);
  app.db = await createDatabaseContext(storageMode, {
    ...DB_OPTIONS,
    ...(options.sqliteUrl ? { sqliteUrl: options.sqliteUrl } : {}),
  });
  await runMigrations(app.db);
  await migrateLegacyVectors(app.db);
  app.decorate('jobs', new JobQueue(app.db));
  app.decorate('worker', new Worker(app.jobs));
  app.decorate('workerEnabled', options.startWorker ?? true);
  const ingestConcurrency = Math.max(1, Number(process.env.INGEST_CONCURRENCY) || 2);
  app.decorate('ingestConcurrency', ingestConcurrency);
  // Single process: any job still 'running' at boot was interrupted by a crash or restart.
  const recovered = await app.jobs.recoverStale(0);
  if (recovered > 0) app.log.info(`[RAGForge] Re-queued ${recovered} interrupted ingestion job(s)`);

  if (options.startWorker ?? true) {
    const concurrency = ingestConcurrency;
    app.worker.start({
      concurrency,
      handler: (job, signal) =>
        ingestDocument(job, { db: app.db, vectorStore: app.db.vectorStore, events: app.events, jobs: app.jobs, dataDir: app.dataDir }, signal),
    });
    app.events.subscribe((e) => {
      if (e.type === 'document.uploaded') app.worker.wake();
    });
    app.log.info(`[RAGForge] Ingestion worker started (concurrency ${concurrency})`);
  }

  // 2. Initialize retrieval engine
  app.retriever = new HybridRetriever({
    vectorStore: app.db.vectorStore,
    async getChunksByIds(ids: string[]) {
      const client: any = app.db.client;
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(',');
      const rs = await client.execute({
        sql: `SELECT c.* FROM document_chunks c JOIN documents d ON d.id = c.document_id
              WHERE d.status = 'ready' AND c.id IN (${placeholders})`, // never return fragments of unfinished documents
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
    keywordIndex: createKeywordIndex(app.db),
    async getEmbedding(text: string, knowledgeBaseId: string) {
      const client: any = app.db.client;
      const kb = (await client.execute({ sql: `SELECT * FROM knowledge_bases WHERE id = ?`, args: [knowledgeBaseId] })).rows[0] ?? {};
      // Same provider and model the knowledge base was indexed with (the old code always used the default provider).
      const { provider, model } = await resolveEmbedder(app.db, kb);
      const recorded = (await client.execute({ sql: `SELECT embedding_model FROM kb_vector_tables WHERE knowledge_base_id = ?`, args: [knowledgeBaseId] })).rows[0];
      if (recorded?.embedding_model && recorded.embedding_model !== model) {
        throw new Error(
          `The embedding model is now "${model}", but this knowledge base was indexed with "${recorded.embedding_model}", so searches would return meaningless matches. ` +
            `Switch back to the original embedding model, or create a new knowledge base.`
        );
      }
      const result = await provider.generateEmbeddings!({ model, texts: [text] });
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
  // Files are streamed to disk by UploadService; no size cap unless MAX_UPLOAD_BYTES is set.
  const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES) || undefined;
  await app.register(multipart, {
    // fileSize must be explicit: the plugin otherwise defaults to Fastify's 1 MiB bodyLimit.
    limits: { fileSize: maxUploadBytes ?? Number.MAX_SAFE_INTEGER, files: 100_000, fieldSize: 1024 * 1024 },
  });

  // 5. Static assets (serve React build)
  const webBuildPath = options.webDir ?? process.env.WEB_DIR ?? join(process.cwd(), 'packages/web/dist');
  const serveWeb = existsSync(join(webBuildPath, 'index.html'));
  if (serveWeb) {
    // decorateReply must stay on: the SPA fallback below uses reply.sendFile.
    await app.register(fastifyStatic, { root: webBuildPath, prefix: '/' });
  } else {
    app.log.warn(`[RAGForge] No web build found at ${webBuildPath}; serving the API only (run \`npm run build\`).`);
  }

  // 6. API routes
  await app.register(healthRoutes);
  await app.register(statsRoutes);
  await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(providerRoutes);
  await app.register(oauthRoutes);
  await app.register(knowledgeBaseRoutes);
  await app.register(documentRoutes);
  await app.register(resumableUploadRoutes);
  await app.register(ingestionRoutes);
  await app.register(apiKeyRoutes);
  await registerMcp(app, { rateLimitPerMinute: options.mcpRateLimit ?? (Number(process.env.MCP_RATE_LIMIT) || 60) });
  purgeStaleUploads(app.db, app.dataDir).catch((err) => app.log.warn({ err }, 'upload purge failed'));
  await app.register(chatRoutes);
  await app.register(playgroundRoutes);

  // 7. Catch-all for React routing (SPA)
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !serveWeb) {
      reply.status(404).send({ error: req.url.startsWith('/api/') ? 'API endpoint not found' : 'Not found' });
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
    await app.worker.stop();
    await app.db.close();
  });

  return app;
}

export async function startServer() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    console.error(`[RAGForge] ${(err as Error).message}`);
    process.exit(1);
  }
  for (const warning of config.warnings) console.warn(`[RAGForge] WARNING: ${warning}`);
  const app = await createApp({ jwtSecret: config.jwtSecret });

  try {
    await app.listen({ port: PORT, host: config.host });
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