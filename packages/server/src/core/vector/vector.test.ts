import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { createTestApp, type TestApp } from '../../test/helpers.js';
import { createKb } from '../../test/multipart.js';
import { migrateLegacyVectors } from './migrate-legacy.js';
import type { IVectorStore, VectorChunkInput } from './vector.interface.js';

let t: TestApp;
let store: IVectorStore;

function rand(dim: number): number[] {
  return Array.from({ length: dim }, () => Math.random() - 0.5);
}
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
async function addDocument(kbId: string): Promise<string> {
  const id = randomUUID();
  await t.app.db.client.execute({
    sql: `INSERT INTO documents (id, knowledge_base_id, title, source_type, status) VALUES (?, ?, 'd', 'txt', 'ready')`,
    args: [id, kbId],
  });
  return id;
}
function chunk(kbId: string, docId: string, i: number, embedding: number[], content = `chunk ${i}`): VectorChunkInput {
  return { id: randomUUID(), documentId: docId, knowledgeBaseId: kbId, chunkIndex: i, content, tokenCount: 1, embedding };
}
async function count(sql: string, args: any[] = []): Promise<number> {
  const rs = await t.app.db.client.execute({ sql, args });
  return Number((rs.rows[0] as any).n);
}

beforeAll(async () => {
  t = await createTestApp();
  store = t.app.db.vectorStore;
});
afterAll(async () => {
  await t.close();
});

