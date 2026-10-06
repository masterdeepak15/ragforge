import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { createKb } from '../test/multipart.js';
import { DEFAULT_RETRIEVAL } from '../services/retrieval-settings.js';

let t: TestApp;
let kb: string;
beforeAll(async () => {
  t = await createTestApp();
  kb = await createKb(t, 'rs');
});
afterAll(async () => {
  await t.close();
});

const call = (method: 'GET' | 'PUT' | 'DELETE', id: string, payload?: unknown, auth = true) =>
  t.app.inject({ method, url: `/api/knowledge-bases/${id}/retrieval-settings`, headers: auth ? { authorization: `Bearer ${t.token}` } : {}, payload: payload as any });

describe('/api/knowledge-bases/:id/retrieval-settings', () => {
  it('requires a signed-in user', async () => {
    expect((await call('GET', kb, undefined, false)).statusCode).toBe(401);
    expect((await call('PUT', kb, { topK: 3 }, false)).statusCode).toBe(401);
  });

  it('returns the defaults for a knowledge base nobody has tuned', async () => {
    const res = await call('GET', kb);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ settings: DEFAULT_RETRIEVAL, defaults: DEFAULT_RETRIEVAL, customized: false });
  });

  it('saves a partial update and reports it as customized', async () => {
    const res = await call('PUT', kb, { minSimilarity: 0.5, topK: 9 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ settings: { ...DEFAULT_RETRIEVAL, minSimilarity: 0.5, topK: 9 }, customized: true });
    expect((await call('GET', kb)).json().settings).toMatchObject({ minSimilarity: 0.5, topK: 9 });
  });

  it('rejects a bad value and keeps what was saved', async () => {
    const res = await call('PUT', kb, { minSimilarity: 7 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/minSimilarity/);
    expect((await call('GET', kb)).json().settings.minSimilarity).toBe(0.5);
  });

  it('goes back to the defaults on delete', async () => {
    expect((await call('DELETE', kb)).statusCode).toBe(200);
    expect((await call('GET', kb)).json()).toMatchObject({ settings: DEFAULT_RETRIEVAL, customized: false });
  });

  it('answers 404 for an unknown knowledge base', async () => {
    expect((await call('GET', 'nope')).statusCode).toBe(404);
    expect((await call('PUT', 'nope', { topK: 3 })).statusCode).toBe(404);
    expect((await call('DELETE', 'nope')).statusCode).toBe(404);
  });
});
