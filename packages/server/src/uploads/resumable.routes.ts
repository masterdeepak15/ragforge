import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, readdir, rm, stat, truncate, writeFile } from 'fs/promises';
import { join } from 'path';
import { Transform, type Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { DatabaseContext } from '../db/connection.js';
import { UploadService, cleanFilename } from './upload.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function sqlTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Deletes upload sessions (and their partial files) idle for longer than `olderThanMs`,
 * plus orphaned `<uuid>.part` files left by interrupted single-request uploads.
 * Returns the number of sessions purged.
 */
export async function purgeStaleUploads(db: DatabaseContext, dataDir: string, olderThanMs = DAY_MS): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const rs = await db.client.execute({
    sql: `SELECT id FROM upload_sessions WHERE updated_at < ?`,
    args: [sqlTimestamp(cutoff)],
  });
  for (const row of rs.rows as any[]) {
    await rm(join(dataDir, 'uploads', '.partial', row.id as string), { force: true });
    await db.client.execute({ sql: `DELETE FROM upload_sessions WHERE id = ?`, args: [row.id] });
  }

  const dir = join(dataDir, 'uploads');
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.endsWith('.part'))) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (info && info.mtimeMs < cutoff) await rm(join(dir, name), { force: true });
  }
  return rs.rows.length;
}

export async function resumableUploadRoutes(app: FastifyInstance) {
  const db = () => app.db.client;
  const partialDir = () => join(app.dataDir, 'uploads', '.partial');
  const partialPath = (id: string) => join(partialDir(), id);

  // Chunks arrive as a raw stream; hand the stream to the route handler untouched.
  app.addContentTypeParser('application/offset+octet-stream', (_req, payload, done) => done(null, payload));

  async function getSession(id: string): Promise<any | null> {
    const rs = await db().execute({ sql: `SELECT * FROM upload_sessions WHERE id = ?`, args: [id] });
    return (rs.rows[0] as any) ?? null;
  }
  async function currentOffset(id: string): Promise<number> {
    return (await stat(partialPath(id)).catch(() => null))?.size ?? 0;
  }

  /** POST /api/uploads — start a resumable upload */
  app.post<{ Body: { knowledgeBaseId: string; filename: string; size: number; mimeType?: string } }>(
    '/api/uploads',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { knowledgeBaseId, filename, size, mimeType } = req.body ?? ({} as any);
      if (!knowledgeBaseId || !filename || !Number.isInteger(size) || size < 0) {
        return reply.status(400).send({ error: 'knowledgeBaseId, filename and a non-negative integer size are required' });
      }
      const kb = await db().execute({ sql: `SELECT id FROM knowledge_bases WHERE id = ?`, args: [knowledgeBaseId] });
      if (!kb.rows[0]) return reply.status(404).send({ error: 'Knowledge base not found' });

      const id = randomUUID();
      await mkdir(partialDir(), { recursive: true });
      await writeFile(partialPath(id), '');
      await db().execute({
        sql: `INSERT INTO upload_sessions (id, knowledge_base_id, filename, size, mime_type) VALUES (?, ?, ?, ?, ?)`,
        args: [id, knowledgeBaseId, cleanFilename(filename), size, mimeType ?? 'application/octet-stream'],
      });
      return reply.status(201).send({ id });
    }
  );

  /** GET /api/uploads/:id — where to resume from */
  app.get<{ Params: { id: string } }>('/api/uploads/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const session = await getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Upload not found' });
    return reply.send({ offset: await currentOffset(session.id), size: Number(session.size) });
  });

  /** PATCH /api/uploads/:id — append a chunk at `Upload-Offset` */
  app.patch<{ Params: { id: string } }>('/api/uploads/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const session = await getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Upload not found' });

    const offset = await currentOffset(session.id);
    const claimed = Number(req.headers['upload-offset']);
    if (!Number.isInteger(claimed) || claimed !== offset) {
      return reply.status(409).send({ error: 'Offset mismatch', offset });
    }

    const remaining = Number(session.size) - offset;
    let received = 0;
    let overflow = false;
    // On overflow keep draining (and discarding) the body so the connection stays usable, then answer 400.
    const guard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        if (overflow || received + chunk.length > remaining) {
          overflow = true;
          return cb();
        }
        received += chunk.length;
        cb(null, chunk);
      },
    });

    try {
      await pipeline(req.body as Readable, guard, createWriteStream(partialPath(session.id), { flags: 'a' }));
    } catch (err) {
      await truncate(partialPath(session.id), offset).catch(() => {});
      throw err;
    }
    if (overflow) {
      await truncate(partialPath(session.id), offset);
      return reply.status(400).send({ error: 'Chunk exceeds the declared upload size', offset });
    }

    const next = offset + received;
    await db().execute({
      sql: `UPDATE upload_sessions SET offset_bytes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [next, session.id],
    });
    return reply.send({ offset: next });
  });

  /** POST /api/uploads/:id/complete — turn the assembled file into a document */
  app.post<{ Params: { id: string } }>('/api/uploads/:id/complete', { onRequest: [app.authenticate] }, async (req, reply) => {
    const session = await getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Upload not found' });

    const offset = await currentOffset(session.id);
    if (offset !== Number(session.size)) {
      return reply.status(409).send({ error: 'Upload incomplete', offset, size: Number(session.size) });
    }

    const saved = await new UploadService(app.db, app.dataDir).finalizeFile({
      knowledgeBaseId: session.knowledge_base_id,
      filename: session.filename,
      mimeType: session.mime_type ?? 'application/octet-stream',
      partialPath: partialPath(session.id),
    });
    await db().execute({ sql: `DELETE FROM upload_sessions WHERE id = ?`, args: [session.id] });
    return reply.status(202).send({
      items: [{ id: saved.documentId, title: saved.title, status: 'pending', deduplicated: saved.deduplicated }],
    });
  });
}
