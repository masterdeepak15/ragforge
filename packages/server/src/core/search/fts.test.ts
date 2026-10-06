import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { createTestApp, type TestApp } from '../../test/helpers.js';
import { createKb } from '../../test/multipart.js';
import { runMigrations } from '../../db/connection.js';
import { createKeywordIndex, toFtsTerms, type IKeywordIndex } from './fts.js';

let t: TestApp;
let index: IKeywordIndex;
let kbA: string;
let kbB: string;

async function addDoc(kbId: string, chunks: string[]): Promise<{ docId: string; chunkIds: string[] }> {
  const docId = randomUUID();
  await t.app.db.client.execute({
    sql: `INSERT INTO documents (id, knowledge_base_id, title, source_type, status) VALUES (?, ?, 'd', 'txt', 'ready')`,
    args: [docId, kbId],
  });
  const chunkIds: string[] = [];
  for (const [i, content] of chunks.entries()) {
    const id = randomUUID();
    chunkIds.push(id);
    await t.app.db.client.execute({
      sql: `INSERT INTO document_chunks (id, document_id, knowledge_base_id, chunk_index, content, token_count) VALUES (?, ?, ?, ?, ?, 1)`,
      args: [id, docId, kbId, i, content],
    });
  }
  return { docId, chunkIds };
}

beforeAll(async () => {
  t = await createTestApp();
  index = createKeywordIndex(t.app.db);
  kbA = await createKb(t, 'A');
  kbB = await createKb(t, 'B');
});
afterAll(async () => {
  await t.close();
});

describe('toFtsTerms', () => {
  it('keeps letters and digits from any script and drops syntax characters', () => {
    expect(toFtsTerms('Hello, "world" -x a*b col:val 日本語 42')).toEqual(['Hello', 'world', 'x', 'a', 'b', 'col', 'val', '日本語', '42']);
  });
  it('returns an empty list when nothing searchable remains', () => {
    expect(toFtsTerms('"" *** --')).toEqual([]);
  });
});

describe('keyword index', () => {
  it('ranks the chunk containing the rare query term first', async () => {
    const { chunkIds } = await addDoc(kbA, [
      'cats and dogs are common household pets',
      'the zeppelin hangar was enormous and cold',
      'pets need food and water every day',
    ]);
    const hits = await index.search(kbA, 'zeppelin', 5);
    expect(hits.map((h) => h.id)).toEqual([chunkIds[1]]);
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('orders by relevance across several matching chunks', async () => {
    const { chunkIds } = await addDoc(kbA, [
      'quokka',
      'quokka quokka quokka are small marsupials, a quokka smiles',
      'a different animal entirely, perhaps a quokka',
    ]);
    const hits = await index.search(kbA, 'quokka', 3);
    expect(hits[0].id).toBe(chunkIds[1]);
    expect(hits).toHaveLength(3);
  });

  it.each([`"foo" AND`, 'a*b', '-x', 'col:val', '""', 'the', '((', "it's", 'NEAR(', 'a OR', '\\', '🙂🙂'])(
    'does not throw for the query %j',
    async (q) => {
      const hits = await index.search(kbA, q, 5);
      expect(Array.isArray(hits)).toBe(true);
    },
  );

  it('returns nothing for a query without searchable terms', async () => {
    expect(await index.search(kbA, '***', 5)).toEqual([]);
  });

  it('isolates knowledge bases', async () => {
    await addDoc(kbB, ['secret platypus content']);
    expect(await index.search(kbA, 'platypus', 5)).toEqual([]);
    expect((await index.search(kbB, 'platypus', 5)).length).toBe(1);
  });

  it('stops returning chunks once they are deleted', async () => {
    const { docId, chunkIds } = await addDoc(kbA, ['ephemeral narwhal text']);
    expect((await index.search(kbA, 'narwhal', 5)).map((h) => h.id)).toEqual(chunkIds);
    await t.app.db.vectorStore.deleteByDocumentId(docId);
    expect(await index.search(kbA, 'narwhal', 5)).toEqual([]);
  });

  it('reflects updated chunk content', async () => {
    const { chunkIds } = await addDoc(kbA, ['original wording about wombats']);
    await t.app.db.client.execute({
      sql: `UPDATE document_chunks SET content = 'rewritten wording about capybaras' WHERE id = ?`,
      args: [chunkIds[0]],
    });
    expect(await index.search(kbA, 'wombats', 5)).toEqual([]);
    expect((await index.search(kbA, 'capybaras', 5)).map((h) => h.id)).toEqual(chunkIds);
  });

  it('indexes chunks that existed before the FTS table was created', async () => {
    const client = t.app.db.client;
    for (const trg of ['ai', 'ad', 'au']) await client.execute(`DROP TRIGGER IF EXISTS chunks_fts_${trg}`);
    await client.execute(`DROP TABLE IF EXISTS chunks_fts`);
    const { chunkIds } = await addDoc(kbA, ['legacy chunk about pangolins']);

    await runMigrations(t.app.db);

    expect((await index.search(kbA, 'pangolins', 5)).map((h) => h.id)).toEqual(chunkIds);
  });
});
