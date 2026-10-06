import type { FastifyInstance } from 'fastify';
import { UploadService, cleanFilename, repairMultipartFilename } from '../uploads/upload.service.js';
import { deleteDocuments } from '../services/document.service.js';

export async function documentRoutes(app: FastifyInstance) {
  const db = () => app.db.client;

  /**
   * POST /api/documents/upload (multipart/form-data)
   * Fields: knowledgeBaseId (must precede files), optional url, optional title (for url).
   * Files are streamed to disk; many files per request are allowed.
   */
  app.post('/api/documents/upload', { onRequest: [app.authenticate] }, async (req, reply) => {
    const uploads = new UploadService(app.db, app.dataDir, { jobs: app.jobs, events: app.events });
    const fields: Record<string, string> = {};
    const items: Array<{ id: string; title: string; status: 'pending'; deduplicated: boolean }> = [];
    let missingKb = false;
    let unknownKb = false;
    let kbChecked: string | null = null;

    const ensureKb = async (): Promise<boolean> => {
      const kbId = fields.knowledgeBaseId;
      if (!kbId) {
        missingKb = true;
        return false;
      }
      if (kbChecked !== kbId) {
        const rs = await db().execute({ sql: `SELECT id FROM knowledge_bases WHERE id = ?`, args: [kbId] });
        if (!rs.rows[0]) {
          unknownKb = true;
          return false;
        }
        kbChecked = kbId;
      }
      return true;
    };

    for await (const part of req.parts()) {
      if (part.type === 'field') {
        fields[part.fieldname] = String(part.value);
        continue;
      }
      if (!(await ensureKb())) {
        part.file.resume();
        continue;
      }
      const saved = await uploads.saveStream({
        knowledgeBaseId: fields.knowledgeBaseId,
        filename: cleanFilename(repairMultipartFilename(part.filename)),
        mimeType: part.mimetype,
        stream: part.file,
      });
      items.push({ id: saved.documentId, title: saved.title, status: 'pending', deduplicated: saved.deduplicated });
    }

    if (fields.url) {
      if (await ensureKb()) {
        const saved = await uploads.saveUrl(fields.knowledgeBaseId, fields.url, fields.title);
        items.push({ id: saved.documentId, title: saved.title, status: 'pending', deduplicated: saved.deduplicated });
      }
    }

    if (unknownKb) return reply.status(404).send({ error: 'Knowledge base not found' });
    if (missingKb || (!fields.knowledgeBaseId && items.length === 0)) {
      return reply.status(400).send({ error: 'knowledgeBaseId is required and must precede file fields' });
    }
    if (items.length === 0) return reply.status(400).send({ error: 'No file or url provided' });
    return reply.status(202).send({ items });
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

  /** DELETE /api/documents/:id — idempotent */
  app.delete<{ Params: { id: string } }>('/api/documents/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    await deleteDocuments(app, [req.params.id]);
    return reply.status(204).send();
  });

  /** POST /api/documents/bulk-delete { ids } — up to 1000 documents */
  app.post<{ Body: { ids?: unknown } }>('/api/documents/bulk-delete', { onRequest: [app.authenticate] }, async (req, reply) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000 || !ids.every((i) => typeof i === 'string')) {
      return reply.status(400).send({ error: 'ids must be an array of 1 to 1000 document ids' });
    }
    return reply.send({ deleted: await deleteDocuments(app, ids as string[]) });
  });
}
