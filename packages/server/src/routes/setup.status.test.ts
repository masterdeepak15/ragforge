import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, type TestApp } from '../test/helpers.js';

let t: TestApp;
const authz = () => ({ authorization: `Bearer ${t.token}` });
const status = async () => (await t.app.inject({ method: 'GET', url: '/api/setup/status' })).json();
const addProvider = (payload: object) => t.app.inject({ method: 'POST', url: '/api/providers', headers: authz(), payload });

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.app.db.client.execute('DELETE FROM ai_providers');
});

describe('GET /api/setup/status', () => {
  it('reports that the system is set up once the admin exists', async () => {
    expect(await status()).toMatchObject({ isInitialized: true, hasAdminUser: true });
  });

  it('says there is no provider yet', async () => {
    expect(await status()).toMatchObject({ hasDefaultProvider: false, hasEmbeddingProvider: false });
  });

  it('does not count a provider that cannot create embeddings as ready for indexing', async () => {
    await addProvider({ provider: 'anthropic', apiKey: 'sk-ant-test' });
    expect(await status()).toMatchObject({ hasDefaultProvider: true, hasEmbeddingProvider: false });
  });

  it('is ready for indexing once an embedding-capable provider is set', async () => {
    await addProvider({ provider: 'anthropic', apiKey: 'sk-ant-test' });
    await addProvider({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11999' });
    expect(await status()).toMatchObject({ hasDefaultProvider: true, hasEmbeddingProvider: true });
  });
});
