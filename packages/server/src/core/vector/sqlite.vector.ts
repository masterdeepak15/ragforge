import type { Client } from '@libsql/client';
import { IVectorStore, VectorChunkInput, VectorSearchResult } from './vector.interface.js';
import { WRITE_BATCH_SIZE, vectorTableName, dimensionMismatch, groupBy } from './vector-tables.js';

export interface VectorRow {
  id: string;
  documentId: string;
  embedding: number[];
}

/**
 * libSQL implementation: one `F32_BLOB(dim)` table per knowledge base, searched with an exact native
 * cosine scan. libSQL's DiskANN index was measured at ~190 inserts/s (vs ~7,600/s unindexed) and slows
 * further as it grows, so it is deliberately not used; an exact scan is ~21 ms per 20k 384-d vectors and has
 * perfect recall. Very large corpora should run on Postgres + pgvector (HNSW), see PgVectorStore.
 */
export class SqliteVectorStore implements IVectorStore {
  constructor(private client: Client) {}

  private async getDimension(knowledgeBaseId: string): Promise<number | null> {
    const rs = await this.client.execute({
      sql: `SELECT dimension FROM kb_vector_tables WHERE knowledge_base_id = ?`,
      args: [knowledgeBaseId],
    });
    return rs.rows[0] ? Number((rs.rows[0] as any).dimension) : null;
  }

  /** Creates the KB's vector table on first use; throws if `dim` disagrees with the existing one. */
  private async ensureTable(knowledgeBaseId: string, dim: number): Promise<void> {
    const existing = await this.getDimension(knowledgeBaseId);
    if (existing !== null) {
      if (existing !== dim) throw dimensionMismatch(knowledgeBaseId, existing, dim);
      return;
    }
    if (!Number.isInteger(dim) || dim < 1) throw new Error(`Invalid embedding dimension: ${dim}`);
    const table = vectorTableName(knowledgeBaseId);
    await this.client.batch(
      [
        `CREATE TABLE IF NOT EXISTS "${table}" (chunk_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, embedding F32_BLOB(${dim}))`,
        `CREATE INDEX IF NOT EXISTS "${table}_doc" ON "${table}"(document_id)`,
        {
          sql: `INSERT OR IGNORE INTO kb_vector_tables (knowledge_base_id, dimension) VALUES (?, ?)`,
          args: [knowledgeBaseId, dim],
        },
      ],
      'write'
    );
    // Concurrent first writers: whoever registered first decides the dimension.
    const winner = await this.getDimension(knowledgeBaseId);
    if (winner !== null && winner !== dim) throw dimensionMismatch(knowledgeBaseId, winner, dim);
  }

  /** Writes only the vector side (used by chunk upserts and the legacy migration). */
  async writeVectors(knowledgeBaseId: string, rows: VectorRow[]): Promise<void> {
    if (rows.length === 0) return;
    const dim = rows[0].embedding.length;
    for (const r of rows) {
      if (r.embedding.length !== dim) throw dimensionMismatch(knowledgeBaseId, dim, r.embedding.length);
    }
    await this.ensureTable(knowledgeBaseId, dim);
    const table = vectorTableName(knowledgeBaseId);
    for (let i = 0; i < rows.length; i += WRITE_BATCH_SIZE) {
      const stmts = rows.slice(i, i + WRITE_BATCH_SIZE).flatMap((r) => [
        { sql: `DELETE FROM "${table}" WHERE chunk_id = ?`, args: [r.id] },
        {
          sql: `INSERT INTO "${table}" (chunk_id, document_id, embedding) VALUES (?, ?, vector32(?))`,
          args: [r.id, r.documentId, JSON.stringify(r.embedding)],
        },
      ]);
      await this.client.batch(stmts, 'write');
    }
  }

