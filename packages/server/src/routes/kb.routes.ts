import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';

export async function knowledgeBaseRoutes(app: FastifyInstance) {
  const db = () => app.db.client;

  /** GET /api/knowledge-bases */
  app.get('/api/knowledge-bases', { onRequest: [app.authenticate] }, async (_req, reply) => {
    const rs = await db().execute({
      sql: `SELECT kb.*,
              (SELECT COUNT(*) FROM documents d WHERE d.knowledge_base_id = kb.id) AS document_count,
              (SELECT COUNT(*) FROM document_chunks c WHERE c.knowledge_base_id = kb.id) AS chunk_count
            FROM knowledge_bases kb
            ORDER BY kb.created_at DESC`,
      args: [],
    });
    return reply.send(rs.rows.map((row: any) => ({
      ...row,
      documentCount: Number(row.document_count || 0),
      chunkCount: Number(row.chunk_count || 0),
    })));
  });

  /** POST /api/knowledge-bases */
  app.post<{
    Body: {
      name: string;
      description?: string;
      icon?: string;
      color?: string;
      embeddingProviderId?: string;
      embeddingModel?: string;
      embeddingDimension?: number;
      chunkSize?: number;
      chunkOverlap?: number;
    }
  }>('/api/knowledge-bases', { onRequest: [app.authenticate] }, async (req, reply) => {
    const {
      name,
      description,
      icon = 'database',
      color = 'emerald',
      embeddingProviderId,
      embeddingModel = 'nomic-embed-text',
      embeddingDimension = 768,
      chunkSize = 1000,
      chunkOverlap = 200,
    } = req.body;

    const id = randomUUID();
    await db().execute({
      sql: `INSERT INTO knowledge_bases (id, name, description, icon, color, embedding_provider_id, embedding_model, embedding_dimension, chunk_size, chunk_overlap)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, name, description ?? null, icon, color, embeddingProviderId ?? null, embeddingModel, embeddingDimension, chunkSize, chunkOverlap],
    });

    const rs = await db().execute({ sql: `SELECT * FROM knowledge_bases WHERE id = ?`, args: [id] });
    return reply.status(201).send({ ...rs.rows[0], documentCount: 0, chunkCount: 0 });
  });

  /** GET /api/knowledge-bases/:id */
  app.get<{ Params: { id: string } }>('/api/knowledge-bases/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const rs = await db().execute({
      sql: `SELECT kb.*,
              (SELECT COUNT(*) FROM documents d WHERE d.knowledge_base_id = kb.id) AS document_count,
              (SELECT COUNT(*) FROM document_chunks c WHERE c.knowledge_base_id = kb.id) AS chunk_count
            FROM knowledge_bases kb
            WHERE kb.id = ?`,
      args: [req.params.id],
    });
    const kb = rs.rows[0];
    if (!kb) return reply.status(404).send({ error: 'Knowledge base not found' });
    return reply.send({ ...kb, documentCount: Number(kb.document_count || 0), chunkCount: Number(kb.chunk_count || 0) });
  });

  /**
   * GET /api/knowledge-bases/:id/documents?status=&q=&limit=&offset=
   * Paged, newest first. `counts` and `stats` describe the whole knowledge base, not the filtered page.
   */
  app.get<{ Params: { id: string }; Querystring: { status?: string; q?: string; limit?: string; offset?: string } }>(
    '/api/knowledge-bases/:id/documents',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const kbId = req.params.id;
      const exists = await db().execute({ sql: `SELECT id FROM knowledge_bases WHERE id = ?`, args: [kbId] });
      if (!exists.rows[0]) return reply.status(404).send({ error: 'Knowledge base not found' });

      const parsedLimit = parseInt(req.query.limit ?? '', 10);
      const limit = Number.isFinite(parsedLimit) && parsedLimit >= 1 ? Math.min(500, parsedLimit) : 100;
      const parsedOffset = parseInt(req.query.offset ?? '', 10);
      const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

      const where = ['knowledge_base_id = ?'];
      const args: any[] = [kbId];
      const statuses = (req.query.status ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length > 0) {
        where.push(`status IN (${statuses.map(() => '?').join(',')})`);
        args.push(...statuses);
      }
      const q = (req.query.q ?? '').trim();
      if (q) {
        // Treat the user's text literally: escape LIKE wildcards.
        where.push(`LOWER(title) LIKE ? ESCAPE '\\'`);
        args.push(`%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      }
      const clause = where.join(' AND ');

      const [items, total, byStatus, totals] = await Promise.all([
        db().execute({
          sql: `SELECT * FROM documents WHERE ${clause} ORDER BY created_at DESC, id LIMIT ${limit} OFFSET ${offset}`,
          args,
        }),
        db().execute({ sql: `SELECT COUNT(*) AS n FROM documents WHERE ${clause}`, args }),
        db().execute({ sql: `SELECT status, COUNT(*) AS n FROM documents WHERE knowledge_base_id = ? GROUP BY status`, args: [kbId] }),
        db().execute({
          sql: `SELECT COUNT(*) AS docs,
                       COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) AS ready,
                       COALESCE(SUM(chunk_count), 0) AS chunks,
                       COALESCE(SUM(file_size), 0) AS bytes
                FROM documents WHERE knowledge_base_id = ?`,
          args: [kbId],
        }),
      ]);

      const counts = { ready: 0, failed: 0, processing: 0, pending: 0 } as Record<string, number>;
      for (const row of byStatus.rows as any[]) counts[row.status as string] = Number(row.n);
      const t = totals.rows[0] as any;

      return reply.send({
        items: items.rows,
        total: Number((total.rows[0] as any).n),
        counts,
        stats: { documents: Number(t.docs), readyDocuments: Number(t.ready), chunks: Number(t.chunks), bytes: Number(t.bytes) },
      });
    }
  );

  /** DELETE /api/knowledge-bases/:id */
  app.delete<{ Params: { id: string } }>('/api/knowledge-bases/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    // SQLite does not enforce foreign keys by default, so remove dependents explicitly.
    await app.db.vectorStore.deleteByKnowledgeBaseId(req.params.id);
    await db().execute({ sql: `DELETE FROM documents WHERE knowledge_base_id = ?`, args: [req.params.id] });
    await db().execute({ sql: `DELETE FROM knowledge_bases WHERE id = ?`, args: [req.params.id] });
    return reply.status(204).send();
  });
}