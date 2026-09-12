import { IVectorStore, VectorChunkInput, VectorSearchResult } from './vector.interface.js';
import type { Client } from '@libsql/client';

export class SqliteVectorStore implements IVectorStore {
  constructor(private client: Client) {}

  /**
   * Serializes a number array into a raw Buffer of Float32Array
   */
  private serializeEmbedding(embedding: number[]): Buffer {
    const f32 = new Float32Array(embedding);
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  }

  /**
   * High performance cosine similarity between two Float32Arrays
   */
  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const len = a.length;
    for (let i = 0; i < len; i++) {
      const valA = a[i];
      const valB = b[i];
      dot += valA * valB;
      normA += valA * valA;
      normB += valB * valB;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async upsertChunks(chunks: VectorChunkInput[]): Promise<void> {
    if (chunks.length === 0) return;

    for (const chunk of chunks) {
      const blob = this.serializeEmbedding(chunk.embedding);
      const metaStr = chunk.metadata ? JSON.stringify(chunk.metadata) : null;

      await this.client.execute({
        sql: `INSERT INTO document_chunks (
                id, document_id, knowledge_base_id, chunk_index, content, token_count, metadata, embedding_blob, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(id) DO UPDATE SET
                content = excluded.content,
                token_count = excluded.token_count,
                metadata = excluded.metadata,
                embedding_blob = excluded.embedding_blob`,
        args: [
          chunk.id,
          chunk.documentId,
          chunk.knowledgeBaseId,
          chunk.chunkIndex,
          chunk.content,
          chunk.tokenCount,
          metaStr,
          blob,
        ],
      });
    }
  }

  async search(
    knowledgeBaseId: string,
    queryEmbedding: number[],
    topK: number,
    threshold: number = 0
  ): Promise<VectorSearchResult[]> {
    const rs = await this.client.execute({
      sql: `SELECT id, embedding_blob FROM document_chunks WHERE knowledge_base_id = ? AND embedding_blob IS NOT NULL`,
      args: [knowledgeBaseId],
    });

    const queryF32 = new Float32Array(queryEmbedding);
    const scored: VectorSearchResult[] = [];

    for (const row of rs.rows) {
      const id = row.id as string;
      const rawBlob = row.embedding_blob;
      if (!rawBlob) continue;

      let buffer: Buffer;
      if (Buffer.isBuffer(rawBlob)) {
        buffer = rawBlob;
      } else if (rawBlob instanceof ArrayBuffer) {
        buffer = Buffer.from(rawBlob);
      } else if (ArrayBuffer.isView(rawBlob)) {
        buffer = Buffer.from(rawBlob.buffer, rawBlob.byteOffset, rawBlob.byteLength);
      } else {
        continue;
      }

      const chunkF32 = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength / Float32Array.BYTES_PER_ELEMENT
      );

      const sim = this.cosineSimilarity(queryF32, chunkF32);
      if (sim >= threshold) {
        scored.push({ id, score: sim });
      }
    }

    // Sort descending by similarity score
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async deleteByDocumentId(documentId: string): Promise<void> {
    await this.client.execute({
      sql: `DELETE FROM document_chunks WHERE document_id = ?`,
      args: [documentId],
    });
  }

  async deleteByKnowledgeBaseId(knowledgeBaseId: string): Promise<void> {
    await this.client.execute({
      sql: `DELETE FROM document_chunks WHERE knowledge_base_id = ?`,
      args: [knowledgeBaseId],
    });
  }
}
