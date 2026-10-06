import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const HEARTBEAT_MS = 15_000;

function toJobView(row: any) {
  return {
    id: row.id as string,
    documentId: row.document_id as string,
    knowledgeBaseId: row.knowledge_base_id as string,
    title: row.title as string,
    status: row.status as string,
    stage: (row.progress_stage ?? null) as string | null,
    chunksTotal: row.chunks_total === null ? null : Number(row.chunks_total),
    chunksDone: row.chunks_done === null ? null : Number(row.chunks_done),
    attempts: Number(row.attempts),
    error: (row.error ?? null) as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function ingestionRoutes(app: FastifyInstance) {
  const db = () => app.db.client;
  /** Open SSE streams; ended on shutdown so `app.close()` is not held up by idle connections. */
  const streams = new Set<() => void>();
  app.addHook('onClose', async () => {
    for (const end of [...streams]) end();
  });

  /** EventSource cannot set headers, so the SSE route also accepts the JWT as `?token=`. */
  const sseAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = (req.query as { token?: string }).token;
    if (!req.headers.authorization && typeof token === 'string' && token) {
      req.headers.authorization = `Bearer ${token}`;
    }
    await app.authenticate(req, reply);
  };

  /** GET /api/ingestion/jobs?knowledgeBaseId=&status=&limit= */
  app.get<{ Querystring: { knowledgeBaseId?: string; status?: string; limit?: string } }>(
    '/api/ingestion/jobs',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { knowledgeBaseId, status } = req.query;
      const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || '200', 10) || 200));
      const where: string[] = [];
      const args: any[] = [];
      if (knowledgeBaseId) {
        where.push('d.knowledge_base_id = ?');
        args.push(knowledgeBaseId);
      }
      if (status) {
        const statuses = status.split(',').filter(Boolean);
        where.push(`j.status IN (${statuses.map(() => '?').join(',')})`);
        args.push(...statuses);
      }
      const rs = await db().execute({
        sql: `SELECT j.*, d.title, d.knowledge_base_id
              FROM ingestion_jobs j JOIN documents d ON d.id = j.document_id
              ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
              ORDER BY j.created_ms DESC, j.id
              LIMIT ${limit}`,
        args,
      });
      return reply.send((rs.rows as any[]).map(toJobView));
    }
  );

  /** POST /api/ingestion/jobs/:id/retry — only failed or cancelled jobs */
  app.post<{ Params: { id: string } }>('/api/ingestion/jobs/:id/retry', { onRequest: [app.authenticate] }, async (req, reply) => {
    const rs = await db().execute({ sql: `SELECT status, document_id FROM ingestion_jobs WHERE id = ?`, args: [req.params.id] });
    const job = rs.rows[0] as any;
    if (!job) return reply.status(404).send({ error: 'Job not found' });
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      return reply.status(409).send({ error: `Only failed or cancelled jobs can be retried (job is ${job.status})` });
    }
    await app.jobs.retry(req.params.id);
    await db().execute({
      sql: `UPDATE documents SET status = 'pending', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [job.document_id],
    });
    app.worker.wake();
    return reply.send({ id: req.params.id, status: 'queued' });
  });

  /** DELETE /api/ingestion/jobs/:id — cancel a queued or running job */
  app.delete<{ Params: { id: string } }>('/api/ingestion/jobs/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const rs = await db().execute({ sql: `SELECT status, document_id FROM ingestion_jobs WHERE id = ?`, args: [req.params.id] });
    const job = rs.rows[0] as any;
    if (!job) return reply.status(404).send({ error: 'Job not found' });
    if (job.status === 'queued' || job.status === 'running') {
      await app.worker.cancel(req.params.id);
      await db().execute({
        sql: `UPDATE documents SET status = 'failed', error_message = 'Cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        args: [job.document_id],
      });
    }
    return reply.status(204).send();
  });

  /** GET /api/ingestion/events?knowledgeBaseId= — Server-Sent Events for ingestion progress */
  app.get<{ Querystring: { knowledgeBaseId?: string; token?: string } }>(
    '/api/ingestion/events',
    { onRequest: [sseAuth] },
    async (req, reply) => {
      const kbFilter = req.query.knowledgeBaseId;
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      reply.raw.write(': connected\n\n');

      const unsubscribe = app.events.subscribe((event) => {
        if (kbFilter && event.knowledgeBaseId !== kbFilter) return;
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), HEARTBEAT_MS);

      const end = () => {
        clearInterval(heartbeat);
        unsubscribe();
        streams.delete(end);
        reply.raw.end();
      };
      streams.add(end);
      req.raw.on('close', end);
    }
  );
}
