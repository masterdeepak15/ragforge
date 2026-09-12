import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';

export async function knowledgeBaseRoutes(app: FastifyInstance) {
  const db = () => app.db.client;

  /** GET /api/knowledge-bases */
  app.get('/api/knowledge-bases', { onRequest: [app.authenticate] }, async (_req, reply) => {
    const rs = await db().execute({
      sql: `SELECT kb.*,
              COUNT(DISTINCT d.id) as document_count,
              COUNT(DISTINCT c.id) as chunk_count
            FROM knowledge_bases kb
            LEFT JOIN documents d ON d.knowledge_base_id = kb.id
            LEFT JOIN document_chunks c ON c.knowledge_base_id = kb.id
            GROUP BY kb.id
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
              COUNT(DISTINCT d.id) as document_count,
              COUNT(DISTINCT c.id) as chunk_count
            FROM knowledge_bases kb
            LEFT JOIN documents d ON d.knowledge_base_id = kb.id
            LEFT JOIN document_chunks c ON c.knowledge_base_id = kb.id
            WHERE kb.id = ?
            GROUP BY kb.id`,
      args: [req.params.id],
    });
    const kb = rs.rows[0];
    if (!kb) return reply.status(404).send({ error: 'Knowledge base not found' });
    return reply.send({ ...kb, documentCount: Number(kb.document_count || 0), chunkCount: Number(kb.chunk_count || 0) });
  });

  /** GET /api/knowledge-bases/:id/documents */
  app.get<{ Params: { id: string } }>('/api/knowledge-bases/:id/documents', { onRequest: [app.authenticate] }, async (req, reply) => {
    const rs = await db().execute({
      sql: `SELECT * FROM documents WHERE knowledge_base_id = ? ORDER BY created_at DESC`,
      args: [req.params.id],
    });
    return reply.send(rs.rows);
  });

  /** DELETE /api/knowledge-bases/:id */
  app.delete<{ Params: { id: string } }>('/api/knowledge-bases/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    // Cascade delete handled by foreign key constraints
    await db().execute({ sql: `DELETE FROM knowledge_bases WHERE id = ?`, args: [req.params.id] });
    return reply.status(204).send();
  });
}