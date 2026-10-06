import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { PROVIDER_SPECS, testProviderConnection } from './connection-test.js';

let server: Server;
let base: string;
let hangs = false;
const seen: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    if (hangs) return; // never answer
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/tags') return send(200, { models: [{ name: 'llama3.1' }, { name: 'nomic-embed-text' }] });
    if (url.pathname === '/v1/models' && req.headers['x-api-key']) {
      return req.headers['x-api-key'] === 'good-key' ? send(200, { data: [{ id: 'claude-haiku-4-5-20251001' }] }) : send(401, { error: 'bad key' });
    }
    if (url.pathname === '/v1beta/models') {
      return url.searchParams.get('key') === 'good-key' ? send(200, { models: [{ name: 'models/gemini-1.5-flash' }] }) : send(400, { error: 'API key not valid' });
    }
    if (url.pathname === '/openai/v1/models' || url.pathname === '/v1/models') {
      return req.headers.authorization === 'Bearer good-key' ? send(200, { data: [{ id: 'gpt-4o-mini' }, { id: 'text-embedding-3-small' }] }) : send(401, { error: 'bad key' });
    }
    if (url.pathname === '/boom/v1/models') return send(500, { error: 'upstream' });
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('PROVIDER_SPECS', () => {
  it('describes what each provider can do', () => {
    expect(PROVIDER_SPECS.anthropic).toMatchObject({ supportsLlm: true, supportsEmbeddings: false, needsApiKey: true });
    expect(PROVIDER_SPECS.groq.supportsEmbeddings).toBe(false);
    expect(PROVIDER_SPECS.ollama).toMatchObject({ supportsEmbeddings: true, needsApiKey: false, defaultEmbeddingModel: 'nomic-embed-text' });
    expect(PROVIDER_SPECS.openai.defaultEmbeddingModel).toBe('text-embedding-3-small');
    for (const spec of Object.values(PROVIDER_SPECS)) {
      expect(spec.defaultLlmModel).toBeTruthy();
      expect(spec.supportsEmbeddings ? !!spec.defaultEmbeddingModel : true).toBe(true);
    }
  });
});

describe('testProviderConnection', () => {
  it('connects to Ollama and lists its models', async () => {
    const res = await testProviderConnection('ollama', { baseUrl: base });
    expect(res).toEqual({ ok: true, models: ['llama3.1', 'nomic-embed-text'] });
  });

  it('explains an unreachable server', async () => {
    const res = await testProviderConnection('ollama', { baseUrl: 'http://127.0.0.1:1' });
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toMatch(/could not reach/i);
    expect((res as { message: string }).message).toContain('127.0.0.1:1');
  });

  it('accepts a valid OpenAI-style key and rejects a wrong one without echoing it', async () => {
    expect(await testProviderConnection('openai', { baseUrl: `${base}/v1`, apiKey: 'good-key' })).toMatchObject({ ok: true, models: ['gpt-4o-mini', 'text-embedding-3-small'] });
    const bad = await testProviderConnection('openai', { baseUrl: `${base}/v1`, apiKey: 'sk-super-secret-wrong' });
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { message: string }).message).toMatch(/key was rejected/i);
    expect(JSON.stringify(bad)).not.toContain('sk-super-secret-wrong');
  });

  it('uses each provider\'s own authentication scheme', async () => {
    seen.length = 0;
    await testProviderConnection('anthropic', { baseUrl: base, apiKey: 'good-key' });
    expect(seen.at(-1)!.headers['x-api-key']).toBe('good-key');
    expect(seen.at(-1)!.headers['anthropic-version']).toBeTruthy();

    await testProviderConnection('gemini', { baseUrl: base, apiKey: 'good-key' });
    expect(seen.at(-1)!.url).toContain('key=good-key');

    await testProviderConnection('groq', { baseUrl: `${base}/openai/v1`, apiKey: 'good-key' });
    expect(seen.at(-1)!.headers.authorization).toBe('Bearer good-key');
  });

  it('accepts a valid Gemini and Anthropic key', async () => {
    expect(await testProviderConnection('gemini', { baseUrl: base, apiKey: 'good-key' })).toEqual({ ok: true, models: ['gemini-1.5-flash'] });
    expect(await testProviderConnection('anthropic', { baseUrl: base, apiKey: 'good-key' })).toMatchObject({ ok: true });
    expect(await testProviderConnection('gemini', { baseUrl: base, apiKey: 'wrong' })).toMatchObject({ ok: false });
  });

  it('asks for a key before making any request when one is required', async () => {
    seen.length = 0;
    const res = await testProviderConnection('openai', { baseUrl: `${base}/v1` });
    expect(res).toMatchObject({ ok: false });
    expect((res as { message: string }).message).toMatch(/needs an API key/i);
    expect(seen).toHaveLength(0);
  });

  it('reports server errors and timeouts distinctly', async () => {
    const err = await testProviderConnection('openai', { baseUrl: `${base}/boom/v1`, apiKey: 'good-key' });
    expect((err as { message: string }).message).toMatch(/HTTP 500/);

    hangs = true;
    const slow = await testProviderConnection('ollama', { baseUrl: base }, { timeoutMs: 150 });
    hangs = false;
    expect(slow).toMatchObject({ ok: false });
    expect((slow as { message: string }).message).toMatch(/did not answer in time/i);
  });

  it('only talks to http(s) addresses', async () => {
    for (const baseUrl of ['file:///etc/passwd', 'ftp://example.com', 'not a url']) {
      const res = await testProviderConnection('ollama', { baseUrl });
      expect(res).toMatchObject({ ok: false });
      expect((res as { message: string }).message).toMatch(/http/i);
    }
  });
});
