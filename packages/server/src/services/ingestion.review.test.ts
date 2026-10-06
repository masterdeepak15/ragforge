import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { createTestApp, fakeEmbed, type TestApp } from '../test/helpers.js';
import { createKb, buildMultipart } from '../test/multipart.js';
import { ProviderFactory } from '../core/providers/factory.js';
import { ingestDocument, type IngestDeps } from './ingestion.handler.js';
import type { Job } from '../queue/job-queue.js';

let t: TestApp;
let kbId: string;
let embedImpl: (texts: string[]) => Promise<number[][]>;
let embedCalls: number;

const BIG = Array.from({ length: 5000 }, (_, i) => `Line ${i} ` + 'x'.repeat(200)).join('\n\n'); // many 32-chunk batches

const deps = (over: Partial<IngestDeps> = {}): IngestDeps => ({
  db: t.app.db, vectorStore: t.app.db.vectorStore, events: t.app.events, jobs: t.app.jobs, dataDir: t.dataDir, retry: { baseMs: 1 }, ...over,
});
const job = (documentId: string, attempts = 1): Job => ({ id: randomUUID(), documentId, status: 'running', attempts, maxAttempts: 3 });

async function upload(filename: string, text: string, kb = kbId): Promise<string> {
  const { payload, headers } = buildMultipart([{ name: 'knowledgeBaseId', value: kb }, { name: 'file', filename, data: Buffer.from(text) }]);
  const res = await t.app.inject({ method: 'POST', url: '/api/documents/upload', headers: { authorization: `Bearer ${t.token}`, ...headers }, payload });
  return res.json().items[0].id;
}
const doc = async (id: string) => (await t.app.db.client.execute({ sql: 'SELECT * FROM documents WHERE id = ?', args: [id] })).rows[0] as any;
async function chunkCount(id: string): Promise<number> {
  return Number(((await t.app.db.client.execute({ sql: 'SELECT COUNT(*) AS n FROM document_chunks WHERE document_id = ?', args: [id] })).rows[0] as any).n);
}
async function searchableDocIds(kb: string): Promise<Set<string>> {
  const hits = await t.app.retriever.retrieve({ knowledgeBaseId: kb, query: 'Line', topK: 50 } as any);
  return new Set(hits.map((h: any) => h.documentId));
}

beforeAll(async () => {
  t = await createTestApp();
  ProviderFactory.register('ollama', () => ({
    async generateEmbeddings({ texts }: { texts: string[] }) {
      embedCalls++;
      return { embeddings: await embedImpl(texts) } as any;
    },
    async listEmbeddingModels() {
      return [];
    },
  }));
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  embedCalls = 0;
  embedImpl = async (texts) => texts.map(fakeEmbed);
  kbId = await createKb(t, `kb-${randomUUID().slice(0, 6)}`);
  await t.app.db.client.execute(`UPDATE ai_providers SET default_embedding_model = 'fake'`);
});

describe('a document that does not finish never leaves searchable fragments', () => {
  it('removes the chunks already stored when the job fails for good', async () => {
    const id = await upload('doomed.txt', BIG);
    embedImpl = async (texts) => {
      if (embedCalls > 2) throw new Error('provider fell over');
      return texts.map(fakeEmbed);
    };
    await expect(ingestDocument(job(id, 3), deps(), new AbortController().signal)).rejects.toThrow('provider fell over');
    expect(embedCalls).toBeGreaterThan(2); // it really did store some batches first
    embedImpl = async (texts) => texts.map(fakeEmbed); // the provider is healthy again for the search below
    expect((await doc(id)).status).toBe('failed');
    expect(await chunkCount(id)).toBe(0);
    expect((await searchableDocIds(kbId)).has(id)).toBe(false);
  });

  it('removes the chunks already stored when the job is cancelled', async () => {
    const id = await upload('cancelled.txt', BIG);
    const controller = new AbortController();
    embedImpl = async (texts) => {
      if (embedCalls >= 3) controller.abort();
      return texts.map(fakeEmbed);
    };
    await expect(ingestDocument(job(id), deps(), controller.signal)).rejects.toThrow(/cancel/i);
    expect(await chunkCount(id)).toBe(0);
    expect((await searchableDocIds(kbId)).has(id)).toBe(false);
  });

  it('hides a half-finished document from search while its job waits for a retry', async () => {
    const id = await upload('retrying.txt', BIG);
    embedImpl = async (texts) => {
      if (embedCalls > 2) throw new Error('temporary outage');
      return texts.map(fakeEmbed);
    };
    await expect(ingestDocument(job(id, 1), deps(), new AbortController().signal)).rejects.toThrow('temporary outage');
    embedImpl = async (texts) => texts.map(fakeEmbed); // the provider is healthy again for the search below
    expect((await doc(id)).status).toBe('pending');
    expect(await chunkCount(id)).toBeGreaterThan(0); // partial data may remain until the retry...
    expect((await searchableDocIds(kbId)).has(id)).toBe(false); // ...but it is never returned
  });

  it('still finds documents that finished', async () => {
    const id = await upload('fine.txt', 'Line one is about quasars and pulsars in distant galaxies');
    await ingestDocument(job(id), deps(), new AbortController().signal);
    expect((await searchableDocIds(kbId)).has(id)).toBe(true);
  });
});

describe('changing the embedding model after documents were indexed', () => {
  it('refuses to mix vector spaces even when the dimension is unchanged', async () => {
    const first = await upload('before.txt', 'Line one was indexed with the original model');
    await ingestDocument(job(first), deps(), new AbortController().signal);
    expect((await doc(first)).status).toBe('ready');

    await t.app.db.client.execute(`UPDATE ai_providers SET default_embedding_model = 'other-model'`); // same 8 dimensions
    const second = await upload('after.txt', 'Line two arrives after the model was switched');
    await expect(ingestDocument(job(second), deps(), new AbortController().signal)).rejects.toThrow(/indexed with "fake".*"other-model"/s);
    const row = await doc(second);
    expect(row.status).toBe('failed');
    expect(row.error_message).toMatch(/different models cannot be mixed|cannot be mixed/i);
    expect(await chunkCount(second)).toBe(0);
    expect(await chunkCount(first)).toBeGreaterThan(0);
  });

  it('refuses to answer queries with a different model than the one that built the index', async () => {
    const first = await upload('indexed.txt', 'Line one is indexed with the original model');
    await ingestDocument(job(first), deps(), new AbortController().signal);
    await t.app.db.client.execute(`UPDATE ai_providers SET default_embedding_model = 'other-model'`);
    await expect(t.app.retriever.retrieve({ knowledgeBaseId: kbId, query: 'Line', topK: 3 } as any)).rejects.toThrow(/embedding model/i);
  });

  it('keeps working when the model is unchanged, and for knowledge bases indexed before models were recorded', async () => {
    const id = await upload('same.txt', 'Line one stays consistent');
    await ingestDocument(job(id), deps(), new AbortController().signal);
    await expect(t.app.retriever.retrieve({ knowledgeBaseId: kbId, query: 'Line', topK: 3 } as any)).resolves.toBeDefined();

    await t.app.db.client.execute({ sql: 'UPDATE kb_vector_tables SET embedding_model = NULL WHERE knowledge_base_id = ?', args: [kbId] });
    await t.app.db.client.execute(`UPDATE ai_providers SET default_embedding_model = 'anything'`);
    await expect(t.app.retriever.retrieve({ knowledgeBaseId: kbId, query: 'Line', topK: 3 } as any)).resolves.toBeDefined();
  });
});
