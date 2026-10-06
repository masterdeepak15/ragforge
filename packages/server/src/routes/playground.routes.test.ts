import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { createKb } from '../test/multipart.js';

let t: TestApp;
let kbId: string;

// What the retriever would find for an unrelated query: weak vector matches, one keyword-only hit.
const FOUND = [
  { id: 'strong', documentId: 'd1', content: 'strong match', score: 0.0164, vectorScore: 0.62, bm25Score: 1.4, metadata: {} },
  { id: 'weak', documentId: 'd1', content: 'weak match', score: 0.0115, vectorScore: 0.41, metadata: {} },
  { id: 'keyword', documentId: 'd1', content: 'has the exact word', score: 0.011, bm25Score: 2.1, metadata: {} },
];

beforeAll(async () => {
  t = await createTestApp();
  kbId = await createKb(t, 'play');
  (t.app.retriever as any).retrieve = async () => FOUND;
});
afterAll(async () => {
  await t.close();
});

async function search(body: Record<string, unknown>) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/playground/retrieve',
    headers: { authorization: `Bearer ${t.token}` },
    payload: { query: 'whatware', knowledgeBaseId: kbId, ...body },
  });
  expect(res.statusCode).toBe(200);
  return res.json().chunks as any[];
}

describe('POST /api/playground/retrieve', () => {
  it('reports how similar each chunk is and whether a keyword matched', async () => {
    const chunks = await search({});
    expect(chunks.map((c) => c.id)).toEqual(['strong', 'weak', 'keyword']);
    expect(chunks[0]).toMatchObject({ similarity: 0.62, keywordMatch: true });
    expect(chunks[1]).toMatchObject({ similarity: 0.41, keywordMatch: false });
    expect(chunks[2]).toMatchObject({ keywordMatch: true });
  });

  it('applies the minimum score to similarity, so weak vector matches drop out', async () => {
    const chunks = await search({ minScore: 0.5 });
    expect(chunks.map((c) => c.id)).toEqual(['strong', 'keyword']); // a keyword hit stays, a 0.41 match goes
  });

  it('can filter everything when nothing is similar enough and no keyword matched', async () => {
    (t.app.retriever as any).retrieve = async () => [FOUND[1]];
    try {
      expect(await search({ minScore: 0.5 })).toEqual([]);
    } finally {
      (t.app.retriever as any).retrieve = async () => FOUND;
    }
  });

  it('ignores keyword hits for the minimum when keyword search is off', async () => {
    const chunks = await search({ minScore: 0.5, useHybridSearch: false });
    expect(chunks.map((c) => c.id)).toEqual(['strong']);
  });

  describe('starts from the knowledge base retrieval settings', () => {
    async function askRecording(body: Record<string, unknown>) {
      let asked: any;
      (t.app.retriever as any).retrieve = async (q: any) => {
        asked = q;
        return FOUND;
      };
      await search(body);
      return asked;
    }
    const put = (payload: Record<string, unknown>) =>
      t.app.inject({ method: 'PUT', url: `/api/knowledge-bases/${kbId}/retrieval-settings`, headers: { authorization: `Bearer ${t.token}` }, payload });

    it('uses the saved settings for anything the page does not send', async () => {
      await put({ topK: 9, minSimilarity: 0.55, useHybridSearch: false, vectorWeight: 0.8, bm25Weight: 0.2 });
      const asked = await askRecording({});
      expect(asked).toMatchObject({ topK: 9, useHybridSearch: false, vectorWeight: 0.8, bm25Weight: 0.2, similarityThreshold: 0.55 });
    });

    it('lets what the page sends win over the saved settings', async () => {
      await put({ topK: 9, minSimilarity: 0.55 });
      const asked = await askRecording({ topK: 3, minScore: 0.1 });
      expect(asked).toMatchObject({ topK: 3, similarityThreshold: 0.1 });
    });

    it('filters the results with the saved minimum when the page sends none', async () => {
      await put({ minSimilarity: 0.5, useHybridSearch: true });
      (t.app.retriever as any).retrieve = async () => FOUND;
      expect((await search({})).map((c) => c.id)).toEqual(['strong', 'keyword']);
    });
  });
});
