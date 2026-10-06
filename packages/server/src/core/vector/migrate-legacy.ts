import type { DatabaseContext } from '../../db/connection.js';
import { SqliteVectorStore } from './sqlite.vector.js';
import { PgVectorStore } from './pg.vector.js';
import { groupBy, vectorTableName } from './vector-tables.js';

const PAGE = 500;

function blobToVector(raw: unknown): number[] | null {
  let buf: Buffer;
  if (Buffer.isBuffer(raw)) buf = raw;
  else if (raw instanceof ArrayBuffer) buf = Buffer.from(raw);
  else if (ArrayBuffer.isView(raw)) buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  else return null;
  if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(buf).buffer; // aligned copy
  return Array.from(new Float32Array(copy));
}

/**
 * Moves embeddings stored on `document_chunks` (pre-ANN layout) into the per-KB vector tables
 * and clears the old column. Idempotent: returns `{ migrated: 0 }` once nothing is left.
 */
export async function migrateLegacyVectors(ctx: DatabaseContext): Promise<{ migrated: number }> {
  return ctx.mode === 'postgres' ? migratePostgres(ctx) : migrateSqlite(ctx);
}

async function migrateSqlite(ctx: DatabaseContext): Promise<{ migrated: number }> {
  const store = ctx.vectorStore as SqliteVectorStore;
  let migrated = 0;
  for (;;) {
    const rs = await ctx.client.execute({
      sql: `SELECT id, document_id, knowledge_base_id, embedding_blob FROM document_chunks WHERE embedding_blob IS NOT NULL LIMIT ?`,
      args: [PAGE],
    });
    if (rs.rows.length === 0) break;

    const rows = (rs.rows as any[]).map((r) => ({
      id: r.id as string,
      documentId: r.document_id as string,
      kb: r.knowledge_base_id as string,
      embedding: blobToVector(r.embedding_blob),
    }));
    for (const [kb, group] of groupBy(rows, (r) => r.kb)) {
      const valid = group.filter((r) => r.embedding !== null) as Array<(typeof group)[number] & { embedding: number[] }>;
      try {
        await store.writeVectors(kb, valid.map((r) => ({ id: r.id, documentId: r.documentId, embedding: r.embedding })));
        migrated += valid.length;
      } catch (err) {
        console.warn(`[RAGForge] Legacy vector migration skipped knowledge base ${kb}:`, (err as Error).message);
      }
    }
    // Clear the old column for the whole page (valid, invalid and skipped) so the loop always terminates.
    const placeholders = rows.map(() => '?').join(',');
    await ctx.client.execute({
      sql: `UPDATE document_chunks SET embedding_blob = NULL WHERE id IN (${placeholders})`,
      args: rows.map((r) => r.id),
    });
  }
  return { migrated };
}

/** Postgres: copy `document_chunks.embedding` into `cv_<kb>` tables. Not covered by automated tests. */
async function migratePostgres(ctx: DatabaseContext): Promise<{ migrated: number }> {
  const sql = ctx.client as import('postgres').Sql;
  const store = ctx.vectorStore as PgVectorStore;
  const kbs = await sql.unsafe(
    `SELECT knowledge_base_id AS kb, MIN(vector_dims(embedding)) AS dim
     FROM document_chunks WHERE embedding IS NOT NULL GROUP BY knowledge_base_id`
  );
  let migrated = 0;
  for (const row of kbs) {
    const kb = row.kb as string;
    try {
      await store.ensureTable(kb, Number(row.dim));
      const table = vectorTableName(kb);
      const res = await sql.unsafe(
        `INSERT INTO "${table}" (chunk_id, document_id, embedding)
         SELECT id, document_id, embedding FROM document_chunks WHERE knowledge_base_id = $1 AND embedding IS NOT NULL
         ON CONFLICT (chunk_id) DO NOTHING`,
        [kb]
      );
      migrated += res.count;
      await sql.unsafe(`UPDATE document_chunks SET embedding = NULL WHERE knowledge_base_id = $1`, [kb]);
    } catch (err) {
      console.warn(`[RAGForge] Legacy vector migration skipped knowledge base ${kb}:`, (err as Error).message);
    }
  }
  return { migrated };
}