  async upsertChunks(chunks: VectorChunkInput[]): Promise<void> {
    for (const [kbId, group] of groupBy(chunks, (c) => c.knowledgeBaseId)) {
      // Validate every embedding before touching the database so a bad batch writes nothing.
      const dim = group[0].embedding.length;
      const existing = await this.getDimension(kbId);
      if (existing !== null && existing !== dim) throw dimensionMismatch(kbId, existing, dim);
      for (const c of group) {
        if (c.embedding.length !== dim) throw dimensionMismatch(kbId, dim, c.embedding.length);
      }
      await this.ensureTable(kbId, dim);
      const table = vectorTableName(kbId);

      for (let i = 0; i < group.length; i += WRITE_BATCH_SIZE) {
        const stmts = group.slice(i, i + WRITE_BATCH_SIZE).flatMap((c) => [
          {
            sql: `INSERT INTO document_chunks (id, document_id, knowledge_base_id, chunk_index, content, token_count, metadata, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                  ON CONFLICT(id) DO UPDATE SET
                    content = excluded.content,
                    token_count = excluded.token_count,
                    metadata = excluded.metadata`,
            args: [c.id, c.documentId, c.knowledgeBaseId, c.chunkIndex, c.content, c.tokenCount, c.metadata ? JSON.stringify(c.metadata) : null],
          },
          { sql: `DELETE FROM "${table}" WHERE chunk_id = ?`, args: [c.id] },
          {
            sql: `INSERT INTO "${table}" (chunk_id, document_id, embedding) VALUES (?, ?, vector32(?))`,
            args: [c.id, c.documentId, JSON.stringify(c.embedding)],
          },
        ]);
        await this.client.batch(stmts, 'write');
      }
    }
  }

  async search(
    knowledgeBaseId: string,
    queryEmbedding: number[],
    topK: number,
    threshold: number = 0
  ): Promise<VectorSearchResult[]> {
    const dim = await this.getDimension(knowledgeBaseId);
    if (dim === null) return [];
    if (queryEmbedding.length !== dim) throw dimensionMismatch(knowledgeBaseId, dim, queryEmbedding.length);

    const table = vectorTableName(knowledgeBaseId);
    // Raw little-endian float32 blob: avoids re-parsing JSON text for the query vector.
    const q = Buffer.from(new Float32Array(queryEmbedding).buffer);
    const k = Math.max(1, Math.floor(topK));
    const rs = await this.client.execute({
      sql: `SELECT chunk_id AS id, 1 - vector_distance_cos(embedding, ?) AS score
            FROM "${table}"
            ORDER BY score DESC
            LIMIT ?`,
      args: [q, BigInt(k)],
    });
    return (rs.rows as any[])
      .map((r) => ({ id: r.id as string, score: Number(r.score) }))
      .filter((r) => r.score >= threshold);
  }

  async deleteByDocumentId(documentId: string): Promise<void> {
    const kbs = await this.client.execute({
      sql: `SELECT knowledge_base_id AS kb FROM documents WHERE id = ?
            UNION SELECT DISTINCT knowledge_base_id FROM document_chunks WHERE document_id = ?`,
      args: [documentId, documentId],
    });
    for (const row of kbs.rows as any[]) {
      const kbId = row.kb as string;
      if ((await this.getDimension(kbId)) !== null) {
        await this.client.execute({ sql: `DELETE FROM "${vectorTableName(kbId)}" WHERE document_id = ?`, args: [documentId] });
      }
    }
    await this.client.execute({ sql: `DELETE FROM document_chunks WHERE document_id = ?`, args: [documentId] });
  }

  async deleteByKnowledgeBaseId(knowledgeBaseId: string): Promise<void> {
    await this.client.execute(`DROP TABLE IF EXISTS "${vectorTableName(knowledgeBaseId)}"`);
    await this.client.batch(
      [
        { sql: `DELETE FROM kb_vector_tables WHERE knowledge_base_id = ?`, args: [knowledgeBaseId] },
        { sql: `DELETE FROM document_chunks WHERE knowledge_base_id = ?`, args: [knowledgeBaseId] },
      ],
      'write'
    );
  }
}
