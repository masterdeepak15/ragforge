import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createTestApp, type TestApp } from '../test/helpers.js';

let t: TestApp;
let fake: Server;
let fakeUrl: string;
const authz = () => ({ authorization: `Bearer ${t.token}` });

beforeAll(async () => {
  t = await createTestApp();
  fake = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'llama3.1' }] }));
    if (url.pathname === '/v1/models') {
      if (req.headers.authorization !== 'Bearer good-key') return void res.writeHead(401).end('{}');
      return void res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }));
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(async () => {
  fake.closeAllConnections?.();
  await new Promise<void>((r) => fake.close(() => r()));
  await t.close();
});
beforeEach(async () => {
  await t.app.db.client.execute('DELETE FROM ai_providers');
});

const post = (url: string, payload: object, headers = authz()) => t.app.inject({ method: 'POST', url, headers, payload });
const list = async () => (await t.app.inject({ method: 'GET', url: '/api/providers', headers: authz() })).json() as any[];

describe('GET /api/providers/capabilities', () => {
  it('describes every provider, including which can create embeddings', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/providers/capabilities', headers: authz() });
    expect(res.statusCode).toBe(200);
    const byType = Object.fromEntries(res.json().providers.map((p: any) => [p.type, p]));
    expect(Object.keys(byType).sort()).toEqual(['anthropic', 'gemini', 'groq', 'ollama', 'openai']);
    expect(byType.anthropic).toMatchObject({ supportsEmbeddings: false, needsApiKey: true, label: 'Anthropic' });
    expect(byType.ollama).toMatchObject({ supportsEmbeddings: true, needsApiKey: false, defaultBaseUrl: 'http://localhost:11434' });
    expect(byType.openai.oauthConfigured).toBe(false);
  });

  it('requires authentication', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/providers/capabilities' })).statusCode).toBe(401);
  });
});

describe('POST /api/providers', () => {
  it('makes the first provider the default for answers and indexing, with sensible models', async () => {
    const res = await post('/api/providers', { provider: 'ollama', baseUrl: fakeUrl });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: 'Ollama (local)', provider: 'ollama', baseUrl: fakeUrl,
      isDefaultLlm: true, isDefaultEmbedding: true,
      defaultLlmModel: 'llama3.1', defaultEmbeddingModel: 'nomic-embed-text',
    });
  });

  it('does not take over defaults that already exist, and never defaults a provider to a job it cannot do', async () => {
    await post('/api/providers', { provider: 'ollama', baseUrl: fakeUrl });
    const second = (await post('/api/providers', { provider: 'anthropic', apiKey: 'sk-ant-xyz' })).json();
    expect(second).toMatchObject({ isDefaultLlm: false, isDefaultEmbedding: false });
    expect(second.hasApiKey).toBe(true);
    expect(JSON.stringify(second)).not.toContain('sk-ant-xyz');

    await t.app.db.client.execute('DELETE FROM ai_providers');
    const only = (await post('/api/providers', { provider: 'anthropic', apiKey: 'sk-ant-xyz' })).json();
    expect(only).toMatchObject({ isDefaultLlm: true, isDefaultEmbedding: false });
  });

  it('still accepts the older "type" field', async () => {
    const res = await post('/api/providers', { type: 'ollama', baseUrl: fakeUrl, name: 'Legacy' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ provider: 'ollama', name: 'Legacy' });
  });

  it('honours explicit models and default flags', async () => {
    await post('/api/providers', { provider: 'ollama', baseUrl: fakeUrl });
    const res = await post('/api/providers', { provider: 'openai', apiKey: 'k', defaultLlmModel: 'gpt-4o', defaultEmbeddingModel: 'text-embedding-3-large', isDefaultEmbedding: true });
    expect(res.json()).toMatchObject({ defaultLlmModel: 'gpt-4o', defaultEmbeddingModel: 'text-embedding-3-large', isDefaultEmbedding: true, isDefaultLlm: false });
    const all = await list();
    expect(all.filter((p) => p.isDefaultEmbedding)).toHaveLength(1);
  });

  it('explains what is wrong with a bad request', async () => {
    const msg = async (payload: object) => (await post('/api/providers', payload)).json().error as string;
    expect((await post('/api/providers', {})).statusCode).toBe(400);
    expect(await msg({})).toMatch(/provider is required/i);
    expect(await msg({ provider: 'skynet' })).toMatch(/unknown provider/i);
    expect(await msg({ provider: 'openai' })).toMatch(/OpenAI needs an API key/);
    expect(await msg({ provider: 'ollama', baseUrl: 'file:///etc' })).toMatch(/http/i);
    expect(await msg({ provider: 'anthropic', apiKey: 'k', isDefaultEmbedding: true })).toMatch(/cannot create embeddings/i);
    expect(await list()).toEqual([]);
  });

  it('is not available to viewers', async () => {
    const viewer = t.app.jwt.sign({ sub: 'v', role: 'viewer' });
    const res = await post('/api/providers', { provider: 'ollama' }, { authorization: `Bearer ${viewer}` });
    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /api/providers/:id', () => {
  it('moves a default to another provider so there is only ever one', async () => {
    const a = (await post('/api/providers', { provider: 'ollama', baseUrl: fakeUrl })).json();
    const b = (await post('/api/providers', { provider: 'openai', apiKey: 'k' })).json();
    const res = await t.app.inject({ method: 'PATCH', url: `/api/providers/${b.id}`, headers: authz(), payload: { isDefaultEmbedding: true } });
    expect(res.statusCode).toBe(200);
    const all = await list();
    expect(all.find((p) => p.id === b.id).isDefaultEmbedding).toBe(true);
    expect(all.find((p) => p.id === a.id).isDefaultEmbedding).toBe(false);
  });

  it('refuses a default the provider cannot fulfil, and 404s for unknown providers', async () => {
    const a = (await post('/api/providers', { provider: 'anthropic', apiKey: 'k' })).json();
    const bad = await t.app.inject({ method: 'PATCH', url: `/api/providers/${a.id}`, headers: authz(), payload: { isDefaultEmbedding: true } });
    expect(bad.statusCode).toBe(400);
    const missing = await t.app.inject({ method: 'PATCH', url: '/api/providers/nope', headers: authz(), payload: { name: 'x' } });
    expect(missing.statusCode).toBe(404);
  });

  it('updates models, name and credentials', async () => {
    const a = (await post('/api/providers', { provider: 'openai', apiKey: 'old' })).json();
    const res = await t.app.inject({ method: 'PATCH', url: `/api/providers/${a.id}`, headers: authz(), payload: { name: 'Work OpenAI', defaultLlmModel: 'gpt-4o', apiKey: 'new-key' } });
    expect(res.json()).toMatchObject({ name: 'Work OpenAI', defaultLlmModel: 'gpt-4o', hasApiKey: true });
    expect(JSON.stringify(res.json())).not.toContain('new-key');
  });
});

