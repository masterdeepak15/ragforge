import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { createTestApp, fakeEmbed, type TestApp } from '../test/helpers.js';
import { createKb, buildMultipart } from '../test/multipart.js';
import { buildPdf } from '../test/pdf.js';
import { ProviderFactory } from '../core/providers/factory.js';
import { ingestDocument, type IngestDeps } from './ingestion.handler.js';
import { NonRetryableError } from '../queue/worker.js';
import type { Job } from '../queue/job-queue.js';
import type { AppEvent } from '../events/event-bus.js';
import type { IVectorStore } from '../core/vector/vector.interface.js';

let t: TestApp;
let kbId: string;
let embedImpl: (texts: string[]) => Promise<number[][]>;
let events: AppEvent[];
let embedCalls: number;

const defaultEmbed = async (texts: string[]) => texts.map(fakeEmbed);
const wide = (text: string) => [...fakeEmbed(text), ...fakeEmbed(text + '!')]; // 16 dimensions

function spyStore(inner: IVectorStore) {
  const s = {
    upserts: 0,
    upsertChunks: async (c: Parameters<IVectorStore['upsertChunks']>[0]) => {
      s.upserts++;
      return inner.upsertChunks(c);
    },
    search: (...a: Parameters<IVectorStore['search']>) => inner.search(...a),
    deleteByDocumentId: (id: string) => inner.deleteByDocumentId(id),
    deleteByKnowledgeBaseId: (id: string) => inner.deleteByKnowledgeBaseId(id),
  };
  return s;
}

function deps(over: Partial<IngestDeps> = {}): IngestDeps {
  return {
    db: t.app.db,
    vectorStore: t.app.db.vectorStore,
    events: t.app.events,
    jobs: t.app.jobs,
    dataDir: t.dataDir,
    retry: { baseMs: 1 },
    ...over,
  };
}
const job = (documentId: string, attempts = 1): Job => ({ id: randomUUID(), documentId, status: 'running', attempts, maxAttempts: 3 });

async function upload(filename: string, data: Buffer | string, kb = kbId): Promise<string> {
  const { payload, headers } = buildMultipart([
    { name: 'knowledgeBaseId', value: kb },
    { name: 'file', filename, data: Buffer.isBuffer(data) ? data : Buffer.from(data) },
  ]);
  const res = await t.app.inject({ method: 'POST', url: '/api/documents/upload', headers: { authorization: `Bearer ${t.token}`, ...headers }, payload });
  return res.json().items[0].id;
}
async function doc(id: string): Promise<any> {
  return (await t.app.db.client.execute({ sql: 'SELECT * FROM documents WHERE id = ?', args: [id] })).rows[0];
}
async function chunkCount(id: string): Promise<number> {
  const rs = await t.app.db.client.execute({ sql: 'SELECT COUNT(*) AS n FROM document_chunks WHERE document_id = ?', args: [id] });
  return Number((rs.rows[0] as any).n);
}
const run = (id: string, over: Partial<IngestDeps> = {}, j = job(id), signal = new AbortController().signal) =>
  ingestDocument(j, deps(over), signal);

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
  kbId = await createKb(t, 'ingest');
  const off = t.app.events.subscribe((e) => events.push(e));
  void off;
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  embedImpl = defaultEmbed;
  events = [];
  embedCalls = 0;
});

