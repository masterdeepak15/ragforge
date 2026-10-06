import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { loadDocument, loadUrl, chunkText } from '../core/ingestion/loaders.js';
import { ProviderFactory, type ProviderInstance } from '../core/providers/factory.js';
import { withRetry, type RetryOptions } from '../core/providers/retry.js';
import { PROVIDER_SPECS } from '../core/providers/connection-test.js';
import { EmbeddingDimensionError } from '../core/vector/vector-tables.js';
import type { IVectorStore, VectorChunkInput } from '../core/vector/vector.interface.js';
import type { DatabaseContext } from '../db/connection.js';
import type { EventBus, IngestStage } from '../events/event-bus.js';
import type { Job, JobQueue } from '../queue/job-queue.js';
import { NonRetryableError } from '../queue/worker.js';

export interface IngestDeps {
  db: DatabaseContext;
  vectorStore: IVectorStore;
  events: EventBus;
  jobs: JobQueue;
  dataDir: string;
  /** Embedding-call retry policy (tests shorten the delays). */
  retry?: Pick<RetryOptions, 'retries' | 'baseMs'>;
}

/** Chunks embedded and stored per provider call. */
const EMBED_BATCH = 32;
/** Characters of a plain-text file held in memory at once. */
const SEGMENT_CHARS = 2_000_000;

interface Segment {
  text: string;
  metadata?: Record<string, any>;
}

/**
 * Processes one ingestion job: loads the document, chunks it, embeds in batches and stores each
 * batch immediately (memory stays bounded for huge files). Safe to re-run: existing chunks are
 * removed first. Document status follows the outcome; the thrown error tells the worker whether
 * to retry (`NonRetryableError` = never).
 */
