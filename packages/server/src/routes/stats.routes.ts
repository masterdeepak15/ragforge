import type { FastifyInstance } from 'fastify';
import { APP_VERSION } from '../config/env.js';

/** GET /api/stats: everything the dashboard and the settings page show about the installation. */
export async function statsRoutes(app: FastifyInstance) {
  const db = () => app.db.client;

  app.get('/api/stats', { onRequest: [app.authenticate] }, async (_req, reply) => {
    const [kbs, docs, chunks, queue, recent] = await Promise.all([
      db().execute(`SELECT COUNT(*) AS n FROM knowledge_bases`),
      db().execute(`SELECT
                      COUNT(*) AS total,
                      COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) AS ready,
                      COALESCE(SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END), 0) AS processing,
                      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
                      COALESCE(SUM(file_size), 0) AS bytes
                    FROM documents`),
      db().execute(`SELECT COALESCE(SUM(chunk_count), 0) AS n FROM documents`),
      db().execute(`SELECT status, COUNT(*) AS n FROM ingestion_jobs WHERE status IN ('queued', 'running', 'failed') GROUP BY status`),
      db().execute(`SELECT d.id, d.title, d.status, d.knowledge_base_id, kb.name AS kb_name, d.created_at
                    FROM documents d LEFT JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
                    ORDER BY d.created_at DESC, d.id LIMIT 8`),
    ]);

    const d = docs.rows[0] as any;
    const jobs = { queued: 0, running: 0, failed: 0 } as Record<string, number>;
    for (const row of queue.rows as any[]) jobs[row.status as string] = Number(row.n);

    return reply.send({
      knowledgeBases: Number((kbs.rows[0] as any).n),
      documents: { total: Number(d.total), ready: Number(d.ready), processing: Number(d.processing), failed: Number(d.failed) },
      chunks: Number((chunks.rows[0] as any).n),
      storageBytes: Number(d.bytes),
      queue: jobs,
      recent: (recent.rows as any[]).map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        knowledgeBaseId: r.knowledge_base_id,
        knowledgeBaseName: r.kb_name ?? null,
        at: r.created_at,
      })),
      system: {
        version: APP_VERSION,
        storageMode: app.db.mode,
        ingestConcurrency: app.ingestConcurrency,
        workerRunning: app.worker.isRunning,
      },
    });
  });
}