describe('vector store (SQLite / libSQL ANN)', () => {
  it('finds true nearest neighbours (recall@5 >= 0.9 on 2,000 vectors)', async () => {
    const kb = await createKb(t, 'recall');
    const doc = await addDocument(kb);
    const vectors = Array.from({ length: 2000 }, () => rand(8));
    const inputs = vectors.map((v, i) => chunk(kb, doc, i, v));
    await store.upsertChunks(inputs);

    let hits = 0;
    const queries = 20;
    for (let q = 0; q < queries; q++) {
      const query = rand(8);
      const truth = inputs
        .map((c, i) => ({ id: c.id, s: cosine(query, vectors[i]) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 5)
        .map((x) => x.id);
      const got = (await store.search(kb, query, 5)).map((r) => r.id);
      hits += got.filter((id) => truth.includes(id)).length;
    }
    expect(hits / (queries * 5)).toBeGreaterThanOrEqual(0.9);
  });

  it('returns cosine similarity scores in descending order', async () => {
    const kb = await createKb(t, 'scores');
    const doc = await addDocument(kb);
    const target = rand(8);
    const inputs = [chunk(kb, doc, 0, target), chunk(kb, doc, 1, rand(8)), chunk(kb, doc, 2, rand(8))];
    await store.upsertChunks(inputs);
    const res = await store.search(kb, target, 3);
    expect(res[0].id).toBe(inputs[0].id);
    expect(res[0].score).toBeCloseTo(1, 4);
    expect(res.map((r) => r.score)).toEqual([...res.map((r) => r.score)].sort((a, b) => b - a));
  });

  it('applies the similarity threshold', async () => {
    const kb = await createKb(t, 'threshold');
    const doc = await addDocument(kb);
    const target = rand(8);
    await store.upsertChunks([chunk(kb, doc, 0, target), chunk(kb, doc, 1, target.map((x) => -x))]);
    const res = await store.search(kb, target, 5, 0.5);
    expect(res).toHaveLength(1);
  });

  it('keeps knowledge bases with different embedding dimensions side by side', async () => {
    const kb8 = await createKb(t, 'dim8');
    const kb16 = await createKb(t, 'dim16');
    const d8 = await addDocument(kb8);
    const d16 = await addDocument(kb16);
    const v8 = rand(8);
    const v16 = rand(16);
    const c8 = chunk(kb8, d8, 0, v8);
    const c16 = chunk(kb16, d16, 0, v16);
    await store.upsertChunks([c8]);
    await store.upsertChunks([c16]);
    expect((await store.search(kb8, v8, 3)).map((r) => r.id)).toEqual([c8.id]);
    expect((await store.search(kb16, v16, 3)).map((r) => r.id)).toEqual([c16.id]);
  });

  it('rejects embeddings whose dimension differs from the knowledge base and says so', async () => {
    const kb = await createKb(t, 'mismatch');
    const doc = await addDocument(kb);
    await store.upsertChunks([chunk(kb, doc, 0, rand(8))]);
    await expect(store.upsertChunks([chunk(kb, doc, 1, rand(16))])).rejects.toThrow(/expected 8.*got 16/i);
    await expect(store.search(kb, rand(16), 3)).rejects.toThrow(/expected 8.*got 16/i);
    expect(await count(`SELECT COUNT(*) AS n FROM document_chunks WHERE knowledge_base_id = ?`, [kb])).toBe(1);
  });

  it('isolates knowledge bases and returns nothing for an empty one', async () => {
    const a = await createKb(t, 'iso-a');
    const b = await createKb(t, 'iso-b');
    const docA = await addDocument(a);
    const v = rand(8);
    await store.upsertChunks([chunk(a, docA, 0, v)]);
    expect(await store.search(b, v, 5)).toEqual([]);
    expect(await store.search(a, v, 5)).toHaveLength(1);
  });

  it('updates an existing chunk instead of duplicating it', async () => {
    const kb = await createKb(t, 'upsert');
    const doc = await addDocument(kb);
    const first = chunk(kb, doc, 0, rand(8), 'old text');
    await store.upsertChunks([first]);
    const newVector = rand(8);
    await store.upsertChunks([{ ...first, content: 'new text', embedding: newVector }]);
    expect(await count(`SELECT COUNT(*) AS n FROM document_chunks WHERE id = ?`, [first.id])).toBe(1);
    const res = await store.search(kb, newVector, 5);
    expect(res).toHaveLength(1);
    expect(res[0].score).toBeCloseTo(1, 4);
  });

  it('writes more than one internal batch in a single call', async () => {
    const kb = await createKb(t, 'batch');
    const doc = await addDocument(kb);
    await store.upsertChunks(Array.from({ length: 1200 }, (_, i) => chunk(kb, doc, i, rand(8))));
    expect(await count(`SELECT COUNT(*) AS n FROM document_chunks WHERE knowledge_base_id = ?`, [kb])).toBe(1200);
    expect((await store.search(kb, rand(8), 10)).length).toBe(10);
  });

  it('removes a document from vector search and keyword search when deleted', async () => {
    const kb = await createKb(t, 'delete');
    const keep = await addDocument(kb);
    const drop = await addDocument(kb);
    const v = rand(8);
    const kept = chunk(kb, keep, 0, rand(8));
    const dropped = chunk(kb, drop, 0, v, 'ephemeral aardvark');
    await store.upsertChunks([kept, dropped]);
    await store.deleteByDocumentId(drop);
    // threshold -1: the kept chunk is random, its cosine to `v` may be negative
    const ids = (await store.search(kb, v, 5, -1)).map((r) => r.id);
    expect(ids).toEqual([kept.id]);
    expect(await count(`SELECT COUNT(*) AS n FROM document_chunks WHERE document_id = ?`, [drop])).toBe(0);
  });

  it('drops all vectors for a deleted knowledge base', async () => {
    const kb = await createKb(t, 'drop-kb');
    const doc = await addDocument(kb);
    await store.upsertChunks([chunk(kb, doc, 0, rand(8))]);
    await store.deleteByKnowledgeBaseId(kb);
    expect(await store.search(kb, rand(8), 5)).toEqual([]);
    expect(await count(`SELECT COUNT(*) AS n FROM document_chunks WHERE knowledge_base_id = ?`, [kb])).toBe(0);
  });
});

describe('migrateLegacyVectors', () => {
  it('moves legacy embedding blobs into the vector index exactly once', async () => {
    const kb = await createKb(t, 'legacy');
    const doc = await addDocument(kb);
    const v = rand(8);
    const id = randomUUID();
    const blob = Buffer.from(new Float32Array(v).buffer);
    await t.app.db.client.execute({
      sql: `INSERT INTO document_chunks (id, document_id, knowledge_base_id, chunk_index, content, token_count, embedding_blob)
            VALUES (?, ?, ?, 0, 'legacy text', 1, ?)`,
      args: [id, doc, kb, blob],
    });

    expect((await migrateLegacyVectors(t.app.db)).migrated).toBe(1);
    const res = await store.search(kb, v, 3);
    expect(res.map((r) => r.id)).toEqual([id]);
    expect(res[0].score).toBeCloseTo(1, 4);
    expect(await count(`SELECT COUNT(*) AS n FROM document_chunks WHERE id = ? AND embedding_blob IS NOT NULL`, [id])).toBe(0);

    expect((await migrateLegacyVectors(t.app.db)).migrated).toBe(0);
  });
});
