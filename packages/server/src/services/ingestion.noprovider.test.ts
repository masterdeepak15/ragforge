import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { createTestApp, type TestApp } from '../test/helpers.js';
import { createKb, buildMultipart } from '../test/multipart.js';
import { ingestDocument } from './ingestion.handler.js';
import { NonRetryableError } from '../queue/worker.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.app.db.client.execute('DELETE FROM ai_providers');
});

async function failedMessage(): Promise<string> {
  const kb = await createKb(t, `kb-${randomUUID().slice(0, 6)}`);
  const { payload, headers } = buildMultipart([{ name: 'knowledgeBaseId', value: kb }, { name: 'file', filename: 'doc.txt', data: Buffer.from('some text to index') }]);
  const up = await t.app.inject({ method: 'POST', url: '/api/documents/upload', headers: { authorization: `Bearer ${t.token}`, ...headers }, payload });
  const documentId = up.json().items[0].id;
  const job = { id: randomUUID(), documentId, status: 'running' as const, attempts: 1, maxAttempts: 3 };
  await expect(
    ingestDocument(job, { db: t.app.db, vectorStore: t.app.db.vectorStore, events: t.app.events, jobs: t.app.jobs, dataDir: t.dataDir }, new AbortController().signal),
  ).rejects.toBeInstanceOf(NonRetryableError);
  return ((await t.app.db.client.execute({ sql: 'SELECT error_message FROM documents WHERE id = ?', args: [documentId] })).rows[0] as any).error_message;
}

describe('the error shown when a document cannot be indexed for lack of a provider', () => {
  it('asks the user to add a provider when there is none', async () => {
    const msg = await failedMessage();
    expect(msg).toMatch(/No embedding provider is configured/);
    expect(msg).toMatch(/Configure an embedding provider in Settings/);
  });

  it('explains that Claude (Anthropic) and Groq cannot index, and what to add instead', async () => {
    await t.app.inject({ method: 'POST', url: '/api/providers', headers: { authorization: `Bearer ${t.token}` }, payload: { provider: 'anthropic', apiKey: 'sk-ant-test' } });
    const msg = await failedMessage();
    expect(msg).toMatch(/Anthropic cannot create embeddings/);
    expect(msg).toMatch(/Ollama, OpenAI or Google Gemini/);
    expect(msg).toMatch(/Settings/);
  });

  it('names every provider that cannot index when several are configured', async () => {
    for (const body of [{ provider: 'anthropic', apiKey: 'k1' }, { provider: 'groq', apiKey: 'k2' }]) {
      await t.app.inject({ method: 'POST', url: '/api/providers', headers: { authorization: `Bearer ${t.token}` }, payload: body });
    }
    const msg = await failedMessage();
    expect(msg).toMatch(/Anthropic/);
    expect(msg).toMatch(/Groq/);
  });

  it('points at the "Use for indexing" button when a capable provider exists but is not selected', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/providers', headers: { authorization: `Bearer ${t.token}` }, payload: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11999', isDefaultEmbedding: false } });
    expect(res.statusCode).toBe(201);
    const msg = await failedMessage();
    expect(msg).toMatch(/Use for indexing/);
  });
});