describe('DELETE /api/providers/:id', () => {
  it('hands the default roles to another capable provider', async () => {
    const a = (await post('/api/providers', { provider: 'ollama', baseUrl: fakeUrl })).json();
    await post('/api/providers', { provider: 'openai', apiKey: 'k' });
    expect((await t.app.inject({ method: 'DELETE', url: `/api/providers/${a.id}`, headers: authz() })).statusCode).toBe(204);
    const [remaining] = await list();
    expect(remaining).toMatchObject({ provider: 'openai', isDefaultLlm: true, isDefaultEmbedding: true });
  });

  it('does not give the embeddings role to a provider that cannot embed', async () => {
    const a = (await post('/api/providers', { provider: 'ollama', baseUrl: fakeUrl })).json();
    await post('/api/providers', { provider: 'anthropic', apiKey: 'k' });
    await t.app.inject({ method: 'DELETE', url: `/api/providers/${a.id}`, headers: authz() });
    const [remaining] = await list();
    expect(remaining).toMatchObject({ provider: 'anthropic', isDefaultLlm: true, isDefaultEmbedding: false });
  });
});

describe('testing a connection', () => {
  it('tests settings before they are saved', async () => {
    const ok = await post('/api/providers/test', { provider: 'ollama', baseUrl: fakeUrl });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, models: ['llama3.1'] });

    const down = await post('/api/providers/test', { provider: 'ollama', baseUrl: 'http://127.0.0.1:1' });
    expect(down.statusCode).toBe(200);
    expect(down.json()).toMatchObject({ ok: false });
    expect(down.json().message).toMatch(/could not reach/i);

    expect(await list()).toEqual([]); // nothing was saved
  });

  it('tests a saved provider with its stored (decrypted) key', async () => {
    const saved = (await post('/api/providers', { provider: 'openai', baseUrl: `${fakeUrl}/v1`, apiKey: 'good-key' })).json();
    const good = await post(`/api/providers/${saved.id}/test`, {});
    expect(good.json()).toMatchObject({ ok: true });

    await t.app.inject({ method: 'PATCH', url: `/api/providers/${saved.id}`, headers: authz(), payload: { apiKey: 'revoked-key' } });
    const bad = await post(`/api/providers/${saved.id}/test`, {});
    expect(bad.json()).toMatchObject({ ok: false });
    expect(bad.json().message).toMatch(/rejected/i);
  });

  it('404s for an unknown provider and refuses viewers', async () => {
    expect((await post('/api/providers/nope/test', {})).statusCode).toBe(404);
    const viewer = t.app.jwt.sign({ sub: 'v', role: 'viewer' });
    expect((await post('/api/providers/test', { provider: 'ollama' }, { authorization: `Bearer ${viewer}` })).statusCode).toBe(403);
  });
});

describe('indexing picks up the provider set through the API', () => {
  it('a provider created through the API is what ingestion resolves as the default embedder', async () => {
    const created = (await post('/api/providers', { provider: 'ollama', baseUrl: fakeUrl })).json();
    const row = (await t.app.db.client.execute({ sql: 'SELECT * FROM ai_providers WHERE is_default_embedding = 1' })).rows[0] as any;
    expect(row.id).toBe(created.id);
    expect(row.default_embedding_model).toBe('nomic-embed-text');
  });
});
