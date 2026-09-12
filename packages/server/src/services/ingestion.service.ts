import { randomUUID } from 'crypto';
import { loadDocument, chunkText } from '../core/ingestion/loaders.js';
import { ProviderFactory } from '../core/providers/factory.js';
import type { IVectorStore } from '../core/vector/vector.interface.js';
import type { HybridRetriever } from '../core/retrieval/hybrid.retriever.js';
import type { DatabaseContext } from '../db/connection.js';
import type { DocumentFileType } from '@ragforge/shared';

export interface IngestionInput {
  documentId: string;
  knowledgeBaseId: string;
  sourceType: DocumentFileType;
  title: string;
  buffer?: Buffer;
  text?: string;
  url?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  embeddingProviderId?: string;
  embeddingModel?: string;
}

export interface IngestionProgress {
  stage: 'loading' | 'chunking' | 'embedding' | 'storing' | 'done' | 'error';
  chunksTotal?: number;
  chunksProcessed?: number;
  error?: string;
}

type ProgressCallback = (progress: IngestionProgress) => void;

export class IngestionService {
  constructor(
    private db: DatabaseContext,
    private vectorStore: IVectorStore,
    private retriever: HybridRetriever
  ) {}

  async ingest(input: IngestionInput, onProgress?: ProgressCallback): Promise<void> {
    const report = (progress: IngestionProgress) => onProgress?.(progress);
    const db = this.getDb();

    try {
      // Mark as processing
      await db.execute({
        sql: `UPDATE documents SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        args: [input.documentId],
      } as any);

      // 1. Load document
      report({ stage: 'loading' });
      const loaded = await loadDocument({
        type: input.sourceType,
        buffer: input.buffer,
        text: input.text,
        url: input.url,
      });

      // 2. Chunk
      report({ stage: 'chunking' });
      const chunks = chunkText(loaded.text, {
        chunkSize: input.chunkSize ?? 1000,
        chunkOverlap: input.chunkOverlap ?? 200,
        baseMetadata: loaded.metadata,
      });
      report({ stage: 'embedding', chunksTotal: chunks.length, chunksProcessed: 0 });

      // 3. Get embedding provider
      const providerRow = await this.getEmbeddingProvider(input.embeddingProviderId);
      const embeddingModel = input.embeddingModel ?? providerRow?.defaultEmbeddingModel ?? 'nomic-embed-text';
      const providerType = providerRow?.provider ?? 'ollama';
      const apiKeyOrCreds = providerRow?.apiKeyEncrypted
        ? this.decryptProviderKey(providerRow.apiKeyEncrypted)
        : undefined;

      const provider = ProviderFactory.create(providerType as any, {
        baseUrl: providerRow?.baseUrl ?? undefined,
        apiKey: typeof apiKeyOrCreds === 'string' ? apiKeyOrCreds : undefined,
        oauthCredentials: typeof apiKeyOrCreds === 'object' ? apiKeyOrCreds : undefined,
      });

      if (!provider.generateEmbeddings) {
        throw new Error(`Provider "${providerType}" does not support embeddings`);
      }

      // 4. Embed in batches of 32
      const BATCH = 32;
      const vectorInputs = [];

      for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks.slice(i, i + BATCH);
        const { embeddings } = await provider.generateEmbeddings!({
          model: embeddingModel,
          texts: batch.map(c => c.content),
        });

        for (let j = 0; j < batch.length; j++) {
          vectorInputs.push({
            id: randomUUID(),
            documentId: input.documentId,
            knowledgeBaseId: input.knowledgeBaseId,
            chunkIndex: i + j,
            content: batch[j].content,
            tokenCount: batch[j].tokenCount,
            metadata: batch[j].metadata,
            embedding: embeddings[j],
          });
        }
        report({ stage: 'embedding', chunksTotal: chunks.length, chunksProcessed: Math.min(i + BATCH, chunks.length) });
      }

      // 5. Store vectors
      report({ stage: 'storing' });
      await this.vectorStore.upsertChunks(vectorInputs);

      // 6. Update document stats
      const totalTokens = chunks.reduce((s, c) => s + c.tokenCount, 0);
      await db.execute({
        sql: `UPDATE documents SET status = 'ready', chunk_count = ?, token_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        args: [chunks.length, totalTokens, input.documentId],
      } as any);

      // Invalidate BM25 cache for this KB
      this.retriever.invalidateCache(input.knowledgeBaseId);

      report({ stage: 'done', chunksTotal: chunks.length, chunksProcessed: chunks.length });
    } catch (err: any) {
      await db.execute({
        sql: `UPDATE documents SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        args: [err?.message ?? 'Unknown error', input.documentId],
      } as any);
      report({ stage: 'error', error: err?.message ?? 'Unknown error' });
      throw err;
    }
  }

  private getDb(): any {
    return this.db.client;
  }

  private async getEmbeddingProvider(providerId?: string): Promise<any> {
    const client = this.getDb();
    if (providerId) {
      const rs = await client.execute({ sql: `SELECT * FROM ai_providers WHERE id = ?`, args: [providerId] });
      return rs.rows[0] ?? null;
    }
    const rs = await client.execute({ sql: `SELECT * FROM ai_providers WHERE is_default_embedding = 1 LIMIT 1`, args: [] });
    return rs.rows[0] ?? null;
  }

  private decryptProviderKey(encrypted: string): string {
    try {
      const plain = ProviderFactory.decryptApiKey(encrypted);
      // If it's JSON, it's OAuth credentials
      if (plain.startsWith('{')) return JSON.parse(plain);
      return plain;
    } catch {
      return encrypted;
    }
  }
}
