import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { createKb } from '../test/multipart.js';
import { DEFAULT_RETRIEVAL, getRetrievalSettings, parseRetrievalPatch, resetRetrievalSettings, saveRetrievalSettings } from './retrieval-settings.js';

describe('parseRetrievalPatch', () => {
  it('accepts a partial update and keeps only known fields', () => {
    expect(parseRetrievalPatch({ topK: 10, minSimilarity: 0.45, junk: 1 })).toEqual({ ok: true, value: { topK: 10, minSimilarity: 0.45 } });
  });

  it.each([
    [{ topK: 0 }, /topK/],
    [{ topK: 51 }, /topK/],
    [{ topK: 2.5 }, /topK/],
    [{ minSimilarity: 1.5 }, /minSimilarity/],
    [{ minSimilarity: -0.1 }, /minSimilarity/],
    [{ vectorWeight: 'x' }, /vectorWeight/],
    [{ bm25Weight: 2 }, /bm25Weight/],
    [{ useHybridSearch: 'yes' }, /useHybridSearch/],
  ])('rejects %j', (input, message) => {
    const r = parseRetrievalPatch(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it('rejects a body that is not an object', () => {
    expect(parseRetrievalPatch('nope').ok).toBe(false);
    expect(parseRetrievalPatch(null).ok).toBe(false);
  });
});

describe('stored retrieval settings', () => {
  let t: TestApp;
  let kb: string;
  beforeAll(async () => {
    t = await createTestApp();
    kb = await createKb(t, 'settings');
  });
  afterAll(async () => {
    await t.close();
  });

  it('starts from the defaults, which match how chat behaved before settings existed', async () => {
    expect(DEFAULT_RETRIEVAL).toEqual({ topK: 6, useHybridSearch: true, vectorWeight: 0.7, bm25Weight: 0.3, minSimilarity: 0.3 });
    expect(await getRetrievalSettings(t.app.db.client, kb)).toEqual(DEFAULT_RETRIEVAL);
  });

  it('saves only what was changed and keeps the rest at the defaults', async () => {
    await saveRetrievalSettings(t.app.db.client, kb, { minSimilarity: 0.5 });
    expect(await getRetrievalSettings(t.app.db.client, kb)).toEqual({ ...DEFAULT_RETRIEVAL, minSimilarity: 0.5 });
    await saveRetrievalSettings(t.app.db.client, kb, { topK: 12 });
    expect(await getRetrievalSettings(t.app.db.client, kb)).toEqual({ ...DEFAULT_RETRIEVAL, minSimilarity: 0.5, topK: 12 });
  });

  it('goes back to the defaults on reset', async () => {
    await resetRetrievalSettings(t.app.db.client, kb);
    expect(await getRetrievalSettings(t.app.db.client, kb)).toEqual(DEFAULT_RETRIEVAL);
  });

  it('falls back to the defaults when stored data is damaged', async () => {
    await t.app.db.client.execute({ sql: `UPDATE knowledge_bases SET retrieval_settings = ? WHERE id = ?`, args: ['{not json', kb] });
    expect(await getRetrievalSettings(t.app.db.client, kb)).toEqual(DEFAULT_RETRIEVAL);
  });

  it('gives the defaults for a knowledge base that does not exist', async () => {
    expect(await getRetrievalSettings(t.app.db.client, 'missing')).toEqual(DEFAULT_RETRIEVAL);
  });
});
