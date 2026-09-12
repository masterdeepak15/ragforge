import { IVectorStore, VectorChunkInput, VectorSearchResult } from './vector.interface.js';
import type { Sql } from 'postgres';
import { documentChunks } from '../../db/schema/pg.js';
import { sql as drizzleSql } from 'drizzle-orm';
import { PgDatabase } from 'drizzle-orm/pg-core';

export class PgVectorStore implements IVectorStore {
  // Pass the Drizzle Postgres database connection to the constructor
  constructor(private db: PgDatabase<any, any, any>) {}

  async upsertChunks(chunks: VectorChunkInput[]): Promise<void> {
    if (chunks.length === 0) return;

    for (const chunk of chunks) {
      await this.db.insert(documentChunks)
        .values({
          id: chunk.id,
          documentId: chunk.documentId,
          knowledgeBaseId: chunk.knowledgeBaseId,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          metadata: chunk.metadata as any,
          embedding: chunk.embedding,
        })
        .onConflictDoUpdate({
          target: documentChunks.id,
          set: {
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            metadata: chunk.metadata as any,
            embedding: chunk.embedding,
          }
        });
    }
  }

  async search(
    knowledgeBaseId: string,
    queryEmbedding: number[],
    topK: number,
    threshold: number = 0
  ): Promise<VectorSearchResult[]> {
    // using pgvector cosine distance: embedding <=> query
    // Cosine similarity is 1 - (embedding <=> query)
    const embeddingStr = JSON.stringify(queryEmbedding);

    // We compute similarity = 1 - (embedding <=> '[...]')
    const rs = await this.db.execute(drizzleSql`
      SELECT
        id,
        (1 - (embedding <=> ${embeddingStr}::vector)) as score
      FROM document_chunks
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND (1 - (embedding <=> ${embeddingStr}::vector)) >= ${threshold}
      ORDER BY embedding <=> ${embeddingStr}::vector
      LIMIT ${topK}
    `);

    return rs.map((row: any) => ({
      id: row.id,
      score: row.score,
    }));
  }

  async deleteByDocumentId(documentId: string): Promise<void> {
    await this.db.execute(drizzleSql`
      DELETE FROM document_chunks WHERE document_id = ${documentId}
    `);
  }

  async deleteByKnowledgeBaseId(knowledgeBaseId: string): Promise<void> {
    await this.db.execute(drizzleSql`
      DELETE FROM document_chunks WHERE knowledge_base_id = ${knowledgeBaseId}
    `);
  }
}
