import type { Sql } from 'postgres';
import { IVectorStore, VectorChunkInput, VectorSearchResult } from './vector.interface.js';
import { WRITE_BATCH_SIZE, vectorTableName, dimensionMismatch, groupBy } from './vector-tables.js';

/** pgvector's HNSW index supports up to 2000 dimensions for the `vector` type. */
const HNSW_MAX_DIM = 2000;

/**
 * Postgres implementation: one `vector(dim)` table + HNSW cosine index per knowledge base.
 * NOTE: not exercised by the automated tests (they need a pgvector-enabled Postgres).
 */
export class PgVectorStore implements IVectorStore {
  constructor(private sql: Sql) {}

  private async getDimension(knowledgeBaseId: string): Promise<number | null> {
    const rows = await this.sql.unsafe(`SELECT dimension FROM kb_vector_tables WHERE knowledge_base_id = $1`, [knowledgeBaseId]);
    return rows[0] ? Number(rows[0].dimension) : null;
  }

  async ensureTable(knowledgeBaseId: string, dim: number): Promise<void> {
    const existing = await this.getDimension(knowledgeBaseId);
    if (existing !== null) {
      if (existing !== dim) throw dimensionMismatch(knowledgeBaseId, existing, dim);
      return;
    }
    if (!Number.isInteger(dim) || dim < 1) throw new Error(`Invalid embedding dimension: ${dim}`);
    const table = vectorTableName(knowledgeBaseId);
    await this.sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "${table}" (chunk_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, embedding vector(${dim}))`
    );
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS "${table}_doc" ON "${table}"(document_id)`);
    if (dim <= HNSW_MAX_DIM) {
      await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS "${table}_hnsw" ON "${table}" USING hnsw (embedding vector_cosine_ops)`);
    }
    await this.sql.unsafe(
      `INSERT INTO kb_vector_tables (knowledge_base_id, dimension) VALUES ($1, $2) ON CONFLICT (knowledge_base_id) DO NOTHING`,
      [knowledgeBaseId, dim]
    );
    const winner = await this.getDimension(knowledgeBaseId);
    if (winner !== null && winner !== dim) throw dimensionMismatch(knowledgeBaseId, winner, dim);
  }

  async upsertChunks(chunks: VectorChunkInput[]): Promise<void> {
    for (const [kbId, group] of groupBy(chunks, (c) => c.knowledgeBaseId)) {
      const dim = group[0].embedding.length;
      const existing = await this.getDimension(kbId);
      if (existing !== null && existing !== dim) throw dimensionMismatch(kbId, existing, dim);
      for (const c of group) {
        if (c.embedding.length !== dim) throw dimensionMismatch(kbId, dim, c.embedding.length);
      }
      await this.ensureTable(kbId, dim);
      const table = vectorTableName(kbId);

      for (let i = 0; i < group.length; i += WRITE_BATCH_SIZE) {
        const slice = group.slice(i, i + WRITE_BATCH_SIZE);
        await this.sql.begin(async (tx) => {
          for (const c of slice) {
            await tx.unsafe(
              `INSERT INTO document_chunks (id, document_id, knowledge_base_id, chunk_index, content, token_count, metadata)
               VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
               ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, token_count = EXCLUDED.token_count, metadata = EXCLUDED.metadata`,
              [c.id, c.documentId, c.knowledgeBaseId, c.chunkIndex, c.content, c.tokenCount, c.metadata ? JSON.stringify(c.metadata) : null]
            );
            await tx.unsafe(
              `INSERT INTO "${table}" (chunk_id, document_id, embedding) VALUES ($1, $2, $3::vector)
               ON CONFLICT (chunk_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
              [c.id, c.documentId, JSON.stringify(c.embedding)]
            );
          }
        });
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
    const rows = await this.sql.unsafe(
      `SELECT chunk_id AS id, 1 - (embedding <=> $1::vector) AS score
       FROM "${table}"
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [JSON.stringify(queryEmbedding), topK]
    );
    return rows.map((r: any) => ({ id: r.id as string, score: Number(r.score) })).filter((r) => r.score >= threshold);
  }

  async deleteByDocumentId(documentId: string): Promise<void> {
    const kbs = await this.sql.unsafe(
      `SELECT knowledge_base_id AS kb FROM documents WHERE id = $1
       UNION SELECT DISTINCT knowledge_base_id FROM document_chunks WHERE document_id = $1`,
      [documentId]
    );
    for (const row of kbs) {
      const kbId = row.kb as string;
      if ((await this.getDimension(kbId)) !== null) {
        await this.sql.unsafe(`DELETE FROM "${vectorTableName(kbId)}" WHERE document_id = $1`, [documentId]);
      }
    }
    await this.sql.unsafe(`DELETE FROM document_chunks WHERE document_id = $1`, [documentId]);
  }

  async deleteByKnowledgeBaseId(knowledgeBaseId: string): Promise<void> {
    await this.sql.unsafe(`DROP TABLE IF EXISTS "${vectorTableName(knowledgeBaseId)}"`);
    await this.sql.unsafe(`DELETE FROM kb_vector_tables WHERE knowledge_base_id = $1`, [knowledgeBaseId]);
    await this.sql.unsafe(`DELETE FROM document_chunks WHERE knowledge_base_id = $1`, [knowledgeBaseId]);
  }
}