export async function ingestDocument(job: Job, deps: IngestDeps, signal: AbortSignal): Promise<void> {
  const client = deps.db.client;
  const rs = await client.execute({ sql: `SELECT * FROM documents WHERE id = ?`, args: [job.documentId] });
  const doc = rs.rows[0] as any;
  if (!doc) throw new NonRetryableError(`Document ${job.documentId} not found`);
  const knowledgeBaseId: string = doc.knowledge_base_id;

  try {
    await runIngestion(job, doc, deps, signal);
  } catch (raw: any) {
    const cancelled = signal.aborted;
    const err = cancelled ? new NonRetryableError('Cancelled') : toIngestError(raw);
    const willRetry = (err as any).retryable !== false && job.attempts < job.maxAttempts;

    await client.execute({
      sql: `UPDATE documents SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [willRetry ? 'pending' : 'failed', err.message, job.documentId],
    });
    // A document that will not be retried must not leave searchable fragments behind.
    if (!willRetry) await deps.vectorStore.deleteByDocumentId(job.documentId).catch(() => undefined);
    if (!willRetry && !cancelled) {
      deps.events.publish({ type: 'job.failed', jobId: job.id, documentId: job.documentId, knowledgeBaseId, error: err.message });
    }
    throw err;
  }
}

function toIngestError(err: any): Error {
  if (err?.retryable === false) return err;
  if (err instanceof EmbeddingDimensionError) return new NonRetryableError(err.message);
  return err instanceof Error ? err : new Error(String(err));
}

async function runIngestion(job: Job, doc: any, deps: IngestDeps, signal: AbortSignal): Promise<void> {
  const client = deps.db.client;
  const documentId: string = doc.id;
  const knowledgeBaseId: string = doc.knowledge_base_id;
  const throwIfCancelled = () => {
    if (signal.aborted) throw new Error('Cancelled');
  };

  const progress = async (stage: IngestStage, chunksDone?: number, chunksTotal?: number) => {
    deps.events.publish({ type: 'job.progress', jobId: job.id, documentId, knowledgeBaseId, stage, chunksTotal, chunksDone });
    await deps.jobs.updateProgress(job.id, { stage, chunksTotal, chunksDone });
  };

  await client.execute({
    sql: `UPDATE documents SET status = 'processing', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    args: [documentId],
  });
  await progress('loading');

  const kb = (await client.execute({ sql: `SELECT * FROM knowledge_bases WHERE id = ?`, args: [knowledgeBaseId] })).rows[0] as any;
  if (!kb) throw new NonRetryableError('Knowledge base not found');
  const chunkSize = Number(kb.chunk_size) || 1000;
  const chunkOverlap = Number(kb.chunk_overlap) || 200;

  const { provider, model } = await resolveEmbedder(deps.db, kb);

  // Vectors from different models live in different spaces even when their length matches; never mix them.
  const recorded = (await client.execute({ sql: `SELECT embedding_model FROM kb_vector_tables WHERE knowledge_base_id = ?`, args: [knowledgeBaseId] })).rows[0] as any;
  if (recorded?.embedding_model && recorded.embedding_model !== model) {
    throw new NonRetryableError(
      `This knowledge base was indexed with "${recorded.embedding_model}", but the embedding model is now "${model}". ` +
        `Vectors from different models cannot be mixed. Switch back to the original model, or create a new knowledge base.`
    );
  }

  // Idempotent re-runs: drop whatever a previous attempt stored.
  await deps.vectorStore.deleteByDocumentId(documentId);

  let chunkIndex = 0;
  let totalTokens = 0;
  let dimensionRecorded = false;
  const fileSize = Number(doc.file_size) || 0;
  let estimatedTotal = fileSize > 0 ? Math.ceil(fileSize / (chunkSize * 4 * 0.9)) : undefined;

  for await (const segment of segments(doc, deps.dataDir)) {
    throwIfCancelled();
    await progress('chunking', chunkIndex, estimatedTotal);
    const chunks = chunkText(segment.text, { chunkSize, chunkOverlap, baseMetadata: segment.metadata });
    if (!doc.file_path || doc.source_type === 'pdf' || doc.source_type === 'docx' || doc.source_type === 'url') {
      estimatedTotal = chunks.length; // single segment: exact
    }

    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      throwIfCancelled();
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const { embeddings } = await withRetry(
        () => provider.generateEmbeddings!({ model, texts: batch.map((c) => c.content) }),
        { ...deps.retry, signal }
      );
      if (embeddings.length !== batch.length) {
        throw new Error(`Embedding provider returned ${embeddings.length} vectors for ${batch.length} chunks`);
      }

      const inputs: VectorChunkInput[] = batch.map((c, j) => ({
        id: randomUUID(),
        documentId,
        knowledgeBaseId,
        chunkIndex: chunkIndex + j,
        content: c.content,
        tokenCount: c.tokenCount,
        metadata: { ...c.metadata, chunkIndex: chunkIndex + j },
        embedding: embeddings[j],
      }));
      throwIfCancelled(); // cancellation may have arrived while the provider was working
      await deps.vectorStore.upsertChunks(inputs);

      if (!dimensionRecorded) {
        dimensionRecorded = true;
        await client.execute({
          sql: `UPDATE knowledge_bases SET embedding_dimension = ? WHERE id = ?`,
          args: [embeddings[0].length, knowledgeBaseId],
        });
        await client.execute({
          sql: `UPDATE kb_vector_tables SET embedding_model = ? WHERE knowledge_base_id = ? AND embedding_model IS NULL`,
          args: [model, knowledgeBaseId],
        });
      }
      chunkIndex += batch.length;
      totalTokens += batch.reduce((s, c) => s + c.tokenCount, 0);
      await progress('embedding', chunkIndex, Math.max(chunkIndex, estimatedTotal ?? 0));
    }
  }

  if (chunkIndex === 0) {
    throw new NonRetryableError('No extractable text (the file is empty, or it is a scanned document without a text layer)');
  }

  await client.execute({
    sql: `UPDATE documents SET status = 'ready', error_message = NULL, chunk_count = ?, token_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    args: [chunkIndex, totalTokens, documentId],
  });
  deps.events.publish({ type: 'document.ready', documentId, knowledgeBaseId, chunkCount: chunkIndex });
}

/** Yields the document's text in memory-bounded pieces. */
async function* segments(doc: any, dataDir: string): AsyncGenerator<Segment> {
  const type: string = doc.source_type;
  if (type === 'url') {
    const loaded = await loadUrl(doc.source_url);
    yield { text: loaded.text, metadata: loaded.metadata };
    return;
  }

  const path = join(dataDir, 'uploads', doc.file_path);
  if (type === 'pdf' || type === 'docx') {
    const buffer = await readFile(path);
    try {
      const loaded = await loadDocument({ type, buffer });
      yield { text: loaded.text, metadata: loaded.metadata };
    } catch (err: any) {
      throw new NonRetryableError(`Could not read ${type}: ${err?.message ?? err}`);
    }
    return;
  }

  let carry = '';
  for await (const piece of createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
    carry += piece;
    while (carry.length >= SEGMENT_CHARS) {
      const cut = findCut(carry, SEGMENT_CHARS);
      yield { text: carry.slice(0, cut) };
      carry = carry.slice(cut);
    }
  }
  if (carry.length > 0) yield { text: carry };
}

/** Cut a segment at a paragraph, line or word boundary near `limit` so chunks are not split mid-sentence. */
function findCut(text: string, limit: number): number {
  for (const sep of ['\n\n', '\n', ' ']) {
    const idx = text.lastIndexOf(sep, limit);
    if (idx > limit / 2) return idx + sep.length;
  }
  return limit;
}

export async function resolveEmbedder(db: DatabaseContext, kb: any): Promise<{ provider: ProviderInstance; model: string }> {
  const client = db.client;
  const rs = kb.embedding_provider_id
    ? await client.execute({ sql: `SELECT * FROM ai_providers WHERE id = ?`, args: [kb.embedding_provider_id] })
    : await client.execute({ sql: `SELECT * FROM ai_providers WHERE is_default_embedding = 1 LIMIT 1`, args: [] });
  const row = rs.rows[0] as any;
  if (!row) throw new NonRetryableError(await explainMissingEmbedder(client));

  let secret: string | object | undefined;
  if (row.api_key_encrypted) {
    try {
      const plain = ProviderFactory.decryptApiKey(row.api_key_encrypted as string);
      secret = plain.startsWith('{') ? JSON.parse(plain) : plain;
    } catch {
      secret = row.api_key_encrypted as string;
    }
  }
  const provider = ProviderFactory.create(row.provider, {
    baseUrl: row.base_url ?? undefined,
    apiKey: typeof secret === 'string' ? secret : undefined,
    oauthCredentials: secret && typeof secret === 'object' ? (secret as any) : undefined,
  });
  if (!provider.generateEmbeddings) {
    throw new NonRetryableError(`Provider "${row.provider}" does not support embeddings`);
  }
  // Same model the retriever uses for query embeddings, so documents and queries share a vector space.
  const model: string = row.default_embedding_model || kb.embedding_model || 'nomic-embed-text';
  return { provider, model };
}

/** Says why indexing has no provider, so the user knows what to do (not just that something is missing). */
async function explainMissingEmbedder(client: DatabaseContext['client']): Promise<string> {
  const types = ((await client.execute({ sql: `SELECT provider FROM ai_providers`, args: [] })).rows as any[]).map((r) => r.provider as string);
  if (types.length === 0) return 'No embedding provider is configured. Configure an embedding provider in Settings.';
  const spec = (t: string) => PROVIDER_SPECS[t as keyof typeof PROVIDER_SPECS];
  if (types.some((t) => spec(t)?.supportsEmbeddings)) {
    return 'You have a provider that can index documents, but none is selected for indexing. Open Settings and press "Use for indexing" on it, then retry.';
  }
  const labels = [...new Set(types.map((t) => spec(t)?.label ?? t))];
  return `${labels.join(' and ')} cannot create embeddings, so documents cannot be indexed yet. Add Ollama, OpenAI or Google Gemini in Settings, then press Retry.`;
}
