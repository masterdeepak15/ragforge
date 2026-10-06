import { rm } from 'fs/promises';
import { join } from 'path';
import type { FastifyInstance } from 'fastify';

/**
 * Deletes documents completely: cancels pending ingestion, removes vectors/chunks, job rows,
 * the stored upload and the document row. Safe to call for ids that no longer exist.
 * Returns how many documents were actually removed.
 */
export async function deleteDocuments(app: FastifyInstance, ids: string[]): Promise<number> {
  const client = app.db.client;
  let deleted = 0;

  for (const id of ids) {
    const doc = (await client.execute({ sql: `SELECT id, file_path FROM documents WHERE id = ?`, args: [id] })).rows[0] as any;

    const jobs = await client.execute({
      sql: `SELECT id FROM ingestion_jobs WHERE document_id = ? AND status IN ('queued', 'running')`,
      args: [id],
    });
    for (const job of jobs.rows as any[]) await app.worker.cancel(job.id as string);

    await app.db.vectorStore.deleteByDocumentId(id);
    await client.execute({ sql: `DELETE FROM ingestion_jobs WHERE document_id = ?`, args: [id] });
    await client.execute({ sql: `DELETE FROM documents WHERE id = ?`, args: [id] });

    if (doc) {
      deleted++;
      if (doc.file_path) await rm(join(app.dataDir, 'uploads', doc.file_path as string), { force: true });
    }
  }
  return deleted;
}