describe('ingestDocument', () => {
  it('turns a text file into searchable chunks, reporting progress and readiness', async () => {
    const id = await upload('space.txt', 'The quasar emits radiation across the galaxy.\n\nPulsars spin quickly.');
    await run(id);

    const row = await doc(id);
    expect(row.status).toBe('ready');
    expect(Number(row.chunk_count)).toBeGreaterThan(0);
    expect(Number(row.token_count)).toBeGreaterThan(0);
    expect(await chunkCount(id)).toBe(Number(row.chunk_count));

    const stages = events.filter((e) => e.type === 'job.progress').map((e: any) => e.stage);
    expect(stages[0]).toBe('loading');
    expect(stages).toContain('embedding');
    expect(events.at(-1)).toMatchObject({ type: 'document.ready', documentId: id, knowledgeBaseId: kbId });

    const hits = await t.app.retriever.retrieve({ knowledgeBaseId: kbId, query: 'quasar', topK: 3 } as any);
    expect(hits.some((h: any) => h.documentId === id && h.content.includes('quasar'))).toBe(true);

    const kb = (await t.app.db.client.execute({ sql: 'SELECT embedding_dimension FROM knowledge_bases WHERE id = ?', args: [kbId] })).rows[0] as any;
    expect(Number(kb.embedding_dimension)).toBe(8);
  });

  it('is idempotent: running twice leaves the same chunks', async () => {
    const id = await upload('twice.txt', 'alpha beta gamma\n\ndelta epsilon zeta');
    await run(id);
    const first = await chunkCount(id);
    await run(id);
    expect(await chunkCount(id)).toBe(first);
    expect((await doc(id)).status).toBe('ready');
  });

  it.each([
    ['empty file', Buffer.alloc(0)],
    ['whitespace-only file', Buffer.from('  \n\t \n ')],
  ])('fails a %s with a clear non-retryable message instead of becoming ready', async (_name, data) => {
    const id = await upload(`blank-${randomUUID()}.txt`, data);
    await expect(run(id)).rejects.toBeInstanceOf(NonRetryableError);
    const row = await doc(id);
    expect(row.status).toBe('failed');
    expect(row.error_message).toMatch(/No extractable text/);
    expect(await chunkCount(id)).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: 'job.failed', documentId: id });
  });

  it('fails a corrupt PDF as non-retryable', async () => {
    const id = await upload('broken.pdf', 'this is definitely not a pdf');
    await expect(run(id)).rejects.toBeInstanceOf(NonRetryableError);
    const row = await doc(id);
    expect(row.status).toBe('failed');
    expect(row.error_message).toMatch(/Could not read pdf/i);
    expect(row.error_message).not.toMatch(/ENOENT/); // pdf-parse must not fall into its debug-file mode
  });

  it('extracts text from a real PDF', async () => {
    const id = await upload('real.pdf', await buildPdf('Hello pangolin world'));
    await run(id);
    expect((await doc(id)).status).toBe('ready');
    const hits = await t.app.retriever.retrieve({ knowledgeBaseId: kbId, query: 'pangolin', topK: 3 } as any);
    expect(hits.some((h: any) => h.documentId === id && h.content.includes('pangolin'))).toBe(true);
  });

  it('survives a rate-limited provider by retrying the embedding call', async () => {
    let n = 0;
    embedImpl = async (texts) => {
      if (++n <= 2) throw Object.assign(new Error('rate limited'), { status: 429 });
      return texts.map(fakeEmbed);
    };
    const id = await upload('limited.txt', 'a short document that fits in one batch');
    await run(id);
    expect((await doc(id)).status).toBe('ready');
    expect(embedCalls).toBe(3);
  });

  it('rejects embeddings of a different dimension without writing partial data', async () => {
    const first = await upload('dim-a.txt', 'first document, eight dimensional');
    await run(first);

    embedImpl = async (texts) => texts.map(wide);
    const second = await upload('dim-b.txt', 'second document, sixteen dimensional');
    await expect(run(second)).rejects.toThrow(/dimension/i);
    const row = await doc(second);
    expect(row.status).toBe('failed');
    expect(row.error_message).toMatch(/expected 8.*got 16/i);
    expect(await chunkCount(second)).toBe(0);
    expect(await chunkCount(first)).toBeGreaterThan(0);
  });

  it('stores vectors incrementally instead of buffering a large file', async () => {
    const text = Array.from({ length: 30_000 }, (_, i) => `Paragraph ${i} ` + 'lorem ipsum dolor sit amet '.repeat(4)).join('\n\n');
    const id = await upload('large.txt', text);
    const store = spyStore(t.app.db.vectorStore);
    let upsertsAtReady = -1;
    const off = t.app.events.subscribe((e) => {
      if (e.type === 'document.ready' && e.documentId === id) upsertsAtReady = store.upserts;
    });
    await run(id, { vectorStore: store });
    off();
    expect((await doc(id)).status).toBe('ready');
    expect(Number((await doc(id)).chunk_count)).toBeGreaterThan(300);
    expect(upsertsAtReady).toBeGreaterThan(5);
    expect(embedCalls).toBe(store.upserts);
  });

  it('puts a document back to pending while retries remain and to failed on the final attempt', async () => {
    embedImpl = async () => {
      throw new Error('upstream exploded');
    };
    const id = await upload('retryable.txt', 'content that will hit a broken provider');

    await expect(run(id, {}, job(id, 1))).rejects.toThrow('upstream exploded');
    expect(await doc(id)).toMatchObject({ status: 'pending', error_message: 'upstream exploded' });
    expect(events.some((e) => e.type === 'job.failed')).toBe(false);

    await expect(run(id, {}, job(id, 3))).rejects.toThrow('upstream exploded');
    expect((await doc(id)).status).toBe('failed');
    expect(events.at(-1)).toMatchObject({ type: 'job.failed', error: 'upstream exploded' });
  });

  it('tells the user to configure an embedding provider when none exists', async () => {
    await t.app.db.client.execute(`UPDATE ai_providers SET is_default_embedding = 0`);
    try {
      const id = await upload('noprovider.txt', 'nobody to embed this');
      await expect(run(id)).rejects.toBeInstanceOf(NonRetryableError);
      // A capable provider exists but is not selected, so the message points at the exact button to press.
      expect((await doc(id)).error_message).toMatch(/Settings.*Use for indexing/);
    } finally {
      await t.app.db.client.execute(`UPDATE ai_providers SET is_default_embedding = 1`);
    }
  });

  it('stops between batches when cancelled', async () => {
    const text = Array.from({ length: 5000 }, (_, i) => `Line ${i} ` + 'x'.repeat(200)).join('\n\n');
    const id = await upload('cancel.txt', text);
    const controller = new AbortController();
    embedImpl = async (texts) => {
      controller.abort();
      return texts.map(fakeEmbed);
    };
    await expect(run(id, {}, job(id), controller.signal)).rejects.toThrow(/cancel/i);
    expect(embedCalls).toBe(1);
    expect((await doc(id)).status).toBe('failed');
    expect((await doc(id)).error_message).toMatch(/Cancelled/);
  });
});
