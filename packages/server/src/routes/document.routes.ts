import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { IngestionService } from '../services/ingestion.service.js';
import type { DocumentFileType } from '@ragforge/shared';

export async function documentRoutes(app: FastifyInstance) {
  const db = () => app.db.client;

  /** POST /api/documents/upload */
  app.post<{
    Body: {
      knowledgeBaseId: string;
      title: string;
      sourceType: DocumentFileType;
      sourceUrl?: string;
      text?: string;
    }
  }>('/api/documents/upload', {
    onRequest: [app.authenticate],
    preHandler: app.upload.fields([{ name: 'file', maxCount: 1 }])
  }, async (req, reply) => {
    const { knowledgeBaseId, title, sourceType, sourceUrl, text } = req.body as any;
    const files = req.files as any;

    if (!knowledgeBaseId || !title || !sourceType) {
      return reply.status(400).send({ error: 'knowledgeBaseId, title, and sourceType are required' });
    }

    const id = randomUUID();
    let filePath: string | null = null;
    let fileSize: number | null = null;
    let mimeType: string | null = null;
    let buffer: Buffer | undefined;

    // Handle file upload
    if (files?.file?.[0]) {
      const file = files.file[0];
      filePath = file.filename;
      fileSize = file.buffer.length;
      mimeType = file.mimetype;
      buffer = file.buffer;
    }

    // Insert document record
    await db().execute({
      sql: `INSERT INTO documents (id, knowledge_base_id, title, source_type, source_url, file_path, file_size, mime_type, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      args: [id, knowledgeBaseId, title, sourceType, sourceUrl ?? null, filePath, fileSize, mimeType],
    });

    // Start ingestion in background
    const ingestionService = new IngestionService(app.db, app.db.vectorStore, app.retriever);

    // Get knowledge base settings for embedding
    const kbRs = await db().execute({
      sql: `SELECT * FROM knowledge_bases WHERE id = ?`,
      args: [knowledgeBaseId],
    });
    const kb = kbRs.rows[0];

    ingestionService.ingest({
      documentId: id,
      knowledgeBaseId,
      sourceType,
      title,
      buffer,
      text,
      url: sourceUrl,
      chunkSize: Number(kb?.chunk_size) || 1000,
      chunkOverlap: Number(kb?.chunk_overlap) || 200,
      embeddingProviderId: kb?.embedding_provider_id as string | undefined,
      embeddingModel: kb?.embedding_model as string | undefined,
    }).catch(err => {
      console.error(`[RAGForge] Ingestion failed for ${id}:`, err);
    });

    return reply.status(202).send({ id, status: 'pending', message: 'Document queued for processing' });
  });

  /** GET /api/documents/:id */
  app.get<{ Params: { id: string } }>('/api/documents/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const rs = await db().execute({
      sql: `SELECT * FROM documents WHERE id = ?`,
      args: [req.params.id],
    });
    const doc = rs.rows[0];
    if (!doc) return reply.status(404).send({ error: 'Document not found' });
    return reply.send(doc);
  });

  /** GET /api/documents/:id/chunks */
  app.get<{ Params: { id: string }; Querystring: { page?: string; limit?: string } }>(
    '/api/documents/:id/chunks',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const page = Math.max(1, parseInt(req.query.page || '1'));
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20')));
      const offset = (page - 1) * limit;

      const rs = await db().execute({
        sql: `SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index ASC LIMIT ? OFFSET ?`,
        args: [req.params.id, limit, offset],
      });

      const countRs = await db().execute({
        sql: `SELECT COUNT(*) as total FROM document_chunks WHERE document_id = ?`,
        args: [req.params.id],
      });

      return reply.send({
        chunks: rs.rows,
        pagination: {
          page,
          limit,
          total: Number(countRs.rows[0]?.total || 0),
        },
      });
    }
  );

  /** DELETE /api/documents/:id */
  app.delete<{ Params: { id: string } }>('/api/documents/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params;

    // Vector store cleanup (cascaded by DB foreign keys for chunks)
    await app.db.vectorStore.deleteByDocumentId(id);

    // Delete document (cascades to chunks via FK)
    await db().execute({ sql: `DELETE FROM documents WHERE id = ?`, args: [id] });

    return reply.status(204).send();
  });
}